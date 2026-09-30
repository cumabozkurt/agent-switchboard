import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { sandbox } from './helpers.js';
sandbox();
const { startUi, probeRouter } = await import('../src/ui/server.js');
const core = await import('../src/core.js');
const { startRouter } = await import('../src/router.js');
const { CATALOGS } = await import('../src/i18n/index.js');

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function open(opts = {}) {
  const ui = await startUi({ port: 0, open: false, ...opts });
  const base = ui.url.split('#')[0];
  const call = async (p, body) => {
    const r = await fetch(base + 'api/' + p, { method: 'POST', headers: { 'x-aswitch-token': ui.token, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json();
    return r.ok ? j : Object.assign(new Error(j.error), { status: r.status, body: j });
  };
  return { ...ui, base, call };
}

test('arayüz: belirteç, JSON içerik türü ve yalnız POST zorunlu', async () => {
  const ui = await open();
  try {
    assert.equal((await fetch(ui.base + 'api/providers', { method: 'POST', headers: { 'content-type': 'application/json' } })).status, 403);
    assert.equal((await fetch(ui.base + 'api/providers', { method: 'POST', headers: { 'x-aswitch-token': ui.token } })).status, 415);
    assert.equal((await fetch(ui.base + 'api/providers', { headers: { 'x-aswitch-token': ui.token } })).status, 405);
    const list = await ui.call('providers');
    assert.ok(list.find(p => p.id === 'openrouter' && p.oauth && p.keyUrl));
    assert.ok(list.find(p => p.id === 'ollama' && p.noKey));
  } finally { await ui.stop(); }
});

test('arayüz: yabancı Host başlığı (DNS yeniden bağlama) reddedilir', async () => {
  const ui = await open();
  try {
    const status = await new Promise(r => http.get({ host: '127.0.0.1', port: ui.server.address().port, path: '/', headers: { host: 'evil.example' } }, res => { res.resume(); r(res.statusCode); }));
    assert.equal(status, 403);
  } finally { await ui.stop(); }
});

test('arayüz sayfası: innerHTML yok, tüm data-i18n anahtarları kataloglarda, dil sunucuda ayarlanır', async () => {
  const html = fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html), false, 'dinamik HTML enjeksiyonu kullanılmamalı');
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-aria-label)?="([^"]+)"/g)) {
    assert.ok(m[1] in CATALOGS.en && m[1] in CATALOGS.tr, `eksik anahtar: ${m[1]}`);
  }
  const ui = await open();
  try {
    await ui.call('settings', { lang: 'en' });
    let page = await (await fetch(ui.base)).text();
    assert.match(page, /<html lang="en">/);
    assert.match(page, /"lang":"en"/);
    assert.equal(page.includes('/*__BOOT__*/null'), false);
    assert.equal(/<\/script>/.test(page.slice(page.indexOf('const BOOT'), page.indexOf('const token'))), false);
    await ui.call('settings', { lang: 'tr' });
    page = await (await fetch(ui.base)).text();
    assert.match(page, /<html lang="tr">/);
    const bad = await ui.call('settings', { lang: 'xx' });
    assert.equal(bad.status, 400);
    const auto = await ui.call('settings', { lang: 'auto' });
    assert.equal(auto.langSaved, null);
    await ui.call('settings', { lang: 'tr' });
  } finally { await ui.stop(); }
});

test('arayüz: dil değişince sunucu hataları da o dilde döner ve onLangChange çağrılır', async () => {
  const seen = [];
  const ui = await open({ onLangChange: l => seen.push(l) });
  try {
    await ui.call('settings', { lang: 'en' });
    assert.match((await ui.call('use', { provider: 'nope', tools: ['claude'] })).message, /Unknown provider: nope/);
    await ui.call('settings', { lang: 'tr' });
    assert.match((await ui.call('use', { provider: 'nope', tools: ['claude'] })).message, /Bilinmeyen sağlayıcı: nope/);
    assert.deepEqual(seen, ['en', 'tr']);
  } finally { await ui.stop(); }
});

test('arayüz: anahtar ekle/sil, özel sağlayıcı ekle/sil, ortam çıktısı maskeli/açık', async () => {
  const ui = await open();
  try {
    assert.equal((await ui.call('key', { provider: 'deepseek', key: '   ' })).status, 400);
    await ui.call('key', { provider: 'deepseek', key: 'sk-deepseek-123456' });
    let p = (await ui.call('providers')).find(x => x.id === 'deepseek');
    assert.equal(p.keySource, 'saved'); assert.equal(p.hasKey, true); assert.equal(p.keyMasked, 'sk-dee…3456');
    await ui.call('provider', { id: 'my-proxy', label: 'Proxy', openaiBase: 'https://proxy.example/v1', codexWire: 'responses', keyEnv: 'MY_PROXY_KEY' });
    p = (await ui.call('providers')).find(x => x.id === 'my-proxy');
    assert.equal(p.custom, true); assert.equal(p.spec.modelsUrl, 'https://proxy.example/v1/models');
    assert.equal((await ui.call('provider', { id: 'openrouter', openaiBase: 'https://x/v1' })).status, 400, 'hazır sağlayıcı kimliği reddedilir');
    assert.equal((await ui.call('provider/remove', { id: 'openrouter' })).status, 400);
    await ui.call('key', { provider: 'my-proxy', key: 'pk-1' });
    await ui.call('provider/remove', { id: 'my-proxy' });
    assert.equal((await ui.call('providers')).some(x => x.id === 'my-proxy'), false);
    await ui.call('use', { provider: 'openrouter', model: 'x', tools: ['codex'] }).catch(() => {});
    core.setKey('openrouter', 'sk-or-v1-abcdefghijkl');
    await ui.call('use', { provider: 'openrouter', model: 'openai/gpt-5', tools: ['codex'] });
    let env = await ui.call('env', { shell: 'powershell' });
    assert.deepEqual(env.lines, ["$env:OPENROUTER_API_KEY='sk-or-…ijkl'"]);
    env = await ui.call('env', { shell: 'sh', reveal: true });
    assert.deepEqual(env.lines, ["export OPENROUTER_API_KEY='sk-or-v1-abcdefghijkl'"]);
    await ui.call('key/remove', { provider: 'deepseek' });
    assert.equal((await ui.call('providers')).find(x => x.id === 'deepseek').keySource, null);
  } finally { await ui.stop(); }
});

test('arayüz: yönlendirici başlat → yeniden başlat → durdur; port çakışması ve harici yönlendirici anlaşılır', async () => {
  const port = await freePort();
  core.setKey('opencode-go', 'g');
  await core.useProvider({ provider: 'opencode-go', model: 'kimi-k3', tools: ['claude'], port });
  const ui = await open();
  try {
    let st = await ui.call('status');
    assert.deepEqual({ state: st.router.state, needed: st.router.needed, port: st.router.port }, { state: 'stopped', needed: true, port });
    const r = await ui.call('use', { provider: 'opencode-go', model: 'gpt-6-luna', tools: ['claude'] });
    assert.equal(r.results[0].viaRouter, true);
    assert.equal(r.routerAutoStarted, false);
    assert.equal((await ui.call('router/start')).router.state, 'running');
    assert.equal(await probeRouter(port), true);
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).claude, { target: 'https://opencode.ai/zen/go/v1', model: 'gpt-6-luna', api: 'responses' });
    assert.equal((await ui.call('router/start')).already, true);
    assert.equal((await ui.call('router/restart')).router.state, 'running');
    assert.equal((await ui.call('router/stop')).router.state, 'stopped');
    assert.equal(await probeRouter(port), false, 'durdurunca port serbest kalır');

    // Port başka bir programda
    const socks = new Set();
    const blocker = net.createServer(sk => { socks.add(sk); }).listen(port, '127.0.0.1');
    await new Promise(r => blocker.once('listening', r));
    let e = await ui.call('router/start');
    assert.equal(e.body.code, 'router.portInUse');
    for (const sk of socks) sk.destroy();
    await new Promise(r => blocker.close(r));

    // Terminalde çalışan bir "aswitch router"
    const ext = await startRouter({ port, targets: () => core.routerTargets(), log: () => {} });
    st = await ui.call('status');
    assert.equal(st.router.state, 'external');
    e = await ui.call('router/start');
    assert.equal(e.body.code, 'router.externalRunning');
    await new Promise(r => { ext.close(r); ext.closeAllConnections(); });
  } finally { await ui.stop(); }
});

test('arayüz: otomatik başlatma — uygulandığında ve yeniden açılışta; stop() yönlendiriciyi kapatır', async () => {
  const port = await freePort();
  await core.useProvider({ provider: 'opencode-go', model: 'kimi-k3', tools: ['claude'], port });
  let ui = await open();
  try {
    await ui.call('settings', { routerAutoStart: true });   // ayarı açmak, gerekiyorsa hemen başlatır
    assert.equal((await ui.call('status')).router.state, 'running');
    await ui.call('router/stop');
    const r = await ui.call('use', { provider: 'opencode-go', model: 'gpt-6-luna', tools: ['claude'] });
    assert.equal(r.routerAutoStarted, true);
    assert.equal(r.router.state, 'running');
  } finally { await ui.stop(); }
  assert.equal(await probeRouter(port), false, 'uygulamadan çıkınca yönlendirici kapanır');
  ui = await open();                                         // yeniden açılış: ayar kalıcı, yönlendirici kendiliğinden kalkar
  try {
    assert.equal(ui.routerRunning(), true);
    assert.equal((await ui.call('info')).settings.routerAutoStart, true);
  } finally { await ui.stop(); }
  assert.equal(await probeRouter(port), false);
  const ui2 = await open({ autoStartRouter: false });
  try { assert.equal(ui2.routerRunning(), false); } finally { await ui2.stop(); }
  core.setSettings({ routerAutoStart: false });
});

test('arayüz: yedekleri listele ve geri yükle, resmî giriş, orijinalleri geri yükle', async () => {
  const ui = await open();
  try {
    core.restore(['claude']); // earlier tests touched Claude; start from a clean original
    const settings = core.toolFile('claude');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ theme: 'dark' }));
    core.setKey('openrouter', 'sk-or-1');
    await ui.call('use', { provider: 'openrouter', model: 'anthropic/claude-sonnet-5', tools: ['claude'] });
    await ui.call('use', { provider: 'openrouter', model: 'anthropic/claude-opus-5', tools: ['claude'] });
    const bs = await ui.call('backups');
    assert.ok(bs.length >= 1);
    const newest = bs.find(b => b.files.some(f => f.startsWith('claude')));
    const name = newest.files.find(f => f.startsWith('claude'));
    const rb = await ui.call('backups/restore', { id: newest.id, name });
    assert.equal(rb.tool, 'claude');
    assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).env.ANTHROPIC_MODEL, 'anthropic/claude-sonnet-5');
    assert.equal((await ui.call('backups/restore', { id: '../../etc', name: 'passwd' })).status, 400, 'yol geçişi reddedilir');
    const off = await ui.call('official', { tools: ['claude'] });
    assert.equal(off[0].tool, 'claude');
    assert.equal((await ui.call('status')).claude.mode, 'official');
    const rs = await ui.call('restore', { tools: ['claude'] });
    assert.equal(rs[0].restored, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { theme: 'dark' });
    const info = await ui.call('info');
    assert.equal(info.paths.claude, settings);
    assert.ok(info.version);
  } finally { await ui.stop(); }
});
