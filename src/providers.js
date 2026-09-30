// Hazır sağlayıcı profilleri. Her uç nokta resmi dokümantasyondan alınmıştır;
// kullanıcı `aswitch provider add` ile istediği OpenAI/Anthropic uyumlu servisi ekleyebilir.
//
// anthropicBase : Claude Code'un ANTHROPIC_BASE_URL'i (Claude Code sonuna /v1/messages ekler)
// openaiBase    : OpenAI uyumlu taban adres (/chat/completions, /responses, /models)
// codexWire     : Sağlayıcının OpenAI tarafında sunduğu API: "responses" (Codex doğrudan bağlanır)
//                 veya "chat" (yalnız /chat/completions; Codex yerel yönlendirici üzerinden bağlanır,
//                 çünkü güncel Codex yalnızca wire_api = "responses" destekler)
// modelApis     : Model başına farklı uç nokta kullanan sağlayıcılar için [düzenli ifade, api] listesi
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
    codexWire: 'responses', // https://openrouter.ai/docs/api_reference/responses/overview (durumsuz)
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
    // https://opencode.ai/docs/zen/#endpoints — her model kendi uç noktasını kullanır
    modelApis: [
      [/^(gpt-|grok-|muse-)/i, 'responses'],
      [/^claude-/i, 'messages'],
      [/^qwen3\.8-max/i, 'chat'],
      [/^qwen/i, 'messages'],
      [/^gemini-/i, 'google'],
      [/^jev-/i, 'none'],
      [/.*/, 'chat']
    ],
    modelsUrl: 'https://opencode.ai/zen/v1/models',
    modelsPublic: true,
    keyEnv: 'OPENCODE_API_KEY',
    keyUrl: 'https://opencode.ai/auth'
  },
  'opencode-go': {
    label: 'OpenCode Go',
    anthropicBase: 'https://opencode.ai/zen/go',
    openaiBase: 'https://opencode.ai/zen/go/v1',
    codexWire: 'chat',
    // https://opencode.ai/docs/go/#endpoints
    modelApis: [
      [/^(gpt-|grok-|muse-)/i, 'responses'],
      [/^(minimax-|qwen)/i, 'messages'],
      [/.*/, 'chat']
    ],
    modelsUrl: 'https://opencode.ai/zen/go/v1/models',
    modelsPublic: true,
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
    codexWire: 'responses', // Ollama ≥ 0.13.3: /v1/responses (https://docs.ollama.com/api/openai-compatibility)
    modelsUrl: 'http://localhost:11434/v1/models',
    modelsPublic: true,
    noKey: true
  }
};

export function resolveProvider(cfg, id) {
  if (!id) return null;
  const custom = cfg.providers?.[id] || {};
  if (!PRESETS[custom.preset || id] && !cfg.providers?.[id]) return null;
  const preset = PRESETS[custom.preset || id] || {};
  const clean = Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const p = { id, ...preset, ...clean };
  if (!p.anthropicBase && !p.openaiBase) return null;
  return p;
}

// Bir modelin sağlayıcıda hangi API ile sunulduğu: 'messages' | 'responses' | 'chat' | 'google' | 'none' | null
export function modelApi(provider, model) {
  if (!model || !provider.modelApis) return null;
  for (const [re, api] of provider.modelApis) if (re.test(model)) return api;
  return null;
}

// Claude Code için bağlantı biçimi: 'direct' (Anthropic uyumlu uç nokta), 'router' (yerel çevirici →
// /chat/completions ya da /responses) veya null (desteklenmiyor).
export function claudeMode(provider, model) {
  const api = modelApi(provider, model);
  if (api === 'messages' || (api === null && provider.anthropicBase)) return provider.anthropicBase ? 'direct' : null;
  if ((api === 'chat' || api === 'responses' || api === null) && provider.openaiBase) return 'router';
  return null;
}

// Yönlendiricinin Claude Code isteklerini bu model için hangi API'ye çevireceği: 'messages' (olduğu gibi
// iletilir), 'responses' veya 'chat'. Tabloda olmayan modellerde, Anthropic uç noktası olmayan ve Responses
// sunan sağlayıcılar (ör. OpenAI) Responses ile, diğerleri Chat Completions ile konuşur.
export function claudeRouterApi(provider, model) {
  const api = modelApi(provider, model);
  if (api === 'messages' && provider.anthropicBase) return 'messages';
  if (api === 'responses') return 'responses';
  if (api === null && !provider.anthropicBase && provider.codexWire === 'responses') return 'responses';
  return 'chat';
}

// Codex için bağlantı biçimi: 'direct' (sağlayıcının /responses uç noktası), 'router' (yerel çevirici
// Responses → Chat Completions) veya null.
export function codexMode(provider, model) {
  if (!provider.openaiBase) return null;
  const api = modelApi(provider, model);
  if (api === 'responses' || (api === null && provider.codexWire === 'responses')) return 'direct';
  if (api === 'chat' || api === null) return 'router';
  return null;
}

export function listProviderIds(cfg) {
  return [...new Set([...Object.keys(PRESETS), ...Object.keys(cfg.providers || {})])];
}
