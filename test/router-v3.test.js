import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream } from './helpers.js';
import { startRouter, anthropicToOpenAI, openAIToAnthropic, createStreamTranslator, anthropicToResponses, responsesToAnthropic, createAnthropicFromResponsesStream, stripLocalThinking, effortFor, LOCAL_SIG } from '../src/router.js';

const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('çeviri: stop_sequences en fazla 4; OpenRouter için thinking → reasoning, diğer Chat sağlayıcılarına eklenmez', () => {
  const req = { messages: [{ role: 'user', content: 'a' }], stop_sequences: ['1', '2', '3', '4', '5'], thinking: { type: 'enabled', budget_tokens: 3000 } };
  assert.deepEqual(anthropicToOpenAI(req, { baseUrl: 'https://api.deepseek.com/v1' }).stop, ['1', '2', '3', '4']);
  assert.equal('reasoning' in anthropicToOpenAI(req, { baseUrl: 'https://api.deepseek.com/v1' }), false);
  assert.deepEqual(anthropicToOpenAI(req, { baseUrl: 'https://openrouter.ai/api/v1' }).reasoning, { max_tokens: 3000 });
  assert.deepEqual(anthropicToResponses(req, {}).reasoning, { effort: 'low', summary: 'auto' });
  assert.equal(effortFor({ type: 'enabled', budget_tokens: 10000 }), 'medium');
  assert.equal(effortFor({ type: 'enabled', budget_tokens: 32000 }), 'high');
  assert.equal(effortFor({ type: 'disabled' }), null);
});

test('düşünce çevirisi: Chat reasoning_content ve Responses reasoning özeti → Anthropic thinking blokları', () => {
  const m = openAIToAnthropic({ choices: [{ message: { reasoning_content: 'plan', content: 'cevap' }, finish_reason: 'stop' }] }, 'x');
  assert.deepEqual(m.content[0], { type: 'thinking', thinking: 'plan', signature: LOCAL_SIG });
  const ev = [];
  const tr = createStreamTranslator('x', s => ev.push(JSON.parse(s.split('\n')[1].slice(6))));
  tr.chunk({ choices: [{ delta: { reasoning: 'dü' } }] });
  tr.chunk({ choices: [{ delta: { reasoning: 'şün' } }] });
  tr.chunk({ choices: [{ delta: { content: 'ok' } }] });
  tr.end();
  assert.deepEqual(ev[1].content_block, { type: 'thinking', thinking: '', signature: '' });
  assert.deepEqual(ev.filter(e => e.delta?.type === 'thinking_delta').map(e => e.delta.thinking), ['dü', 'şün']);
  assert.ok(ev.some(e => e.delta?.type === 'signature_delta'));
  assert.equal(ev.find(e => e.content_block?.type === 'text').index, 1);
  const r = responsesToAnthropic({ output: [{ type: 'reasoning', summary: [{ text: 'özet' }] }, { type: 'message', content: [{ type: 'output_text', text: 'x' }] }] }, 'm');
  assert.equal(r.content[0].type, 'thinking');
  const ev2 = [];
  const tr2 = createAnthropicFromResponsesStream('m', s => ev2.push(JSON.parse(s.split('\n')[1].slice(6))));
  tr2.event({ type: 'response.reasoning_summary_text.delta', item_id: 'r1', delta: 'dü' });
  tr2.event({ type: 'response.output_text.delta', item_id: 'm1', delta: 'x' });
  tr2.event({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } });
  assert.deepEqual(ev2.filter(e => e.type === 'content_block_start').map(e => e.content_block.type), ['thinking', 'text']);
});

test('yerel imzalı thinking blokları Anthropic uç noktasına gönderilmez', () => {
  const b = stripLocalThinking({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'a', signature: LOCAL_SIG }, { type: 'text', text: 't' }] }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'b', signature: 'real' }] }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'c', signature: LOCAL_SIG }] }] });
  assert.equal(b.messages.length, 2);
  assert.deepEqual(b.messages[0].content, [{ type: 'text', text: 't' }]);
  assert.equal(b.messages[1].content[0].signature, 'real');
});

test('yedek zinciri: 429 ve ağ hatasında sıradaki sağlayıcı:model denenir; kullanım kaydı yedeği belirtir', async () => {
  const bad = await fakeUpstream((b, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"slow down"}}'); });
  const good = await fakeUpstream((b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'yedekten' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } })); });
  const usage = [], logs = [];
  const targets = { claude: { provider: 'a', baseUrl: bad.base, key: 'k1', model: 'm1', apiFor: () => 'chat', fallbacks: [
    { provider: 'dead', baseUrl: 'http://127.0.0.1:1/v1', key: '', model: 'm2', apiFor: () => 'chat' },
    { provider: 'b', baseUrl: good.base, key: 'k3', model: 'm3', apiFor: () => 'chat' }
  ] } };
  const router = await startRouter({ port: 0, targets, log: (...a) => logs.push(a.join(' ')), onUsage: e => usage.push(e) });
  const r = await post(router.address().port, '/v1/messages', { model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.content[0].text, 'yedekten');
  assert.equal(good.seen[0].body.model, 'm3');
  assert.equal(good.seen[0].headers.authorization, 'Bearer k3');
  assert.equal(logs.length, 2);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual({ provider: usage[0].provider, model: usage[0].model, fallback: usage[0].fallback, in: usage[0].in, out: usage[0].out }, { provider: 'b', model: 'm3', fallback: 2, in: 3, out: 4 });
  // Tek hedef 429 döndürürse hata olduğu gibi iletilir
  const r2 = await startRouter({ port: 0, targets: { claude: { provider: 'a', baseUrl: bad.base, key: 'k', model: 'm', apiFor: () => 'chat' } }, log: () => {} });
  const x = await post(r2.address().port, '/v1/messages', { messages: [{ role: 'user', content: 'x' }] });
  assert.equal(x.status, 429);
  assert.equal((await x.json()).error.type, 'rate_limit_error');
  router.close(); r2.close(); bad.s.close(); good.s.close();
});

test('yedek zinciri: 400 gibi istemci hatalarında yedeğe geçilmez; Codex yedeği Responses sunuyorsa istek aynen iletilir', async () => {
  const bad = await fakeUpstream((b, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad"}}'); });
  const other = await fakeUpstream((b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"resp_1","output":[]}'); });
  const router = await startRouter({ port: 0, targets: { claude: { provider: 'a', baseUrl: bad.base, model: 'm', apiFor: () => 'chat', fallbacks: [{ provider: 'b', baseUrl: other.base, model: 'z', apiFor: () => 'chat' }] } }, log: () => {} });
  const r = await post(router.address().port, '/v1/messages', { messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 400);
  assert.equal(other.seen.length, 0);
  router.close();
  const down = await fakeUpstream((b, res) => { res.writeHead(503); res.end('down'); });
  const r3 = await startRouter({ port: 0, targets: { codex: { provider: 'a', baseUrl: down.base, model: 'm', codexApi: () => 'chat', fallbacks: [{ provider: 'openai', baseUrl: other.base, model: 'gpt-x', codexApi: () => 'responses' }] } }, log: () => {} });
  const c = await post(r3.address().port, '/v1/responses', { model: 'm', input: 'hi', stream: false });
  assert.equal(c.status, 200);
  assert.equal(other.seen[0].url, '/v1/responses');
  assert.equal(other.seen[0].body.model, 'gpt-x');
  assert.equal(other.seen[0].body.input, 'hi');
  r3.close(); bad.s.close(); other.s.close(); down.s.close();
});

test('Responses: reasoning parametresini reddeden model için bir kez reasoning olmadan yeniden denenir', async () => {
  const up = await fakeUpstream((b, res) => {
    if (b.reasoning) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"reasoning not supported"}}'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'resp_1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }));
  });
  const router = await startRouter({ port: 0, targets: { claude: { provider: 'x', baseUrl: up.base, model: 'gpt-y', apiFor: () => 'responses' } }, log: () => {} });
  const r = await post(router.address().port, '/v1/messages', { thinking: { type: 'enabled', budget_tokens: 20000 }, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200);
  assert.equal(up.seen.length, 2);
  assert.deepEqual(up.seen[0].body.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal('reasoning' in up.seen[1].body, false);
  router.close(); up.s.close();
});

test('health: sağlayıcı, model ve yedek zinciri görünür', async () => {
  const router = await startRouter({ port: 0, targets: { claude: { provider: 'a', baseUrl: 'http://x/v1', model: 'm', apiFor: () => 'chat', fallbacks: [{ provider: 'b', model: 'n' }] } }, log: () => {} });
  const j = await (await fetch(`http://127.0.0.1:${router.address().port}/health`)).json();
  assert.deepEqual(j.claude, { target: 'http://x/v1', provider: 'a', model: 'm', api: 'chat', fallbacks: ['b:n'] });
  assert.equal(j.gemini, null);
  router.close();
});
