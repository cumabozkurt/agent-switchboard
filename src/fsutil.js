import fs from 'node:fs';
import path from 'node:path';

export function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

// Bozuk/okunamayan dosyada sessizce varsayılana dönen okuyucu: yalnızca önbellek gibi
// kaybı önemsiz dosyalar için kullanılır.
export function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Kullanıcı dosyaları için katı okuyucu: dosya yoksa varsayılanı döndürür, ama dosya var
// ve ayrıştırılamıyorsa HATA verir. Böylece bozuk/yorum içeren bir ayar dosyası asla
// boş bir nesneyle ezilmez.
export function readJsonStrict(file, fallback = {}, { jsonc = false } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return fallback;
  try { return JSON.parse(text); } catch (e) {
    if (jsonc) {
      try { return JSON.parse(stripJsonc(text)); } catch { /* aşağıdaki hata */ }
    }
    throw new Error(`${file} geçerli JSON değil (${e.message}). Dosyaya dokunulmadı; düzeltip tekrar deneyin.`);
  }
}

// JSONC (yorumlar ve sondaki virgüller) → JSON. Dizgelerin içindeki // ve /* korunur.
export function stripJsonc(text) {
  let out = '', i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  // Sondaki virgüller (dizge dışında kaldığı garanti: yukarıda dizgeler aynen kopyalandı)
  return out.replace(/,(\s*[}\]])/g, (m, g, off) => (insideString(out, off) ? m : g));
}

function insideString(s, pos) {
  let inStr = false;
  for (let i = 0; i < pos; i++) {
    if (s[i] === '\\' && inStr) { i++; continue; }
    if (s[i] === '"') inStr = !inStr;
  }
  return inStr;
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Atomik yazma: önce geçici dosya, sonra rename. Windows'ta hedef dosya başka bir süreç
// (ör. editör, antivirüs, aracın kendisi) tarafından tutuluyorsa rename EPERM/EBUSY/EACCES
// verebilir; birkaç kez yeniden denenir, olmazsa doğrudan üzerine yazılır.
export function writeFileSafe(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let keepMode = mode;
  if (keepMode == null) {
    try { keepMode = fs.statSync(file).mode & 0o777; } catch { keepMode = undefined; }
  }
  const tmp = `${file}.aswitch-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, keepMode != null ? { mode: keepMode } : undefined);
  if (keepMode != null && process.platform !== 'win32') {
    try { fs.chmodSync(tmp, keepMode); } catch { /* umask yeterli */ }
  }
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      lastErr = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
      sleep(40 * (attempt + 1));
    }
  }
  try {
    fs.writeFileSync(file, content, keepMode != null ? { mode: keepMode } : undefined);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* yok say */ }
    throw lastErr || e;
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* yok say */ }
}

export function writeJson(file, obj, mode) {
  writeFileSafe(file, JSON.stringify(obj, null, 2) + '\n', mode);
}
