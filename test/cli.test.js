import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox } from './helpers.js';

const dir = sandbox();
const { flags, envLine } = await import('../src/cli.js');
const { winQuote } = await import('../src/core.js');
const { stripJsonc, writeFileSafe } = await import('../src/fsutil.js');
const bin = new URL('../bin/aswitch.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: process.env });

test('bayraklar: boolean bayrak sonraki sözcüğü yutmaz', () => {
  assert.deepEqual(flags(['--refresh', 'openrouter', '--filter', 'claude']), { _: ['openrouter'], refresh: true, filter: 'claude' });
  assert.deepEqual(flags(['openrouter', '--refresh']), { _: ['openrouter'], refresh: true });
});

test('bayraklar: --anahtar=değer içindeki "=" korunur', () => {
  assert.equal(flags(['--openai-base=https://x.example/v1?a=b'])['openai-base'], 'https://x.example/v1?a=b');
});

test('env satırları kabuklara göre güvenle tırnaklanır', () => {
  assert.equal(envLine('sh', 'K', "a'b"), `export K='a'\\''b'`);
  assert.equal(envLine('powershell', 'K', "a'$b"), `$env:K='a''$b'`);
  assert.equal(envLine('cmd', 'K', 'v'), 'set "K=v"');
  assert.equal(envLine('fish', 'K', "a'b"), "set -gx K 'a\\'b'");
});

test('Windows argüman tırnaklama', () => {
  assert.equal(winQuote('exec'), 'exec');
  assert.equal(winQuote('merhaba dünya'), '"merhaba dünya"');
  assert.equal(winQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(winQuote(''), '""');
});

test('--version package.json sürümünü yazar', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const r = cli('--version');
  assert.equal(r.stdout.trim(), pkg.version);
});

test('uçtan uca: key set (borudan) → key get → use → status → env → official', () => {
  let r = spawnSync(process.execPath, [bin, 'key', 'set', 'deepseek'], { input: 'sk-ds-123\n', encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  r = cli('key', 'get', 'deepseek');
  assert.equal(r.stdout.trim(), 'sk-ds-123');
  r = cli('use', 'deepseek', '--model', 'deepseek-chat', '--tools', 'claude,codex');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /yönlendirici/);
  const st = JSON.parse(cli('status').stdout);
  assert.equal(st.claude.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(st.codex.baseUrl, 'http://127.0.0.1:3456/v1');
  r = cli('env', '--shell', 'sh');
  assert.equal(r.stdout.trim(), ''); // Codex yönlendiricide; anahtar değişkeni gerekmez
  r = cli('official');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(cli('status').stdout).codex.baseUrl, '(resmî OpenAI / ChatGPT girişi)');
  r = cli('provider', 'add', 'Kötü İsim', '--openai-base', 'https://x');
  assert.notEqual(r.status, 0);
});

test('JSONC ayıklayıcı dizgelere dokunmaz', () => {
  assert.deepEqual(JSON.parse(stripJsonc('{"a":"//x", /* y */ "b":[1,2,], // z\n}')), { a: '//x', b: [1, 2] });
});

test('writeFileSafe mevcut dosyanın iznini korur', { skip: process.platform === 'win32' }, () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aswitch-fs-')), 'x.toml');
  fs.writeFileSync(f, 'a'); fs.chmodSync(f, 0o640);
  writeFileSafe(f, 'b');
  assert.equal(fs.statSync(f).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(f, 'utf8'), 'b');
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['x.toml']);
});

test('config.json 0600 izinle yazılır', { skip: process.platform === 'win32' }, () => {
  assert.equal(fs.statSync(path.join(dir, '.agent-switchboard', 'config.json')).mode & 0o777, 0o600);
});

test('status: anahtar gerektirmeyen sağlayıcı (ollama) "****" yerine "(gerekmez)" gösterir', async () => {
  const core = await import('../src/core.js');
  assert.equal(core.status().keys.ollama, '(gerekmez)');
});
