import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { anthropicToOpenAI, openAIToAnthropic, createStreamTranslator, startRouter } from '../src/router.js';

test('Anthropic isteği OpenAI biçimine çevrilir (araçlar dahil)', () => {
  const o = anthropicToOpenAI({
    model: 'claude-x', max_tokens: 100, system: [{ type: 'text', text: 'sys' }],
    tools: [{ name: 'Read', description: 'oku', input_schema: { type: 'object' } }], tool_choice: { type: 'any' },
    messages: [
      { role: 'user', content: 'selam' },
      { role: 'assistant', content: [{ type: 'text', text: 'bakıyorum' }, { type: 'tool_use', id: 't1', name: 'Read', input: { p: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'içerik' }] }
    ]
  }, { model: 'gpt-5' });
  assert.equal(o.model, 'gpt-5');
  assert.deepEqual(o.messages[0], { role: 'system', content: 'sys' });
  assert.equal(o.messages[2].tool_calls[0].function.arguments, '{"p":1}');
  assert.deepEqual(o.messages[3], { role: 'tool', tool_call_id: 't1', content: 'içerik' });
  assert.equal(o.tools[0].function.name, 'Read');
  assert.equal(o.tool_choice, 'required');
});

test('OpenAI yanıtı Anthropic biçimine çevrilir', () => {
  const a = openAIToAnthropic({ id: '1', choices: [{ finish_reason: 'tool_calls', message: { content: 'ok', tool_calls: [{ id: 'c', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }, 'm');
  assert.equal(a.stop_reason, 'tool_use');
  assert.deepEqual(a.content[1], { type: 'tool_use', id: 'c', name: 'Bash', input: { cmd: 'ls' } });
  assert.equal(a.usage.input_tokens, 5);
});

test('akış çevirisi doğru olay sırasını üretir', () => {
  const ev = [];
  const tr = createStreamTranslator('m', s => ev.push(s.split('\n')[0].slice(7)));
  tr.chunk({ choices: [{ delta: { content: 'Mer' } }] });
  tr.chunk({ choices: [{ delta: { content: 'haba' } }] });
  tr.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"a"' } }] } }] });
  tr.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] });
  tr.end();
  assert.deepEqual(ev, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
});

test('yönlendirici uçtan uca: sahte OpenAI sunucusuna akışlı istek', async () => {
  const upstream = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const body = JSON.parse(b);
      assert.equal(body.model, 'hedef-model');
      assert.equal(req.headers.authorization, 'Bearer k');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Selam"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const router = await startRouter({ port: 0, target: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, key: 'k', model: 'hedef-model' }, log: () => {} });
  const r = await fetch(`http://127.0.0.1:${router.address().port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const text = await r.text();
  assert.match(text, /"text":"Selam"/);
  assert.match(text, /"stop_reason":"end_turn"/);
  router.close(); upstream.close();
});

import { responsesToChat, chatToResponse, createResponsesStreamTranslator, estimateTokens } from '../src/router.js';

function fakeUpstream(handler) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { const body = b ? JSON.parse(b) : {}; seen.push({ url: req.url, body, headers: req.headers }); handler(body, res); });
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ s, seen, base: `http://127.0.0.1:${s.address().port}/v1` })));
}

test('çeviri: thinking blokları atlanır, boş asistan içeriği "" olur, max_tokens yoksa gönderilmez', () => {
  const o = anthropicToOpenAI({ messages: [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'gizli', signature: 's' }] },
    { role: 'user', content: 'b' }
  ] }, { model: 'm' });
  assert.deepEqual(o.messages[1], { role: 'assistant', content: '' });
  assert.ok(!('max_tokens' in o) && !('max_completion_tokens' in o));
  const oa = anthropicToOpenAI({ max_tokens: 50, messages: [{ role: 'user', content: 'x' }] }, { model: 'gpt-5', baseUrl: 'https://api.openai.com/v1' });
  assert.equal(oa.max_completion_tokens, 50);
  assert.ok(!('max_tokens' in oa));
});

test('çeviri: tool_result içindeki görsel ayrı kullanıcı mesajıyla iletilir', () => {
  const o = anthropicToOpenAI({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ekran' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }] }
  ] }, { model: 'm' });
  assert.equal(o.messages[1].role, 'tool');
  assert.match(o.messages[1].content, /^ekran/);
  assert.equal(o.messages[2].role, 'user');
  assert.equal(o.messages[2].content[1].image_url.url, 'data:image/png;base64,AAA');
});

test('çeviri: içerik null ve araç çağrısı yoksa yanıt boş metin bloğu içerir', () => {
  const a = openAIToAnthropic({ choices: [{ finish_reason: 'stop', message: { content: null } }] }, 'm');
  assert.deepEqual(a.content, [{ type: 'text', text: '' }]);
});

test('count_tokens yalnızca metinleri sayar (JSON sözdizimini değil)', () => {
  const n = estimateTokens({ system: 'x'.repeat(40), messages: [{ role: 'user', content: 'y'.repeat(40) }] });
  assert.equal(n, 20);
});

test('akış içinde gelen hata nesnesi Anthropic "error" olayına çevrilir', () => {
  const ev = [];
  const tr = createStreamTranslator('m', s => ev.push(s));
  tr.chunk({ choices: [{ delta: { content: 'a' } }] });
  tr.chunk({ error: { message: 'kota doldu', code: 429 } });
  tr.end();
  const names = ev.map(s => s.split('\n')[0].slice(7));
  assert.deepEqual(names, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'error']);
  assert.match(ev.at(-1), /rate_limit_error/);
});

test('yönlendirici: akışsız istekte sağlayıcı hatası Anthropic hata biçiminde döner', async () => {
  const up = await fakeUpstream((b, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad key"}}'); });
  const router = await startRouter({ port: 0, target: { baseUrl: up.base, key: 'k', model: 'x' }, log: () => {} });
  const r = await fetch(`http://127.0.0.1:${router.address().port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { type: 'error', error: { type: 'authentication_error', message: 'bad key' } });
  router.close(); up.s.close();
});

test('yönlendirici: akış istendiğinde düz JSON dönen sağlayıcı da doğru SSE üretir', async () => {
  const up = await fakeUpstream((b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'tamam' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); });
  const router = await startRouter({ port: 0, target: { baseUrl: up.base, key: '', model: 'x' }, log: () => {} });
  const r = await fetch(`http://127.0.0.1:${router.address().port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-x', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const t = await r.text();
  assert.match(t, /"text":"tamam"/);
  assert.match(t, /event: message_stop/);
  router.close(); up.s.close();
});

test('yönlendirici: tarayıcıdan (Origin başlıklı) gelen istekler reddedilir', async () => {
  const router = await startRouter({ port: 0, target: { baseUrl: 'http://127.0.0.1:9/v1', model: 'x' }, log: () => {} });
  const r = await fetch(`http://127.0.0.1:${router.address().port}/v1/messages`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 403);
  router.close();
});

test('Responses → Chat: talimatlar, geçmiş, araç çağrıları ve serbest biçimli araçlar', () => {
  const { body, kinds } = responsesToChat({
    model: 'gpt-x', instructions: 'sys', stream: true, max_output_tokens: 99,
    tools: [
      { type: 'function', name: 'shell', description: 'd', parameters: { type: 'object', properties: { command: { type: 'array' } } } },
      { type: 'custom', name: 'apply_patch', description: 'yama', format: { type: 'grammar', syntax: 'lark', definition: 'start: x' } },
      { type: 'web_search' }
    ],
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'merhaba' }] },
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'bakıyorum' }] },
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":["ls"]}' },
      { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'function_call_output', call_id: 'c1', output: 'a.txt' },
      { type: 'custom_tool_call_output', call_id: 'c2', output: 'ok' }
    ]
  }, { model: 'deepseek-chat' });
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.max_tokens, 99);
  assert.deepEqual(body.messages[0], { role: 'system', content: 'sys' });
  assert.deepEqual(body.messages[1], { role: 'system', content: 'dev' });
  assert.deepEqual(body.messages[2], { role: 'user', content: 'merhaba' });
  assert.equal(body.messages[3].role, 'assistant');
  assert.equal(body.messages[3].content, 'bakıyorum');
  assert.equal(body.messages[3].tool_calls.length, 2);
  assert.equal(body.messages[3].tool_calls[1].function.arguments, '{"input":"*** Begin Patch"}');
  assert.deepEqual(body.messages[4], { role: 'tool', tool_call_id: 'c1', content: 'a.txt' });
  assert.equal(body.tools.length, 2); // web_search atlanır
  assert.equal(kinds.get('apply_patch'), 'custom');
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('Chat → Responses (akışsız): metin ve serbest biçimli araç çağrısı', () => {
  const r = chatToResponse({ id: 'x', choices: [{ finish_reason: 'tool_calls', message: { content: 'tamam', tool_calls: [{ id: 'c9', function: { name: 'apply_patch', arguments: '{"input":"PATCH"}' } }] } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }, 'm', new Map([['apply_patch', 'custom']]));
  assert.equal(r.output[0].content[0].text, 'tamam');
  assert.deepEqual({ type: r.output[1].type, call_id: r.output[1].call_id, input: r.output[1].input }, { type: 'custom_tool_call', call_id: 'c9', input: 'PATCH' });
  assert.equal(r.usage.total_tokens, 5);
});

test('Chat SSE → Responses SSE: olay sırası ve response.completed', () => {
  const ev = [];
  const tr = createResponsesStreamTranslator('m', s => ev.push(JSON.parse(s.split('\n')[1].slice(6))));
  tr.chunk({ choices: [{ delta: { content: 'Mer' } }] });
  tr.chunk({ choices: [{ delta: { content: 'haba' } }] });
  tr.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'shell', arguments: '{"command":' } }] } }] });
  tr.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '["ls"]}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 3 } });
  tr.end();
  const types = ev.map(e => e.type);
  assert.deepEqual(types, ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added',
    'response.output_text.delta', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
    'response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.delta', 'response.output_item.done', 'response.completed']);
  const done = ev.at(-1).response;
  assert.equal(done.output[0].content[0].text, 'Merhaba');
  assert.deepEqual(done.output[1], { type: 'function_call', id: done.output[1].id, call_id: 'c1', name: 'shell', arguments: '{"command":["ls"]}', status: 'completed' });
  assert.equal(done.usage.input_tokens, 4);
  assert.ok(ev.every((e, i) => e.sequence_number === i));
});

test('yönlendirici uçtan uca: Codex /v1/responses isteği Chat Completions sağlayıcısına çevrilir', async () => {
  const up = await fakeUpstream((b, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Selam"}}]}\n\n');
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}'); // son satırda \n yok
  });
  const router = await startRouter({ port: 0, targets: () => ({ codex: { baseUrl: up.base, key: 'dk', model: 'deepseek-chat' } }), log: () => {} });
  const r = await fetch(`http://127.0.0.1:${router.address().port}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-chat', stream: true, instructions: 'i', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }) });
  const t = await r.text();
  assert.equal(up.seen[0].url, '/v1/chat/completions');
  assert.equal(up.seen[0].headers.authorization, 'Bearer dk');
  assert.match(t, /"delta":"Selam"/);
  assert.match(t, /event: response.completed/);
  assert.match(t, /"output_tokens":1/); // sondaki yeni satırsız parça da işlendi
  // Claude uç noktası yapılandırılmamışsa anlaşılır hata
  const c = await fetch(`http://127.0.0.1:${router.address().port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(c.status, 503);
  router.close(); up.s.close();
});
