import { spawn } from 'node:child_process';
import { checkOutboundUrl, checkPort } from './netguard.js';
import { SCENARIOS, BALANCE_STRATEGIES, BREAKER_DEFAULTS, DEFAULT_LONG_CONTEXT, parseSpec } from './routing.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, getKey, mask } from './config.js';
import { resolveProvider, listProviderIds, PRESETS, claudeMode, codexMode, geminiMode, modelApi, claudeRouterApi } from './providers.js';
import { applyGemini, clearGemini, statusGemini, buildGeminiEnv } from './targets/gemini.js';
import { fetchModels, resolveModelAlias } from './models.js';
import { applyClaude, clearClaude, statusClaude } from './targets/claude.js';
import { applyCodex, clearCodex, statusCodex } from './targets/codex.js';
import { applyOpencode, statusOpencode } from './targets/opencode.js';
import fs from 'node:fs';
import { restoreOriginal, listBackups, backupFile, ensureOriginal, snapshot } from './backup.js';
import { claudeSettingsPath, codexConfigPath, appDir, geminiSettingsPath, geminiEnvPath } from './paths.js';
import { opencodeFile } from './targets/opencode.js';
import { configPath } from './config.js';
import { t, LANGS, normalizeLang, resetLangCache, getLang } from './i18n/index.js';

export const TOOLS = ['claude', 'codex', 'opencode', 'gemini'];
export const OFFICIAL_TOOLS = ['claude', 'codex', 'gemini'];
export const ROUTED_TOOLS = ['claude', 'codex', 'gemini'];
export const DEFAULT_ROUTER_PORT = 3456;
export const CODEX_KEY_MODES = ['env', 'command'];

export function keyEnvName(provider) {
  return provider.keyEnv || `ASWITCH_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`;
}

function need(cond, key, vars) { if (!cond) throw Object.assign(new Error(t(key, vars)), { code: key }); }

function checkTools(tools) {
  need(Array.isArray(tools) && tools.length, 'err.noTools');
  for (const tool of tools) need(TOOLS.includes(tool), 'err.unknownTool', { tool });
}

// Codex'in anahtarı aswitch'ten istemesi için komut (yalnızca düz Node ile çalışırken; Electron'da env kullanılır).
function authCommand(pid) {
  if (process.versions.electron) return null;
  const bin = fileURLToPath(new URL('../bin/aswitch.js', import.meta.url));
  return { command: process.execPath, args: [path.resolve(bin), 'key', 'get', pid] };
}

// Eski sürümlerin tek hedefli router kaydını yeni biçime çevirir.
function routerCfg(cfg) {
  const r = cfg.router;
  if (!r) return null;
  if (r.provider && !r.claude && !r.codex && !r.gemini) return { port: r.port, claude: { provider: r.provider, model: r.model, fastModel: r.fastModel } };
  return r;
}

// True when the tool has router-only features configured (fallback chain, balance group, scenario models).
function routerFeatures(r, tool) {
  return !!(r?.fallback?.[tool]?.length || r?.balance?.[tool]?.members?.length || Object.keys(r?.scenarios?.[tool] || {}).length);
}
// Keeps cfg.router only while it carries something (a routed tool, a policy, a custom port, logging off).
function storeRouter(cfg, r) {
  for (const k of ['fallback', 'balance', 'scenarios']) if (r[k] && !Object.keys(r[k]).length) delete r[k];
  const keep = ROUTED_TOOLS.some(k => r[k]) || r.fallback || r.balance || r.scenarios || r.breaker || r.longContext
    || (r.port || DEFAULT_ROUTER_PORT) !== DEFAULT_ROUTER_PORT || r.log !== undefined;
  if (keep) cfg.router = r; else delete cfg.router;
}

// Default targets for "use": Gemini CLI is included only when it has a config directory (i.e. it is
// installed/used), so upgrading aswitch never creates ~/.gemini on machines without Gemini CLI.
export function defaultTools() {
  return fs.existsSync(path.dirname(geminiSettingsPath())) ? TOOLS : TOOLS.filter(t => t !== 'gemini');
}

export async function useProvider({ tools = defaultTools(), provider: pid, model, fastModel, port, codexKey, viaRouter = false }) {
  const cfg = loadConfig();
  need(pid, 'err.noProvider');
  const provider = resolveProvider(cfg, pid);
  need(provider, 'err.unknownProvider', { id: pid });
  checkTools(tools);
  const key = getKey(cfg, provider);
  need(key, provider.oauth ? 'err.noKeyOauth' : 'err.noKey', { id: pid, env: provider.keyEnv || keyEnvName(provider) });
  if (codexKey) need(CODEX_KEY_MODES.includes(codexKey), 'err.badCodexKey');

  if ((model && model.startsWith('latest')) || (fastModel && fastModel.startsWith('latest'))) {
    const models = await fetchModels(provider, key, { refresh: true });
    model = resolveModelAlias(model, models);
    fastModel = resolveModelAlias(fastModel, models);
  }

  const router = routerCfg(cfg) || {};
  const routerPort = port || router.port || DEFAULT_ROUTER_PORT;
  const routerUrl = `http://127.0.0.1:${routerPort}`;

  // Önce her araç için bağlantı biçimini doğrula; hiçbir dosyaya yarım yamalak yazılmasın.
  const plan = {};
  const api = modelApi(provider, model);
  for (const tool of tools) {
    if (tool === 'claude') {
      const mode = claudeMode(provider, model);
      need(mode, api ? 'err.modelApiUnsupported' : 'err.providerNoClaude', { id: pid, model, api, tool: 'Claude Code' });
      need(mode === 'direct' || model, 'err.routerNeedsModel', { id: pid, tool: 'Claude Code' });
      plan.claude = mode;
      // Router features (fallback, balance, scenarios) or --via-router: route even direct-capable models.
      if (mode === 'direct' && model && (viaRouter || routerFeatures(router, 'claude'))) plan.claude = 'router';
      if (fastModel && fastModel !== model) {
        // Hızlı model başka bir uç noktadaysa (ör. ana model /messages, hızlı model /responses) her iki
        // modeli de yönlendirici taşır; yönlendirici /messages modellerini çevirmeden iletir.
        const fmode = claudeMode(provider, fastModel);
        need(fmode, 'err.modelApiUnsupported', { id: pid, model: fastModel, api: modelApi(provider, fastModel), tool: 'Claude Code' });
        if (fmode === 'router') plan.claude = 'router';
      }
    } else if (tool === 'codex') {
      const mode = codexMode(provider, model);
      need(mode, provider.openaiBase ? 'err.modelApiUnsupported' : 'err.providerNoOpenai', { id: pid, model, api, tool: 'Codex' });
      need(mode === 'direct' || model, 'err.routerNeedsModel', { id: pid, tool: 'Codex' });
      plan.codex = mode === 'direct' && model && (viaRouter || routerFeatures(router, 'codex')) ? 'router' : mode;
    } else if (tool === 'opencode') {
      need(provider.openaiBase, 'err.providerNoOpenai', { id: pid, tool: 'OpenCode' });
    } else if (tool === 'gemini') {
      const mode = geminiMode(provider, model);
      need(mode, api ? 'err.modelApiUnsupported' : 'err.providerNoClaude', { id: pid, model, api, tool: 'Gemini CLI' });
      need(mode === 'direct' || model, 'err.routerNeedsModel', { id: pid, tool: 'Gemini CLI' });
      plan.gemini = mode === 'direct' && model && (viaRouter || routerFeatures(router, 'gemini')) ? 'router' : mode;
    }
  }

  const results = [];
  for (const tool of tools) {
    if (tool === 'claude') {
      const file = applyClaude({ provider, key, model, fastModel, routerUrl, mode: plan.claude });
      if (plan.claude === 'router') router.claude = { provider: pid, model, fastModel: fastModel || null }; else delete router.claude;
      results.push({ tool, file, viaRouter: plan.claude === 'router' });
    } else if (tool === 'codex') {
      const direct = plan.codex === 'direct';
      const mode = codexKey || cfg.codexKeyMode || 'env';
      const envName = direct && !provider.noKey ? keyEnvName(provider) : null;
      const cmd = mode === 'command' ? authCommand(pid) : null;
      const file = applyCodex({ provider, model, keyEnvName: envName, baseUrl: direct ? provider.openaiBase : `${routerUrl}/v1`, keyMode: cmd ? 'command' : 'env', authCommand: cmd });
      if (direct) delete router.codex; else router.codex = { provider: pid, model };
      if (codexKey) cfg.codexKeyMode = codexKey;
      results.push({ tool, file, viaRouter: !direct, keyEnv: envName && !cmd ? envName : null });
    } else if (tool === 'opencode') {
      const file = applyOpencode({ provider, model, keyEnvName: keyEnvName(provider) });
      results.push({ tool, file, keyEnv: provider.noKey ? null : keyEnvName(provider) });
    } else if (tool === 'gemini') {
      const file = applyGemini({ provider, key, model, routerUrl, mode: plan.gemini });
      if (plan.gemini === 'router') router.gemini = { provider: pid, model, fastModel: fastModel || null }; else delete router.gemini;
      results.push({ tool, file, viaRouter: plan.gemini === 'router' });
    }
    cfg.active[tool] = { provider: pid, model: model || null, fastModel: fastModel || null, at: new Date().toISOString() };
  }
  // The port is kept even when no tool needs the router, so a custom --port survives later switches.
  const keep = Object.fromEntries(Object.entries(router).filter(([k]) => !ROUTED_TOOLS.includes(k) && k !== 'port'));
  storeRouter(cfg, { port: routerPort, ...keep, ...Object.fromEntries(ROUTED_TOOLS.filter(k => router[k]).map(k => [k, router[k]])) });
  delete cfg.activeProfile; // a manual switch leaves any profile
  saveConfig(cfg);
  return { provider: pid, model, fastModel, results };
}

function dropRouter(cfg, tools) {
  const r = routerCfg(cfg);
  if (!r) return;
  for (const tool of tools) delete r[tool];
  storeRouter(cfg, r);
}

// Aracın kendi resmî girişine (Claude Pro/Max OAuth, ChatGPT girişi) döner; diğer ayarlar korunur.
// OpenCode'un "resmî" bir modu olmadığından onun dosyası orijinal haline getirilir.
export function useOfficial(tools = OFFICIAL_TOOLS) {
  checkTools(tools);
  const cfg = loadConfig();
  const out = [];
  for (const tool of tools) {
    if (tool === 'claude') out.push({ tool: tool, file: clearClaude() });
    else if (tool === 'codex') out.push({ tool: tool, file: clearCodex() });
    else if (tool === 'gemini') out.push({ tool: tool, file: clearGemini() });
    else if (tool === 'opencode') { const r = restoreOriginal('opencode'); out.push({ tool: tool, file: r.file, note: r.restored ? t('restore.done') : r.reason }); }
    cfg.active[tool] = { provider: 'official', at: new Date().toISOString() };
  }
  dropRouter(cfg, tools);
  delete cfg.activeProfile;
  saveConfig(cfg);
  return out;
}

export function restore(tools = TOOLS) {  // restoring an untouched tool is a no-op
  checkTools(tools);
  const cfg = loadConfig();
  const out = tools.map(tool => {
    delete cfg.active[tool];
    const r = restoreOriginal(tool);
    if (tool === 'gemini') { const e = restoreOriginal('gemini-env'); if (!r.restored && e.restored) return { ...e, target: 'gemini' }; }
    return r;
  });
  dropRouter(cfg, tools);
  saveConfig(cfg);
  return out;
}

// Shell variables that silently win over the files aswitch writes (the tools read the environment first).
export const ENV_OVERRIDES = {
  claude: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL'],
  codex: ['OPENAI_BASE_URL'],
  gemini: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_MODEL']
};
export function envConflicts(env = process.env) {
  const out = [];
  for (const [tool, names] of Object.entries(ENV_OVERRIDES)) for (const name of names) if (env[name]) out.push({ tool, name });
  return out;
}

export function status() {
  const cfg = loadConfig();
  return {
    envConflicts: envConflicts(),
    active: cfg.active,
    activeProfile: cfg.activeProfile || null,
    router: routerCfg(cfg),
    claude: statusClaude(),
    codex: statusCodex(),
    opencode: statusOpencode(),
    gemini: statusGemini(),
    keys: Object.fromEntries(listProviderIds(cfg).map(id => {
      const p = resolveProvider(cfg, id);
      return [id, !p ? t('key.invalid') : p.noKey && !cfg.keys?.[id] ? t('key.notNeeded') : mask(getKey(cfg, p))];
    }))
  };
}

export function providers() {
  const cfg = loadConfig();
  return listProviderIds(cfg).map(id => {
    const p = resolveProvider(cfg, id);
    const custom = !PRESETS[id];
    const key = p ? getKey(cfg, p) : '';
    return {
      id, label: p?.label || id, desc: custom ? '' : t(`provider.${id}`), custom,
      claude: !!p?.anthropicBase || !!p?.openaiBase, codex: !!p?.openaiBase, codexDirect: p?.codexWire === 'responses',
      gemini: !!p && !!(p.geminiBase || p.anthropicBase || p.openaiBase), geminiDirect: !!p?.geminiBase,
      hasKey: !!(p && !p.noKey && key), noKey: !!p?.noKey, keyMasked: p?.noKey ? '' : mask(key),
      keySource: p?.noKey ? null : cfg.keys?.[id] ? 'saved' : key ? 'env' : null,
      keyEnv: p ? keyEnvName(p) : null, keyUrl: p?.keyUrl || null, oauth: !!p?.oauth,
      ...(custom && p ? { spec: { openaiBase: p.openaiBase || '', anthropicBase: p.anthropicBase || '', modelsUrl: p.modelsUrl || '', codexWire: p.codexWire || 'chat', keyEnv: p.keyEnv || '' } } : {})
    };
  });
}

export function setKey(pid, key) {
  const cfg = loadConfig();
  need(resolveProvider(cfg, pid), 'err.unknownProvider', { id: pid });
  if (key) cfg.keys[pid] = key; else delete cfg.keys[pid];
  saveConfig(cfg);
}

export function getProviderKey(pid) {
  const cfg = loadConfig();
  const p = resolveProvider(cfg, pid);
  need(p, 'err.unknownProvider', { id: pid });
  return getKey(cfg, p);
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const URL_RE = /^https?:\/\/\S+$/i;

export function addProvider(id, spec = {}) {
  need(id && ID_RE.test(id), 'err.badProviderId');
  need(!PRESETS[id], 'err.presetId', { id });
  need(spec.anthropicBase || spec.openaiBase, 'err.needBase');
  for (const k of ['anthropicBase', 'openaiBase', 'modelsUrl']) if (spec[k]) { need(URL_RE.test(spec[k]), 'err.badUrl', { field: k, url: spec[k] }); checkOutboundUrl(spec[k], k); }
  if (spec.codexWire) need(['responses', 'chat'].includes(spec.codexWire), 'err.badWire');
  if (spec.keyEnv) need(/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.keyEnv), 'err.badKeyEnv');
  const allowed = ['label', 'anthropicBase', 'openaiBase', 'modelsUrl', 'codexWire', 'keyEnv'];
  const clean = Object.fromEntries(allowed.filter(k => spec[k] != null && spec[k] !== '').map(k => [k, String(spec[k])]));
  const cfg = loadConfig();
  cfg.providers[id] = { label: clean.label || id, ...clean };
  saveConfig(cfg);
}

export function removeProvider(id) {
  const cfg = loadConfig();
  need(cfg.providers[id], 'err.notCustom', { id });
  delete cfg.providers[id]; delete cfg.keys[id];
  saveConfig(cfg);
}

export async function models(pid, { refresh } = {}) {
  const cfg = loadConfig();
  const p = resolveProvider(cfg, pid);
  need(p, 'err.unknownProvider', { id: pid });
  return fetchModels(p, getKey(cfg, p), { refresh });
}

// Araçların beklediği ortam değişkenleri. Varsayılan: yalnızca aktif Codex/OpenCode sağlayıcılarının
// anahtarları (ANTHROPIC_API_KEY gibi bir değişkeni kabuğa kalıcı eklemek aboneliğin önüne geçebilir).
export function toolEnv({ all = false, tools = ['codex', 'opencode'], geminiRun = false } = {}) {
  const cfg = loadConfig();
  const env = {};
  const add = id => {
    const p = resolveProvider(cfg, id);
    if (!p || p.noKey) return;
    const k = getKey(cfg, p);
    if (k) env[keyEnvName(p)] = k;
  };
  if (all) for (const id of listProviderIds(cfg)) add(id);
  const viaRouter = routerCfg(cfg) || {};
  for (const tool of tools) {
    const a = cfg.active?.[tool];
    // Claude Code anahtarı settings.json'dan okur; yönlendiriciden geçen Codex'in anahtara ihtiyacı yoktur.
    if (!a || a.provider === 'official' || tool === 'claude' || (tool === 'codex' && viaRouter.codex)) continue;
    if (tool === 'gemini') {
      // `aswitch run gemini` passes the managed variables directly, because Gemini CLI loads only the
      // first .env it finds (a project .env would otherwise hide ~/.gemini/.env).
      if (!geminiRun) continue;
      const p = resolveProvider(cfg, a.provider);
      if (!p) continue;
      const port = viaRouter.port || DEFAULT_ROUTER_PORT;
      Object.assign(env, buildGeminiEnv({ provider: p, key: getKey(cfg, p), model: a.model, routerUrl: `http://127.0.0.1:${port}`, mode: viaRouter.gemini ? 'router' : 'direct' }));
      continue;
    }
    add(a.provider);
  }
  return env;
}

// Windows'ta .cmd/.bat başlatıcıları için kabuk gerekir; argümanlar cmd.exe için tırnaklanır.
export function winQuote(a) {
  if (a === '') return '""';
  if (!/[\s"&|<>^()!]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

export async function run(tool, args = []) {
  need(tool, 'err.runNoTool');
  // A ".aswitch.json" in the project switches the tools to that project's profile first.
  const pp = await applyProjectProfile();
  if (pp?.applied) process.stderr.write(t('cli.projectProfile', { profile: pp.profile, file: pp.file }) + '\n');
  const bin = { claude: 'claude', codex: 'codex', opencode: 'opencode', gemini: 'gemini' }[tool] || tool;
  const env = { ...process.env, ...toolEnv({ tools: TOOLS.includes(tool) ? [tool] : ['codex', 'opencode'], geminiRun: tool === 'gemini' }) };
  const child = process.platform === 'win32'
    ? spawn([bin, ...args].map(winQuote).join(' '), { stdio: 'inherit', env, shell: true })
    : spawn(bin, args, { stdio: 'inherit', env });
  return new Promise((resolve, reject) => {
    child.on('error', e => reject(e.code === 'ENOENT' ? new Error(t('err.binNotFound', { bin })) : e));
    child.on('exit', code => resolve(code ?? 0));
  });
}

export function routerTargets() {
  const cfg = loadConfig();
  const r = routerCfg(cfg);
  need(r && ROUTED_TOOLS.some(k => r[k]), 'err.routerNotNeeded');
  const one = (id, model, fastModel) => {
    const p = resolveProvider(cfg, id);
    need(p, 'err.routerProviderMissing', { id });
    for (const u of [p.openaiBase, p.anthropicBase]) if (u) checkOutboundUrl(u, id);
    // Models Claude Code could reach directly are passed through to the Anthropic endpoint untouched.
    return { provider: id, baseUrl: p.openaiBase, anthropicBase: p.anthropicBase, key: p.noKey ? '' : getKey(cfg, p), model, fastModel,
      apiFor: m => (claudeMode(p, m) === 'direct' && p.anthropicBase ? 'messages' : claudeRouterApi(p, m)), codexApi: m => codexMode(p, m) === 'direct' ? 'responses' : 'chat' };
  };
  const breaker = { ...BREAKER_DEFAULTS, ...(r.breaker || {}) };
  const fixed = (x, tool) => { try { const c = one(x.provider, x.model, x.model); c.fixedModel = true; if (tool === 'gemini') geminiApi(c, x.provider); return c; } catch { return null; } };
  const geminiApi = (t, id) => {
    const p = resolveProvider(cfg, id);
    t.apiFor = m => { const a = modelApi(p, m); return (a === 'messages' || a === null) && p.anthropicBase ? 'messages' : claudeRouterApi(p, m); };
  };
  const mk = (x, tool) => {
    if (!x) return undefined;
    const t = one(x.provider, x.model, x.fastModel);
    // Gemini CLI has no direct Anthropic mode, so a provider's Anthropic endpoint is the best route.
    if (tool === 'gemini') geminiApi(t, x.provider);
    // Ordered fallback chain (provider:model) tried on 429/5xx/network errors before any byte is sent.
    const chain = (r.fallback?.[tool] || []).map(f => fixed(f, tool)).filter(Boolean);
    if (chain.length) t.fallbacks = chain;
    const bal = r.balance?.[tool];
    if (bal?.members?.length) {
      const members = bal.members.map(m => { const c = fixed(m, tool); if (c) c.weight = m.weight ?? 1; return c; }).filter(Boolean);
      if (members.length) t.balance = { strategy: bal.strategy || 'weighted', members };
    }
    const sc = r.scenarios?.[tool];
    if (sc && Object.keys(sc).length) {
      t.scenarios = Object.fromEntries(Object.entries(sc).map(([k, v]) => [k, fixed(v, tool)]).filter(([, v]) => v));
      t.longContextThreshold = r.longContext || DEFAULT_LONG_CONTEXT;
    }
    t.breaker = breaker;
    return t;
  };
  return { port: r.port || DEFAULT_ROUTER_PORT, claude: mk(r.claude, 'claude'), codex: mk(r.codex, 'codex'), gemini: mk(r.gemini, 'gemini'), log: r.log !== false };
}

// Geriye dönük uyumluluk: tek hedef (Claude) döndürür.
export function routerTarget() {
  const t = routerTargets();
  const one = t.claude || t.codex;
  return { ...one, port: t.port };
}

export { listBackups };

// Current file for each tool (used by backup restore and the UI's "files" view).
export function toolFile(tool) {
  return { claude: claudeSettingsPath, codex: codexConfigPath, opencode: opencodeFile, gemini: geminiSettingsPath, 'gemini-env': geminiEnvPath }[tool]?.();
}

// Restores one timestamped backup file over the tool's current config. The current file is
// snapshotted first, so this is itself undoable. Only names returned by listBackups() are accepted.
export function restoreBackup(id, name) {
  const b = listBackups().find(x => x.id === id);
  need(b && b.files.includes(name), 'err.backupNotFound', { id, name });
  const tool = String(name).replace(/(-\d+)?\.[^.]+$/, '');
  need(TOOLS.includes(tool) || tool === 'gemini-env', 'err.backupNotFound', { id, name });
  const dest = toolFile(tool);
  ensureOriginal(tool, dest);
  snapshot(tool, dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(backupFile(id, name), dest);
  const cfg = loadConfig();
  const activeTool = tool === 'gemini-env' ? 'gemini' : tool;
  cfg.active[activeTool] = { provider: 'backup', backup: id, at: new Date().toISOString() };
  saveConfig(cfg);
  return { tool: activeTool, file: dest };
}

// App settings shown in the UI / `aswitch lang`.
export function getSettings() {
  const cfg = loadConfig();
  return { lang: getLang(), langSaved: normalizeLang(cfg.lang), routerAutoStart: !!cfg.routerAutoStart, routerPort: routerCfg(cfg)?.port || DEFAULT_ROUTER_PORT };
}

export function setSettings({ lang, routerAutoStart } = {}) {
  const cfg = loadConfig();
  if (lang !== undefined) {
    if (lang === null || lang === '' || lang === 'auto') delete cfg.lang;
    else { need(normalizeLang(lang), 'err.badLang', { lang, langs: LANGS.join(' | ') }); cfg.lang = normalizeLang(lang); }
  }
  if (routerAutoStart !== undefined) cfg.routerAutoStart = !!routerAutoStart;
  saveConfig(cfg);
  resetLangCache();
  return getSettings();
}

export function paths() {
  return { config: configPath(), appDir: appDir(), claude: toolFile('claude'), codex: toolFile('codex'), opencode: toolFile('opencode'), gemini: toolFile('gemini'), geminiEnv: toolFile('gemini-env') };
}

// Is the router needed by the current configuration?
export function routerNeeded() {
  const r = routerCfg(loadConfig());
  return !!(r && ROUTED_TOOLS.some(k => r[k]));
}

// ---------------------------------------------------------------------------------------------
// v0.3.0: fallback chains, profiles (+ per-project), import/export, endpoint ping, usage, MCP, updates.

const FALLBACK_TOOLS = ['claude', 'codex', 'gemini'];

// specs: ["provider:model", ...] tried in order when the primary provider answers 429/5xx or is unreachable.
export function setFallback(tool, specs = []) {
  need(FALLBACK_TOOLS.includes(tool), 'err.fallbackTool', { tool, tools: FALLBACK_TOOLS.join(' | ') });
  const cfg = loadConfig();
  const list = specs.map(s => { const { provider, model } = routeSpec(cfg, tool, s); return { provider, model }; });
  const r = routerCfg(cfg) || { port: DEFAULT_ROUTER_PORT };
  r.fallback = { ...(r.fallback || {}) };
  if (list.length) r.fallback[tool] = list; else delete r.fallback[tool];
  if (!Object.keys(r.fallback).length) delete r.fallback;
  storeRouter(cfg, r);
  saveConfig(cfg);
  return getFallback();
}

export function getFallback() {
  const r = routerCfg(loadConfig());
  return Object.fromEntries(FALLBACK_TOOLS.map(t => [t, r?.fallback?.[t] || []]));
}

// "provider:model" (optionally "*weight") checked against the tool: Codex needs an OpenAI endpoint,
// Claude Code / Gemini CLI any endpoint the router can translate from.
function routeSpec(cfg, tool, s) {
  const spec = parseSpec(s);
  need(spec, 'err.fallbackSpec', { spec: String(s) });
  const p = resolveProvider(cfg, spec.provider);
  need(p, 'err.unknownProvider', { id: spec.provider });
  need(tool === 'codex' ? p.openaiBase : (p.anthropicBase || p.openaiBase), 'err.providerNoClaude', { id: spec.provider });
  return spec;
}

// Load balancing: a group of provider:model*weight entries that replaces the tool's primary target in the router.
export function setBalance(tool, specs = [], { strategy = 'weighted' } = {}) {
  need(FALLBACK_TOOLS.includes(tool), 'err.fallbackTool', { tool, tools: FALLBACK_TOOLS.join(' | ') });
  need(BALANCE_STRATEGIES.includes(strategy), 'err.badStrategy', { strategy, list: BALANCE_STRATEGIES.join(' | ') });
  const cfg = loadConfig();
  const members = specs.map(s => routeSpec(cfg, tool, s));
  need(!members.length || members.length >= 2, 'err.balanceTwo');
  const r = routerCfg(cfg) || { port: DEFAULT_ROUTER_PORT };
  r.balance = { ...(r.balance || {}) };
  if (members.length) r.balance[tool] = { strategy, members }; else delete r.balance[tool];
  storeRouter(cfg, r);
  saveConfig(cfg);
  return getBalance();
}
export function getBalance() {
  const r = routerCfg(loadConfig());
  return Object.fromEntries(FALLBACK_TOOLS.map(t => [t, r?.balance?.[t] || null]));
}

// Scenario routing: image / longContext / webSearch / think / background → provider:model.
export function setScenario(tool, name, spec) {
  need(FALLBACK_TOOLS.includes(tool), 'err.fallbackTool', { tool, tools: FALLBACK_TOOLS.join(' | ') });
  const cfg = loadConfig();
  const r = routerCfg(cfg) || { port: DEFAULT_ROUTER_PORT };
  r.scenarios = { ...(r.scenarios || {}) };
  const cur = { ...(r.scenarios[tool] || {}) };
  if (name === '*' && !spec) delete r.scenarios[tool];
  else {
    need(SCENARIOS.includes(name), 'err.badScenario', { name, list: SCENARIOS.join(' | ') });
    if (spec) { const { provider, model } = routeSpec(cfg, tool, spec); cur[name] = { provider, model }; } else delete cur[name];
    if (Object.keys(cur).length) r.scenarios[tool] = cur; else delete r.scenarios[tool];
  }
  storeRouter(cfg, r);
  saveConfig(cfg);
  return getScenarios();
}
export function setLongContextThreshold(tokens) {
  const n = Number(tokens);
  need(Number.isInteger(n) && n >= 1000 && n <= 10000000, 'err.badThreshold', { value: String(tokens) });
  const cfg = loadConfig();
  const r = routerCfg(cfg) || { port: DEFAULT_ROUTER_PORT };
  if (n === DEFAULT_LONG_CONTEXT) delete r.longContext; else r.longContext = n;
  storeRouter(cfg, r);
  saveConfig(cfg);
  return getScenarios();
}
export function getScenarios() {
  const r = routerCfg(loadConfig());
  return { tools: Object.fromEntries(FALLBACK_TOOLS.map(t => [t, r?.scenarios?.[t] || {}])), longContextThreshold: r?.longContext || DEFAULT_LONG_CONTEXT, scenarios: SCENARIOS };
}

// Circuit breaker settings (live state comes from the running router's /health).
export function setBreaker({ enabled, failures, cooldownSec } = {}) {
  const cfg = loadConfig();
  const r = routerCfg(cfg) || { port: DEFAULT_ROUTER_PORT };
  const b = { ...BREAKER_DEFAULTS, ...(r.breaker || {}) };
  if (enabled !== undefined) b.enabled = !!enabled;
  if (failures !== undefined) { const n = Number(failures); need(Number.isInteger(n) && n >= 1 && n <= 100, 'err.badBreaker', { field: 'failures', value: String(failures) }); b.failures = n; }
  if (cooldownSec !== undefined) { const n = Number(cooldownSec); need(Number.isInteger(n) && n >= 1 && n <= 3600, 'err.badBreaker', { field: 'cooldown', value: String(cooldownSec) }); b.cooldownSec = n; }
  if (b.enabled === BREAKER_DEFAULTS.enabled && b.failures === BREAKER_DEFAULTS.failures && b.cooldownSec === BREAKER_DEFAULTS.cooldownSec) delete r.breaker; else r.breaker = b;
  storeRouter(cfg, r);
  saveConfig(cfg);
  return getBreaker();
}
export function getBreaker() { return { ...BREAKER_DEFAULTS, ...(routerCfg(loadConfig())?.breaker || {}) }; }

// After a router feature is configured, a tool that currently connects directly is re-applied through the
// router (same provider/model), otherwise the feature would have no effect. Returns the re-apply result.
export async function ensureRouted(tool) {
  const cfg = loadConfig();
  const a = cfg.active?.[tool];
  const r = routerCfg(cfg);
  if (!a || !a.provider || ['official', 'backup'].includes(a.provider) || r?.[tool] || !routerFeatures(r, tool) || !a.model) return null;
  const prof = cfg.activeProfile;
  const res = await useProvider({ provider: a.provider, model: a.model, fastModel: a.fastModel || undefined, tools: [tool] });
  if (prof) { const c = loadConfig(); c.activeProfile = prof; saveConfig(c); }
  return res;
}

// Router request logging (metadata only) — on by default, can be turned off.
export function setRouterLog(on) {
  const cfg = loadConfig();
  const r = routerCfg(cfg) || { port: DEFAULT_ROUTER_PORT };
  if (on) delete r.log; else r.log = false;
  storeRouter(cfg, r);
  saveConfig(cfg);
}
export function routerLogEnabled() { return routerCfg(loadConfig())?.log !== false; }

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

// A profile is a named copy of what each tool uses right now (provider/model/fast model or "official").
export function saveProfile(name, { tools } = {}) {
  need(name && PROFILE_RE.test(name), 'err.badProfileName');
  const cfg = loadConfig();
  const pick = tools || Object.keys(cfg.active || {});
  const entry = {};
  for (const tool of pick) {
    const a = cfg.active?.[tool];
    if (!a || !TOOLS.includes(tool) || a.provider === 'backup') continue;
    entry[tool] = a.provider === 'official' ? { provider: 'official' } : { provider: a.provider, model: a.model || null, fastModel: a.fastModel || null };
  }
  need(Object.keys(entry).length, 'err.profileEmpty');
  cfg.profiles = { ...(cfg.profiles || {}), [name]: { tools: entry, at: new Date().toISOString() } };
  saveConfig(cfg);
  return cfg.profiles[name];
}

export function listProfiles() {
  const cfg = loadConfig();
  return Object.entries(cfg.profiles || {}).map(([name, p]) => ({ name, ...p }));
}

export function removeProfile(name) {
  const cfg = loadConfig();
  need(cfg.profiles?.[name], 'err.profileNotFound', { name });
  delete cfg.profiles[name];
  saveConfig(cfg);
}

export async function useProfile(name) {
  const cfg = loadConfig();
  const p = cfg.profiles?.[name];
  need(p, 'err.profileNotFound', { name });
  const results = [];
  const official = Object.entries(p.tools).filter(([, v]) => v.provider === 'official').map(([k]) => k);
  if (official.length) results.push(...useOfficial(official.filter(t => OFFICIAL_TOOLS.includes(t))).map(r => ({ ...r, provider: 'official' })));
  // Group tools that share provider + models so each group is one atomic "use".
  const groups = new Map();
  for (const [tool, v] of Object.entries(p.tools)) {
    if (v.provider === 'official') continue;
    const k = JSON.stringify([v.provider, v.model, v.fastModel]);
    groups.set(k, [...(groups.get(k) || []), tool]);
  }
  for (const [k, tools] of groups) {
    const [provider, model, fastModel] = JSON.parse(k);
    const r = await useProvider({ provider, model: model || undefined, fastModel: fastModel || undefined, tools });
    results.push(...r.results.map(x => ({ ...x, provider })));
  }
  const c2 = loadConfig(); c2.activeProfile = name; saveConfig(c2);
  return { name, results };
}

// Per-project profile: the nearest ".aswitch.json" ({"profile": "name"}) from cwd upwards.
export function projectProfile(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (;;) {
    const f = path.join(dir, '.aswitch.json');
    if (fs.existsSync(f)) {
      try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && typeof j.profile === 'string') return { file: f, profile: j.profile }; } catch { /* ignore invalid file */ }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function setProjectProfile(name, cwd = process.cwd()) {
  need(loadConfig().profiles?.[name], 'err.profileNotFound', { name });
  const f = path.join(path.resolve(cwd), '.aswitch.json');
  fs.writeFileSync(f, JSON.stringify({ profile: name }, null, 2) + '\n');
  return f;
}

// Applies the project's profile if the tools are not already on it. Returns the profile name or null.
export async function applyProjectProfile(cwd = process.cwd()) {
  const pp = projectProfile(cwd);
  if (!pp) return null;
  if (loadConfig().activeProfile === pp.profile) return { ...pp, applied: false };
  await useProfile(pp.profile);
  return { ...pp, applied: true };
}

// Export: custom providers, profiles, fallback chains and settings. Keys only with withKeys (plain text!).
export function exportConfig({ withKeys = false } = {}) {
  const cfg = loadConfig();
  const r = routerCfg(cfg);
  return {
    format: 'agent-switchboard', formatVersion: 1, exportedAt: new Date().toISOString(),
    providers: cfg.providers || {}, profiles: cfg.profiles || {},
    fallback: r?.fallback || {}, settings: { lang: cfg.lang, routerAutoStart: !!cfg.routerAutoStart, codexKeyMode: cfg.codexKeyMode },
    ...(withKeys ? { keys: cfg.keys || {} } : {})
  };
}

export function importConfig(data, { overwrite = false } = {}) {
  need(data && data.format === 'agent-switchboard' && data.formatVersion === 1, 'err.badImport');
  const cfg = loadConfig();
  const counts = { providers: 0, profiles: 0, keys: 0, fallback: 0 };
  for (const [id, spec] of Object.entries(data.providers || {})) {
    if (PRESETS[id] || (cfg.providers[id] && !overwrite)) continue;
    const old = cfg.providers[id];
    addProvider(id, spec); counts.providers++;
    // An imported file must not be able to send an existing saved key to a different server.
    const now = loadConfig().providers[id];
    if (old && now && (old.openaiBase !== now.openaiBase || (old.anthropicBase || '') !== (now.anthropicBase || ''))) {
      const c = loadConfig(); delete c.keys[id]; saveConfig(c);
    }
  }
  const fresh = loadConfig();
  for (const [name, p] of Object.entries(data.profiles || {})) {
    if (!PROFILE_RE.test(name) || !p?.tools || typeof p.tools !== 'object' || (fresh.profiles?.[name] && !overwrite)) continue;
    const tools = {};
    for (const [tool, v] of Object.entries(p.tools)) {
      if (!TOOLS.includes(tool) || !v || typeof v.provider !== 'string') continue;
      tools[tool] = { provider: v.provider, model: typeof v.model === 'string' ? v.model : null, fastModel: typeof v.fastModel === 'string' ? v.fastModel : null };
    }
    if (!Object.keys(tools).length) continue;
    fresh.profiles = { ...(fresh.profiles || {}), [name]: { tools } }; counts.profiles++;
  }
  for (const [id, key] of Object.entries(data.keys || {})) {
    if (typeof key !== 'string' || !key || !resolveProvider(fresh, id) || (fresh.keys[id] && !overwrite)) continue;
    fresh.keys[id] = key; counts.keys++;
  }
  if (data.fallback && typeof data.fallback === 'object') {
    const r = routerCfg(fresh) || { port: DEFAULT_ROUTER_PORT };
    for (const tool of FALLBACK_TOOLS) {
      const list = Array.isArray(data.fallback[tool]) ? data.fallback[tool].filter(f => f && resolveProvider(fresh, f.provider) && typeof f.model === 'string') : [];
      if (list.length && (overwrite || !r.fallback?.[tool])) { r.fallback = { ...(r.fallback || {}), [tool]: list }; counts.fallback++; }
    }
    if (r.fallback) fresh.router = r;
  }
  saveConfig(fresh);
  return counts;
}

// Endpoint latency check: one authenticated GET per provider (models list when available).
export async function pingProviders(ids, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const cfg = loadConfig();
  const all = listProviderIds(cfg).map(id => resolveProvider(cfg, id)).filter(Boolean);
  const pick = ids?.length ? ids.map(id => { const p = resolveProvider(cfg, id); need(p, 'err.unknownProvider', { id }); return p; })
    : all.filter(p => p.noKey ? false : !!getKey(cfg, p));
  return Promise.all(pick.map(async p => {
    const key = getKey(cfg, p);
    const url = p.modelsUrl ? (p.modelsAuth === 'anthropic' ? `${p.modelsUrl}?limit=1` : p.modelsUrl) : (p.openaiBase ? p.openaiBase.replace(/\/$/, '') + '/models' : p.anthropicBase);
    const headers = { accept: 'application/json' };
    if (p.modelsAuth === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; } else if (key && !p.noKey) headers.authorization = `Bearer ${key}`;
    const started = Date.now();
    try {
      checkOutboundUrl(url, p.id);
      const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const ms = Date.now() - started;
      try { await r.arrayBuffer(); } catch { /* ignore */ }
      return { id: p.id, url, status: r.status, ms, ok: r.ok, auth: r.status === 401 || r.status === 403 ? 'rejected' : r.ok ? 'ok' : null };
    } catch (e) {
      return { id: p.id, url, status: 0, ms: Date.now() - started, ok: false, error: e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code || e.message) };
    }
  }));
}

export { recordUsage, readUsage, summarizeUsage, clearUsage, estimateCost } from './usage.js';
export { allMcp, listMcp, syncMcp, MCP_TOOLS, MCP_TARGETS } from './mcp.js';
export { checkForUpdate, compareVersions } from './update.js';

// Usage report for the last `days` days (0 = everything in the log).
export async function usageReport({ days = 7 } = {}) {
  const { readUsage, summarizeUsage } = await import('./usage.js');
  const entries = readUsage({ since: days ? Date.now() - days * 864e5 : 0 });
  return { days, ...summarizeUsage(entries), recent: entries.slice(-100).reverse() };
}

// Router usage callback: adds a cost estimate when the provider publishes prices (OpenRouter).
export async function routerUsageHook() {
  const { recordUsage, estimateCost } = await import('./usage.js');
  return entry => {
    if (!routerLogEnabled()) return;
    recordUsage({ ...entry, cost: estimateCost(entry.provider, entry.model, entry.in, entry.out) });
  };
}

// Live state of a running router on the configured port (null when none answers).
export async function routerHealth({ timeoutMs = 800, fetchImpl = fetch } = {}) {
  const port = checkPort(routerCfg(loadConfig())?.port || DEFAULT_ROUTER_PORT);
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    return j?.ok ? j : null;
  } catch { return null; }
}
