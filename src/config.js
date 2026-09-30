import path from 'node:path';
import { appDir } from './paths.js';
import { readJson, writeJson } from './fsutil.js';

export function configPath() { return path.join(appDir(), 'config.json'); }

export function loadConfig() {
  return readJson(configPath(), { version: 1, keys: {}, providers: {}, active: {} });
}

export function saveConfig(cfg) {
  cfg.keys ||= {}; cfg.providers ||= {}; cfg.active ||= {};
  writeJson(configPath(), cfg, 0o600);
}

// Anahtar önceliği: kayıtlı anahtar > ortam değişkeni
export function getKey(cfg, provider) {
  if (provider.noKey) return 'ollama';
  return cfg.keys?.[provider.id] || (provider.keyEnv && process.env[provider.keyEnv]) || '';
}

export function mask(key) {
  if (!key) return '(yok)';
  return key.length <= 10 ? '****' : key.slice(0, 6) + '…' + key.slice(-4);
}
