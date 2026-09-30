import os from 'node:os';
import path from 'node:path';

// Tüm yollar ortam değişkeniyle değiştirilebilir (test ve taşınabilir kurulum için).
export function home() {
  return process.env.ASWITCH_HOME_OVERRIDE || os.homedir();
}

export function appDir() {
  return process.env.ASWITCH_DIR || path.join(home(), '.agent-switchboard');
}

export function claudeSettingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
  return path.join(dir, 'settings.json');
}

export function codexConfigPath() {
  const dir = process.env.CODEX_HOME || path.join(home(), '.codex');
  return path.join(dir, 'config.toml');
}

export function opencodeConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(home(), '.config');
  return path.join(base, 'opencode', 'opencode.json');
}
