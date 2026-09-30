import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dir = sandbox();
const core = await import('../src/core.js');
const { buildClaudeEnv } = await import('../src/targets/claude.js');
const f = path.join(dir, '.claude', 'settings.json');
const read = () => JSON.parse(fs.readFileSync(f, 'utf8'));

test('Claude: OpenRouter → Anthropic geçişinde BASE_URL ve AUTH_TOKEN tamamen temizlenir', async () => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ model: 'opus', env: { FOO: '1' } }));
  core.setKey('openrouter', 'sk-or');
  core.setKey('anthropic', 'sk-ant');
  await core.useProvider({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', tools: ['claude'] });
  assert.equal(read().env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
  await core.useProvider({ provider: 'anthropic', tools: ['claude'] });
  const s = read();
  assert.equal(s.env.ANTHROPIC_API_KEY, 'sk-ant');
  assert.equal(s.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(s.env.ANTHROPIC_MODEL, undefined);
  assert.equal(s.env.FOO, '1');
});

test('Claude: güncel değişkenler yazılır, kullanımdan kalkmış ANTHROPIC_SMALL_FAST_MODEL yazılmaz', () => {
  const env = buildClaudeEnv({ provider: { id: 'x', anthropicBase: 'https://x.example/anthropic' }, key: 'k', model: 'm', fastModel: 'f' });
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'm');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'm');
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'm');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'm');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'f');
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
});

test('Claude: resmî moda dönüş kullanıcının önceki "model" değerini geri koyar', () => {
  core.useOfficial(['claude']);
  const s = read();
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.env, { FOO: '1' });
});

test('Claude: yalnızca --anthropic-base ile eklenen özel sağlayıcı çalışır (Codex/OpenCode istenmezse)', async () => {
  core.addProvider('my-gw', { anthropicBase: 'https://gw.example.com/anthropic' });
  core.setKey('my-gw', 'gw-key');
  await core.useProvider({ provider: 'my-gw', model: 'claude-x', tools: ['claude'] });
  const s = read();
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'https://gw.example.com/anthropic');
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'gw-key');
  // Varsayılan (üç araç) ile istenirse hiçbir dosyaya dokunmadan anlaşılır hata verir.
  const before = fs.readFileSync(f, 'utf8');
  await assert.rejects(core.useProvider({ provider: 'my-gw', model: 'claude-y' }), /OpenAI uyumlu/);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
});

test('Claude: özel adresli "anthropic" profili BASE_URL + AUTH_TOKEN kullanır', () => {
  const env = buildClaudeEnv({ provider: { id: 'anthropic', anthropicBase: 'https://proxy.example.com' }, key: 'k' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://proxy.example.com');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'k');
});

test('Claude: bozuk settings.json asla üzerine yazılmaz', async () => {
  fs.writeFileSync(f, '{ "theme": "dark", // yorum\n');
  await assert.rejects(core.useProvider({ provider: 'openrouter', model: 'x', tools: ['claude'] }), /geçerli bir JSON değil/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{ "theme": "dark", // yorum\n');
});

test('Claude: Zen/Go üzerindeki yalnız-/responses modelleri yönlendirici üzerinden bağlanır (Responses çevirisi)', async () => {
  fs.writeFileSync(f, '{}');
  core.setKey('opencode-zen', 'z');
  core.setKey('opencode-go', 'g');
  const r1 = await core.useProvider({ provider: 'opencode-go', model: 'gpt-6-luna', tools: ['claude'] });
  assert.equal(r1.results[0].viaRouter, true);
  assert.equal(read().env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456');
  assert.equal(read().env.ANTHROPIC_MODEL, 'gpt-6-luna');
  const t1 = core.routerTargets().claude;
  assert.equal(t1.baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(t1.apiFor('gpt-6-luna'), 'responses');
  assert.equal(t1.apiFor('grok-5'), 'responses');
  assert.equal(t1.apiFor('kimi-k3'), 'chat');
  assert.equal(t1.apiFor('minimax-m3'), 'messages');
  const r2 = await core.useProvider({ provider: 'opencode-zen', model: 'gpt-5.5', tools: ['claude'] });
  assert.equal(r2.results[0].viaRouter, true);
  assert.equal(core.routerTargets().claude.apiFor('gpt-5.5'), 'responses');
  const r3 = await core.useProvider({ provider: 'opencode-zen', model: 'kimi-k3', tools: ['claude'] });
  assert.equal(r3.results[0].viaRouter, true);
  assert.equal(core.routerTargets().claude.apiFor('kimi-k3'), 'chat');
  // Google-native Gemini hâlâ desteklenmez
  await assert.rejects(core.useProvider({ provider: 'opencode-zen', model: 'gemini-3-pro', tools: ['claude'] }), /Claude Code bu uç noktayı kullanamaz|Claude Code ile kullanılamaz/);
});

test('Claude: ana model /messages, hızlı model /responses ise ikisi de yönlendiriciden geçer', async () => {
  fs.writeFileSync(f, '{}');
  const r = await core.useProvider({ provider: 'opencode-zen', model: 'claude-opus-5', fastModel: 'gpt-5.5-mini', tools: ['claude'] });
  assert.equal(r.results[0].viaRouter, true);
  const t = core.routerTargets().claude;
  assert.equal(t.apiFor('claude-opus-5'), 'messages');
  assert.equal(t.apiFor('gpt-5.5-mini'), 'responses');
  assert.equal(t.anthropicBase, 'https://opencode.ai/zen');
  // ikisi de /messages ise doğrudan bağlanır
  const r2 = await core.useProvider({ provider: 'opencode-zen', model: 'claude-opus-5', fastModel: 'claude-haiku-5', tools: ['claude'] });
  assert.equal(r2.results[0].viaRouter, false);
  assert.equal(read().env.ANTHROPIC_BASE_URL, 'https://opencode.ai/zen');
});

test('Claude: OpenAI (Anthropic uç noktası yok, Responses var) Claude Code için Responses ile yönlendirilir', async () => {
  fs.writeFileSync(f, '{}');
  core.setKey('openai', 'o');
  core.setKey('deepseek', 'd');
  await core.useProvider({ provider: 'openai', model: 'gpt-6', tools: ['claude'] });
  assert.equal(core.routerTargets().claude.apiFor('gpt-6'), 'responses');
  core.setKey('gemini', 'g');
  await core.useProvider({ provider: 'gemini', model: 'gemini-3-pro', tools: ['claude'] });
  assert.equal(core.routerTargets().claude.apiFor('gemini-3-pro'), 'chat');
});

test('Claude: yönlendirici modu model olmadan reddedilir', async () => {
  core.setKey('gemini', 'g');
  await assert.rejects(core.useProvider({ provider: 'gemini', tools: ['claude'] }), /--model/);
});
