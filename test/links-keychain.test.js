import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox } from './helpers.js';

const dir = sandbox();
const core = await import('../src/core.js');
const { parseDeepLink, applyDeepLink, makeDeepLink, linkFromArgv } = await import('../src/deeplink.js');
const kc = await import('../src/keychain.js');
const { configPath } = await import('../src/config.js');
const bin = new URL('../bin/aswitch.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cli = (args, env = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, input: '' });
const cfgFile = () => JSON.parse(fs.readFileSync(configPath(), 'utf8'));

test('deep link: provider bağlantısı önizlenir, anahtar parametresi atılır, onaysız hiçbir şey yazılmaz', () => {
  const url = 'aswitch://provider?id=my-gw&label=My%20GW&openaiBase=https%3A%2F%2Fgw.example.com%2Fv1&wire=chat&keyEnv=MY_GW_KEY&key=sk-secret';
  const p = parseDeepLink(url);
  assert.equal(p.kind, 'provider');
  assert.equal(p.keysStripped, true);
  assert.equal(p.preview.providers[0].openaiBase, 'https://gw.example.com/v1');
  assert.equal(p.preview.providers[0].error, null);
  assert.ok(!core.providers().some(x => x.id === 'my-gw'), 'parse yalnızca önizler');
  const r = applyDeepLink(url);
  assert.equal(r.counts.providers, 1);
  const cfg = cfgFile();
  assert.equal(cfg.providers['my-gw'].openaiBase, 'https://gw.example.com/v1');
  assert.equal(cfg.keys['my-gw'], undefined, 'bağlantıdan anahtar kaydedilmez');
  assert.ok(!JSON.stringify(cfg).includes('sk-secret'));
  // Existing provider is kept unless overwrite is asked for.
  const again = applyDeepLink(url.replace('gw.example.com', 'other.example.com'));
  assert.equal(again.counts.providers, 0);
  assert.equal(cfgFile().providers['my-gw'].openaiBase, 'https://gw.example.com/v1');
});

test('deep link: güvensiz/bozuk bağlantılar reddedilir', () => {
  const bad = parseDeepLink('aswitch://provider?id=evil&openaiBase=http%3A%2F%2Fevil.example.com%2Fv1');
  assert.ok(bad.preview.providers[0].error);
  assert.throws(() => applyDeepLink('aswitch://provider?id=evil&openaiBase=http%3A%2F%2Fevil.example.com%2Fv1'));
  assert.throws(() => parseDeepLink('https://example.com/provider?id=x'));
  assert.throws(() => parseDeepLink('aswitch://unknown?x=1'));
  assert.throws(() => parseDeepLink('aswitch://provider?label=x'));
  assert.throws(() => parseDeepLink('aswitch://import?data=bm90LWpzb24'));
  assert.throws(() => parseDeepLink('aswitch://provider?id=x&openaiBase=https://a.example/' + 'a'.repeat(17000)));
  assert.equal(parseDeepLink('aswitch://provider?id=openrouter&openaiBase=https%3A%2F%2Fx.example%2Fv1').preview.providers[0].error !== null, true, 'hazır sağlayıcı kimliği ele geçirilemez');
});

test('deep link: profil ve içe aktarma bağlantıları; make → parse gidiş-dönüş; anahtarlar asla taşınmaz', () => {
  const pl = parseDeepLink('aswitch://profile?name=cheap&claude=openrouter%3Aqwen%2Fqwen3-coder%3Afree%7Cqwen%2Fqwen3-8b&codex=official&bogus=x');
  assert.deepEqual(pl.bundle.profiles.cheap.tools.claude, { provider: 'openrouter', model: 'qwen/qwen3-coder:free', fastModel: 'qwen/qwen3-8b' });
  assert.deepEqual(pl.bundle.profiles.cheap.tools.codex, { provider: 'official' });
  applyDeepLink(pl);
  assert.ok(core.listProfiles().some(p => p.name === 'cheap'));

  core.setKey('my-gw', 'sk-local-only');
  const cfg = cfgFile();
  cfg.profiles.gw = { tools: { claude: { provider: 'my-gw', model: 'm1', fastModel: null } } };
  fs.writeFileSync(configPath(), JSON.stringify(cfg));
  const link = makeDeepLink('profile', 'gw');
  assert.match(link, /^aswitch:\/\/import\?data=/, 'özel sağlayıcı kullanan profil sağlayıcıyla birlikte paketlenir');
  assert.ok(!Buffer.from(link.split('data=')[1], 'base64url').toString().includes('sk-local-only'));
  const pv = parseDeepLink(link).preview;
  assert.equal(pv.providers[0].id, 'my-gw'); assert.equal(pv.profiles[0].name, 'gw');
  assert.equal(pv.providers[0].exists, true);

  const simple = makeDeepLink('profile', 'cheap');
  assert.match(simple, /^aswitch:\/\/profile\?/);
  assert.deepEqual(parseDeepLink(simple).bundle.profiles.cheap.tools.claude.fastModel, 'qwen/qwen3-8b');
  const prov = makeDeepLink('provider', 'my-gw');
  assert.equal(parseDeepLink(prov).bundle.providers['my-gw'].openaiBase, 'https://gw.example.com/v1');
  const all = makeDeepLink('all');
  assert.ok(!Buffer.from(all.split('data=')[1], 'base64url').toString().includes('sk-local-only'));

  // An import link that smuggles keys: flagged and ignored.
  const data = Buffer.from(JSON.stringify({ format: 'agent-switchboard', formatVersion: 1, providers: { 'x-gw': { openaiBase: 'https://x.example/v1' } }, keys: { 'x-gw': 'sk-smuggled', openrouter: 'sk-smuggled' } })).toString('base64url');
  const imp = parseDeepLink('aswitch://import?data=' + data);
  assert.equal(imp.keysStripped, true);
  applyDeepLink(imp);
  assert.ok(!JSON.stringify(cfgFile()).includes('sk-smuggled'));
  assert.equal(linkFromArgv(['/app', '--flag', 'aswitch://provider?id=a']), 'aswitch://provider?id=a');
  assert.equal(linkFromArgv(['/app']), null);
});

test('CLI: aswitch link onaysız uygulamaz, --yes ile uygular; link make', () => {
  const url = 'aswitch://provider?id=cli-gw&openaiBase=https%3A%2F%2Fcli.example.com%2Fv1';
  const r1 = cli(['link', url]);
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /cli\.example\.com/);
  assert.match(r1.stdout, /--yes/);
  assert.ok(!cfgFile().providers['cli-gw']);
  const r2 = cli(['link', url, '--yes']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(cfgFile().providers['cli-gw']);
  const r3 = cli(['link', 'make', 'provider', 'cli-gw']);
  assert.match(r3.stdout.trim(), /^aswitch:\/\/provider\?id=cli-gw/);
  const r4 = cli(['link', url, '--json']);
  assert.equal(JSON.parse(r4.stdout).providers[0].id, 'cli-gw');
});

// A stand-in for libsecret's secret-tool (stores each secret in a file), so the Linux path runs everywhere but Windows.
const fakeBin = path.join(dir, 'fakebin');
const fakeStore = path.join(dir, 'fake-keychain');
fs.mkdirSync(fakeBin, { recursive: true }); fs.mkdirSync(fakeStore, { recursive: true });
fs.writeFileSync(path.join(fakeBin, 'secret-tool'), `#!/bin/sh
cmd=$1; shift
while [ $# -gt 0 ]; do case "$1" in account) acct=$2; shift 2;; *) shift;; esac; done
f="${fakeStore}/$acct"
case $cmd in store) cat > "$f";; lookup) [ -f "$f" ] || exit 1; cat "$f";; clear) rm -f "$f";; esac
`, { mode: 0o755 });
const skip = process.platform === 'win32';

test('anahtar zinciri: anahtarlar taşınır, geri okunur, dışa aktarımda çözülür, geri alınır', { skip }, () => {
  const oldPath = process.env.PATH;
  process.env.PATH = fakeBin + path.delimiter + oldPath;
  process.env.ASWITCH_KEYCHAIN_BACKEND = 'linux';
  try {
    kc.clearKeychainCache();
    core.setKey('openrouter', 'sk-or-test-123456');
    assert.equal(core.getKeyStore().store, 'file');
    const on = core.setKeyStore('keychain');
    assert.ok(on.moved.includes('openrouter'));
    assert.equal(cfgFile().keys.openrouter, '@keychain');
    assert.equal(cfgFile().keyStore, 'keychain');
    assert.equal(fs.readFileSync(path.join(fakeStore, 'openrouter'), 'utf8'), 'sk-or-test-123456');
    assert.ok(!fs.readFileSync(configPath(), 'utf8').includes('sk-or-test-123456'));
    kc.clearKeychainCache();
    assert.equal(core.getProviderKey('openrouter'), 'sk-or-test-123456');
    assert.equal(core.exportConfig({ withKeys: true }).keys.openrouter, 'sk-or-test-123456');
    assert.equal(core.providers().find(p => p.id === 'openrouter').keySource, 'saved');
    core.setKey('deepseek', 'sk-ds-abcdef123');
    assert.equal(cfgFile().keys.deepseek, '@keychain', 'yeni anahtarlar da zincire gider');
    core.setKey('deepseek', '');
    assert.ok(!fs.existsSync(path.join(fakeStore, 'deepseek')), 'silinen anahtar zincirden de silinir');
    // CLI sees the same store
    const st = cli(['keychain', '--json'], { PATH: process.env.PATH, ASWITCH_KEYCHAIN_BACKEND: 'linux' });
    assert.equal(JSON.parse(st.stdout).store, 'keychain');
    const off = core.setKeyStore('file');
    assert.ok(off.moved.includes('openrouter'));
    assert.equal(cfgFile().keys.openrouter, 'sk-or-test-123456');
    assert.equal(cfgFile().keyStore, undefined);
    assert.ok(!fs.existsSync(path.join(fakeStore, 'openrouter')));
  } finally { process.env.PATH = oldPath; delete process.env.ASWITCH_KEYCHAIN_BACKEND; kc.clearKeychainCache(); }
});

test('anahtar zinciri: arka uç yoksa açık hata, dosya deposu değişmez', () => {
  process.env.ASWITCH_KEYCHAIN_BACKEND = 'none';
  try {
    assert.equal(core.getKeyStore().available, false);
    assert.throws(() => core.setKeyStore('keychain'), /anahtar zinciri|keychain/i);
    assert.throws(() => core.setKeyStore('cloud'));
    assert.equal(core.getKeyStore().store, 'file');
  } finally { delete process.env.ASWITCH_KEYCHAIN_BACKEND; }
});

// Real OS keychains on CI runners (macOS login keychain, Windows Credential Manager). Opt-in locally with ASWITCH_REAL_KEYCHAIN=1.
const real = (process.env.CI && (process.platform === 'darwin' || process.platform === 'win32')) || process.env.ASWITCH_REAL_KEYCHAIN === '1';
test('anahtar zinciri: gerçek işletim sistemi deposu (CI macOS/Windows)', { skip: !real }, () => {
  const acct = 'aswitch-ci-' + process.pid;
  const secret = 'sk-ci-' + Math.random().toString(36).slice(2) + '-ü';
  kc.kcSet(acct, secret);
  kc.clearKeychainCache();
  assert.equal(kc.kcGet(acct), secret, kc.lastKeychainError());
  kc.kcDelete(acct);
  kc.clearKeychainCache();
  assert.equal(kc.kcGet(acct), '');
});
