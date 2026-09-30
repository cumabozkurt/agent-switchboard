import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dir = sandbox();
const core = await import('../src/core.js');
const { buildClaudeEnv } = await import('../src/targets/claude.js');
const f = path.join(dir, '.claude', 'settings.json');
const read = () => JSON.parse(fs.readFileSync(f, 'utf8'));

test('Claude: OpenRouter → Anthropic geçişinde BASE_URL ve AUTH_TOKEN tamamen temizlenir', async () => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ model: 'opus', env: { FOO: '1' } }));
  core.setKey('openrouter', 'sk-or');
  core.setKey('anthropic', 'sk-ant');
  await core.useProvider({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', tools: ['claude'] });
  assert.equal(read().env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
  await core.useProvider({ provider: 'anthropic', tools: ['claude'] });
  const s = read();
  assert.equal(s.env.ANTHROPIC_API_KEY, 'sk-ant');
  assert.equal(s.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(s.env.ANTHROPIC_MODEL, undefined);
  assert.equal(s.env.FOO, '1');
});

test('Claude: güncel değişkenler yazılır, kullanımdan kalkmış ANTHROPIC_SMALL_FAST_MODEL yazılmaz', () => {
  const env = buildClaudeEnv({ provider: { id: 'x', anthropicBase: 'https://x.example/anthropic' }, key: 'k', model: 'm', fastModel: 'f' });
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'm');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'm');
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'm');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'm');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'f');
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
});

test('Claude: resmî moda dönüş kullanıcının önceki "model" değerini geri koyar', () => {
  core.useOfficial(['claude']);
  const s = read();
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.env, { FOO: '1' });
});

test('Claude: yalnızca --anthropic-base ile eklenen özel sağlayıcı çalışır (Codex/OpenCode istenmezse)', async () => {
  core.addProvider('my-gw', { anthropicBase: 'https://gw.example.com/anthropic' });
  core.setKey('my-gw', 'gw-key');
  await core.useProvider({ provider: 'my-gw', model: 'claude-x', tools: ['claude'] });
  const s = read();
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'https://gw.example.com/anthropic');
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'gw-key');
  // Varsayılan (üç araç) ile istenirse hiçbir dosyaya dokunmadan anlaşılır hata verir.
  const before = fs.readFileSync(f, 'utf8');
  await assert.rejects(core.useProvider({ provider: 'my-gw', model: 'claude-y' }), /OpenAI uyumlu/);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
});

test('Claude: özel adresli "anthropic" profili BASE_URL + AUTH_TOKEN kullanır', () => {
  const env = buildClaudeEnv({ provider: { id: 'anthropic', anthropicBase: 'https://proxy.example.com' }, key: 'k' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://proxy.example.com');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'k');
});

test('Claude: bozuk settings.json asla üzerine yazılmaz', async () => {
  fs.writeFileSync(f, '{ "theme": "dark", // yorum\n');
  await assert.rejects(core.useProvider({ provider: 'openrouter', model: 'x', tools: ['claude'] }), /geçerli JSON değil/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{ "theme": "dark", // yorum\n');
});

test('Claude: Zen üzerindeki GPT modeli (yalnız /responses) Claude Code için reddedilir', async () => {
  fs.writeFileSync(f, '{}');
  core.setKey('opencode-zen', 'z');
  await assert.rejects(core.useProvider({ provider: 'opencode-zen', model: 'gpt-5.5', tools: ['claude'] }), /Claude Code ile kullanılamaz/);
  const r = await core.useProvider({ provider: 'opencode-zen', model: 'kimi-k3', tools: ['claude'] });
  assert.equal(r.results[0].viaRouter, true);
  assert.equal(core.routerTargets().claude.baseUrl, 'https://opencode.ai/zen/v1');
});

test('Claude: yönlendirici modu model olmadan reddedilir', async () => {
  core.setKey('gemini', 'g');
  await assert.rejects(core.useProvider({ provider: 'gemini', tools: ['claude'] }), /--model/);
});
