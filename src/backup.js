import fs from 'node:fs';
import path from 'node:path';
import { appDir } from './paths.js';
import { exists, readJson, writeJson } from './fsutil.js';

// İlk dokunuşta dosyanın ORİJİNAL hali saklanır; her değişiklikten önce ayrıca zaman damgalı yedek alınır.
function manifestPath() { return path.join(appDir(), 'originals', 'manifest.json'); }

export function ensureOriginal(target, file) {
  const mf = readJson(manifestPath(), {});
  if (mf[target]) return;
  const dir = path.join(appDir(), 'originals');
  fs.mkdirSync(dir, { recursive: true });
  if (exists(file)) {
    const copy = path.join(dir, target + path.extname(file));
    fs.copyFileSync(file, copy);
    mf[target] = { file, copy, existed: true, at: new Date().toISOString() };
  } else {
    mf[target] = { file, existed: false, at: new Date().toISOString() };
  }
  writeJson(manifestPath(), mf);
}

export function snapshot(target, file) {
  if (!exists(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(appDir(), 'backups', stamp);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, target + path.extname(file));
  fs.copyFileSync(file, dest);
  return dest;
}

export function restoreOriginal(target) {
  const mf = readJson(manifestPath(), {});
  const rec = mf[target];
  if (!rec) return { target, restored: false, reason: 'Bu araç için değişiklik yapılmamış.' };
  snapshot(target, rec.file);
  if (rec.existed) {
    fs.mkdirSync(path.dirname(rec.file), { recursive: true });
    fs.copyFileSync(rec.copy, rec.file);
  } else if (exists(rec.file)) {
    fs.rmSync(rec.file);
  }
  delete mf[target];
  writeJson(manifestPath(), mf);
  return { target, restored: true, file: rec.file };
}

export function listBackups() {
  const dir = path.join(appDir(), 'backups');
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).sort().reverse().map(d => ({ id: d, files: fs.readdirSync(path.join(dir, d)) }));
}
