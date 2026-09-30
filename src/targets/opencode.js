import { opencodeConfigPath } from '../paths.js';
import { readJson, writeJson } from '../fsutil.js';
import { ensureOriginal, snapshot } from '../backup.js';

// OpenCode, Zen/Go ve OpenRouter'ı yerleşik tanır; diğerleri için özel sağlayıcı bloğu yazılır.
const BUILTIN = { 'opencode-zen': 'opencode', openrouter: 'openrouter', anthropic: 'anthropic', openai: 'openai' };

export function applyOpencode({ provider, model, keyEnvName }) {
  const file = opencodeConfigPath();
  ensureOriginal('opencode', file);
  snapshot('opencode', file);
  const c = readJson(file, { $schema: 'https://opencode.ai/config.json' });
  const builtin = BUILTIN[provider.id];
  const pid = builtin || `aswitch-${provider.id}`;
  if (!builtin) {
    c.provider ||= {};
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
  const c = readJson(opencodeConfigPath(), {});
  return { file: opencodeConfigPath(), model: c.model || '(varsayılan)' };
}
