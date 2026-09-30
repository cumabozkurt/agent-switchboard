import { claudeSettingsPath } from '../paths.js';
import { readJson, writeJson } from '../fsutil.js';
import { ensureOriginal, snapshot } from '../backup.js';

// Claude Code CLI, VS Code/JetBrains uzantıları ve Claude Code masaüstü oturumları
// aynı ~/.claude/settings.json dosyasını okur; tek dosya hepsini yönetir.
export const MANAGED_ENV = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'
];

export function buildClaudeEnv({ provider, key, model, fastModel, routerUrl }) {
  const env = {};
  const fast = fastModel || model;
  if (provider.id === 'anthropic' && !provider.anthropicBaseOverride) {
    env.ANTHROPIC_API_KEY = key;
  } else if (provider.anthropicBase) {
    env.ANTHROPIC_BASE_URL = provider.anthropicBase;
    env.ANTHROPIC_AUTH_TOKEN = key;
    env.ANTHROPIC_API_KEY = ''; // Anthropic hesabına sızmayı önler (OpenRouter önerisi)
  } else {
    // Sağlayıcı yalnızca OpenAI uyumluysa yerel çeviri yönlendiricisi kullanılır.
    env.ANTHROPIC_BASE_URL = routerUrl;
    env.ANTHROPIC_AUTH_TOKEN = 'aswitch-local';
    env.ANTHROPIC_API_KEY = '';
  }
  if (model) {
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  }
  if (fast) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = fast;
    env.ANTHROPIC_SMALL_FAST_MODEL = fast;
  }
  return env;
}

export function applyClaude(opts) {
  const file = claudeSettingsPath();
  ensureOriginal('claude', file);
  snapshot('claude', file);
  const s = readJson(file, {});
  s.env ||= {};
  for (const k of MANAGED_ENV) delete s.env[k];
  Object.assign(s.env, buildClaudeEnv(opts));
  if (opts.model) s.model = opts.model; else delete s.model;
  writeJson(file, s, 0o600);
  return file;
}

// Resmî girişe (claude /login, Pro/Max OAuth) dönmek için yönetilen alanları kaldırır,
// kullanıcının diğer ayarlarına dokunmaz.
export function clearClaude() {
  const file = claudeSettingsPath();
  const s = readJson(file, null);
  if (!s) return file;
  snapshot('claude', file);
  for (const k of MANAGED_ENV) delete s.env?.[k];
  if (s.env && !Object.keys(s.env).length) delete s.env;
  delete s.model;
  writeJson(file, s, 0o600);
  return file;
}

export function statusClaude() {
  const s = readJson(claudeSettingsPath(), {});
  return {
    file: claudeSettingsPath(),
    baseUrl: s.env?.ANTHROPIC_BASE_URL || '(resmî Anthropic)',
    model: s.env?.ANTHROPIC_MODEL || s.model || '(varsayılan)'
  };
}
