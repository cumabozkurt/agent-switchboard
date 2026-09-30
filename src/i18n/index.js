import fs from 'node:fs';
import path from 'node:path';
import { appDir } from '../paths.js';
import en from './en.js';
import tr from './tr.js';

// Minimal, dependency-free i18n. Messages live in en.js / tr.js; placeholders use {name}.
// Language resolution order: explicit setLang() > ASWITCH_LANG > config.json "lang" >
// locale hint (e.g. Electron app.getLocale()) > POSIX locale env > Intl locale > English.
export const CATALOGS = { en, tr };
export const LANGS = Object.keys(CATALOGS);
export const LANG_NAMES = { en: 'English', tr: 'Türkçe' };

let forced = null;
let hint = null;
let cached = null;

export function normalizeLang(v) {
  const s = String(v || '').trim().toLowerCase().replace('_', '-');
  if (!s || s === 'c' || s === 'posix') return null;
  const base = s.split(/[-.@]/)[0];
  return LANGS.includes(base) ? base : null;
}

// Reads config.json directly (not via config.js) so that a corrupt config can still produce a
// translated error message without recursion.
function configLang() {
  try { return normalizeLang(JSON.parse(fs.readFileSync(path.join(appDir(), 'config.json'), 'utf8')).lang); } catch { return null; }
}

export function systemLang(localeHint) {
  const fromHint = normalizeLang(localeHint);
  if (fromHint) return fromHint;
  for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
    const first = (process.env[k] || '').split(':')[0];
    const low = first.toLowerCase();
    if (!first || low === 'c' || low === 'posix' || low.startsWith('c.')) continue;
    return normalizeLang(first) || 'en';
  }
  try { return normalizeLang(Intl.DateTimeFormat().resolvedOptions().locale) || 'en'; } catch { return 'en'; }
}

export function detectLang() {
  return forced || normalizeLang(process.env.ASWITCH_LANG) || configLang() || systemLang(hint);
}

export function getLang() {
  if (!cached) cached = detectLang();
  return cached;
}

// Force a language for this process (CLI --lang). Pass null to clear.
export function setLang(lang) {
  forced = lang == null ? null : normalizeLang(lang);
  if (lang != null && !forced) throw new Error(t('err.badLang', { lang, langs: LANGS.join(' | ') }));
  cached = null;
  return getLang();
}

// OS/app locale hint (Electron app.getLocale()). Lower priority than config and env.
export function setLocaleHint(locale) { hint = locale || null; cached = null; }

// Call after the persisted language changes so the next t() re-resolves.
export function resetLangCache() { cached = null; }

export function format(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

export function t(key, vars, lang) {
  const l = lang || getLang();
  const msg = CATALOGS[l]?.[key] ?? CATALOGS.en[key];
  if (msg === undefined) return key;
  return format(msg, vars);
}

// Error with a stable code and a translated message (the UI/CLI show message; tests may check code).
export class AppError extends Error {
  constructor(key, vars, extra = {}) {
    super(t(key, vars));
    this.code = key;
    Object.assign(this, extra);
  }
}
