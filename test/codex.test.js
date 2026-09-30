import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dir = sandbox();
const { renderCodex, stripCodex, statusCodex } = await import('../src/targets/codex.js');
const core = await import('../src/core.js');

const zen = { id: 'opencode-zen', label: 'OpenCode Zen' };
const opts = { provider: zen, model: 'gpt-5.5', keyEnvName: 'OPENCODE_API_KEY', baseUrl: 'https://opencode.ai/zen/v1' };

test('Codex: uygula → kaldır orijinali birebir geri getirir (model satırları dahil)', () => {
  const orig = '# üst yorum\nmodel = "gpt-5-codex"\nmodel_provider = "openai"\napproval_policy = "on-request"\n\n[mcp_servers.docs]\ncommand = "npx"\n';
  const applied = renderCodex(orig, opts);
  assert.equal(applied.match(/^model = /gm).length, 1);
  assert.equal(applied.match(/^model_provider = /gm).length, 1);
  assert.match(applied, /^# aswitch-saved: model = "gpt-5-codex"$/m);
  const back = stripCodex(applied);
  assert.equal(back, 'model = "gpt-5-codex"\nmodel_provider = "openai"\n# üst yorum\napproval_policy = "on-request"\n\n[mcp_servers.docs]\ncommand = "npx"\n');
});

test('Codex: tekrarlanan uygula/kaldır döngüleri kararlı (satır büyümesi yok)', () => {
  const orig = 'model = "gpt-5-codex"\napproval_policy = "on-request"\n\n[mcp_servers.docs]\ncommand = "npx"\n';
  let t = orig;
  const first = renderCodex(t, opts);
  for (let i = 0; i < 5; i++) t = renderCodex(t, opts);
  assert.equal(t, first);
  for (let i = 0; i < 3; i++) { t = stripCodex(t); t = renderCodex(t, opts); }
  assert.equal(t, first);
  assert.equal(stripCodex(t), orig);
});

test('Codex: CRLF satır sonları korunur', () => {
  const orig = 'model = "o3"\r\n\r\n[profiles.x]\r\nmodel = "y"\r\n';
  const applied = renderCodex(orig, opts);
  assert.ok(!/[^\r]\n/.test(applied), 'tek başına \\n kalmamalı');
  assert.match(applied, /\[profiles\.x\]\r\nmodel = "y"/); // tablo içindeki model satırına dokunulmaz
  assert.equal(stripCodex(applied), orig);
});

test('Codex: ilk satırı tablo olan dosya ve eski [model_providers.aswitch] tabloları', () => {
  const orig = '[model_providers.aswitch]\nname = "eski"\nbase_url = "http://x"\n\n[model_providers.aswitch.auth]\ncommand = "x"\n\n[mcp_servers.a]\ncommand = "b"\n';
  const applied = renderCodex(orig, opts);
  assert.equal(applied.match(/\[model_providers\.aswitch\]/g).length, 1);
  assert.doesNotMatch(applied, /eski/);
  assert.doesNotMatch(applied, /command = "x"/);
  assert.ok(applied.startsWith('# >>> agent-switchboard >>>\nmodel_provider = "aswitch"'), 'üst düzey anahtarlar ilk tablodan önce olmalı');
  assert.match(applied, /\[mcp_servers\.a\]\ncommand = "b"/);
});

test('Codex: yorumlu model satırı ve benzer adlı anahtarlar korunur', () => {
  const orig = '# model = "yorum"\nmodel_reasoning_effort = "high"\nmodel = "gpt-5" # satır sonu yorumu\n';
  const applied = renderCodex(orig, opts);
  assert.match(applied, /^# model = "yorum"$/m);
  assert.match(applied, /^model_reasoning_effort = "high"$/m);
  assert.equal(stripCodex(applied).split('\n').filter(l => l.startsWith('model = ')).length, 1);
});

test('Codex: komutla anahtar modu [model_providers.aswitch.auth] yazar, env_key yazmaz', () => {
  const t = renderCodex('', { ...opts, keyMode: 'command', authCommand: { command: '/usr/bin/node', args: ['/x/aswitch.js', 'key', 'get', 'opencode-zen'] } });
  assert.match(t, /\[model_providers\.aswitch\.auth\]\ncommand = "\/usr\/bin\/node"\nargs = \["\/x\/aswitch.js", "key", "get", "opencode-zen"\]/);
  assert.doesNotMatch(t, /env_key =/);
});

test('Codex: resmî moda dönüş kaldırılan model satırını geri koyar, sonraki kullanıcı düzenlemelerini korur', async () => {
  const f = path.join(dir, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'model = "gpt-5-codex"\n\n[mcp_servers.docs]\ncommand = "npx"\n');
  core.setKey('deepseek', 'ds');
  const r = await core.useProvider({ provider: 'deepseek', model: 'deepseek-chat', tools: ['codex'] });
  assert.equal(r.results[0].viaRouter, true);
  let t = fs.readFileSync(f, 'utf8');
  assert.match(t, /base_url = "http:\/\/127\.0\.0\.1:3456\/v1"/);
  assert.match(t, /wire_api = "responses"/);
  assert.doesNotMatch(t, /env_key/); // yönlendirici anahtarı kendisi ekler
  assert.equal(statusCodex().model, 'deepseek-chat');
  assert.equal(core.routerTargets().codex.baseUrl, 'https://api.deepseek.com/v1');
  fs.appendFileSync(f, '\n[mcp_servers.yeni]\ncommand = "uvx"\n');
  core.useOfficial(['codex']);
  t = fs.readFileSync(f, 'utf8');
  assert.match(t, /^model = "gpt-5-codex"$/m);
  assert.match(t, /\[mcp_servers\.yeni\]/);
  assert.doesNotMatch(t, /aswitch/);
  assert.equal(core.status().router, null);
});

test('Codex: yalnız /messages sunan model (Zen Claude) Codex için reddedilir ve dosyaya yazılmaz', async () => {
  const f = path.join(dir, '.codex', 'config.toml');
  const before = fs.readFileSync(f, 'utf8');
  core.setKey('opencode-zen', 'z');
  await assert.rejects(core.useProvider({ provider: 'opencode-zen', model: 'claude-opus-4-8', tools: ['claude', 'codex'] }), /Codex ile kullanılamaz/);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'settings.json')), 'doğrulama başarısızsa Claude da yazılmamalı');
});

test('Codex: OpenRouter ve OpenCode Go GPT modeli doğrudan /responses ile bağlanır', async () => {
  core.setKey('openrouter', 'or');
  let r = await core.useProvider({ provider: 'openrouter', model: 'openai/gpt-5', tools: ['codex'] });
  assert.equal(r.results[0].viaRouter, false);
  assert.equal(r.results[0].keyEnv, 'OPENROUTER_API_KEY');
  core.setKey('opencode-go', 'g');
  r = await core.useProvider({ provider: 'opencode-go', model: 'gpt-6-luna', tools: ['codex'] });
  assert.equal(r.results[0].viaRouter, false);
  r = await core.useProvider({ provider: 'opencode-go', model: 'kimi-k3', tools: ['codex'] });
  assert.equal(r.results[0].viaRouter, true);
});
