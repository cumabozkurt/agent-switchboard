import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  anthropicToResponses, responsesToAnthropic, createAnthropicFromResponsesStream, emitAnthropicMessage, startRouter
} from '../src/router.js';

const parseSse = text => text.split('\n\n').filter(Boolean).map(b => {
  const ev = b.split('\n').find(l => l.startsWith('event:'))?.slice(7);
  const data = JSON.parse(b.split('\n').find(l => l.startsWith('data:')).slice(5));
  return { ev, data };
});

test('Anthropic → Responses: system, mesajlar, araç çağrısı/çıktısı, görseller, araçlar ve seçenekler', () => {
  const o = anthropicToResponses({
    model: 'claude-sonnet-4-5', max_tokens: 321, temperature: 0.2, stream: true, stop_sequences: ['X'],
    system: [{ type: 'text', text: 'sen yardımcısın' }],
    tools: [{ name: 'Read', description: 'oku', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }, { type: 'web_search_20250305', name: 'web_search' }],
    tool_choice: { type: 'tool', name: 'Read', disable_parallel_tool_use: true },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'şuna bak' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: 'okuyorum' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { p: 'a' } }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'dosya' }, { type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] },
        { type: 'text', text: 'devam' }
      ] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: 'yok' }] }
    ]
  }, { model: 'gpt-6-luna' });
  assert.equal(o.model, 'gpt-6-luna');
  assert.equal(o.instructions, 'sen yardımcısın');
  assert.equal(o.max_output_tokens, 321);
  assert.equal(o.temperature, 0.2);
  assert.equal(o.stream, true);
  assert.equal(o.store, false);
  assert.equal('stop' in o, false);
  assert.deepEqual(o.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'şuna bak' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'auto' }] });
  assert.deepEqual(o.input[1], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'okuyorum' }] });
  assert.deepEqual(o.input[2], { type: 'function_call', call_id: 'toolu_1', name: 'Read', arguments: '{"p":"a"}' });
  assert.equal(o.input[3].type, 'function_call_output');
  assert.equal(o.input[3].call_id, 'toolu_1');
  assert.match(o.input[3].output, /^dosya\n\[image output/);
  assert.equal(o.input[4].role, 'user');
  assert.deepEqual(o.input[4].content[1], { type: 'input_image', image_url: 'https://x/y.png', detail: 'auto' });
  assert.deepEqual(o.input[4].content.at(-1), { type: 'input_text', text: 'devam' });
  assert.deepEqual(o.input[5], { type: 'function_call', call_id: 'toolu_2', name: 'Read', arguments: '{}' });
  assert.deepEqual(o.input[6], { type: 'function_call_output', call_id: 'toolu_2', output: '[ERROR] yok' });
  assert.equal(o.input.length, 7);
  assert.deepEqual(o.tools, [{ type: 'function', name: 'Read', description: 'oku', parameters: { type: 'object', properties: { p: { type: 'string' } } }, strict: false }]);
  assert.deepEqual(o.tool_choice, { type: 'function', name: 'Read' });
  assert.equal(o.parallel_tool_calls, false);
});

test('Anthropic → Responses: dize içerik, tool_choice any/none/auto, max_tokens yoksa alan eklenmez', () => {
  const base = { messages: [{ role: 'user', content: 'selam' }], tools: [{ name: 'A', input_schema: { type: 'object' } }] };
  const o = anthropicToResponses({ ...base, tool_choice: { type: 'any' } });
  assert.deepEqual(o.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'selam' }] }]);
  assert.equal(o.tool_choice, 'required');
  assert.equal('max_output_tokens' in o, false);
  assert.equal('instructions' in o, false);
  assert.equal(anthropicToResponses({ ...base, tool_choice: { type: 'none' } }).tool_choice, 'none');
  assert.equal(anthropicToResponses({ ...base, tool_choice: { type: 'auto' } }).tool_choice, 'auto');
  assert.equal('tool_choice' in anthropicToResponses(base), false);
});

test('Responses → Anthropic (akışsız): metin, araç çağrısı, reasoning atlanır, kullanım ve durma nedeni', () => {
  const a = responsesToAnthropic({
    id: 'resp_abc', status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Bakalım' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'Bash', arguments: '{"cmd":"ls"}' }
    ],
    usage: { input_tokens: 11, output_tokens: 7 }
  }, 'gpt-6-luna');
  assert.equal(a.id, 'msg_abc');
  assert.deepEqual(a.content, [{ type: 'text', text: 'Bakalım' }, { type: 'tool_use', id: 'call_9', name: 'Bash', input: { cmd: 'ls' } }]);
  assert.equal(a.stop_reason, 'tool_use');
  assert.deepEqual(a.usage, { input_tokens: 11, output_tokens: 7 });
  const inc = responsesToAnthropic({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, 'm');
  assert.equal(inc.stop_reason, 'max_tokens');
  assert.deepEqual(inc.content, [{ type: 'text', text: '' }]);
  assert.equal(responsesToAnthropic({ status: 'completed', output: [{ type: 'function_call', call_id: 'c', name: 'X', arguments: 'bozuk' }] }, 'm').content[0].input._raw, 'bozuk');
  assert.throws(() => responsesToAnthropic({ status: 'failed', error: { message: 'kota' } }, 'm'), /kota/);
});

test('Responses akışı → Anthropic SSE: metin + araç çağrısı, olay sırası ve içerik', () => {
  const out = [];
  const tr = createAnthropicFromResponsesStream('gpt-6-luna', s => out.push(s));
  const evs = [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'Mer' },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'haba' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Merhaba' }] } },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Bash', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '{"cmd"' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: ':"ls"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 2, arguments: '{"cmd":"ls"}' },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' } },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 20, output_tokens: 9 } } }
  ];
  for (const e of evs) tr.event(e);
  tr.end();
  const p = parseSse(out.join(''));
  assert.deepEqual(p.map(x => x.ev), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.deepEqual(p[1].data.content_block, { type: 'text', text: '' });
  assert.equal(p[2].data.delta.text + p[3].data.delta.text, 'Merhaba');
  assert.deepEqual(p[5].data.content_block, { type: 'tool_use', id: 'call_1', name: 'Bash', input: {} });
  assert.equal(p[5].data.index, 1);
  assert.equal(p[6].data.delta.partial_json + p[7].data.delta.partial_json, '{"cmd":"ls"}');
  assert.equal(p[9].data.delta.stop_reason, 'tool_use');
  assert.deepEqual(p[9].data.usage, { input_tokens: 20, output_tokens: 9 });
});

test('Responses akışı: argümanlar yalnızca .done ile gelirse tek parça gönderilir; delta olmadan biten metin de iletilir', () => {
  const out = [];
  const tr = createAnthropicFromResponsesStream('m', s => out.push(s));
  tr.event({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'tam metin' }] } });
  tr.event({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'X' } });
  tr.event({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'X', arguments: '{"a":1}' } });
  tr.event({ type: 'response.completed', response: { status: 'completed' } });
  const p = parseSse(out.join(''));
  assert.equal(p.find(x => x.data.delta?.type === 'text_delta').data.delta.text, 'tam metin');
  assert.equal(p.filter(x => x.data.delta?.type === 'input_json_delta').map(x => x.data.delta.partial_json).join(''), '{"a":1}');
  assert.equal(p.filter(x => x.ev === 'content_block_stop').length, 2);
});

test('Responses akışı: incomplete → max_tokens, failed ve error olayları → Anthropic error olayı', () => {
  let out = [];
  let tr = createAnthropicFromResponsesStream('m', s => out.push(s));
  tr.event({ type: 'response.output_text.delta', item_id: 'a', delta: 'yarım' });
  tr.event({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 2 } } });
  tr.end();
  let p = parseSse(out.join(''));
  assert.equal(p.find(x => x.ev === 'message_delta').data.delta.stop_reason, 'max_tokens');
  assert.equal(p.filter(x => x.ev === 'message_stop').length, 1);

  out = [];
  tr = createAnthropicFromResponsesStream('m', s => out.push(s));
  tr.event({ type: 'response.created', response: {} });
  tr.event({ type: 'response.output_text.delta', item_id: 'a', delta: 'x' });
  tr.event({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'çöktü' } } });
  tr.end();
  p = parseSse(out.join(''));
  assert.equal(p.at(-1).ev, 'error');
  assert.equal(p.at(-1).data.error.message, 'çöktü');
  assert.equal(p.at(-2).ev, 'content_block_stop');
  assert.equal(p.some(x => x.ev === 'message_stop'), false);

  out = [];
  tr = createAnthropicFromResponsesStream('m', s => out.push(s));
  tr.event({ type: 'error', code: 429, message: 'yavaş' });
  p = parseSse(out.join(''));
  assert.deepEqual(p[0].data, { type: 'error', error: { type: 'rate_limit_error', message: 'yavaş' } });
});

test('emitAnthropicMessage tam mesajı geçerli SSE dizisine çevirir', () => {
  const out = [];
  emitAnthropicMessage({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't', name: 'X', input: { q: 1 } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 4 } }, s => out.push(s));
  const p = parseSse(out.join(''));
  assert.deepEqual(p.map(x => x.ev), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.deepEqual(p[0].data.message.content, []);
  assert.equal(p[5].data.delta.partial_json, '{"q":1}');
});

// ------------------------------------------------------------------ uçtan uca (sahte Responses sunucusu)

function fakeUpstream(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const body = b ? JSON.parse(b) : {};
      seen.push({ url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};

async function withRouter(up, targetExtra, fn) {
  const target = { baseUrl: `${up.base}/v1`, anthropicBase: up.base, key: 'k', model: 'gpt-6-luna', fastModel: 'mini-chat', apiFor: m => (/^gpt-/.test(m) ? 'responses' : /^claude-/.test(m) ? 'messages' : 'chat'), ...targetExtra };
  const router = await startRouter({ port: 0, targets: () => ({ claude: target }), log: () => {} });
  try { return await fn(`http://127.0.0.1:${router.address().port}`); } finally { router.close(); up.server.close(); }
}

const post = (url, body, headers = {}) => fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('uçtan uca: Claude isteği /responses modeline akışlı olarak çevrilir (metin + araç çağrısı)', async () => {
  const up = await fakeUpstream((req, res, body) => sse(res, [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'Dosyalara ' },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'bakıyorum' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Bash' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"command":"ls"}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' } },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 30, output_tokens: 12 } } }
  ]));
  await withRouter(up, {}, async url => {
    const r = await post(url, { model: 'claude-sonnet-4-5', max_tokens: 50, stream: true, system: 'sys', tools: [{ name: 'Bash', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'ls çalıştır' }] });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const p = parseSse(await r.text());
    assert.equal(up.seen[0].url, '/v1/responses');
    assert.equal(up.seen[0].headers.authorization, 'Bearer k');
    assert.equal(up.seen[0].body.model, 'gpt-6-luna');
    assert.equal(up.seen[0].body.instructions, 'sys');
    assert.equal(up.seen[0].body.max_output_tokens, 50);
    assert.equal(up.seen[0].body.tools[0].name, 'Bash');
    assert.equal(p.filter(x => x.data.delta?.type === 'text_delta').map(x => x.data.delta.text).join(''), 'Dosyalara bakıyorum');
    const tool = p.find(x => x.data.content_block?.type === 'tool_use');
    assert.equal(tool.data.content_block.id, 'call_1');
    assert.equal(p.filter(x => x.data.delta?.type === 'input_json_delta').map(x => x.data.delta.partial_json).join(''), '{"command":"ls"}');
    const md = p.find(x => x.ev === 'message_delta');
    assert.equal(md.data.delta.stop_reason, 'tool_use');
    assert.equal(md.data.usage.output_tokens, 12);
    assert.equal(p.at(-1).ev, 'message_stop');
  });
});

test('uçtan uca: akışsız /responses isteği ve araç sonucu geri gönderimi', async () => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_2', status: 'completed', output: [{ type: 'reasoning', id: 'r' }, { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'Bitti' }] }], usage: { input_tokens: 5, output_tokens: 1 } }));
  });
  await withRouter(up, {}, async url => {
    const r = await post(url, { model: 'claude-opus-4', max_tokens: 20, messages: [
      { role: 'user', content: 'ls' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.txt' }] }
    ] });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.deepEqual(j.content, [{ type: 'text', text: 'Bitti' }]);
    assert.equal(j.stop_reason, 'end_turn');
    assert.equal(j.usage.input_tokens, 5);
    const input = up.seen[0].body.input;
    assert.deepEqual(input[1], { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' });
    assert.deepEqual(input[2], { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' });
    assert.equal(up.seen[0].body.stream, false);
  });
});

test('uçtan uca: akış istendi ama sağlayıcı JSON döndürdü → SSE üretilir', async () => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'function_call', call_id: 'c7', name: 'Read', arguments: '{"p":"x"}' }] }));
  });
  await withRouter(up, {}, async url => {
    const p = parseSse(await (await post(url, { model: 'gpt-6-luna', stream: true, max_tokens: 5, messages: [{ role: 'user', content: 'x' }] })).text());
    assert.equal(p.find(x => x.data.content_block?.type === 'tool_use').data.content_block.id, 'c7');
    assert.equal(p.find(x => x.ev === 'message_delta').data.delta.stop_reason, 'tool_use');
  });
});

test('uçtan uca: /responses hataları Anthropic hata biçiminde döner (HTTP hatası ve akış ortasında response.failed)', async () => {
  let n = 0;
  const up = await fakeUpstream((req, res) => {
    if (n++ === 0) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Çok fazla istek' } })); }
    sse(res, [
      { type: 'response.created', response: {} },
      { type: 'response.output_text.delta', item_id: 'm', delta: 'ya' },
      { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'model çöktü' } } }
    ]);
  });
  await withRouter(up, {}, async url => {
    const r1 = await post(url, { model: 'gpt-6-luna', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r1.status, 429);
    assert.deepEqual(await r1.json(), { type: 'error', error: { type: 'rate_limit_error', message: 'Çok fazla istek' } });
    const p = parseSse(await (await post(url, { model: 'gpt-6-luna', stream: true, max_tokens: 5, messages: [{ role: 'user', content: 'x' }] })).text());
    assert.equal(p.at(-1).ev, 'error');
    assert.equal(p.at(-1).data.error.message, 'model çöktü');
  });
});

test('uçtan uca: aynı hedefte hızlı model /chat/completions, claude-* modeli /v1/messages olarak iletilir', async () => {
  const up = await fakeUpstream((req, res, body) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'chat:' + body.model } }] }));
    }
    if (req.url === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'geçti:' + req.headers['x-api-key'] + ':' + req.headers['anthropic-beta'] }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    res.writeHead(404); res.end();
  });
  await withRouter(up, { model: 'claude-opus-5', fastModel: 'mini-chat' }, async url => {
    const fast = await (await post(url, { model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] })).json();
    assert.equal(fast.content[0].text, 'chat:mini-chat');
    const main = await (await post(url, { model: 'claude-sonnet-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }, { 'anthropic-beta': 'b1' })).json();
    assert.equal(main.content[0].text, 'geçti:k:b1');
    assert.equal(up.seen.at(-1).body.model, 'claude-opus-5');
  });
});
