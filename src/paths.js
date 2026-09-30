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

// Claude Desktop, MCP ve uzantı ayarlarını bu dosyada tutar.
export function claudeDesktopConfigPath() {
  const h = home();
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(h, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(h, '.config', 'Claude', 'claude_desktop_config.json');
}
