import path from 'node:path';
import { opencodeConfigPath } from '../paths.js';
import { readJsonStrict, writeJson, exists } from '../fsutil.js';
import { ensureOriginal, snapshot } from '../backup.js';

// OpenCode'un yerleşik sağlayıcı kimlikleri (https://opencode.ai/docs/zen, /docs/go, /docs/providers):
// Zen = "opencode", Go = "opencode-go". Bunlar kendi girişlerini (/connect) veya OPENCODE_API_KEY'i kullanır.
// Diğerleri için @ai-sdk/openai-compatible ile özel sağlayıcı bloğu yazılır.
export const BUILTIN = { 'opencode-zen': 'opencode', 'opencode-go': 'opencode-go', openrouter: 'openrouter', anthropic: 'anthropic', openai: 'openai' };

// ~/.config/opencode/opencode.json yoksa ama opencode.jsonc varsa onu düzenleriz.
export function opencodeFile() {
  const json = opencodeConfigPath();
  const jsonc = path.join(path.dirname(json), 'opencode.jsonc');
  return !exists(json) && exists(jsonc) ? jsonc : json;
}

export function applyOpencode({ provider, model, keyEnvName }) {
  const file = opencodeFile();
  // JSONC (yorumlu) dosyalar okunur; bozuk dosyada hata verilir ve dosyaya dokunulmaz.
  const c = readJsonStrict(file, { $schema: 'https://opencode.ai/config.json' }, { jsonc: true });
  ensureOriginal('opencode', file);
  snapshot('opencode', file);
  const builtin = BUILTIN[provider.id];
  const pid = builtin || `aswitch-${provider.id}`;
  if (!builtin) {
    if (!c.provider || typeof c.provider !== 'object') c.provider = {};
    c.provider[pid] = {
      npm: '@ai-sdk/openai-compatible',
      name: provider.label || provider.id,
      options: { baseURL: provider.openaiBase, ...(provider.noKey ? {} : { apiKey: `{env:${keyEnvName}}` }) },
      models: model ? { [model]: {} } : {}
    };
  }
  if (model) c.model = `${pid}/${model}`;
  writeJson(file, c);
  return file;
}

export function statusOpencode() {
  const file = opencodeFile();
  try {
    const c = readJsonStrict(file, {}, { jsonc: true });
    return { file, model: c.model || '(varsayılan)' };
  } catch (e) { return { file, model: '?', error: e.message }; }
}
