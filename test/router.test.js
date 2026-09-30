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
