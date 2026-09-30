import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox } from './helpers.js';

const dir = sandbox();
process.env.ASWITCH_NO_UPDATE_CHECK = '1';
const core = await import('../src/core.js');
const usage = await import('../src/usage.js');
const { fetchModels, bundledModels, normalizeModels } = await import('../src/models.js');
const { parseCodexMcp } = await import('../src/mcp.js');
const bin = new URL('../bin/aswitch.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, ASWITCH_LANG: 'en' }, cwd: dir });

test('yeni hazır sağlayıcılar: uç noktalar ve araç desteği', () => {
  const list = Object.fromEntries(core.providers().map(p => [p.id, p]));
  for (const id of ['minimax', 'xai', 'groq', 'mistral', 'cerebras', 'nvidia', 'siliconflow', 'lmstudio']) assert.ok(list[id], id);
  assert.equal(list.xai.codexDirect, true);
  assert.equal(list.groq.codexDirect, false);
  assert.equal(list.lmstudio.noKey, true);
  assert.equal(list.gemini.geminiDirect, true);
  assert.equal(list.minimax.gemini, true);
});

test('yedek zinciri yapılandırması: set/get/clear, hatalı biçim ve araç reddedilir, routerTargets zinciri taşır', async () => {
  core.setKey('deepseek', 'sk-deepseek-123456'); core.setKey('openrouter', 'sk-or-123456789');
  assert.deepEqual(core.setFallback('claude', ['openrouter:deepseek/deepseek-chat', 'ollama:qwen3']).claude, [{ provider: 'openrouter', model: 'deepseek/deepseek-chat' }, { provider: 'ollama', model: 'qwen3' }]);
  assert.throws(() => core.setFallback('opencode', ['a:b']), /claude \| codex \| gemini/);
  assert.throws(() => core.setFallback('claude', ['nocolon']), /provider:model|sağlayıcı:model/);
  assert.throws(() => core.setFallback('claude', ['nope:x']), /nope/);
  await core.useProvider({ provider: 'deepseek', model: 'deepseek-chat', tools: ['codex'] });
  core.setFallback('codex', ['openrouter:openai/gpt-5']);
  const tg = core.routerTargets();
  assert.equal(tg.codex.fallbacks[0].provider, 'openrouter');
  assert.equal(tg.codex.fallbacks[0].codexApi('openai/gpt-5'), 'responses');
  assert.equal(core.status().router.fallback.claude.length, 2);
  core.setFallback('claude', []); core.setFallback('codex', []);
  assert.deepEqual(core.getFallback(), { claude: [], codex: [], gemini: [] });
  // yönlendirici gerekmezse zincir temizlenince router kaydı da kalkar
  core.useOfficial(['codex']);
  assert.equal(core.status().router, null);
});

test('profiller: kaydet, listele, uygula (araçlar gruplanır), resmî mod, sil; elle geçiş etkin profili düşürür', async () => {
  await core.useProvider({ provider: 'deepseek', model: 'deepseek-chat', tools: ['claude', 'opencode'] });
  core.useOfficial(['codex']);
  core.saveProfile('ucuz');
  assert.throws(() => core.saveProfile('bad name!'), /profile|Profil/i);
  core.setKey('moonshot', 'sk-moon-123456789');
  await core.useProvider({ provider: 'moonshot', model: 'kimi-k2', tools: ['claude', 'opencode', 'codex'] });
  const r = await core.useProfile('ucuz');
  assert.deepEqual(r.results.map(x => x.tool).sort(), ['claude', 'codex', 'opencode']);
  const st = core.status();
  assert.equal(st.active.claude.provider, 'deepseek');
  assert.equal(st.active.opencode.provider, 'deepseek');
  assert.equal(st.active.codex.provider, 'official');
  assert.equal(st.activeProfile, 'ucuz');
  assert.equal(core.listProfiles()[0].name, 'ucuz');
  await core.useProvider({ provider: 'moonshot', model: 'kimi-k2', tools: ['claude'] });
  assert.equal(core.status().activeProfile, null);
  await assert.rejects(core.useProfile('yok'), /yok/);
});

test('proje profili: .aswitch.json bulunur (üst klasörler dahil) ve yalnızca gerektiğinde uygulanır', async () => {
  const proj = path.join(dir, 'proj', 'sub');
  fs.mkdirSync(proj, { recursive: true });
  const f = core.setProjectProfile('ucuz', path.join(dir, 'proj'));
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { profile: 'ucuz' });
  assert.equal(core.projectProfile(proj).profile, 'ucuz');
  assert.equal((await core.applyProjectProfile(proj)).applied, true);
  assert.equal(core.status().active.claude.provider, 'deepseek');
  assert.equal((await core.applyProjectProfile(proj)).applied, false);
  assert.throws(() => core.setProjectProfile('yok', proj), /yok/);
  assert.equal(core.projectProfile(path.parse(dir).root), null);
});

test('dışa/içe aktarma: anahtarlar yalnızca istenirse; mevcut kayıtlar korunur, --overwrite ile değişir', () => {
  core.addProvider('my-proxy', { openaiBase: 'https://proxy.example/v1' });
  core.setFallback('claude', ['openrouter:x/y']);
  const ex = core.exportConfig();
  assert.equal(ex.format, 'agent-switchboard');
  assert.equal('keys' in ex, false);
  assert.equal(ex.providers['my-proxy'].openaiBase, 'https://proxy.example/v1');
  assert.ok(ex.profiles.ucuz);
  const withKeys = core.exportConfig({ withKeys: true });
  assert.equal(withKeys.keys.deepseek, 'sk-deepseek-123456');
  // yeni bir kurulum
  sandbox();
  assert.throws(() => core.importConfig({ format: 'x' }), /agent-switchboard/);
  const c = core.importConfig(withKeys);
  assert.deepEqual(c, { providers: 1, profiles: 1, keys: 3, fallback: 1 });
  assert.equal(core.getProviderKey('deepseek'), 'sk-deepseek-123456');
  assert.equal(core.getFallback().claude[0].model, 'x/y');
  assert.deepEqual(core.importConfig(withKeys), { providers: 0, profiles: 0, keys: 0, fallback: 0 });
  assert.equal(core.importConfig(withKeys, { overwrite: true }).profiles, 1);
});

test('MCP: dört aracın sunucuları okunur; Claude → Codex/OpenCode/Gemini eşitlenir, mevcutlar korunur, tekrar eşitleme kararlı', () => {
  const home = sandbox();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { fs: { command: 'npx', args: ['-y', '@mcp/fs', '/tmp'], env: { A: '1' } }, web: { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer x' } }, 'bad name': { command: 'x' } } }));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.fs]\ncommand = "mine"\n');
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { old: { httpUrl: 'https://o/mcp' } } }));
  const res = core.syncMcp({ from: 'claude' });
  const by = Object.fromEntries(res.map(r => [r.tool, r]));
  assert.deepEqual(by.codex.added, ['web']);
  assert.deepEqual(by.codex.skipped, ['fs']);
  assert.deepEqual(by.opencode.added.sort(), ['fs', 'web']);
  assert.deepEqual(by.gemini.added.sort(), ['fs', 'web']);
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.web\]\nurl = "https:\/\/mcp\.example\/mcp"\nhttp_headers = \{ Authorization = "Bearer x" \}/);
  assert.match(toml, /command = "mine"/);
  const oc = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.deepEqual(oc.mcp.fs, { type: 'local', command: ['npx', '-y', '@mcp/fs', '/tmp'], environment: { A: '1' }, enabled: true });
  assert.deepEqual(oc.mcp.web, { type: 'remote', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer x' }, enabled: true });
  const gs = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
  assert.deepEqual(gs.mcpServers.fs, { command: 'npx', args: ['-y', '@mcp/fs', '/tmp'], env: { A: '1' } });
  assert.deepEqual(gs.mcpServers.web, { httpUrl: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer x' } });
  assert.ok(gs.mcpServers.old);
  const all = core.allMcp();
  assert.deepEqual(all.codex.servers.map(s => s.name).sort(), ['fs', 'web']);
  assert.equal(all.claude.servers.length, 3);
  // ikinci eşitleme hiçbir şey eklemez; --overwrite yönetilen Codex bloğunu yeniden yazar ama kullanıcınınkine dokunmaz
  assert.ok(core.syncMcp({ from: 'claude' }).every(r => !r.added.length));
  const ov = core.syncMcp({ from: 'claude', to: ['codex'], overwrite: true });
  assert.deepEqual(ov[0].added, ['web']);
  assert.equal((fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/\[mcp_servers\.web\]/g) || []).length, 1);
  assert.throws(() => core.syncMcp({ from: 'codex', to: ['claude'] }), /codex \| opencode \| gemini/);
  // restore Codex → MCP bloğu da gider
  core.restore(['codex']);
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), 'model = "gpt-5"\n\n[mcp_servers.fs]\ncommand = "mine"\n');
});

test('MCP: Codex TOML ayrıştırıcı alt tabloları ve satır içi tabloları okur', () => {
  const s = parseCodexMcp('[mcp_servers."my-srv"]\ncommand = "node"\nargs = ["a", \'b\']\n\n[mcp_servers.my-srv.env]\nX = "1"\n\n[mcp_servers.r]\nurl = "https://r"\n[other]\nk = 1\n');
  assert.deepEqual(s, [{ name: 'my-srv', type: 'stdio', command: 'node', args: ['a', 'b'], env: { X: '1' } }, { name: 'r', type: 'http', url: 'https://r', headers: {} }]);
});

test('uç nokta testi: gecikme, reddedilen anahtar ve ulaşılamayan uç nokta', async () => {
  sandbox();
  core.setKey('openai', 'sk-openai-123456'); core.setKey('anthropic', 'sk-ant-123456');
  const seen = [];
  const fetchImpl = async (url, opt) => {
    seen.push({ url, opt });
    if (url.includes('openai')) return new Response('{}', { status: 200 });
    if (url.includes('anthropic')) return new Response('{}', { status: 401 });
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  const r = await core.pingProviders(undefined, { fetchImpl });
  const by = Object.fromEntries(r.map(x => [x.id, x]));
  assert.deepEqual(Object.keys(by).sort(), ['anthropic', 'openai']);
  assert.equal(by.openai.ok, true);
  assert.equal(by.anthropic.auth, 'rejected');
  assert.equal(seen.find(s => s.url.includes('anthropic')).opt.headers['x-api-key'], 'sk-ant-123456');
  const off = await core.pingProviders(['ollama'], { fetchImpl });
  assert.equal(off[0].error, 'ECONNREFUSED');
  await assert.rejects(core.pingProviders(['nope'], { fetchImpl }), /nope/);
});

test('güncelleme denetimi: sürüm karşılaştırma, önbellek, devre dışı bırakma', async () => {
  assert.equal(core.compareVersions('0.3.0', '0.2.9'), 1);
  assert.equal(core.compareVersions('v0.10.0', '0.9.0'), 1);
  assert.equal(core.compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(core.compareVersions('0.3.0', '0.3.0'), 0);
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://github.com/x/releases/v9.9.9', body: 'notes' }), { status: 200 }); };
  assert.equal((await core.checkForUpdate('0.3.0', { fetchImpl })).disabled, true);
  const u = await core.checkForUpdate('0.3.0', { force: true, fetchImpl });
  assert.equal(u.update, true);
  assert.equal(u.latest, '9.9.9');
  assert.match(u.install, /github:cumabozkurt\/agent-switchboard#v9\.9\.9/);
  delete process.env.ASWITCH_NO_UPDATE_CHECK;
  await core.checkForUpdate('0.3.0', { fetchImpl });
  assert.equal(calls, 1, '12 saatlik önbellek');
  // API hız sınırı (403) → github.com releases/latest yönlendirmesine düşülür
  const limited = async (url) => url.includes('api.github.com') ? new Response('{}', { status: 403 })
    : new Response(null, { status: 302, headers: { location: 'https://github.com/cumabozkurt/agent-switchboard/releases/tag/v1.2.3' } });
  const r = await core.checkForUpdate('0.3.0', { force: true, fetchImpl: limited });
  assert.equal(r.latest, '1.2.3');
  assert.equal(r.update, true);
  process.env.ASWITCH_NO_UPDATE_CHECK = '1';
});

test('model listesi: fiyatlar korunur; çevrimdışıyken önbellek, o da yoksa paketteki anlık görüntü kullanılır', async () => {
  const [m] = normalizeModels({ data: [{ id: 'a/b', pricing: { prompt: '0.000001', completion: '0.000002' } }] });
  assert.deepEqual(m.pricing, { prompt: 0.000001, completion: 0.000002 });
  sandbox();
  const snap = bundledModels('openrouter');
  assert.ok(Array.isArray(snap) && snap.length > 10);
  assert.equal(bundledModels('../etc'), null);
  const offline = async () => { throw new TypeError('fetch failed'); };
  const list = await fetchModels({ id: 'openrouter', modelsUrl: 'https://openrouter.ai/api/v1/models' }, '', { refresh: true, fetchImpl: offline });
  assert.equal(list.offline, true);
  assert.equal(list.length, snap.length);
  await assert.rejects(fetchModels({ id: 'deepseek', modelsUrl: 'https://x/models' }, '', { refresh: true, fetchImpl: offline }), /deepseek/);
});

test('kullanım kaydı: yazma, özet (sağlayıcı/model), maliyet tahmini, kırpma değil temizleme', () => {
  sandbox();
  fs.mkdirSync(process.env.ASWITCH_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.ASWITCH_DIR, 'models-cache.json'), JSON.stringify({ openrouter: { at: Date.now(), models: [{ id: 'x/y', pricing: { prompt: 0.000001, completion: 0.000002 } }] } }));
  assert.equal(usage.estimateCost('openrouter', 'x/y', 1000, 500), 0.002);
  assert.equal(usage.estimateCost('deepseek', 'z', 1, 1), null);
  const now = new Date().toISOString();
  usage.recordUsage({ ts: now, tool: 'claude', provider: 'openrouter', model: 'x/y', status: 200, ms: 100, ttft: 40, in: 1000, out: 500, cost: 0.002 });
  usage.recordUsage({ ts: now, tool: 'claude', provider: 'openrouter', model: 'x/y', status: 500, ms: 300, ttft: null, in: 0, out: 0, cost: 0, error: 'x' });
  usage.recordUsage({ ts: now, tool: 'codex', provider: 'deepseek', model: 'z', status: 200, ms: 50, ttft: 10, in: 10, out: 5, cost: null });
  usage.recordUsage({ ts: '2020-01-01T00:00:00.000Z', tool: 'codex', provider: 'old', model: 'o', status: 200, ms: 1, in: 1, out: 1 });
  const s = usage.summarizeUsage(usage.readUsage({ since: Date.now() - 864e5 }));
  assert.equal(s.total.requests, 3);
  assert.equal(s.total.errors, 1);
  assert.equal(s.total.cost, 0.002);
  assert.deepEqual({ ...s.rows[0], last: undefined }, { provider: 'openrouter', model: 'x/y', requests: 2, errors: 1, input: 1000, output: 500, cost: 0.002, avgMs: 200, avgTtft: 40, last: undefined });
  assert.equal(usage.readUsage().length, 4);
  if (process.platform !== 'win32') assert.equal(fs.statSync(usage.usagePath()).mode & 0o777, 0o600);
  usage.clearUsage();
  assert.deepEqual(usage.readUsage(), []);
  core.setRouterLog(false);
  assert.equal(core.routerLogEnabled(), false);
  core.setRouterLog(true);
  assert.equal(core.routerLogEnabled(), true);
  assert.equal(core.status().router, null);
});

test('CLI: yeni komutlar (providers, profile, fallback, usage, mcp, export/import, ping, update yardım)', () => {
  const h = cli('--help').stdout;
  for (const c of ['profile save', 'ping', 'fallback', 'usage', 'mcp sync', 'export', 'import', 'update', 'gemini']) assert.ok(h.includes(c), c);
  assert.match(cli('providers').stdout, /lmstudio/);
  assert.match(cli('profile', 'list').stdout, /No profiles yet/);
  assert.match(cli('fallback').stdout, /Gemini CLI/);
  assert.match(cli('usage').stdout, /0 requests/);
  assert.match(cli('mcp').stdout, /Claude Code \(0\)/);
  const ex = path.join(dir, 'exp.json');
  assert.equal(cli('export', ex).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(ex, 'utf8')).format, 'agent-switchboard');
  assert.match(cli('import', ex).stdout, /Imported:/);
  assert.match(cli('ping').stdout, /No provider with a key/);
  assert.match(cli('usage', '--log', 'off').stdout, /off/);
  assert.match(cli('usage', '--log', 'on').stdout, /on/);
  assert.match(cli('fallback', 'set', 'opencode', 'a:b').stderr, /claude \| codex \| gemini/);
});

test('ortam değişkeni çakışmaları: yapılandırmanın önüne geçen değişkenler bildirilir (değerleri değil)', () => {
  assert.deepEqual(core.envConflicts({}), []);
  const c = core.envConflicts({ ANTHROPIC_BASE_URL: 'x', GEMINI_API_KEY: 'secret', PATH: '/bin' });
  assert.deepEqual(c, [{ tool: 'claude', name: 'ANTHROPIC_BASE_URL' }, { tool: 'gemini', name: 'GEMINI_API_KEY' }]);
  assert.ok(!JSON.stringify(c).includes('secret'));
  assert.ok(Array.isArray(core.status().envConflicts));
});

test('içe aktarma: kayıtlı anahtar başka sunucuya yönlendirilemez; profiller temizlenir', () => {
  sandbox();
  core.addProvider('mygw', { openaiBase: 'https://gw.example.com/v1' });
  core.setKey('mygw', 'sk-secret');
  const file = { format: 'agent-switchboard', formatVersion: 1,
    providers: { mygw: { openaiBase: 'https://evil.example.net/v1' } },
    profiles: { p1: { tools: { claude: { provider: 'mygw', model: 'm', evil: 'x' }, bogus: { provider: 'x' } } }, empty: { tools: { nope: {} } } } };
  core.importConfig(file, { overwrite: false });
  assert.equal(core.getProviderKey('mygw'), 'sk-secret', 'overwrite olmadan dokunulmaz');
  core.importConfig(file, { overwrite: true });
  assert.equal(core.getProviderKey('mygw'), '', 'adres değişince eski anahtar silinir');
  const ps = core.listProfiles();
  assert.deepEqual(ps.find(p => p.name === 'p1').tools, { claude: { provider: 'mygw', model: 'm', fastModel: null } });
  assert.ok(!ps.find(p => p.name === 'empty'));
});
