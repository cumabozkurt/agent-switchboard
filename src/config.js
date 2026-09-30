import path from 'node:path';
import { appDir } from './paths.js';
import { readJsonStrict, writeJson, mkdirPrivate } from './fsutil.js';
import { t } from './i18n/index.js';

export function configPath() { return path.join(appDir(), 'config.json'); }

// Katı okuma: config.json bozuksa kayıtlı anahtarlar sessizce silinmesin diye hata verilir.
export function loadConfig() {
  const cfg = readJsonStrict(configPath(), {});
  cfg.version ||= 1; cfg.keys ||= {}; cfg.providers ||= {}; cfg.active ||= {};
  return cfg;
}

export function saveConfig(cfg) {
  cfg.keys ||= {}; cfg.providers ||= {}; cfg.active ||= {};
  mkdirPrivate(appDir());
  writeJson(configPath(), cfg, 0o600);
}

// Anahtar önceliği: kayıtlı anahtar > ortam değişkeni
export function getKey(cfg, provider) {
  if (provider.noKey) return 'ollama';
  return cfg.keys?.[provider.id] || (provider.keyEnv && process.env[provider.keyEnv]) || '';
}

export function mask(key) {
  if (!key) return t('key.none');
  return key.length <= 10 ? '****' : key.slice(0, 6) + '…' + key.slice(-4);
}
