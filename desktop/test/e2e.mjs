// End-to-end check of the real Electron app (runs in CI under xvfb: .github/workflows/ci.yml → e2e). Drives the UI with Playwright, verifies the
// launch → keys → models → apply → router start/stop/restart → language switch → quit → relaunch flows,
// plus the v0.3.0 features (Gemini CLI, endpoint test, profiles, fallback, usage log, MCP sync, tray), and saves
// screenshots to docs/images/ (or $SHOTS_DIR). Uses a throw-away HOME so real ~/.claude and ~/.codex are never touched.
//
//   cd desktop && npm install && npm run sync && xvfb-run -a node test/e2e.mjs
// Network: by default everything runs against a local mock upstream and the bundled model snapshots (no internet
// needed). E2E_LIVE=1 additionally refreshes the live OpenRouter / OpenCode Zen model lists.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('..', import.meta.url));
const shots = process.env.SHOTS_DIR ? path.resolve(process.env.SHOTS_DIR) : path.join(desktop, '..', 'docs', 'images');
fs.mkdirSync(shots, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aswitch-e2e-'));
const LIVE = process.env.E2E_LIVE === '1';
// Local mock upstream (OpenAI-compatible): /v1/models and /v1/chat/completions, records the requested models.
const mockSeen = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => { b += c; });
  req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    mockSeen.push({ url: req.url, model: body.model, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/v1/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-large', created: 1790000000, context_length: 200000 }, { id: 'mock-small', created: 1780000000 }] }));
    res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'hello from ' + body.model }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockBase = `http://127.0.0.1:${mock.address().port}/v1`;
const routerPort = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const env = { ...process.env, ASWITCH_HOME_OVERRIDE: home, ASWITCH_DIR: path.join(home, '.agent-switchboard'), XDG_CONFIG_HOME: path.join(home, '.config'), LANG: 'en_US.UTF-8', LANGUAGE: 'en_US' };
for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'ASWITCH_LANG', 'LC_ALL', 'LC_MESSAGES']) delete env[k];
env.ASWITCH_NO_UPDATE_CHECK = '1'; // no GitHub API calls from CI
// Gemini CLI "installed" (config dir exists) and one MCP server configured in Claude Code.
fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', home] }, docs: { type: 'http', url: 'https://mcp.example.com/mcp' } } }));
// Pre-set the router port so the test never collides with a real router on 3456.
fs.mkdirSync(env.ASWITCH_DIR, { recursive: true });
fs.writeFileSync(path.join(env.ASWITCH_DIR, 'config.json'), JSON.stringify({ version: 1, keys: {}, providers: {}, active: {}, router: { port: routerPort } }));
// Model lists come from the snapshots bundled with the app (as if fetched a moment ago), unless E2E_LIVE=1.
if (!LIVE) {
  const cache = {};
  for (const id of ['openrouter', 'opencode-zen', 'opencode-go']) cache[id] = { at: Date.now(), models: JSON.parse(fs.readFileSync(path.join(desktop, 'models', id + '.json'), 'utf8')) };
  fs.writeFileSync(path.join(env.ASWITCH_DIR, 'models-cache.json'), JSON.stringify(cache));
}
// OS keychain: a stand-in secret-tool (files in the throwaway HOME) so the keychain card can be exercised on Linux CI.
const fakeBin = path.join(home, 'fakebin'), fakeStore = path.join(home, 'fake-keychain');
if (process.platform !== 'win32') {
  fs.mkdirSync(fakeBin, { recursive: true }); fs.mkdirSync(fakeStore, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'secret-tool'), `#!/bin/sh\ncmd=$1; shift\nwhile [ $# -gt 0 ]; do case "$1" in account) acct=$2; shift 2;; *) shift;; esac; done\nf="${fakeStore}/$acct"\ncase $cmd in store) cat > "$f";; lookup) [ -f "$f" ] || exit 1; cat "$f";; clear) rm -f "$f";; esac\n`, { mode: 0o755 });
  env.PATH = fakeBin + path.delimiter + env.PATH;
  env.ASWITCH_KEYCHAIN_BACKEND = 'linux';
}
env.ASWITCH_NO_PROTOCOL = '1';

const results = [];
// Details can contain page text: keep each result on one line (no control characters in the log).
const oneLine = v => String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300);
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + oneLine(detail) : ''}`); };
const probe = async () => { try { return (await (await fetch(`http://127.0.0.1:${routerPort}/health`, { signal: AbortSignal.timeout(800) })).json()).ok === true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch() {
  const app = await _electron.launch({ executablePath: require('electron'), args: [desktop, '--no-sandbox', '--disable-gpu'], cwd: desktop, env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForSelector('#toolCards .card');
  return { app, page };
}
const shot = (page, name) => page.screenshot({ path: path.join(shots, name) });
const tab = (page, name) => page.click('#tab-' + name);

// ---------------------------------------------------------------- first launch (English from OS locale)
let { app, page } = await launch();
check('app launches and shows the panel', await page.isVisible('#p-overview'));
check('language defaults to the OS locale (English)', (await page.getAttribute('html', 'lang')) === 'en' && (await page.textContent('#tab-switch')).includes('Switch provider'));
check('first-run welcome is shown', await page.isVisible('#welcome'));
const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
check('window title is localized', title.includes('API & model switcher'), title);
const menuEn = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(i => i.label));
check('menu is localized (English)', menuEn.includes('Edit') && menuEn.includes('Help'), menuEn.join(', '));
await shot(page, 'overview-first-run-en.png');

// keys
await tab(page, 'keys');
for (const [name, key] of [['OpenCode Go', 'demo-go-key-0123456789'], ['OpenRouter', 'sk-or-v1-demo-0123456789']]) {
  const row = page.locator('#keyRows tr', { hasText: name }).first();
  await row.locator('input').fill(key);
  await row.getByRole('button', { name: 'Save' }).click();
  await page.waitForFunction(n => [...document.querySelectorAll('#keyRows tr')].some(r => r.textContent.includes(n) && r.textContent.includes('Saved')), name);
}
check('keys saved from the UI', true);
await shot(page, 'keys-en.png');

// models (bundled snapshot / cache; live refresh only with E2E_LIVE=1)
await tab(page, 'models');
await page.selectOption('#mProv', 'openrouter');
for (let i = 0; i < (LIVE ? 2 : 1); i++) {
  if (LIVE) await page.click('#mRefresh');
  const ok = await page.waitForFunction(() => document.querySelectorAll('#mRows tr').length > 10, null, { timeout: 30000 }).then(() => true).catch(() => false);
  if (ok) break;
}
const modelRows = await page.locator('#mRows tr').count();
check(`model list loads (OpenRouter, ${LIVE ? 'live' : 'cached snapshot'})`, modelRows > 10, `${modelRows} rows`);
await page.fill('#mSearch', 'gpt');
await sleep(200);
const filtered = await page.locator('#mRows tr').count();
check('model search filters the list', filtered > 0 && filtered < modelRows, `${filtered} rows`);
await shot(page, 'models-en.png');
const codexModel = await page.evaluate(async () => {
  const r = await fetch('/api/models', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aswitch-token': location.hash.slice(1) }, body: '{"provider":"openrouter"}' });
  return (await r.json()).find(m => /^openai\/gpt-/.test(m.id) && !m.id.includes(':'))?.id || 'openai/gpt-5';
});

// apply: Codex → OpenRouter (direct Responses)
await tab(page, 'switch');
await page.selectOption('#prov', 'openrouter');
await page.fill('#model', codexModel);
await page.uncheck('input[name=swTool][value=claude]');
await page.check('input[name=swTool][value=codex]');
await page.click('#apply');
await page.waitForSelector('#applyResult:not(.hidden)');
check('apply Codex → OpenRouter', (await page.textContent('#applyResult')).includes('OPENROUTER_API_KEY'));

// apply: Claude Code → OpenCode Go gpt-6-luna (Responses-only → router)
await page.selectOption('#prov', 'opencode-go');
await page.fill('#model', 'gpt-6-luna');
await page.check('input[name=swTool][value=claude]');
await page.uncheck('input[name=swTool][value=codex]');
await page.check('input[name=swTool][value=opencode]');
await page.click('#apply');
await page.waitForFunction(() => document.querySelector('#applyResult').textContent.includes('opencode-go'));
const applyText = await page.textContent('#applyResult');
check('Responses-only model routed through the router, hint shown', /local router/.test(applyText), applyText.slice(0, 120));
await shot(page, 'switch-en.png');

// router start / restart / stop
await tab(page, 'router');
check('router shown as needed + stopped', (await page.textContent('#routerInfo')).includes('Stopped') && !(await page.isDisabled('#rStart')));
await page.click('#rStart');
await page.waitForFunction(() => document.querySelector('#routerBadge').textContent.includes('running'));
check('router starts from the UI', await probe(), `port ${routerPort}`);
await page.click('#rRestart');
await page.waitForFunction(() => document.querySelector('#log').textContent.includes('restarted'));
check('router restarts', await probe());
await shot(page, 'router-en.png');
await page.click('#rStop');
await page.waitForFunction(() => document.querySelector('#routerBadge').textContent.includes('needed'));
check('router stops and frees the port', !(await probe()));
await page.check('#rAuto');
await page.waitForFunction(() => document.querySelector('#routerBadge').textContent.includes('running'));
check('enabling auto-start starts the needed router', await probe());

await tab(page, 'overview');
await page.waitForSelector('#welcome.hidden', { state: 'attached' });
await shot(page, 'overview-en.png');
// a second change to Codex creates a timestamped backup of the first one
await page.evaluate(async m => {
  await fetch('/api/use', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aswitch-token': location.hash.slice(1) }, body: JSON.stringify({ provider: 'openrouter', model: m, tools: ['codex'] }) });
}, codexModel);
await tab(page, 'restore');
await page.waitForFunction(() => document.querySelectorAll('#bRows button').length > 0);
check('backups are listed', (await page.locator('#bRows button').count()) > 0);
await shot(page, 'restore-en.png');
await tab(page, 'env');
await page.waitForFunction(() => document.querySelector('#envOut').textContent.includes('OPENCODE_API_KEY'));
const envText = await page.textContent('#envOut');
check('environment view masks keys by default', envText.includes('OPENROUTER_API_KEY') && !envText.includes('0123456789'), envText.replace(/\n/g, ' | '));
await shot(page, 'env-en.png');
await tab(page, 'providers');
await page.fill('#cpId', 'my-proxy'); await page.fill('#cpLabel', 'My LiteLLM proxy'); await page.fill('#cpOpenai', mockBase);
await page.click('#cpAdd');
await page.waitForFunction(() => document.querySelector('#cpRows').textContent.includes('my-proxy'));
// the UI refuses to send keys over plain http to a public host
await page.fill('#cpId', 'bad-proxy'); await page.fill('#cpLabel', 'Bad'); await page.fill('#cpOpenai', 'http://proxy.example.com/v1');
await page.click('#cpAdd');
await page.waitForFunction(() => /http/.test(document.querySelector('#log').textContent) && document.querySelector('#log .err'));
check('plain-http public endpoint is rejected', !(await page.textContent('#cpRows')).includes('bad-proxy'));
await page.fill('#cpId', ''); await page.fill('#cpLabel', ''); await page.fill('#cpOpenai', '');
check('custom provider added from the UI', true);
await shot(page, 'providers-en.png');

// ---------------------------------------------------------------- v0.3.0
// Gemini CLI → local mock provider (OpenAI-compatible) through the router
await page.evaluate(async () => {
  await fetch('/api/key', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aswitch-token': location.hash.slice(1) }, body: JSON.stringify({ provider: 'my-proxy', key: 'mock-key-0123456789' }) });
});
await tab(page, 'switch');
check('Gemini CLI is offered and pre-checked when installed', await page.isChecked('input[name=swTool][value=gemini]'));
await page.reload(); await page.waitForSelector('#toolCards .card'); await tab(page, 'switch');
await page.selectOption('#prov', 'my-proxy');
await page.fill('#model', 'mock-large'); await page.fill('#fast', '');
for (const v of ['claude', 'codex', 'opencode']) await page.uncheck(`input[name=swTool][value=${v}]`);
await page.check('input[name=swTool][value=gemini]');
await page.click('#apply');
await page.waitForFunction(() => document.querySelector('#applyResult').textContent.includes('Gemini CLI'));
const genv = fs.readFileSync(path.join(home, '.gemini', '.env'), 'utf8');
check('apply Gemini CLI → custom provider via router (.env written)', genv.includes(`GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:${routerPort}`) && genv.includes('GEMINI_MODEL='), genv.replace(/\n/g, ' | '));
const gset = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'));
check('Gemini CLI settings.json uses API-key auth', gset.security?.auth?.selectedType === 'gemini-api-key');
// Gemini request through the running router reaches the mock upstream, is answered in Gemini format and logged
const gemReq = () => fetch(`http://127.0.0.1:${routerPort}/v1beta/models/gemini-3-pro:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }) });
const gres = await gemReq();
const gj = await gres.json().catch(() => ({}));
check('router answers Gemini API requests in Gemini format', gres.status === 200 && gj.candidates?.[0]?.content?.parts?.[0]?.text === 'hello from mock-large', `${gres.status} ${JSON.stringify(gj).slice(0, 160)}`);
check('upstream got the saved key and the chosen model', mockSeen.some(r => r.url === '/v1/chat/completions' && r.model === 'mock-large' && r.auth === 'Bearer mock-key-0123456789'));
await tab(page, 'overview');
await page.waitForFunction(() => document.querySelector('#toolCards').textContent.includes('Gemini CLI'));
check('overview shows a Gemini CLI card', true);
await shot(page, 'overview-en.png');

// endpoint test
await tab(page, 'keys');
await page.click('#pingAll');
await page.waitForFunction(() => /tested/.test(document.querySelector('#pingState').textContent), null, { timeout: 30000 }).catch(() => {});
const pingText = await page.locator('#keyRows td[data-ping="my-proxy"]').textContent();
check('endpoint test shows latency / key status', /\d+ ms/.test(pingText), pingText);
await shot(page, 'keys-en.png');

// profiles
await tab(page, 'profiles');
await page.fill('#pfName', 'work');
await page.click('#pfSave');
await page.waitForFunction(() => document.querySelector('#pfRows').textContent.includes('work'));
await page.locator('#pfRows tr', { hasText: 'work' }).getByRole('button', { name: 'Apply' }).click();
await page.waitForFunction(() => document.querySelector('#pfRows').textContent.includes('active'));
check('profile saved and applied from the UI', true);
await shot(page, 'profiles-en.png');

// fallback chain
await tab(page, 'router');
await page.selectOption('#fbTool', 'gemini');
await page.fill('#fbSpecs', 'opencode-go:glm-5.1, ollama:qwen3');
await page.click('#fbSave');
await page.waitForFunction(() => document.querySelector('#fbList').textContent.includes('opencode-go:glm-5.1 → ollama:qwen3'));
const health = await (await fetch(`http://127.0.0.1:${routerPort}/health`)).json();
check('fallback chain saved and live in the router', health.gemini?.fallbacks?.join(',') === 'opencode-go:glm-5.1,ollama:qwen3', JSON.stringify(health.gemini?.fallbacks));

// v0.4.0: load balancing (round-robin) across two models of the mock provider, scenario routing, circuit breaker
await page.selectOption('#lbTool', 'gemini');
await page.selectOption('#lbStrategy', 'round-robin');
await page.fill('#lbSpecs', 'my-proxy:mock-large, my-proxy:mock-small');
await page.click('#lbSave');
await page.waitForFunction(() => document.querySelector('#lbList').textContent.includes('mock-small'));
mockSeen.length = 0;
for (let i = 0; i < 4; i++) await (await gemReq()).json();
const seenModels = mockSeen.filter(r => r.url === '/v1/chat/completions').map(r => r.model);
check('round-robin load balancing spreads requests', seenModels.filter(m => m === 'mock-large').length === 2 && seenModels.filter(m => m === 'mock-small').length === 2, seenModels.join(','));
await page.selectOption('#scTool', 'gemini');
await page.selectOption('#scName', 'longContext');
await page.fill('#scSpec', 'my-proxy:mock-long');
await page.click('#scSave');
await page.fill('#scThreshold', '1000');
await page.click('#scThresholdSave');
await page.waitForFunction(() => document.querySelector('#scList').textContent.includes('mock-long'));
mockSeen.length = 0;
await (await fetch(`http://127.0.0.1:${routerPort}/v1beta/models/gemini-3-pro:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'long '.repeat(2000) }] }] }) })).json();
check('scenario routing sends long prompts to the long-context model', mockSeen.some(r => r.model === 'mock-long'), mockSeen.map(r => r.model).join(','));
// (the Router tab reloads its policy cards after each save, so re-fill if a reload raced the typing)
let h2 = {};
for (let attempt = 0; attempt < 3 && h2.breaker?.failures !== 5; attempt++) {
  await sleep(300);
  await page.fill('#brFailures', '5'); await page.fill('#brCooldown', '45');
  await page.click('#brSave');
  for (let i = 0; i < 12 && h2.breaker?.failures !== 5; i++) { await sleep(250); h2 = await (await fetch(`http://127.0.0.1:${routerPort}/health`)).json(); }
}
check('balance / scenario / breaker are live in the router', h2.gemini?.balance?.strategy === 'round-robin' && h2.gemini?.scenarios?.longContext && h2.breaker?.failures === 5 && h2.breaker?.cooldownSec === 45, JSON.stringify({ b: h2.gemini?.balance, s: h2.gemini?.scenarios, br: h2.breaker }));
await shot(page, 'router-en.png');

// usage log
await tab(page, 'usage');
await page.waitForFunction(() => document.querySelectorAll('#usRecent tr').length > 0, null, { timeout: 10000 }).catch(() => {});
check('usage tab lists the routed request', (await page.textContent('#usRecent')).includes('my-proxy'), (await page.textContent('#usTotal')));
await shot(page, 'usage-en.png');

// MCP
await tab(page, 'mcp');
await page.waitForFunction(() => document.querySelector('#mcpRows').textContent.includes('filesystem'));
await page.click('#mcpSync');
await page.waitForFunction(() => (document.querySelector('#mcpRows').textContent.match(/filesystem/g) || []).length >= 4);
const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
check('MCP servers synced from Claude Code to Codex/OpenCode/Gemini', toml.includes('[mcp_servers.filesystem]') && JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8')).mcpServers?.docs?.httpUrl === 'https://mcp.example.com/mcp');
await shot(page, 'mcp-en.png');

// tray
const trayOk = await app.evaluate(() => !!globalThis.aswitchTray);
check('tray / menu bar icon created', trayOk);
await tab(page, 'settings');
// deep links: create a share link for the custom provider, open one → confirmation dialog (nothing applied on cancel)
await page.selectOption('#lkKind', 'provider');
await page.waitForFunction(() => [...document.querySelectorAll('#lkId option')].some(o => o.value === 'my-proxy'));
await page.selectOption('#lkId', 'my-proxy');
await page.click('#lkMake');
await page.waitForFunction(() => document.querySelector('#lkOut').value.startsWith('aswitch://provider?'));
const madeLink = await page.inputValue('#lkOut');
check('share link created for a custom provider (no key inside)', madeLink.includes('id=my-proxy') && !madeLink.includes('mock-key'), madeLink);
await page.fill('#lkIn', 'aswitch://provider?id=team-gw&label=Team%20gateway&openaiBase=https%3A%2F%2Fgw.example.com%2Fv1&key=sk-should-not-be-saved');
await page.click('#lkPreview');
await page.waitForSelector('#linkDialog[open]', { timeout: 10000 }).catch(async () => console.log('LOG:', await page.textContent('#log')));
const dlgText = await page.textContent('#linkDialog');
check('opening a link shows a confirmation dialog with the endpoint and a key warning', dlgText.includes('https://gw.example.com/v1') && /removed/.test(dlgText), dlgText.slice(0, 160));
await shot(page, 'link-dialog-en.png');
await page.click('#ldCancel');
check('cancelled link changes nothing', !JSON.parse(fs.readFileSync(path.join(env.ASWITCH_DIR, 'config.json'), 'utf8')).providers['team-gw']);
// OS keychain (fake secret-tool on Linux CI): move keys in and back out
if (process.platform !== 'win32') {
  await page.waitForFunction(() => !document.querySelector('#kcOn').disabled);
  await page.click('#kcOn');
  await page.waitForFunction(() => /moved/.test(document.querySelector('#log').textContent));
  const cfgK = JSON.parse(fs.readFileSync(path.join(env.ASWITCH_DIR, 'config.json'), 'utf8'));
  check('keys moved to the OS keychain from the UI', cfgK.keyStore === 'keychain' && cfgK.keys.openrouter === '@keychain' && fs.readFileSync(path.join(fakeStore, 'openrouter'), 'utf8') === 'sk-or-v1-demo-0123456789');
  const r2 = await gemReq();
  check('router still authenticates with a keychain-stored key', r2.status === 200 && mockSeen.at(-1)?.auth === 'Bearer mock-key-0123456789');
  await shot(page, 'settings-en.png');
  await page.click('#kcOff');
  await page.waitForFunction(() => (document.querySelector('#log').textContent.match(/moved/g) || []).length >= 2);
  check('keys moved back to config.json', JSON.parse(fs.readFileSync(path.join(env.ASWITCH_DIR, 'config.json'), 'utf8')).keys.openrouter === 'sk-or-v1-demo-0123456789');
} else await shot(page, 'settings-en.png');

// language switch → Turkish (UI + menu + title), persisted
await page.selectOption('#langQuick', 'tr');
await page.waitForFunction(() => document.documentElement.lang === 'tr');
await tab(page, 'overview');
check('UI switches to Turkish', (await page.textContent('#tab-switch')) === 'Sağlayıcı değiştir');
const menuTr = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(i => i.label));
check('menu switches to Turkish', menuTr.includes('Düzen') && menuTr.includes('Yardım'), menuTr.join(', '));
const titleTr = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
check('window title switches to Turkish', titleTr.includes('API ve model değiştirici'), titleTr);
await shot(page, 'overview-tr.png');
await tab(page, 'switch'); await shot(page, 'switch-tr.png');
await tab(page, 'router'); await shot(page, 'router-tr.png');
await tab(page, 'keys'); await shot(page, 'keys-tr.png');
await tab(page, 'models');
await page.selectOption('#mProv', 'opencode-zen');
// Live network list only with E2E_LIVE=1 (retry once on a transient failure); otherwise the cached snapshot.
for (let i = 0; i < (LIVE ? 2 : 1); i++) {
  if (LIVE) await page.click('#mRefresh');
  const ok = await page.waitForFunction(() => document.querySelectorAll('#mRows tr').length > 5, null, { timeout: 30000 }).then(() => true).catch(() => false);
  if (ok) break;
}
check(`model list loads (OpenCode Zen, ${LIVE ? 'live' : 'cached snapshot'})`, (await page.locator('#mRows tr').count()) > 5, `${await page.locator('#mRows tr').count()} rows`);
await shot(page, 'models-tr.png');
await tab(page, 'profiles'); await page.waitForFunction(() => document.querySelector('#pfRows').textContent.includes('work')); await shot(page, 'profiles-tr.png');
await tab(page, 'usage'); await sleep(300); await shot(page, 'usage-tr.png');
await tab(page, 'mcp'); await sleep(300); await shot(page, 'mcp-tr.png');
// server-side errors follow the language
await tab(page, 'switch');
await page.selectOption('#prov', 'opencode-zen');
await page.fill('#model', 'gemini-3-pro'); await page.check('input[name=swTool][value=claude]');
await page.click('#apply');
await page.waitForFunction(() => document.querySelector('#log').textContent.includes('Hata:'));
check('server errors are translated', (await page.textContent('#log')).includes('uç noktayı kullanamaz') || (await page.textContent('#log')).includes('anahtar yok'));

// keyboard: tabs are reachable with arrow keys
await page.focus('#tab-switch'); await page.keyboard.press('ArrowDown');
check('tabs support keyboard navigation', await page.isVisible('#p-keys'));

// quit with the router running → port released
check('router running before quit', await probe());
await app.close();
await sleep(300);
check('quitting the app stops the router', !(await probe()));

// relaunch: language + auto-start persisted
({ app, page } = await launch());
await page.waitForFunction(() => document.querySelector('#routerBadge').textContent.includes(':'));
check('relaunch keeps Turkish', (await page.getAttribute('html', 'lang')) === 'tr');
check('relaunch auto-starts the needed router', await probe());
// A second launch carrying an aswitch:// link (what the OS does on click) → no second window, the running
// app shows the confirmation dialog; the provider is added only after "Import", and never with the key.
const link = 'aswitch://provider?id=shared-gw&label=Shared&openaiBase=https%3A%2F%2Fshared.example.com%2Fv1&apikey=sk-nope';
// Plain child process (not Playwright): the second instance quits right away, which a debugger attach would race.
const { spawn } = await import('node:child_process');
const second = spawn(require('electron'), [desktop, '--no-sandbox', '--disable-gpu', link], { cwd: desktop, env, stdio: 'ignore' });
const secondExit = await Promise.race([new Promise(r => second.on('exit', c => r(c ?? 0))), sleep(15000).then(() => 'timeout')]);
if (secondExit === 'timeout') second.kill();
const winCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
check('second instance exits and does not open a second window', secondExit !== 'timeout' && winCount === 1, `exit ${secondExit}, windows ${winCount}`);
const gotDlg = await page.waitForSelector('#linkDialog[open]', { timeout: 10000 }).then(() => true).catch(() => false);
check('aswitch:// link from the OS opens the confirmation dialog', gotDlg && (await page.textContent('#linkDialog')).includes('https://shared.example.com/v1'));
await shot(page, 'link-dialog-tr.png');
if (gotDlg) await page.click('#ldApply');
await page.waitForFunction(() => !document.querySelector('#linkDialog').open).catch(() => {});
const cfgL = JSON.parse(fs.readFileSync(path.join(env.ASWITCH_DIR, 'config.json'), 'utf8'));
check('confirmed link adds the provider without any key', cfgL.providers['shared-gw']?.openaiBase === 'https://shared.example.com/v1' && !cfgL.keys['shared-gw'] && !JSON.stringify(cfgL).includes('sk-nope'));
await app.close();
await sleep(300);
check('router stopped after final quit', !(await probe()));

fs.rmSync(home, { recursive: true, force: true });
mock.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
