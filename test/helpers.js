import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aswitch-'));
  process.env.ASWITCH_HOME_OVERRIDE = dir;
  process.env.ASWITCH_DIR = path.join(dir, '.agent-switchboard');
  delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, '.config');
  return dir;
}
