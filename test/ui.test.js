import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
sandbox();
const { startUi } = await import('../src/ui/server.js');

test('arayüz API belirteç olmadan reddeder, belirteçle çalışır', async () => {
  const { server, url, token } = await startUi({ port: 0, open: false });
  const base = url.split('#')[0];
  const bad = await fetch(base + 'api/providers', { method: 'POST' });
  assert.equal(bad.status, 403);
  const ok = await fetch(base + 'api/providers', { method: 'POST', headers: { 'x-aswitch-token': token } });
  const list = await ok.json();
  assert.ok(list.find(p => p.id === 'openrouter'));
  server.close();
});

test('arayüz: uzak model kimlikleri ve etiketler HTML olarak yorumlanmaz', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  const script = html.slice(html.indexOf('<script>'));
  // innerHTML'e giden her ${...} ifadesi esc() ile sarılmalı
  const interpolations = [...script.matchAll(/innerHTML = [^;]*/g)].flatMap(m => [...m[0].matchAll(/\$\{([^}]*)\}/g)].map(x => x[1]));
  assert.ok(interpolations.length > 0);
  for (const expr of interpolations) assert.ok(/^esc\(|^p\.hasKey/.test(expr.trim()), `kaçışsız ifade: ${expr}`);
  const esc = new Function(`${script.match(/const esc = [^\n]*/)[0]}; return esc;`)();
  assert.equal(esc('<img src=x onerror=alert(1)>"'), '&lt;img src=x onerror=alert(1)&gt;&quot;');
});

test('arayüz: yabancı Host başlığı (DNS yeniden bağlama) reddedilir', async () => {
  const http = await import('node:http');
  const { server } = await startUi({ port: 0, open: false });
  const status = await new Promise(r => http.get({ host: '127.0.0.1', port: server.address().port, path: '/', headers: { host: 'evil.example' } }, res => { res.resume(); r(res.statusCode); }));
  assert.equal(status, 403);
  server.close();
});
