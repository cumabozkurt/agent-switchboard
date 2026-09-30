import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';
sandbox();
const { normalizeModels, resolveModelAlias, fetchModels } = await import('../src/models.js');

const list = normalizeModels({ data: [
  { id: 'claude-opus-4-7', created: 100 }, { id: 'claude-opus-4-8', created: 300 },
  { id: 'gpt-5', created: 200 }, { id: 'claude-haiku-4-5', created_at: '2025-10-01T00:00:00Z' }
] });

test('modeller yeniden eskiye sıralanır', () => assert.equal(list[0].id, 'claude-haiku-4-5'));
test('latest en yeniyi seçer', () => assert.equal(resolveModelAlias('latest', list), 'claude-haiku-4-5'));
test('latest:filtre ailedeki en yeniyi seçer', () => assert.equal(resolveModelAlias('latest:opus', list), 'claude-opus-4-8'));
test('tam ad aynen kalır', () => assert.equal(resolveModelAlias('gpt-5', list), 'gpt-5'));

test('fetchModels Anthropic başlıklarını kullanır', async () => {
  let seen;
  const fake = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ data: [{ id: 'x', created_at: '2026-01-01' }] }) }; };
  const r = await fetchModels({ id: 'anthropic', modelsUrl: 'https://api.anthropic.com/v1/models', modelsAuth: 'anthropic' }, 'k', { refresh: true, fetchImpl: fake });
  assert.equal(r[0].id, 'x');
  assert.equal(seen.opts.headers['x-api-key'], 'k');
  assert.match(seen.url, /limit=1000/);
});

test('tarih bilgisi taşımayan listelerde (hepsi aynı created) sürüm numarasına göre sıralanır', () => {
  const l = normalizeModels({ data: [
    { id: 'claude-opus-4-8', created: 1790799844 }, { id: 'claude-opus-5-5', created: 1790799844 },
    { id: 'claude-opus-5', created: 1790799844 }, { id: 'claude-fable-5', created: 1790799844 }, { id: 'claude-fable-5-1', created: 1790799844 }
  ] });
  assert.ok(l.every(m => m.created === 0));
  assert.equal(resolveModelAlias('latest:opus', l), 'claude-opus-5-5');
  assert.equal(resolveModelAlias('latest:fable', l), 'claude-fable-5-1');
});

test('eşit tarihte bile sonuç liste sırasına bağlı değil', () => {
  const a = normalizeModels([{ id: 'gpt-5.4', created: 5 }, { id: 'gpt-5.5', created: 5 }, { id: 'x', created: 1 }]);
  const b = normalizeModels([{ id: 'gpt-5.5', created: 5 }, { id: 'gpt-5.4', created: 5 }, { id: 'x', created: 1 }]);
  assert.equal(resolveModelAlias('latest:gpt', a), 'gpt-5.5');
  assert.equal(resolveModelAlias('latest:gpt', b), 'gpt-5.5');
});

test('geçersiz öğeler ve boş gövde hataya yol açmaz', () => {
  assert.deepEqual(normalizeModels(null), []);
  assert.equal(normalizeModels({ data: [null, { id: 5 }, { id: 'ok' }] }).length, 1);
});

test('latest: OpenRouter varyantları (:batch, :free) ve ~ takma adları yalnızca açıkça istenince seçilir', async () => {
  const { resolveModelAlias } = await import('../src/models.js');
  const list = [
    { id: 'anthropic/claude-sonnet-5.5:batch', created: 200 },
    { id: 'anthropic/claude-sonnet-5.5', created: 200 },
    { id: '~anthropic/claude-sonnet-latest', created: 300 },
    { id: 'anthropic/claude-sonnet-5', created: 100 }
  ];
  assert.equal(resolveModelAlias('latest:claude-sonnet', list), 'anthropic/claude-sonnet-5.5');
  assert.equal(resolveModelAlias('latest:5.5:batch', list), 'anthropic/claude-sonnet-5.5:batch');
  assert.equal(resolveModelAlias('latest:~anthropic', list), '~anthropic/claude-sonnet-latest');
});
