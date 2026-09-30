import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dir = sandbox();
const core = await import('../src/core.js');

test('Claude: OpenRouter doğrudan Anthropic uyumlu uç noktaya yazılır, diğer ayarlar korunur', async () => {
  const f = path.join(dir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ theme: 'dark', env: { FOO: '1' } }));
  core.setKey('openrouter', 'sk-or-test');
  await core.useProvider({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', tools: ['claude'] });
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.equal(s.env.FOO, '1');
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'sk-or-test');
  assert.equal(s.env.ANTHROPIC_API_KEY, '');
  assert.equal(s.env.ANTHROPIC_MODEL, 'anthropic/claude-sonnet-4.5');
});

test('Claude: resmî girişe dönüş yalnızca yönetilen alanları siler', () => {
  core.useOfficial(['claude']);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.env, { FOO: '1' });
});

test('Claude: yalnız OpenAI uyumlu sağlayıcı yerel yönlendiriciye bağlanır', async () => {
  core.setKey('openai', 'sk-test');
  const r = await core.useProvider({ provider: 'openai', model: 'gpt-5', tools: ['claude'] });
  assert.equal(r.results[0].viaRouter, true);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456');
  assert.equal(core.routerTarget().baseUrl, 'https://api.openai.com/v1');
});

test('Codex: config.toml içine yönetilen blok yazılır, kullanıcı tabloları korunur', async () => {
  const f = path.join(dir, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'model = "gpt-5-codex"\napproval_policy = "on-request"\n\n[mcp_servers.docs]\ncommand = "npx"\n');
  core.setKey('opencode-zen', 'zen-key');
  await core.useProvider({ provider: 'opencode-zen', model: 'gpt-5.5', tools: ['codex'] });
  const t = fs.readFileSync(f, 'utf8');
  assert.match(t, /model_provider = "aswitch"/);
  assert.match(t, /^model = "gpt-5.5"/m);
  assert.match(t, /wire_api = "responses"/);
  assert.doesNotMatch(t, /^model = "gpt-5-codex"/m); // yalnızca yorum olarak saklanır
  assert.match(t, /approval_policy = "on-request"/);
  assert.match(t, /\[mcp_servers\.docs\]/);
  assert.match(t, /base_url = "https:\/\/opencode.ai\/zen\/v1"/);
  assert.match(t, /env_key = "OPENCODE_API_KEY"/);
  // ikinci uygulama bloğu çoğaltmamalı
  await core.useProvider({ provider: 'opencode-zen', model: 'gpt-5.4', tools: ['codex'] });
  const t2 = fs.readFileSync(f, 'utf8');
  assert.equal(t2.match(/\[model_providers\.aswitch\]/g).length, 1);
  assert.equal(t2.match(/^model = /gm).length, 1);
});

test('restore: dosyalar aswitch öncesi orijinal haline döner', () => {
  core.restore(['codex', 'claude']);
  const t = fs.readFileSync(path.join(dir, '.codex', 'config.toml'), 'utf8');
  assert.equal(t, 'model = "gpt-5-codex"\napproval_policy = "on-request"\n\n[mcp_servers.docs]\ncommand = "npx"\n');
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s, { theme: 'dark', env: { FOO: '1' } });
});

test('OpenCode: yerleşik olmayan sağlayıcı için openai-compatible blok yazılır', async () => {
  core.setKey('deepseek', 'ds');
  await core.useProvider({ provider: 'deepseek', model: 'deepseek-chat', tools: ['opencode'] });
  const c = JSON.parse(fs.readFileSync(path.join(dir, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(c.model, 'aswitch-deepseek/deepseek-chat');
  assert.equal(c.provider['aswitch-deepseek'].options.apiKey, '{env:DEEPSEEK_API_KEY}');
});

test('anahtar yoksa anlaşılır hata verir', async () => {
  delete process.env.MOONSHOT_API_KEY;
  await assert.rejects(core.useProvider({ provider: 'moonshot', tools: ['claude'] }), /anahtar yok/);
});

test('yönlendirici: özel port, yönlendirici gerekmeyen geçişlerden sonra da korunur', async () => {
  core.setKey('openai', 'sk-test');
  core.setKey('openrouter', 'sk-or-test');
  await core.useProvider({ provider: 'openai', model: 'gpt-5', tools: ['claude'], port: 4567 });
  assert.equal(core.status().router.port, 4567);
  // Claude now goes direct: nothing needs the router, but the chosen port must stay.
  await core.useProvider({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', tools: ['claude'] });
  assert.equal(core.status().router.port, 4567);
  assert.equal(core.routerNeeded(), false);
  // Switching back without --port reuses it.
  const r = await core.useProvider({ provider: 'openai', model: 'gpt-5', tools: ['claude'] });
  assert.equal(r.results[0].viaRouter, true);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4567');
  core.useOfficial(['claude']);
  assert.equal(core.status().router.port, 4567);
});

test('güvenlik: aswitch veri klasörü ve yedekler yalnızca kullanıcıya açık (macOS/Linux)', { skip: process.platform === 'win32' }, () => {
  const app = path.join(dir, '.agent-switchboard');
  for (const d of [app, path.join(app, 'backups'), path.join(app, 'originals')]) {
    assert.equal(fs.statSync(d).mode & 0o077, 0, d);
  }
  assert.equal(fs.statSync(path.join(app, 'config.json')).mode & 0o077, 0);
});
