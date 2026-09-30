import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeUpstream } from './helpers.js';
import { detectScenario, orderBalance, createBreaker, buildChain, parseSpec } from '../src/routing.js';
import { startRouter, serveRequest } from '../src/router.js';

const post = (port, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ok = text => (b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); };
const fail = code => (b, res) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end('{"error":{"message":"x"}}'); };
const tgt = (provider, up, model, extra = {}) => ({ provider, baseUrl: up.base, key: 'k', model, fastModel: model, apiFor: () => 'chat', fixedModel: true, ...extra });

test('senaryo algılama: görsel > uzun bağlam > web arama > düşünme > arka plan', () => {
  const img = { messages: [{ role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'x' }] }], thinking: { type: 'enabled' } };
  assert.equal(detectScenario('claude', img), 'image');
  assert.equal(detectScenario('claude', { messages: [] }, { tokens: 70000 }), 'longContext');
  assert.equal(detectScenario('claude', { messages: [] }, { tokens: 70000, threshold: 100000 }), null);
  assert.equal(detectScenario('claude', { messages: [], tools: [{ type: 'web_search_20250305', name: 'web_search' }] }), 'webSearch');
  assert.equal(detectScenario('claude', { messages: [], thinking: { type: 'enabled', budget_tokens: 5000 } }), 'think');
  assert.equal(detectScenario('claude', { model: 'claude-haiku-4-5', messages: [] }), 'background');
  assert.equal(detectScenario('claude', { messages: [] }, { requestedModel: 'gemini-2.5-flash' }), 'background');
  assert.equal(detectScenario('claude', { model: 'claude-sonnet-5', messages: [] }), null);
  assert.equal(detectScenario('codex', { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }] }), 'image');
  assert.equal(detectScenario('codex', { input: [], reasoning: { effort: 'high' } }), 'think');
  assert.equal(detectScenario('codex', { input: [], reasoning: { effort: 'low' } }), null);
});

test('yük dengeleme: ağırlıklı seçim ve sırayla dağıtım; spec ayrıştırma', () => {
  const g = { strategy: 'weighted', members: [{ provider: 'a', weight: 3 }, { provider: 'b', weight: 1 }, { provider: 'z', weight: 0 }] };
  assert.equal(orderBalance(g, new Map(), 'k', () => 0.1)[0].provider, 'a');
  assert.equal(orderBalance(g, new Map(), 'k', () => 0.9)[0].provider, 'b');
  assert.deepEqual(orderBalance(g, new Map(), 'k', () => 0.9).map(m => m.provider), ['b', 'a'], 'ağırlığı 0 olan dışarıda');
  const rr = { strategy: 'round-robin', members: [{ provider: 'a' }, { provider: 'b' }, { provider: 'c' }] };
  const st = new Map();
  assert.deepEqual([0, 1, 2, 3].map(() => orderBalance(rr, st, 'k')[0].provider), ['a', 'b', 'c', 'a']);
  assert.deepEqual(parseSpec('openrouter:anthropic/claude-sonnet-4.5:free*2.5'), { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5:free', weight: 2.5 });
  assert.deepEqual(parseSpec('deepseek:deepseek-chat'), { provider: 'deepseek', model: 'deepseek-chat', weight: 1 });
  assert.equal(parseSpec('nocolon'), null);
  assert.equal(parseSpec('a:*3'), null);
});

test('devre kesici: N hatada açılır, bekleme sonrası yarı açık tek deneme, başarıyla kapanır', () => {
  let now = 0;
  const b = createBreaker(() => now);
  const cfg = { enabled: true, failures: 2, cooldownSec: 10 };
  assert.equal(b.allow('p', cfg), true);
  b.failure('p', cfg); assert.equal(b.allow('p', cfg), true);
  b.failure('p', cfg); assert.equal(b.allow('p', cfg), false, 'açık');
  assert.equal(b.snapshot(cfg).p.state, 'open');
  now = 10000; assert.equal(b.allow('p', cfg), true, 'yarı açık');
  b.begin('p'); assert.equal(b.allow('p', cfg), false, 'aynı anda tek deneme');
  b.failure('p', cfg); assert.equal(b.allow('p', cfg), false, 'deneme başarısız → yeniden açık');
  now = 20000; assert.equal(b.allow('p', cfg), true); b.begin('p'); b.success('p');
  assert.equal(b.snapshot(cfg).p.state, 'closed');
  assert.equal(b.allow('p', { ...cfg, enabled: false }), true);
  const { chain, skipped } = buildChain({ primary: { provider: 'x', model: '1' }, fallbacks: [{ provider: 'x', model: '1' }, { provider: 'y', model: '2' }], breaker: { allow: p => p !== 'x' }, breakerCfg: cfg });
  assert.deepEqual(chain.map(c => c.provider), ['y']); assert.deepEqual(skipped, ['x']);
  const all = buildChain({ primary: { provider: 'x', model: '1' }, breaker: { allow: () => false }, breakerCfg: cfg });
  assert.deepEqual(all.chain.map(c => c.provider), ['x'], 'hepsi açıksa yine de denenir');
});

test('router: dengeleme istekleri paylaştırır, devre kesici bozuk sağlayıcıyı atlar, senaryo görseli ayrı modele yollar', async () => {
  const A = await fakeUpstream(ok('A')), B = await fakeUpstream(ok('B')), BAD = await fakeUpstream(fail(503)), V = await fakeUpstream(ok('V'));
  const breaker = createBreaker();
  const bcfg = { enabled: true, failures: 2, cooldownSec: 60 };
  const targets = { claude: { ...tgt('main', A, 'm0', { fixedModel: false }), breaker: bcfg,
    balance: { strategy: 'round-robin', members: [tgt('bad', BAD, 'mx'), tgt('a', A, 'ma'), tgt('b', B, 'mb')] },
    scenarios: { image: tgt('vision', V, 'mv') } } };
  const usage = [], logs = [];
  const router = await startRouter({ port: 0, targets, breaker, onUsage: e => usage.push(e), log: (...a) => logs.push(a.join(' ')) });
  const port = router.address().port;
  const ask = async content => (await (await post(port, '/v1/messages', { model: 'claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content }] })).json()).content?.[0]?.text;
  const answers = [];
  for (let i = 0; i < 6; i++) answers.push(await ask('x'));
  assert.ok(answers.includes('A') && answers.includes('B'), answers.join(','));
  assert.equal(BAD.seen.length, 2, 'iki hatadan sonra devre açıldı, bir daha denenmedi');
  assert.ok(logs.some(l => /bad/.test(l)));
  assert.equal(A.seen.every(s => s.body.model === 'ma'), true, 'her üye kendi modelini kullanır');
  assert.equal(await ask([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }, { type: 'text', text: 'ne var?' }]), 'V');
  assert.equal(V.seen[0].body.model, 'mv');
  assert.equal(usage.at(-1).scenario, 'image');
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.breaker.providers.bad.state, 'open');
  assert.deepEqual(health.claude.balance.members, ['bad:mx*1', 'a:ma*1', 'b:mb*1']);
  assert.equal(health.claude.scenarios.image, 'vision:mv');
  router.close(); for (const u of [A, B, BAD, V]) u.s.close();
});

test('ayarlar: balance/scenario/breaker CLI çekirdeği; doğrudan bağlı araç yönlendiriciye alınır', async () => {
  const dir = sandbox();
  const core = await import('../src/core.js');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  core.setKey('deepseek', 'sk-d'); core.setKey('openrouter', 'sk-o');
  const r1 = await core.useProvider({ provider: 'deepseek', model: 'deepseek-chat', tools: ['claude'] });
  assert.equal(r1.results[0].viaRouter, false, 'DeepSeek Claude Code için doğrudan');
  assert.throws(() => core.setBalance('claude', ['deepseek:deepseek-chat']), /en az iki|at least two/);
  assert.throws(() => core.setBalance('claude', ['a:b', 'c:d'], { strategy: 'random' }), /strateji|strategy/i);
  core.setBalance('claude', ['deepseek:deepseek-chat*3', 'openrouter:deepseek/deepseek-chat'], { strategy: 'round-robin' });
  const re = await core.ensureRouted('claude');
  assert.equal(re.results[0].viaRouter, true);
  assert.equal(await core.ensureRouted('claude'), null, 'zaten yönlendiricide');
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.match(settings.env.ANTHROPIC_BASE_URL, /127\.0\.0\.1/);
  core.setScenario('claude', 'think', 'openrouter:anthropic/claude-opus-4.5');
  assert.throws(() => core.setScenario('claude', 'nope', 'openrouter:x'), /senaryo|scenario/i);
  assert.throws(() => core.setLongContextThreshold(10), /eşiği|threshold/);
  core.setLongContextThreshold(90000);
  core.setBreaker({ failures: 5, cooldownSec: 20 });
  assert.throws(() => core.setBreaker({ failures: 0 }), /devre kesici|circuit breaker/i);
  const t = core.routerTargets().claude;
  assert.equal(t.balance.strategy, 'round-robin');
  assert.deepEqual(t.balance.members.map(m => [m.provider, m.weight, m.fixedModel]), [['deepseek', 3, true], ['openrouter', 1, true]]);
  assert.equal(t.scenarios.think.model, 'anthropic/claude-opus-4.5');
  assert.equal(t.longContextThreshold, 90000);
  assert.deepEqual(t.breaker, { enabled: true, failures: 5, cooldownSec: 20 });
  assert.equal(t.apiFor('deepseek-chat'), 'messages', 'doğrudan uyumlu model çevrilmeden iletilir');
  core.setBalance('claude', []); core.setScenario('claude', '*', null); core.setBreaker({ failures: 3, cooldownSec: 30 });
  assert.equal(core.getBalance().claude, null);
  assert.deepEqual(core.getScenarios().tools.claude, {});
  const viaFlag = await core.useProvider({ provider: 'deepseek', model: 'deepseek-chat', tools: ['claude'], viaRouter: true });
  assert.equal(viaFlag.results[0].viaRouter, true, '--via-router');
});

test('serveRequest: 4xx istemci hatası devreyi açmaz', async () => {
  const U = await fakeUpstream(fail(401));
  const breaker = createBreaker();
  const cfg = { enabled: true, failures: 1, cooldownSec: 60 };
  const res = { headersSent: false, writeHead() { this.headersSent = true; return this; }, write() {}, end() {} };
  for (let i = 0; i < 3; i++) await serveRequest('claude', {}, { ...res }, { ...tgt('p', U, 'm'), breaker: cfg, fallbacks: [] }, { messages: [{ role: 'user', content: 'x' }] }, { breaker });
  assert.equal(breaker.allow('p', cfg), true);
  U.s.close();
});
