import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeUpstream } from './helpers.js';

const dir = sandbox();
const core = await import('../src/core.js');
const { geminiToAnthropic, anthropicToGemini, createGeminiStreamFromAnthropic, toJsonSchema } = await import('../src/gemini-wire.js');
const { startRouter } = await import('../src/router.js');
const { stripEnvBlock, parseEnv } = await import('../src/targets/gemini.js');
const gdir = path.join(dir, '.gemini');
const read = f => fs.readFileSync(path.join(gdir, f), 'utf8');

test('gemini: Gemini CLI yoksa varsayılan araçlara eklenmez, ~/.gemini varsa eklenir', () => {
  assert.deepEqual(core.defaultTools(), ['claude', 'codex', 'opencode']);
  fs.mkdirSync(gdir, { recursive: true });
  assert.deepEqual(core.defaultTools(), ['claude', 'codex', 'opencode', 'gemini']);
});

test('gemini: Google Gemini doğrudan (.env + settings.json), kullanıcı satırları korunur, resmî girişe dönüş', async () => {
  fs.writeFileSync(path.join(gdir, 'settings.json'), JSON.stringify({ model: { name: 'gemini-2.5-pro' }, security: { auth: { selectedType: 'oauth-personal' } }, ui: { theme: 'x' } }));
  fs.writeFileSync(path.join(gdir, '.env'), 'MY_VAR=1\n');
  core.setKey('gemini', 'AIza-test-key-123456');
  const r = await core.useProvider({ provider: 'gemini', model: 'gemini-3-pro', tools: ['gemini'] });
  assert.equal(r.results[0].viaRouter, false);
  const s = JSON.parse(read('settings.json'));
  assert.equal(s.model.name, 'gemini-3-pro');
  assert.equal(s.security.auth.selectedType, 'gemini-api-key');
  assert.equal(s.ui.theme, 'x');
  const env = parseEnv(read('.env'));
  assert.equal(env.MY_VAR, '1');
  assert.equal(env.GEMINI_API_KEY, 'AIza-test-key-123456');
  assert.equal(env.GEMINI_MODEL, 'gemini-3-pro');
  assert.equal('GOOGLE_GEMINI_BASE_URL' in env, false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(gdir, '.env')).mode & 0o777, 0o600);
  assert.equal(core.status().gemini.mode, 'apikey');
  // aswitch run gemini: değişkenler doğrudan verilir
  assert.equal(core.toolEnv({ tools: ['gemini'], geminiRun: true }).GEMINI_API_KEY, 'AIza-test-key-123456');
  assert.deepEqual(core.toolEnv({ tools: ['gemini'] }), {});

  core.useOfficial(['gemini']);
  const s2 = JSON.parse(read('settings.json'));
  assert.equal(s2.model.name, 'gemini-2.5-pro');
  assert.equal(s2.security.auth.selectedType, 'oauth-personal');
  assert.equal(read('.env'), 'MY_VAR=1\n');
  assert.equal(core.status().gemini.mode, 'official');
});

test('gemini: yalnız Chat/Anthropic sunan sağlayıcılar yerel yönlendirici üzerinden; restore iki dosyayı da geri getirir', async () => {
  core.setKey('deepseek', 'sk-deepseek-123456');
  const r = await core.useProvider({ provider: 'deepseek', model: 'deepseek-chat', tools: ['gemini'] });
  assert.equal(r.results[0].viaRouter, true);
  const env = parseEnv(read('.env'));
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:3456');
  assert.equal(env.GEMINI_API_KEY, 'aswitch-local');
  assert.equal(core.status().gemini.mode, 'router');
  const tg = core.routerTargets();
  assert.equal(tg.gemini.provider, 'deepseek');
  assert.equal(tg.gemini.apiFor('deepseek-chat'), 'messages');
  assert.ok(core.routerNeeded());
  await assert.rejects(core.useProvider({ provider: 'deepseek', tools: ['gemini'] }), /model/);
  const out = core.restore(['gemini']);
  assert.equal(out[0].restored, true);
  assert.equal(read('.env'), 'MY_VAR=1\n');
  assert.equal(JSON.parse(read('settings.json')).security.auth.selectedType, 'oauth-personal');
  assert.equal(core.routerNeeded(), false);
});

test('gemini: .env yedekleri tanınır ve geri yüklenebilir', async () => {
  await core.useProvider({ provider: 'gemini', model: 'gemini-3-flash', tools: ['gemini'] });
  const b = core.listBackups().find(x => x.files.includes('gemini-env.env'));
  assert.ok(b, 'gemini-env.env yedeği');
  const r = core.restoreBackup(b.id, 'gemini-env.env');
  assert.equal(r.tool, 'gemini');
  assert.equal(r.file, path.join(gdir, '.env'));
});

test('gemini: yönetilen blok temizleme ve .env ayrıştırma', () => {
  assert.equal(stripEnvBlock('A=1\n\n# >>> agent-switchboard >>>\nGEMINI_API_KEY=x\n# <<< agent-switchboard <<<\n'), 'A=1');
  assert.deepEqual(parseEnv('export A="x y"\nB=\'z\'\n# yorum\nC=3'), { A: 'x y', B: 'z', C: '3' });
});

test('Gemini → Anthropic: sistem, çok turlu araç çağrıları (id yoksa ada göre eşleşir), görsel, araç şemaları, seçenekler', () => {
  const a = geminiToAnthropic({
    systemInstruction: { parts: [{ text: 'sys' }] },
    contents: [
      { role: 'user', parts: [{ text: 'bak' }, { inlineData: { mimeType: 'image/png', data: 'AAA' } }] },
      { role: 'model', parts: [{ text: 'düşünce', thought: true }, { text: 'okuyorum' }, { functionCall: { name: 'read_file', args: { path: 'a' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'içerik' } } }] },
      { role: 'user', parts: [{ text: 'devam' }] }
    ],
    tools: [{ functionDeclarations: [{ name: 'read_file', description: 'oku', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING', nullable: true } }, required: ['path'] } }, { name: 'ls', parametersJsonSchema: { type: 'object' } }] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['ls'] } },
    generationConfig: { maxOutputTokens: 500, temperature: 0.3, topP: 0.9, stopSequences: ['END'], thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 } }
  }, { model: 'm' });
  assert.equal(a.system, 'sys');
  assert.equal(a.max_tokens, 500);
  assert.deepEqual(a.stop_sequences, ['END']);
  assert.deepEqual(a.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.equal(a.messages[0].content[1].type, 'image');
  assert.deepEqual(a.messages[1].content.map(b => b.type), ['text', 'tool_use']);
  const id = a.messages[1].content[1].id;
  assert.equal(a.messages[2].role, 'user');
  assert.deepEqual(a.messages[2].content[0], { type: 'tool_result', tool_use_id: id, content: 'içerik' });
  assert.deepEqual(a.messages[2].content[1], { type: 'text', text: 'devam' }, 'ardışık kullanıcı turları birleşir');
  assert.deepEqual(a.tools[0].input_schema, { type: 'object', properties: { path: { type: ['string', 'null'] } }, required: ['path'] });
  assert.deepEqual(a.tools[1].input_schema, { type: 'object' });
  assert.deepEqual(a.tool_choice, { type: 'tool', name: 'ls' });
  assert.deepEqual(toJsonSchema({ type: 'ARRAY', items: { type: 'NUMBER' } }), { type: 'array', items: { type: 'number' } });
});

test('Anthropic → Gemini: JSON yanıt ve SSE akışı (metin, düşünce, araç çağrısı, kullanım)', () => {
  const g = anthropicToGemini({ id: 'msg_1', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Selam' }, { type: 'tool_use', id: 't1', name: 'ls', input: { d: '.' } }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 3 } }, 'm');
  assert.deepEqual(g.candidates[0].content.parts, [{ text: 'hm', thought: true }, { text: 'Selam' }, { functionCall: { id: 't1', name: 'ls', args: { d: '.' } } }]);
  assert.equal(g.candidates[0].finishReason, 'STOP');
  assert.deepEqual(g.usageMetadata, { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 });
  assert.equal(anthropicToGemini({ content: [], stop_reason: 'max_tokens', usage: {} }, 'm').candidates[0].finishReason, 'MAX_TOKENS');

  const out = [];
  const tr = createGeminiStreamFromAnthropic('m', s => out.push(JSON.parse(s.slice(6))));
  tr.event({ type: 'message_start', message: { usage: { input_tokens: 7 } } });
  tr.event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  tr.event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Mer' } });
  tr.event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'x', name: 'ls' } });
  tr.event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"d":' } });
  tr.event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"."}' } });
  tr.event({ type: 'content_block_stop', index: 1 });
  tr.event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } });
  tr.end();
  assert.deepEqual(out[0].candidates[0].content.parts, [{ text: 'Mer' }]);
  assert.deepEqual(out[1].candidates[0].content.parts, [{ functionCall: { id: 'x', name: 'ls', args: { d: '.' } } }]);
  assert.equal(out.at(-1).candidates[0].finishReason, 'STOP');
  assert.deepEqual(out.at(-1).usageMetadata, { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 });
});

test('yönlendirici uçtan uca: Gemini CLI streamGenerateContent → Chat Completions sağlayıcısı → Gemini SSE; flash → hızlı model', async () => {
  const up = await fakeUpstream((b, res) => {
    if (!b.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: 'Merhaba' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"reasoning_content":"düşün"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"Merhaba"}}]}\n\n');
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n');
  });
  const usage = [];
  const router = await startRouter({ port: 0, targets: () => ({ gemini: { provider: 'p', baseUrl: up.base, key: 'k', model: 'big', fastModel: 'small', apiFor: () => 'chat' } }), log: () => {}, onUsage: e => usage.push(e) });
  const base = `http://127.0.0.1:${router.address().port}`;
  const r = await fetch(`${base}/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': 'aswitch-local' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'selam' }] }] }) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /event-stream/);
  const chunks = (await r.text()).split('\n\n').filter(Boolean).map(l => JSON.parse(l.slice(6)));
  assert.deepEqual(chunks[0].candidates[0].content.parts, [{ text: 'düşün', thought: true }]);
  assert.deepEqual(chunks[1].candidates[0].content.parts, [{ text: 'Merhaba' }]);
  assert.equal(chunks.at(-1).usageMetadata.totalTokenCount, 11);
  assert.equal(up.seen[0].url, '/v1/chat/completions');
  assert.equal(up.seen[0].body.model, 'big');
  // akışsız + flash modeli → hızlı model
  const r2 = await fetch(`${base}/v1beta/models/gemini-2.5-flash-lite:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] }) });
  const j2 = await r2.json();
  assert.equal(up.seen[1].body.model, 'small');
  assert.equal(j2.candidates[0].content.parts.at(-1).text, 'Merhaba');
  // countTokens yerel tahmin
  const r3 = await fetch(`${base}/v1beta/models/gemini-3-pro:countTokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'abcdefgh' }] }] }) });
  assert.deepEqual(await r3.json(), { totalTokens: 2 });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(usage[0].tool, 'gemini');
  assert.equal(usage[0].in, 9);
  assert.equal(usage[0].out, 2);
  assert.ok(usage[0].ttft != null);
  router.close(); up.s.close();
});

test('yönlendirici: Gemini hatası Gemini biçiminde döner; Gemini hedefi yoksa 503', async () => {
  const up = await fakeUpstream((b, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad key"}}'); });
  const router = await startRouter({ port: 0, targets: () => ({ gemini: { provider: 'p', baseUrl: up.base, key: 'k', model: 'big' } }), log: () => {} });
  const r = await fetch(`http://127.0.0.1:${router.address().port}/v1beta/models/x:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"contents":[]}' });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: { code: 401, message: 'bad key', status: 'UNAUTHENTICATED' } });
  router.close(); up.s.close();
  const r2 = await startRouter({ port: 0, targets: () => ({}), log: () => {} });
  const x = await fetch(`http://127.0.0.1:${r2.address().port}/v1beta/models/x:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(x.status, 503);
  assert.equal((await x.json()).error.status, 'UNAVAILABLE');
  r2.close();
});
