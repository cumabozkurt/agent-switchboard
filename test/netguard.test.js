import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOutboundUrl, checkPort, isPrivateHost } from '../src/netguard.js';
import { normalizeModels } from '../src/models.js';

test('netguard: private host detection', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5', '169.254.1.1', '[::1]', 'fd00::1', 'box.local', 'nas.lan', 'host.docker.internal', 'gateway'])
    assert.equal(isPrivateHost(h), true, h);
  for (const h of ['api.openai.com', '8.8.8.8', '172.32.0.1', '2001:4860::8888', 'example.com'])
    assert.equal(isPrivateHost(h), false, h);
});

test('netguard: outbound URL policy', () => {
  assert.equal(checkOutboundUrl('https://api.example.com/v1'), 'https://api.example.com/v1');
  assert.ok(checkOutboundUrl('http://127.0.0.1:11434/v1'));
  assert.ok(checkOutboundUrl('http://gpu-box.lan:8000/v1'));
  assert.throws(() => checkOutboundUrl('http://api.example.com/v1'), /http|şifresiz|unencrypted/i);
  assert.throws(() => checkOutboundUrl('https://user:pw@api.example.com'));
  assert.throws(() => checkOutboundUrl('file:///etc/passwd'));
  assert.throws(() => checkOutboundUrl('javascript:alert(1)'));
  assert.throws(() => checkOutboundUrl('not a url'));
});

test('netguard: port validation', () => {
  assert.equal(checkPort('8080'), 8080);
  for (const p of [0, 70000, 'abc', 1.5, -1]) assert.throws(() => checkPort(p));
});

test('models: normalizeModels sanitizes untrusted model lists', () => {
  const out = normalizeModels({ data: [
    { id: 'ok-model', context_length: 128000 },
    { id: 'bad\u0000id' },
    { id: 'x'.repeat(500) },
    { id: 'neg', context_length: -5 },
  ] });
  const ids = out.map((m) => m.id);
  assert.ok(ids.includes('ok-model'));
  assert.ok(!ids.some((i) => /[\u0000-\u001f]/.test(i)));
  assert.ok(!ids.some((i) => i.length > 200));
  const neg = out.find((m) => m.id === 'neg');
  if (neg) assert.ok(!(neg.context < 0) && !(neg.context_length < 0));
});
