import fs from 'node:fs';
import path from 'node:path';
import { appDir } from './paths.js';
import { exists, readJson, writeJson, mkdirPrivate } from './fsutil.js';
import { t } from './i18n/index.js';

const KEEP_BACKUPS = 50;

// İlk dokunuşta dosyanın ORİJİNAL hali saklanır; her değişiklikten önce ayrıca zaman damgalı yedek alınır.
function manifestPath() { return path.join(appDir(), 'originals', 'manifest.json'); }
function statePath() { return path.join(appDir(), 'state.json'); }

export function ensureOriginal(target, file) {
  const mf = readJson(manifestPath(), {});
  if (mf[target]) return;
  const dir = path.join(appDir(), 'originals');
  mkdirPrivate(appDir()); mkdirPrivate(path.dirname(dir)); mkdirPrivate(dir);
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
  mkdirPrivate(appDir()); mkdirPrivate(path.dirname(dir)); mkdirPrivate(dir);
  let dest = path.join(dir, target + path.extname(file));
  for (let i = 2; exists(dest); i++) dest = path.join(dir, `${target}-${i}${path.extname(file)}`);
  fs.copyFileSync(file, dest);
  pruneBackups();
  return dest;
}

function pruneBackups() {
  const dir = path.join(appDir(), 'backups');
  try {
    const all = fs.readdirSync(dir).sort();
    for (const d of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  } catch { /* yedek klasörü yoksa sorun değil */ }
}

export function restoreOriginal(target) {
  const mf = readJson(manifestPath(), {});
  const rec = mf[target];
  if (!rec) return { target, restored: false, reason: t('restore.untouched') };
  if (rec.existed && !exists(rec.copy)) return { target, restored: false, reason: t('restore.copyMissing', { file: rec.copy }) };
  snapshot(target, rec.file);
  if (rec.existed) {
    fs.mkdirSync(path.dirname(rec.file), { recursive: true });
    fs.copyFileSync(rec.copy, rec.file);
  } else if (exists(rec.file)) {
    fs.rmSync(rec.file);
  }
  delete mf[target];
  writeJson(manifestPath(), mf);
  setState(target, undefined);
  return { target, restored: true, file: rec.file };
}

// Hedeflerin, resmî moda dönerken geri koyulacak küçük durum bilgileri (ör. Claude'un önceki "model" değeri).
export function getState(target) { return readJson(statePath(), {})[target]; }
export function setState(target, value) {
  const s = readJson(statePath(), {});
  if (value === undefined) { if (!(target in s)) return; delete s[target]; } else s[target] = value;
  writeJson(statePath(), s);
}

export function backupFile(id, name) { return path.join(appDir(), 'backups', id, name); }

export function listBackups() {
  const dir = path.join(appDir(), 'backups');
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).sort().reverse().map(d => ({ id: d, files: fs.readdirSync(path.join(dir, d)) }));
}
