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
