// aswitch:// deep links: share a custom provider, a profile or a whole (key-less) export as one link.
//   aswitch://provider?id=my-gw&label=My%20GW&openaiBase=https://…/v1&anthropicBase=…&modelsUrl=…&wire=chat&keyEnv=MY_KEY
//   aswitch://profile?name=cheap&claude=openrouter:deepseek/deepseek-chat&codex=official
//   aswitch://import?data=<base64url of an "aswitch export" JSON>
// Links never carry API keys: key-like parameters and "keys" blocks are dropped, and nothing is applied
// without an explicit confirmation (CLI prompt/--yes, desktop dialog).
import { loadConfig } from './config.js';
import { PRESETS } from './providers.js';
import { importConfig, exportConfig, TOOLS } from './core.js';
import { checkOutboundUrl } from './netguard.js';
import { t } from './i18n/index.js';

export const DEEPLINK_SCHEME = 'aswitch:';
const MAX_LEN = 16384;
const KEY_PARAMS = /^(key|apikey|api_key|token|secret|password|auth|authorization)$/i;
const fail = (key, vars) => { throw Object.assign(new Error(t(key, vars)), { code: key }); };

const b64u = s => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url').toString('utf8');

// Turns a link into an import bundle (same shape as `aswitch export`, keys removed) + a preview.
export function parseDeepLink(raw) {
  const s = String(raw || '').trim();
  if (s.length > MAX_LEN) fail('err.linkTooLong');
  let u;
  try { u = new URL(s); } catch { fail('err.badLink'); }
  if (u.protocol !== DEEPLINK_SCHEME) fail('err.badLink');
  const kind = (u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0]).toLowerCase();
  const q = u.searchParams;
  let keysStripped = [...q.keys()].some(k => KEY_PARAMS.test(k));
  const bundle = { format: 'agent-switchboard', formatVersion: 1, providers: {}, profiles: {} };
  if (kind === 'provider') {
    const id = q.get('id') || '';
    const spec = {};
    for (const [k, name] of [['label', 'label'], ['openaiBase', 'openaiBase'], ['anthropicBase', 'anthropicBase'], ['modelsUrl', 'modelsUrl'], ['wire', 'codexWire'], ['keyEnv', 'keyEnv']])
      if (q.get(k)) spec[name] = q.get(k);
    if (!id) fail('err.badLink');
    bundle.providers[id] = spec;
  } else if (kind === 'profile') {
    const name = q.get('name') || '';
    if (!name) fail('err.badLink');
    const tools = {};
    for (const tool of TOOLS) {
      const v = q.get(tool);
      if (!v) continue;
      if (v === 'official') { tools[tool] = { provider: 'official' }; continue; }
      const [provider, ...rest] = v.split(':');
      const [model, fastModel] = rest.join(':').split('|');
      tools[tool] = { provider, model: model || null, fastModel: fastModel || null };
    }
    if (!Object.keys(tools).length) fail('err.badLink');
    bundle.profiles[name] = { tools };
  } else if (kind === 'import') {
    let data;
    try { data = JSON.parse(unb64u(q.get('data') || '')); } catch { fail('err.badLink'); }
    if (!data || data.format !== 'agent-switchboard' || data.formatVersion !== 1) fail('err.badImport');
    if (data.keys && Object.keys(data.keys).length) keysStripped = true;
    bundle.providers = data.providers && typeof data.providers === 'object' ? data.providers : {};
    bundle.profiles = data.profiles && typeof data.profiles === 'object' ? data.profiles : {};
    if (data.fallback && typeof data.fallback === 'object') bundle.fallback = data.fallback;
  } else fail('err.badLink');
  return { kind, bundle, keysStripped, preview: previewBundle(bundle, keysStripped) };
}

// Validates like addProvider does, without writing, so the confirmation shows exactly what would change.
function previewBundle(bundle, keysStripped) {
  const cfg = loadConfig();
  const providers = Object.entries(bundle.providers).map(([id, spec]) => {
    const p = { id, label: spec?.label || id, openaiBase: spec?.openaiBase || '', anthropicBase: spec?.anthropicBase || '', modelsUrl: spec?.modelsUrl || '', exists: !!cfg.providers?.[id], preset: !!PRESETS[id], error: null };
    try {
      if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(id)) fail('err.badProviderId');
      if (PRESETS[id]) fail('err.presetId', { id });
      if (!p.openaiBase && !p.anthropicBase) fail('err.needBase');
      for (const k of ['openaiBase', 'anthropicBase', 'modelsUrl']) if (p[k]) checkOutboundUrl(p[k], k);
    } catch (e) { p.error = e.message; }
    return p;
  });
  const known = id => id === 'official' || !!PRESETS[id] || !!cfg.providers?.[id] || !!bundle.providers[id];
  const profiles = Object.entries(bundle.profiles).map(([name, p]) => ({
    name, exists: !!cfg.profiles?.[name],
    tools: Object.fromEntries(Object.entries(p?.tools || {}).map(([tool, v]) => [tool, v?.provider === 'official' ? 'official' : `${v?.provider}${v?.model ? ':' + v.model : ''}`])),
    missing: [...new Set(Object.values(p?.tools || {}).map(v => v?.provider).filter(id => id && !known(id)))]
  }));
  return { providers, profiles, fallback: Object.keys(bundle.fallback || {}), keysStripped };
}

// Applies a parsed link through the normal import path (never keys, never overwrites unless asked).
export function applyDeepLink(raw, { overwrite = false } = {}) {
  const parsed = typeof raw === 'string' ? parseDeepLink(raw) : raw;
  const bad = parsed.preview.providers.find(p => p.error);
  if (bad) throw new Error(bad.error);
  const { keys, ...clean } = parsed.bundle; // eslint-disable-line no-unused-vars
  const counts = importConfig(clean, { overwrite });
  return { kind: parsed.kind, counts, keysStripped: parsed.keysStripped };
}

// Builds a share link for a custom provider, a profile (+ the custom providers it uses) or everything.
export function makeDeepLink(kind, id) {
  const cfg = loadConfig();
  if (kind === 'provider') {
    const p = cfg.providers?.[id];
    if (!p) fail('err.notCustom', { id });
    const q = new URLSearchParams({ id });
    for (const [k, name] of [['label', 'label'], ['openaiBase', 'openaiBase'], ['anthropicBase', 'anthropicBase'], ['modelsUrl', 'modelsUrl'], ['codexWire', 'wire'], ['keyEnv', 'keyEnv']])
      if (p[k]) q.set(name, p[k]);
    return 'aswitch://provider?' + q.toString();
  }
  if (kind === 'profile') {
    const p = cfg.profiles?.[id];
    if (!p) fail('err.profileNotFound', { name: id });
    const custom = [...new Set(Object.values(p.tools).map(v => v.provider))].filter(pid => cfg.providers?.[pid]);
    if (!custom.length) {
      const q = new URLSearchParams({ name: id });
      for (const [tool, v] of Object.entries(p.tools))
        q.set(tool, v.provider === 'official' ? 'official' : [v.provider, [v.model || '', v.fastModel ? '|' + v.fastModel : ''].join('')].filter(Boolean).join(':'));
      return 'aswitch://profile?' + q.toString();
    }
    const data = { format: 'agent-switchboard', formatVersion: 1, providers: Object.fromEntries(custom.map(pid => [pid, cfg.providers[pid]])), profiles: { [id]: { tools: p.tools } } };
    return 'aswitch://import?data=' + b64u(JSON.stringify(data));
  }
  if (kind === 'all') {
    const { keys, settings, exportedAt, ...data } = exportConfig({ withKeys: false }); // eslint-disable-line no-unused-vars
    return 'aswitch://import?data=' + b64u(JSON.stringify(data));
  }
  fail('err.badLink');
}

// Finds an aswitch:// argument in a process argv (Windows/Linux pass the link as a command-line argument).
export function linkFromArgv(argv = []) {
  return argv.find(a => typeof a === 'string' && a.toLowerCase().startsWith('aswitch://')) || null;
}
