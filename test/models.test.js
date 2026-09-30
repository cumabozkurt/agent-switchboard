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
