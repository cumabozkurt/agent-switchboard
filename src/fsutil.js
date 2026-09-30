import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeFileSafe(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.aswitch-tmp';
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function writeJson(file, obj, mode) {
  writeFileSafe(file, JSON.stringify(obj, null, 2) + '\n', mode);
}

export function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}
