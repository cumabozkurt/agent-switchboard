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
    label: 'Anthropic',
    anthropicBase: 'https://api.anthropic.com',
    openaiBase: 'https://api.anthropic.com/v1', // Anthropic'in OpenAI SDK uyumluluk katmanı (Codex için)
    codexWire: 'chat',
    modelsUrl: 'https://api.anthropic.com/v1/models',
    modelsAuth: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  openai: {
    label: 'OpenAI',
    openaiBase: 'https://api.openai.com/v1',
    codexWire: 'responses',
    modelsUrl: 'https://api.openai.com/v1/models',
    keyEnv: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  openrouter: {
    label: 'OpenRouter',
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
    label: 'Google Gemini',
    geminiBase: 'https://generativelanguage.googleapis.com', // Gemini CLI connects natively (no router)
    openaiBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
    codexWire: 'chat',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    keyEnv: 'GEMINI_API_KEY'
  },
  // v0.3.0 presets. Endpoints from each vendor's official docs (links in docs/PROVIDERS.md).
  minimax: {
    label: 'MiniMax',
    anthropicBase: 'https://api.minimax.io/anthropic',
    openaiBase: 'https://api.minimax.io/v1',
    codexWire: 'chat',
    keyEnv: 'MINIMAX_API_KEY',
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key'
  },
  xai: {
    label: 'xAI Grok',
    openaiBase: 'https://api.x.ai/v1',
    codexWire: 'responses',
    modelsUrl: 'https://api.x.ai/v1/models',
    keyEnv: 'XAI_API_KEY',
    keyUrl: 'https://console.x.ai'
  },
  groq: {
    label: 'Groq',
    openaiBase: 'https://api.groq.com/openai/v1',
    codexWire: 'chat',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    keyEnv: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys'
  },
  mistral: {
    label: 'Mistral',
    openaiBase: 'https://api.mistral.ai/v1',
    codexWire: 'chat',
    modelsUrl: 'https://api.mistral.ai/v1/models',
    keyEnv: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys'
  },
  cerebras: {
    label: 'Cerebras',
    openaiBase: 'https://api.cerebras.ai/v1',
    codexWire: 'chat',
    modelsUrl: 'https://api.cerebras.ai/v1/models',
    keyEnv: 'CEREBRAS_API_KEY',
    keyUrl: 'https://cloud.cerebras.ai'
  },
  nvidia: {
    label: 'NVIDIA NIM',
    openaiBase: 'https://integrate.api.nvidia.com/v1',
    codexWire: 'chat',
    modelsUrl: 'https://integrate.api.nvidia.com/v1/models',
    modelsPublic: true,
    keyEnv: 'NVIDIA_API_KEY',
    keyUrl: 'https://build.nvidia.com'
  },
  siliconflow: {
    label: 'SiliconFlow',
    anthropicBase: 'https://api.siliconflow.com',
    openaiBase: 'https://api.siliconflow.com/v1',
    codexWire: 'chat',
    modelsUrl: 'https://api.siliconflow.com/v1/models',
    keyEnv: 'SILICONFLOW_API_KEY',
    keyUrl: 'https://cloud.siliconflow.com/account/ak'
  },
  lmstudio: {
    label: 'LM Studio',
    anthropicBase: 'http://localhost:1234', // LM Studio ≥ 0.4: POST /v1/messages (https://lmstudio.ai/docs/developer/anthropic-compat)
    openaiBase: 'http://localhost:1234/v1',
    codexWire: 'responses', // LM Studio ≥ 0.3.29: POST /v1/responses
    modelsUrl: 'http://localhost:1234/v1/models',
    modelsPublic: true,
    noKey: true
  },
  ollama: {
    label: 'Ollama',
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

// Gemini CLI: 'direct' (the provider speaks the Gemini API natively), 'router' (the local router
// translates Gemini generateContent ⇄ the provider's Anthropic/Chat/Responses API) or null.
export function geminiMode(provider, model) {
  const api = modelApi(provider, model);
  if (provider.geminiBase && (api === null || api === 'google')) return 'direct';
  return claudeMode(provider, model) ? 'router' : null;
}

export function listProviderIds(cfg) {
  return [...new Set([...Object.keys(PRESETS), ...Object.keys(cfg.providers || {})])];
}
