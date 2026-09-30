// Hazır sağlayıcı profilleri. Her uç nokta resmi dokümantasyondan alınmıştır;
// kullanıcı `aswitch provider add` ile istediği OpenAI/Anthropic uyumlu servisi ekleyebilir.
//
// anthropicBase : Claude Code'un ANTHROPIC_BASE_URL'i (Claude Code sonuna /v1/messages ekler)
// openaiBase    : OpenAI uyumlu taban adres (/chat/completions, /responses, /models)
// codexWire     : Codex için "responses" veya "chat"
// modelsUrl     : Güncel model listesinin çekildiği adres
export const PRESETS = {
  anthropic: {
    label: 'Anthropic (API anahtarı)',
    anthropicBase: 'https://api.anthropic.com',
    openaiBase: 'https://api.anthropic.com/v1', // Anthropic'in OpenAI SDK uyumluluk katmanı (Codex için)
    codexWire: 'chat',
    modelsUrl: 'https://api.anthropic.com/v1/models',
    modelsAuth: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  openai: {
    label: 'OpenAI (API anahtarı)',
    openaiBase: 'https://api.openai.com/v1',
    codexWire: 'responses',
    modelsUrl: 'https://api.openai.com/v1/models',
    keyEnv: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  openrouter: {
    label: 'OpenRouter (API anahtarı veya OAuth/PKCE)',
    anthropicBase: 'https://openrouter.ai/api',
    openaiBase: 'https://openrouter.ai/api/v1',
    codexWire: 'chat',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    modelsPublic: true,
    keyEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/settings/keys',
    oauth: 'openrouter-pkce'
  },
  'opencode-zen': {
    label: 'OpenCode Zen',
    anthropicBase: 'https://opencode.ai/zen',
    openaiBase: 'https://opencode.ai/zen/v1',
    codexWire: 'responses',
    modelsUrl: 'https://opencode.ai/zen/v1/models',
    modelsPublic: true,
    keyEnv: 'OPENCODE_API_KEY',
    keyUrl: 'https://opencode.ai/auth'
  },
  'opencode-go': {
    label: 'OpenCode Go',
    anthropicBase: 'https://opencode.ai/zen/go',
    openaiBase: 'https://opencode.ai/zen/go/v1',
    codexWire: 'responses',
    modelsUrl: 'https://opencode.ai/zen/go/v1/models',
    keyEnv: 'OPENCODE_API_KEY',
    keyUrl: 'https://opencode.ai/auth'
  },
  deepseek: {
    label: 'DeepSeek',
    anthropicBase: 'https://api.deepseek.com/anthropic',
    openaiBase: 'https://api.deepseek.com/v1',
    codexWire: 'chat',
    modelsUrl: 'https://api.deepseek.com/v1/models',
    keyEnv: 'DEEPSEEK_API_KEY'
  },
  moonshot: {
    label: 'Moonshot Kimi',
    anthropicBase: 'https://api.moonshot.ai/anthropic',
    openaiBase: 'https://api.moonshot.ai/v1',
    codexWire: 'chat',
    modelsUrl: 'https://api.moonshot.ai/v1/models',
    keyEnv: 'MOONSHOT_API_KEY'
  },
  zai: {
    label: 'Z.ai GLM',
    anthropicBase: 'https://api.z.ai/api/anthropic',
    openaiBase: 'https://api.z.ai/api/paas/v4',
    codexWire: 'chat',
    keyEnv: 'ZAI_API_KEY'
  },
  gemini: {
    label: 'Google Gemini (OpenAI uyumlu uç nokta)',
    openaiBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
    codexWire: 'chat',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    keyEnv: 'GEMINI_API_KEY'
  },
  ollama: {
    label: 'Ollama (yerel)',
    anthropicBase: 'http://localhost:11434',
    openaiBase: 'http://localhost:11434/v1',
    codexWire: 'chat',
    modelsUrl: 'http://localhost:11434/v1/models',
    modelsPublic: true,
    noKey: true
  }
};

export function resolveProvider(cfg, id) {
  const custom = cfg.providers?.[id] || {};
  const preset = PRESETS[custom.preset || id] || {};
  const p = { id, ...preset, ...custom };
  if (!p.anthropicBase && !p.openaiBase) return null;
  return p;
}

export function listProviderIds(cfg) {
  return [...new Set([...Object.keys(PRESETS), ...Object.keys(cfg.providers || {})])];
}
