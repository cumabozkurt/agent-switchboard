import { claudeSettingsPath } from '../paths.js';
import { readJsonStrict, writeJson } from '../fsutil.js';
import { ensureOriginal, snapshot, getState, setState } from '../backup.js';

// Claude Code CLI, VS Code/JetBrains uzantıları ve Claude Code masaüstü oturumları
// aynı ~/.claude/settings.json dosyasını okur; tek dosya hepsini yönetir.
// Değişken adları: https://code.claude.com/docs/en/env-vars
export const MANAGED_ENV = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL' // artık yazılmıyor (belgelerde DEPRECATED); eski sürümlerden kalanı temizlemek için listede
];

const ANTHROPIC_OFFICIAL = /^https:\/\/api\.anthropic\.com\/?$/;

// mode: 'direct' (Anthropic uyumlu uç nokta) | 'router' (yerel çevirici)
export function buildClaudeEnv({ provider, key, model, fastModel, routerUrl, mode = provider.anthropicBase ? 'direct' : 'router' }) {
  const env = {};
  const fast = fastModel || model;
  if (mode === 'router') {
    // Sağlayıcı (veya seçilen model) yalnızca OpenAI uyumluysa yerel çeviri yönlendiricisi kullanılır.
    env.ANTHROPIC_BASE_URL = routerUrl;
    env.ANTHROPIC_AUTH_TOKEN = 'aswitch-local';
    env.ANTHROPIC_API_KEY = '';
  } else if (ANTHROPIC_OFFICIAL.test(provider.anthropicBase)) {
    // Resmî Anthropic API: yalnızca anahtar yeterli (X-Api-Key). BASE_URL/AUTH_TOKEN yazılmaz.
    env.ANTHROPIC_API_KEY = key;
  } else {
    env.ANTHROPIC_BASE_URL = provider.anthropicBase;
    env.ANTHROPIC_AUTH_TOKEN = key;
    env.ANTHROPIC_API_KEY = ''; // Anthropic hesabına sızmayı önler (OpenRouter önerisi)
  }
  if (model) {
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = model;
    env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  }
  if (fast) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = fast;
  return env;
}

export function applyClaude(opts) {
  const file = claudeSettingsPath();
  const s = readJsonStrict(file, {}); // bozuk dosyada hata verir, üzerine yazmaz
  ensureOriginal('claude', file);
  snapshot('claude', file);
  // Kullanıcının kendi "model" tercihini ilk uygulamada sakla; "official" ile geri konur.
  if (!getState('claude')) setState('claude', { hadModel: 'model' in s, model: s.model ?? null });
  if (!s.env || typeof s.env !== 'object') s.env = {};
  for (const k of MANAGED_ENV) delete s.env[k];
  Object.assign(s.env, buildClaudeEnv(opts));
  if (opts.model) s.model = opts.model; else delete s.model;
  writeJson(file, s, 0o600);
  return file;
}

// Resmî girişe (claude /login, Pro/Max OAuth) dönmek için yönetilen alanları kaldırır,
// kullanıcının önceki "model" değerini geri koyar, diğer ayarlara dokunmaz.
export function clearClaude() {
  const file = claudeSettingsPath();
  const s = readJsonStrict(file, null);
  const saved = getState('claude');
  if (!s) { setState('claude', undefined); return file; }
  snapshot('claude', file);
  if (s.env && typeof s.env === 'object') {
    for (const k of MANAGED_ENV) delete s.env[k];
    if (!Object.keys(s.env).length) delete s.env;
  }
  if (saved) {
    if (saved.hadModel) s.model = saved.model; else delete s.model;
  } else {
    delete s.model;
  }
  writeJson(file, s, 0o600);
  setState('claude', undefined);
  return file;
}

export function statusClaude() {
  let s = {};
  try { s = readJsonStrict(claudeSettingsPath(), {}); } catch (e) { return { file: claudeSettingsPath(), error: e.message, mode: 'error', baseUrl: null, model: null }; }
  const base = s.env?.ANTHROPIC_BASE_URL || null;
  // mode: official (subscription login) | apikey (Anthropic API key) | custom (other endpoint) | router (local router)
  const mode = base ? (/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(base) ? 'router' : 'custom') : s.env?.ANTHROPIC_API_KEY ? 'apikey' : 'official';
  return { file: claudeSettingsPath(), mode, baseUrl: base || (mode === 'apikey' ? 'https://api.anthropic.com' : null), model: s.env?.ANTHROPIC_MODEL || s.model || null };
}
