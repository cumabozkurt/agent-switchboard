import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, getKey, mask } from './config.js';
import { resolveProvider, listProviderIds, PRESETS, claudeMode, codexMode, modelApi, claudeRouterApi } from './providers.js';
import { fetchModels, resolveModelAlias } from './models.js';
import { applyClaude, clearClaude, statusClaude } from './targets/claude.js';
import { applyCodex, clearCodex, statusCodex } from './targets/codex.js';
import { applyOpencode, statusOpencode } from './targets/opencode.js';
import { restoreOriginal, listBackups } from './backup.js';

export const TOOLS = ['claude', 'codex', 'opencode'];
export const OFFICIAL_TOOLS = ['claude', 'codex'];
export const DEFAULT_ROUTER_PORT = 3456;
export const CODEX_KEY_MODES = ['env', 'command'];

export function keyEnvName(provider) {
  return provider.keyEnv || `ASWITCH_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`;
}

function need(cond, msg) { if (!cond) throw new Error(msg); }

function checkTools(tools) {
  need(Array.isArray(tools) && tools.length, 'En az bir araç seçin (claude | codex | opencode).');
  for (const t of tools) need(TOOLS.includes(t), `Bilinmeyen araç: ${t} (claude | codex | opencode)`);
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
  need(pid, 'Sağlayıcı belirtin. "aswitch providers" ile listeyi görün.');
  const provider = resolveProvider(cfg, pid);
  need(provider, `Bilinmeyen sağlayıcı: ${pid}. "aswitch providers" ile listeyi görün.`);
  checkTools(tools);
  const key = getKey(cfg, provider);
  need(key, `${pid} için anahtar yok. "aswitch key set ${pid}"${provider.oauth ? ` veya "aswitch login ${pid}"` : ''} kullanın ya da ${provider.keyEnv || 'ortam değişkeni'} tanımlayın.`);
  if (codexKey) need(CODEX_KEY_MODES.includes(codexKey), `--codex-key env | command olmalı`);

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
      need(mode, api ? `${pid} üzerinde ${model} modeli ${api} uç noktasıyla sunuluyor; Claude Code ile kullanılamaz.` : `${pid} Claude Code ile kullanılamaz.`);
      need(mode === 'direct' || model, `${pid} Claude Code'a yerel yönlendirici üzerinden bağlanır; --model belirtin (ör. --model latest).`);
      plan.claude = mode;
      if (fastModel && fastModel !== model) {
        // Hızlı model başka bir uç noktadaysa (ör. ana model /messages, hızlı model /responses) her iki
        // modeli de yönlendirici taşır; yönlendirici /messages modellerini çevirmeden iletir.
        const fmode = claudeMode(provider, fastModel);
        need(fmode, `${pid} üzerinde ${fastModel} modeli ${modelApi(provider, fastModel)} uç noktasıyla sunuluyor; Claude Code ile kullanılamaz.`);
        if (fmode === 'router') plan.claude = 'router';
      }
    } else if (tool === 'codex') {
      const mode = codexMode(provider, model);
      need(mode, provider.openaiBase ? `${pid} üzerinde ${model} modeli ${api} uç noktasıyla sunuluyor; Codex ile kullanılamaz.` : `${pid} OpenAI uyumlu uç nokta sunmuyor; Codex için kullanılamaz.`);
      need(mode === 'direct' || model, `${pid} Codex'e yerel yönlendirici üzerinden bağlanır; --model belirtin.`);
      plan.codex = mode;
    } else if (tool === 'opencode') {
      need(provider.openaiBase, `${pid} OpenCode için OpenAI uyumlu uç nokta gerektirir.`);
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
  if (router.claude || router.codex) cfg.router = { port: routerPort, ...(router.claude ? { claude: router.claude } : {}), ...(router.codex ? { codex: router.codex } : {}) };
  else delete cfg.router;
  saveConfig(cfg);
  return { provider: pid, model, fastModel, results };
}

function dropRouter(cfg, tools) {
  const r = routerCfg(cfg);
  if (!r) return;
  for (const t of tools) delete r[t];
  if (r.claude || r.codex) cfg.router = r; else delete cfg.router;
}

// Aracın kendi resmî girişine (Claude Pro/Max OAuth, ChatGPT girişi) döner; diğer ayarlar korunur.
// OpenCode'un "resmî" bir modu olmadığından onun dosyası orijinal haline getirilir.
export function useOfficial(tools = OFFICIAL_TOOLS) {
  checkTools(tools);
  const cfg = loadConfig();
  const out = [];
  for (const t of tools) {
    if (t === 'claude') out.push({ tool: t, file: clearClaude() });
    else if (t === 'codex') out.push({ tool: t, file: clearCodex() });
    else if (t === 'opencode') { const r = restoreOriginal('opencode'); out.push({ tool: t, file: r.file, note: r.restored ? 'orijinal dosya geri yüklendi' : r.reason }); }
    cfg.active[t] = { provider: 'official', at: new Date().toISOString() };
  }
  dropRouter(cfg, tools);
  saveConfig(cfg);
  return out;
}

export function restore(tools = TOOLS) {
  checkTools(tools);
  const cfg = loadConfig();
  const out = tools.map(t => { delete cfg.active[t]; return restoreOriginal(t); });
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
      return [id, !p ? '(geçersiz)' : p.noKey && !cfg.keys?.[id] ? '(gerekmez)' : mask(getKey(cfg, p))];
    }))
  };
}

export function providers() {
  const cfg = loadConfig();
  return listProviderIds(cfg).map(id => {
    const p = resolveProvider(cfg, id);
    return { id, label: p?.label || id, claude: !!p?.anthropicBase || !!p?.openaiBase, codex: !!p?.openaiBase, codexDirect: p?.codexWire === 'responses', custom: !PRESETS[id], hasKey: !!(p && getKey(cfg, p)) };
  });
}

export function setKey(pid, key) {
  const cfg = loadConfig();
  need(resolveProvider(cfg, pid), `Bilinmeyen sağlayıcı: ${pid}`);
  if (key) cfg.keys[pid] = key; else delete cfg.keys[pid];
  saveConfig(cfg);
}

export function getProviderKey(pid) {
  const cfg = loadConfig();
  const p = resolveProvider(cfg, pid);
  need(p, `Bilinmeyen sağlayıcı: ${pid}`);
  return getKey(cfg, p);
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const URL_RE = /^https?:\/\/\S+$/i;

export function addProvider(id, spec = {}) {
  need(id && ID_RE.test(id), 'Sağlayıcı kimliği küçük harf, rakam, "-", "_" veya "." içermeli (ör. my-proxy).');
  need(spec.anthropicBase || spec.openaiBase, 'En az --anthropic-base veya --openai-base gerekli.');
  for (const k of ['anthropicBase', 'openaiBase', 'modelsUrl']) if (spec[k]) need(URL_RE.test(spec[k]), `${k} geçerli bir http(s) adresi değil: ${spec[k]}`);
  if (spec.codexWire) need(['responses', 'chat'].includes(spec.codexWire), '--wire responses | chat olmalı');
  if (spec.keyEnv) need(/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.keyEnv), '--key-env geçerli bir ortam değişkeni adı değil');
  const allowed = ['label', 'anthropicBase', 'openaiBase', 'modelsUrl', 'codexWire', 'keyEnv'];
  const clean = Object.fromEntries(allowed.filter(k => spec[k] != null && spec[k] !== '').map(k => [k, String(spec[k])]));
  const cfg = loadConfig();
  cfg.providers[id] = { label: clean.label || id, ...clean };
  saveConfig(cfg);
}

export function removeProvider(id) {
  const cfg = loadConfig();
  need(cfg.providers[id], `${id} özel bir sağlayıcı değil.`);
  delete cfg.providers[id]; delete cfg.keys[id];
  saveConfig(cfg);
}

export async function models(pid, { refresh } = {}) {
  const cfg = loadConfig();
  const p = resolveProvider(cfg, pid);
  need(p, `Bilinmeyen sağlayıcı: ${pid}`);
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
  for (const t of tools) {
    const a = cfg.active?.[t];
    // Claude Code anahtarı settings.json'dan okur; yönlendiriciden geçen Codex'in anahtara ihtiyacı yoktur.
    if (!a || a.provider === 'official' || t === 'claude' || (t === 'codex' && viaRouter.codex)) continue;
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
  need(tool, 'Çalıştırılacak aracı belirtin: aswitch run <claude|codex|opencode> [argümanlar]');
  const bin = { claude: 'claude', codex: 'codex', opencode: 'opencode' }[tool] || tool;
  const env = { ...process.env, ...toolEnv({ tools: TOOLS.includes(tool) ? [tool] : ['codex', 'opencode'] }) };
  const child = process.platform === 'win32'
    ? spawn([bin, ...args].map(winQuote).join(' '), { stdio: 'inherit', env, shell: true })
    : spawn(bin, args, { stdio: 'inherit', env });
  return new Promise((resolve, reject) => {
    child.on('error', e => reject(e.code === 'ENOENT' ? new Error(`"${bin}" bulunamadı; kurulu ve PATH'te olduğundan emin olun.`) : e));
    child.on('exit', code => resolve(code ?? 0));
  });
}

export function routerTargets() {
  const cfg = loadConfig();
  const r = routerCfg(cfg);
  need(r && (r.claude || r.codex), 'Yönlendirici gerekmiyor: aktif sağlayıcılar araçlara doğrudan bağlı.');
  const mk = x => {
    if (!x) return undefined;
    const p = resolveProvider(cfg, x.provider);
    need(p, `Yönlendirici sağlayıcısı bulunamadı: ${x.provider}`);
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
