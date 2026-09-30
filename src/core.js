import { spawn } from 'node:child_process';
import { loadConfig, saveConfig, getKey, mask } from './config.js';
import { resolveProvider, listProviderIds, PRESETS } from './providers.js';
import { fetchModels, resolveModelAlias } from './models.js';
import { applyClaude, clearClaude, statusClaude } from './targets/claude.js';
import { applyCodex, clearCodex, statusCodex } from './targets/codex.js';
import { applyOpencode, statusOpencode } from './targets/opencode.js';
import { restoreOriginal, listBackups } from './backup.js';

export const TOOLS = ['claude', 'codex', 'opencode'];
export const DEFAULT_ROUTER_PORT = 3456;

export function keyEnvName(provider) {
  return provider.keyEnv || `ASWITCH_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`;
}

function need(cond, msg) { if (!cond) throw new Error(msg); }

export async function useProvider({ tools = TOOLS, provider: pid, model, fastModel, port }) {
  const cfg = loadConfig();
  const provider = resolveProvider(cfg, pid);
  need(provider, `Bilinmeyen sağlayıcı: ${pid}. "aswitch providers" ile listeyi görün.`);
  const key = getKey(cfg, provider);
  need(key, `${pid} için anahtar yok. "aswitch key set ${pid}"${provider.oauth ? ` veya "aswitch login ${pid}"` : ''} kullanın ya da ${provider.keyEnv || 'ortam değişkeni'} tanımlayın.`);

  if ((model && model.startsWith('latest')) || (fastModel && fastModel.startsWith('latest'))) {
    const models = await fetchModels(provider, key, { refresh: true });
    model = resolveModelAlias(model, models);
    fastModel = resolveModelAlias(fastModel, models);
  }

  const routerPort = port || cfg.router?.port || DEFAULT_ROUTER_PORT;
  const routerUrl = `http://127.0.0.1:${routerPort}`;
  const results = [];
  for (const tool of tools) {
    if (tool === 'claude') {
      if (!provider.anthropicBase) {
        need(provider.openaiBase, `${pid} Claude Code ile kullanılamaz.`);
        cfg.router = { provider: pid, model, fastModel, port: routerPort };
      }
      const file = applyClaude({ provider, key, model, fastModel, routerUrl });
      results.push({ tool, file, viaRouter: !provider.anthropicBase });
    } else if (tool === 'codex') {
      need(provider.openaiBase, `${pid} OpenAI uyumlu uç nokta sunmuyor; Codex için kullanılamaz.`);
      const file = applyCodex({ provider, model, keyEnvName: keyEnvName(provider), routerUrl });
      results.push({ tool, file, keyEnv: provider.noKey ? null : keyEnvName(provider) });
    } else if (tool === 'opencode') {
      need(provider.openaiBase, `${pid} OpenCode için OpenAI uyumlu uç nokta gerektirir.`);
      const file = applyOpencode({ provider, model, keyEnvName: keyEnvName(provider) });
      results.push({ tool, file, keyEnv: provider.noKey ? null : keyEnvName(provider) });
    } else {
      throw new Error(`Bilinmeyen araç: ${tool} (claude | codex | opencode)`);
    }
    cfg.active[tool] = { provider: pid, model: model || null, fastModel: fastModel || null, at: new Date().toISOString() };
  }
  saveConfig(cfg);
  return { provider: pid, model, fastModel, results };
}

// Aracın kendi resmî girişine (Claude Pro/Max OAuth, ChatGPT girişi) döner; diğer ayarlar korunur.
export function useOfficial(tools = ['claude', 'codex']) {
  const cfg = loadConfig();
  const out = [];
  for (const t of tools) {
    if (t === 'claude') out.push({ tool: t, file: clearClaude() });
    else if (t === 'codex') out.push({ tool: t, file: clearCodex() });
    else if (t === 'opencode') out.push({ tool: t, ...restoreOriginal('opencode') });
    cfg.active[t] = { provider: 'official', at: new Date().toISOString() };
  }
  saveConfig(cfg);
  return out;
}

export function restore(tools = TOOLS) {
  const cfg = loadConfig();
  const out = tools.map(t => { delete cfg.active[t]; return restoreOriginal(t); });
  saveConfig(cfg);
  return out;
}

export function status() {
  const cfg = loadConfig();
  return {
    active: cfg.active,
    router: cfg.router || null,
    claude: statusClaude(),
    codex: statusCodex(),
    opencode: statusOpencode(),
    keys: Object.fromEntries(listProviderIds(cfg).map(id => {
      const p = resolveProvider(cfg, id);
      return [id, p ? mask(getKey(cfg, p)) : '(geçersiz)'];
    }))
  };
}

export function providers() {
  const cfg = loadConfig();
  return listProviderIds(cfg).map(id => {
    const p = resolveProvider(cfg, id);
    return { id, label: p?.label || id, claude: !!p?.anthropicBase || !!p?.openaiBase, codex: !!p?.openaiBase, custom: !PRESETS[id], hasKey: !!(p && getKey(cfg, p)) };
  });
}

export function setKey(pid, key) {
  const cfg = loadConfig();
  need(resolveProvider(cfg, pid), `Bilinmeyen sağlayıcı: ${pid}`);
  if (key) cfg.keys[pid] = key; else delete cfg.keys[pid];
  saveConfig(cfg);
}

export function addProvider(id, spec) {
  const cfg = loadConfig();
  need(spec.anthropicBase || spec.openaiBase, 'En az --anthropic-base veya --openai-base gerekli.');
  cfg.providers[id] = { label: spec.label || id, ...spec };
  saveConfig(cfg);
}

export function removeProvider(id) {
  const cfg = loadConfig();
  delete cfg.providers[id]; delete cfg.keys[id];
  saveConfig(cfg);
}

export async function models(pid, { refresh } = {}) {
  const cfg = loadConfig();
  const p = resolveProvider(cfg, pid);
  need(p, `Bilinmeyen sağlayıcı: ${pid}`);
  return fetchModels(p, getKey(cfg, p), { refresh });
}

// Kayıtlı tüm anahtarları, araçların beklediği ortam değişkeni adlarıyla döndürür.
export function toolEnv() {
  const cfg = loadConfig();
  const env = {};
  for (const id of listProviderIds(cfg)) {
    const p = resolveProvider(cfg, id);
    if (!p || p.noKey) continue;
    const k = getKey(cfg, p);
    if (k) env[keyEnvName(p)] = k;
  }
  return env;
}

export function run(tool, args = []) {
  const bin = { claude: 'claude', codex: 'codex', opencode: 'opencode' }[tool] || tool;
  const child = spawn(bin, args, { stdio: 'inherit', env: { ...process.env, ...toolEnv() }, shell: process.platform === 'win32' });
  return new Promise(r => child.on('exit', code => r(code ?? 0)));
}

export function routerTarget() {
  const cfg = loadConfig();
  need(cfg.router, 'Yönlendirici gerekmiyor: aktif Claude sağlayıcısı zaten Anthropic uyumlu.');
  const p = resolveProvider(cfg, cfg.router.provider);
  return { baseUrl: p.openaiBase, key: p.noKey ? '' : getKey(cfg, p), model: cfg.router.model, fastModel: cfg.router.fastModel, port: cfg.router.port };
}

export { listBackups };
