import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dir = sandbox();
const core = await import('../src/core.js');
const ocDir = path.join(dir, '.config', 'opencode');

test('OpenCode: Go yerleşik "opencode-go" kimliğiyle yazılır, özel blok eklenmez', async () => {
  core.setKey('opencode-go', 'g');
  await core.useProvider({ provider: 'opencode-go', model: 'kimi-k3', tools: ['opencode'] });
  const c = JSON.parse(fs.readFileSync(path.join(ocDir, 'opencode.json'), 'utf8'));
  assert.equal(c.model, 'opencode-go/kimi-k3');
  assert.equal(c.provider, undefined);
  core.restore(['opencode']);
  assert.ok(!fs.existsSync(path.join(ocDir, 'opencode.json')));
});

test('OpenCode: yorumlu opencode.jsonc okunur ve ayarlar korunur', async () => {
  fs.mkdirSync(ocDir, { recursive: true });
  const jsonc = path.join(ocDir, 'opencode.jsonc');
  const orig = '{\n  // tema\n  "theme": "tokyonight", /* blok */\n  "share": "disabled",\n  "url": "http://a//b",\n}\n';
  fs.writeFileSync(jsonc, orig);
  core.setKey('opencode-zen', 'z');
  await core.useProvider({ provider: 'opencode-zen', model: 'claude-opus-4-8', tools: ['opencode'] });
  const c = JSON.parse(fs.readFileSync(jsonc, 'utf8'));
  assert.equal(c.theme, 'tokyonight');
  assert.equal(c.url, 'http://a//b');
  assert.equal(c.model, 'opencode/claude-opus-4-8');
  assert.ok(!fs.existsSync(path.join(ocDir, 'opencode.json')));
  core.useOfficial(['opencode']);
  assert.equal(fs.readFileSync(jsonc, 'utf8'), orig);
});

test('OpenCode: ayrıştırılamayan dosyaya dokunulmaz', async () => {
  const file = path.join(ocDir, 'opencode.json');
  fs.writeFileSync(file, '{ bozuk');
  await assert.rejects(core.useProvider({ provider: 'opencode-zen', model: 'x', tools: ['opencode'] }), /geçerli bir JSON değil/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ bozuk');
});
