import http from 'node:http';
import { checkPort } from '../netguard.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as core from '../core.js';
import { openUrl } from '../open.js';
import { openRouterLogin } from '../oauth.js';
import { startRouter } from '../router.js';
import { envLine, defaultShell } from '../cli.js';
import { mask } from '../config.js';
import { CATALOGS, LANG_NAMES, getLang, setLang, setLocaleHint, t } from '../i18n/index.js';

const page = fileURLToPath(new URL('./index.html', import.meta.url));
const isLocalHost = h => /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(h || '');
const VERSION = (() => {
  for (const rel of ['../../package.json', '../package.json']) {
    try { return JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8')).version; } catch { /* try next */ }
  }
  return '0.0.0';
})();
const SHELLS = ['sh', 'fish', 'powershell', 'cmd'];

// Is an aswitch router (possibly another process, e.g. `aswitch router` in a terminal) answering on this port?
export async function probeRouter(port, timeoutMs = 600) {
  try {
    const r = await fetch(`http://127.0.0.1:${checkPort(port)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    return !!j?.ok;
  } catch { return false; }
}

function closeServer(s) {
  return new Promise(resolve => {
    if (!s) return resolve();
    s.close(() => resolve());
    s.closeAllConnections?.(); // Node >= 18.2: do not wait for idle keep-alive sockets
  });
}

// Local control panel. Listens on 127.0.0.1 only and requires a random per-session token on every API
// call, so other websites cannot read keys or change settings (CSRF / DNS rebinding protection).
// Options: locale (OS locale hint, e.g. Electron app.getLocale()), onLangChange(lang), autoStartRouter.
export async function startUi({ port = 4567, open = true, locale, onLangChange, autoStartRouter = true, log = () => {} } = {}) {
  if (locale) setLocaleHint(locale);
  const token = crypto.randomBytes(16).toString('hex');
  let router = null;
  let routerPort = null;
  let routerError = null;

  async function startRouterNow() {
    if (router) return { port: routerPort, already: true };
    const tg = core.routerTargets(); // throws a translated error when no tool needs the router
    try {
      router = await startRouter({ port: tg.port, targets: () => core.routerTargets(), log, onUsage: await core.routerUsageHook() });
    } catch (e) {
      if (e.code === 'EADDRINUSE') {
        const ext = await probeRouter(tg.port);
        throw Object.assign(new Error(t(ext ? 'router.externalRunning' : 'router.portInUse', { port: tg.port })), { code: ext ? 'router.externalRunning' : 'router.portInUse' });
      }
      throw e;
    }
    routerPort = router.address().port;
    routerError = null;
    return { port: routerPort };
  }
  async function stopRouterNow() {
    const r = router; router = null; routerPort = null;
    await closeServer(r);
  }
  async function routerState() {
    const settings = core.getSettings();
    const needed = core.routerNeeded();
    const state = router ? 'running' : (await probeRouter(settings.routerPort)) ? 'external' : 'stopped';
    return { state, needed, port: router ? routerPort : settings.routerPort, autoStart: settings.routerAutoStart, error: routerError };
  }
  async function maybeAutoStart() {
    if (!autoStartRouter || router || !core.getSettings().routerAutoStart || !core.routerNeeded()) return null;
    try { return await startRouterNow(); } catch (e) { routerError = e.message; return null; }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const json = (code, obj) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
    if (!isLocalHost(req.headers.host)) return json(403, { error: t('ui.localOnly') }); // DNS rebinding protection
    if (u.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store'
      });
      const boot = { catalogs: CATALOGS, langNames: LANG_NAMES, lang: getLang(), version: VERSION };
      // JSON inside <script>: escape "<" so no catalog/string can close the script element.
      const html = fs.readFileSync(page, 'utf8').replace('/*__BOOT__*/null', JSON.stringify(boot).replace(/</g, '\\u003c'));
      res.end(html.replace('<html lang="en">', `<html lang="${getLang()}">`));
      return;
    }
    if (!u.pathname.startsWith('/api/')) return json(404, { error: t('ui.notFound') });
    if (req.method !== 'POST') return json(405, { error: t('ui.postOnly') });
    const given = String(req.headers['x-aswitch-token'] || '');
    if (given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return json(403, { error: t('ui.badToken') });
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return json(415, { error: t('ui.jsonOnly') });
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 1e6) return json(413, { error: t('ui.tooLarge') }); chunks.push(c); }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const str = v => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      switch (u.pathname) {
        case '/api/info': return json(200, { version: VERSION, lang: getLang(), settings: core.getSettings(), paths: core.paths(), electron: !!process.versions.electron, platform: process.platform, codexKeyModes: process.versions.electron ? ['env'] : core.CODEX_KEY_MODES, defaultShell: defaultShell(), geminiInstalled: core.defaultTools().includes('gemini') });
        case '/api/status': { const st = core.status(); return json(200, { ...st, routerConfig: st.router, router: await routerState() }); }
        case '/api/providers': return json(200, core.providers());
        case '/api/models': return json(200, await core.models(str(body.provider), { refresh: !!body.refresh }));
        case '/api/key': {
          const key = str(body.key);
          if (!key) throw new Error(t('err.emptyKey'));
          core.setKey(str(body.provider), key); return json(200, { ok: true });
        }
        case '/api/key/remove': core.setKey(str(body.provider), ''); return json(200, { ok: true });
        case '/api/use': {
          const r = await core.useProvider({ provider: str(body.provider), model: str(body.model), fastModel: str(body.fastModel), tools: body.tools, codexKey: str(body.codexKey) });
          const auto = r.results.some(x => x.viaRouter) ? await maybeAutoStart() : null;
          return json(200, { ...r, routerAutoStarted: !!auto && !auto.already, router: await routerState() });
        }
        case '/api/official': return json(200, core.useOfficial(body.tools));
        case '/api/restore': return json(200, core.restore(body.tools));
        case '/api/provider': {
          core.addProvider(str(body.id), { label: str(body.label), openaiBase: str(body.openaiBase), anthropicBase: str(body.anthropicBase), modelsUrl: str(body.modelsUrl) || (str(body.openaiBase) ? str(body.openaiBase).replace(/\/$/, '') + '/models' : undefined), codexWire: str(body.codexWire) || 'chat', keyEnv: str(body.keyEnv) });
          return json(200, { ok: true });
        }
        case '/api/provider/remove': core.removeProvider(str(body.id)); return json(200, { ok: true });
        case '/api/login/openrouter': core.setKey('openrouter', await openRouterLogin({ log })); return json(200, { ok: true });
        case '/api/router/start': { const r = await startRouterNow(); return json(200, { ok: true, ...r, router: await routerState() }); }
        case '/api/router/stop': await stopRouterNow(); return json(200, { ok: true, router: await routerState() });
        case '/api/router/restart': await stopRouterNow(); await startRouterNow(); return json(200, { ok: true, router: await routerState() });
        case '/api/backups': return json(200, core.listBackups());
        case '/api/backups/restore': return json(200, core.restoreBackup(String(body.id || ''), String(body.name || '')));
        case '/api/env': {
          const shell = SHELLS.includes(body.shell) ? body.shell : (defaultShell() === 'powershell' ? 'powershell' : defaultShell());
          const env = core.toolEnv({ all: !!body.all });
          return json(200, { shell, lines: Object.entries(env).map(([k, v]) => envLine(shell, k, body.reveal ? v : mask(v))) });
        }
        case '/api/settings': {
          const before = getLang();
          if (body.lang !== undefined) {
            core.setSettings({ lang: body.lang });
            // The user's choice in the panel wins over ASWITCH_LANG / the OS locale for this process.
            setLang(body.lang === 'auto' || !body.lang ? null : body.lang);
          }
          if (body.routerAutoStart !== undefined) core.setSettings({ routerAutoStart: body.routerAutoStart });
          const s = core.getSettings();
          if (s.lang !== before) try { onLangChange?.(s.lang); } catch { /* menu refresh is best effort */ }
          if (body.routerAutoStart) await maybeAutoStart();
          return json(200, s);
        }
        case '/api/fallback': return json(200, core.getFallback());
        case '/api/fallback/set': {
          const r = core.setFallback(str(body.tool), Array.isArray(body.specs) ? body.specs.map(String).filter(x => x.trim()) : []);
          const re = await core.ensureRouted(str(body.tool)); if (re) await maybeAutoStart();
          return json(200, { ...r, rerouted: !!re });
        }
        case '/api/balance': return json(200, core.getBalance());
        case '/api/balance/set': {
          const r = core.setBalance(str(body.tool), Array.isArray(body.specs) ? body.specs.map(String).filter(x => x.trim()) : [], { strategy: str(body.strategy) || 'weighted' });
          const re = await core.ensureRouted(str(body.tool)); if (re) await maybeAutoStart();
          return json(200, { balance: r, rerouted: !!re });
        }
        case '/api/scenarios': return json(200, core.getScenarios());
        case '/api/scenario/set': {
          const r = core.setScenario(str(body.tool), str(body.name), body.spec ? str(body.spec) : null);
          const re = await core.ensureRouted(str(body.tool)); if (re) await maybeAutoStart();
          return json(200, { ...r, rerouted: !!re });
        }
        case '/api/scenario/threshold': return json(200, core.setLongContextThreshold(body.tokens));
        case '/api/breaker': return json(200, { ...core.getBreaker(), live: (await core.routerHealth())?.breaker?.providers || null });
        case '/api/breaker/set': return json(200, core.setBreaker({ enabled: body.enabled, failures: body.failures, cooldownSec: body.cooldownSec }));
        case '/api/ping': return json(200, await core.pingProviders(Array.isArray(body.ids) ? body.ids.map(String) : undefined));
        case '/api/usage': return json(200, { ...(await core.usageReport({ days: Number.isFinite(body.days) ? body.days : 7 })), log: core.routerLogEnabled() });
        case '/api/usage/clear': core.clearUsage(); return json(200, { ok: true });
        case '/api/usage/log': core.setRouterLog(!!body.on); return json(200, { ok: true, log: core.routerLogEnabled() });
        case '/api/profiles': return json(200, { profiles: core.listProfiles(), project: core.projectProfile() });
        case '/api/profile/save': return json(200, core.saveProfile(str(body.name)));
        case '/api/profile/use': {
          const r = await core.useProfile(str(body.name));
          const auto = r.results.some(x => x.viaRouter) ? await maybeAutoStart() : null;
          return json(200, { ...r, routerAutoStarted: !!auto && !auto.already });
        }
        case '/api/profile/remove': core.removeProfile(str(body.name)); return json(200, { ok: true });
        case '/api/export': return json(200, core.exportConfig({ withKeys: !!body.withKeys }));
        case '/api/import': return json(200, core.importConfig(body.data, { overwrite: !!body.overwrite }));
        case '/api/mcp': return json(200, core.allMcp());
        case '/api/mcp/sync': return json(200, core.syncMcp({ from: str(body.from) || 'claude', to: Array.isArray(body.to) ? body.to : undefined, overwrite: !!body.overwrite }));
        case '/api/update': return json(200, await core.checkForUpdate(VERSION, { force: !!body.force }));
        default: return json(404, { error: t('ui.notFound') });
      }
    } catch (e) { return json(400, { error: e.message, code: e.code }); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', e => reject(e.code === 'EADDRINUSE' ? Object.assign(new Error(t('ui.portInUse', { port })), { code: 'EADDRINUSE' }) : e));
    server.listen(port, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/#${token}`;
  await maybeAutoStart();
  if (open) openUrl(url);
  let stopping = null;
  const stop = () => (stopping ||= (async () => { await stopRouterNow(); await closeServer(server); })());
  server.on('close', () => { if (router) stopRouterNow(); });
  return { server, url, token, stop, routerRunning: () => !!router, routerPort: () => routerPort };
}
