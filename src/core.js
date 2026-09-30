import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, getKey, mask } from './config.js';
import { resolveProvider, listProviderIds, PRESETS, claudeMode, codexMode, modelApi, claudeRouterApi } from './providers.js';
import { fetchModels, resolveModelAlias } from './models.js';
import { applyClaude, clearClaude, statusClaude } from './targets/claude.js';
import { applyCodex, clearCodex, statusCodex } from './targets/codex.js';
import { applyOpencode, statusOpencode } from './targets/opencode.js';
import fs from 'node:fs';
import { restoreOriginal, listBackups, backupFile, ensureOriginal, snapshot } from './backup.js';
import { claudeSettingsPath, codexConfigPath, appDir } from './paths.js';
import { opencodeFile } from './targets/opencode.js';
import { configPath } from './config.js';
import { t, LANGS, normalizeLang, resetLangCache, getLang } from './i18n/index.js';

export const TOOLS = ['claude', 'codex', 'opencode'];
export const OFFICIAL_TOOLS = ['claude', 'codex'];
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
  if (r.provider && !r.claude && !r.codex) return { port: r.port, claude: { provider: r.provider, model: r.model, fastModel: r.fastModel } };
  return r;
}

export async function useProvider({ tools = TOOLS, provider: pid, model, fastModel, port, codexKey }) {
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
      plan.codex = mode;
    } else if (tool === 'opencode') {
      need(provider.openaiBase, 'err.providerNoOpenai', { id: pid, tool: 'OpenCode' });
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
    }
    cfg.active[tool] = { provider: pid, model: model || null, fastModel: fastModel || null, at: new Date().toISOString() };
  }
  // The port is kept even when no tool needs the router, so a custom --port survives later switches.
  cfg.router = { port: routerPort, ...(router.claude ? { claude: router.claude } : {}), ...(router.codex ? { codex: router.codex } : {}) };
  if (!router.claude && !router.codex && routerPort === DEFAULT_ROUTER_PORT) delete cfg.router;
  saveConfig(cfg);
  return { provider: pid, model, fastModel, results };
}

function dropRouter(cfg, tools) {
  const r = routerCfg(cfg);
  if (!r) return;
  for (const tool of tools) delete r[tool];
  if (r.claude || r.codex || (r.port && r.port !== DEFAULT_ROUTER_PORT)) cfg.router = r; else delete cfg.router;
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
    else if (tool === 'opencode') { const r = restoreOriginal('opencode'); out.push({ tool: tool, file: r.file, note: r.restored ? t('restore.done') : r.reason }); }
    cfg.active[tool] = { provider: 'official', at: new Date().toISOString() };
  }
  dropRouter(cfg, tools);
  saveConfig(cfg);
  return out;
}

export function restore(tools = TOOLS) {
  checkTools(tools);
  const cfg = loadConfig();
  const out = tools.map(tool => { delete cfg.active[tool]; return restoreOriginal(tool); });
  dropRouter(cfg, tools);
  saveConfig(cfg);
  return out;
}

export function status() {
  const cfg = loadConfig();
  return {
    active: cfg.active,
    router: routerCfg(cfg),
    claude: statusClaude(),
    codex: statusCodex(),
    opencode: statusOpencode(),
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
  for (const k of ['anthropicBase', 'openaiBase', 'modelsUrl']) if (spec[k]) need(URL_RE.test(spec[k]), 'err.badUrl', { field: k, url: spec[k] });
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
export function toolEnv({ all = false, tools = ['codex', 'opencode'] } = {}) {
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

export function run(tool, args = []) {
  need(tool, 'err.runNoTool');
  const bin = { claude: 'claude', codex: 'codex', opencode: 'opencode' }[tool] || tool;
  const env = { ...process.env, ...toolEnv({ tools: TOOLS.includes(tool) ? [tool] : ['codex', 'opencode'] }) };
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
  need(r && (r.claude || r.codex), 'err.routerNotNeeded');
  const mk = x => {
    if (!x) return undefined;
    const p = resolveProvider(cfg, x.provider);
    need(p, 'err.routerProviderMissing', { id: x.provider });
    return { provider: x.provider, baseUrl: p.openaiBase, anthropicBase: p.anthropicBase, key: p.noKey ? '' : getKey(cfg, p), model: x.model, fastModel: x.fastModel, apiFor: m => claudeRouterApi(p, m) };
  };
  return { port: r.port || DEFAULT_ROUTER_PORT, claude: mk(r.claude), codex: mk(r.codex) };
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
  return { claude: claudeSettingsPath, codex: codexConfigPath, opencode: opencodeFile }[tool]?.();
}

// Restores one timestamped backup file over the tool's current config. The current file is
// snapshotted first, so this is itself undoable. Only names returned by listBackups() are accepted.
export function restoreBackup(id, name) {
  const b = listBackups().find(x => x.id === id);
  need(b && b.files.includes(name), 'err.backupNotFound', { id, name });
  const tool = String(name).replace(/(-\d+)?\.[^.]+$/, '');
  need(TOOLS.includes(tool), 'err.backupNotFound', { id, name });
  const dest = toolFile(tool);
  ensureOriginal(tool, dest);
  snapshot(tool, dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(backupFile(id, name), dest);
  const cfg = loadConfig();
  cfg.active[tool] = { provider: 'backup', backup: id, at: new Date().toISOString() };
  saveConfig(cfg);
  return { tool, file: dest };
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
  return { config: configPath(), appDir: appDir(), claude: toolFile('claude'), codex: toolFile('codex'), opencode: toolFile('opencode') };
}

// Is the router needed by the current configuration?
export function routerNeeded() {
  const r = routerCfg(loadConfig());
  return !!(r && (r.claude || r.codex));
}
