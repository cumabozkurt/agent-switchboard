import fs from 'node:fs';
import { geminiSettingsPath, geminiEnvPath } from '../paths.js';
import { readJsonStrict, writeJson, writeFileSafe, exists } from '../fsutil.js';
import { ensureOriginal, snapshot, getState, setState } from '../backup.js';

// Gemini CLI (https://github.com/google-gemini/gemini-cli) reads:
//  • ~/.gemini/settings.json  → model.name, security.auth.selectedType ("gemini-api-key")
//  • ~/.gemini/.env           → GEMINI_API_KEY, GEMINI_MODEL, GOOGLE_GEMINI_BASE_URL
// GOOGLE_GEMINI_BASE_URL must be HTTPS except for localhost, so the local router (http://127.0.0.1) is accepted.
// Caveat (documented): Gemini CLI loads only the FIRST .env it finds walking up from the working directory,
// so a project .env shadows ~/.gemini/.env. `aswitch run gemini` injects the variables directly to avoid that.
export const MANAGED_ENV = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GOOGLE_GEMINI_BASE_URL'];
const BEGIN = '# >>> agent-switchboard >>>';
const END = '# <<< agent-switchboard <<<';
const ENV_TARGET = 'gemini-env';

// Removes our managed block; user lines outside it are never touched.
export function stripEnvBlock(text) {
  const out = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === BEGIN) { inside = true; continue; }
    if (line.trim() === END) { inside = false; continue; }
    if (!inside) out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

const envQuote = v => /^[A-Za-z0-9_./:@+-]*$/.test(v) ? v : JSON.stringify(String(v));

export function buildGeminiEnv({ provider, key, model, routerUrl, mode }) {
  const env = {};
  if (mode === 'router') {
    env.GOOGLE_GEMINI_BASE_URL = routerUrl;
    env.GEMINI_API_KEY = 'aswitch-local';
  } else {
    if (provider.geminiBase && !/^https:\/\/generativelanguage\.googleapis\.com\/?$/.test(provider.geminiBase)) env.GOOGLE_GEMINI_BASE_URL = provider.geminiBase;
    env.GEMINI_API_KEY = key;
  }
  if (model) env.GEMINI_MODEL = model;
  return env;
}

function readEnvFile() { try { return fs.readFileSync(geminiEnvPath(), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }

export function applyGemini(opts) {
  const file = geminiSettingsPath();
  const envFile = geminiEnvPath();
  const s = readJsonStrict(file, {}); // corrupt file → error, never overwritten
  const envText = readEnvFile();
  ensureOriginal('gemini', file); ensureOriginal(ENV_TARGET, envFile);
  snapshot('gemini', file); snapshot(ENV_TARGET, envFile);
  if (!getState('gemini')) setState('gemini', { model: s.model?.name ?? null, auth: s.security?.auth?.selectedType ?? null });
  if (!s.model || typeof s.model !== 'object') s.model = {};
  if (opts.model) s.model.name = opts.model; else delete s.model.name;
  if (!s.security || typeof s.security !== 'object') s.security = {};
  if (!s.security.auth || typeof s.security.auth !== 'object') s.security.auth = {};
  s.security.auth.selectedType = 'gemini-api-key';
  writeJson(file, s);
  const env = buildGeminiEnv(opts);
  const base = stripEnvBlock(envText);
  // Our block goes last: dotenv keeps the last duplicate, so it wins over older lines in the same file.
  const block = [BEGIN, ...Object.entries(env).map(([k, v]) => `${k}=${envQuote(v)}`), END].join('\n');
  writeFileSafe(envFile, (base ? base + '\n\n' : '') + block + '\n', 0o600);
  return file;
}

// Back to the user's own login (Google account OAuth etc.): drops our .env block and restores the
// previous model.name / auth type. Nothing else in settings.json is touched.
export function clearGemini() {
  const file = geminiSettingsPath();
  const envFile = geminiEnvPath();
  const saved = getState('gemini');
  if (exists(envFile)) {
    snapshot(ENV_TARGET, envFile);
    const rest = stripEnvBlock(readEnvFile());
    if (rest.trim()) writeFileSafe(envFile, rest + '\n', 0o600); else fs.rmSync(envFile);
  }
  const s = readJsonStrict(file, null);
  if (s) {
    snapshot('gemini', file);
    if (s.model && typeof s.model === 'object') {
      if (saved?.model) s.model.name = saved.model; else delete s.model.name;
      if (!Object.keys(s.model).length) delete s.model;
    }
    if (s.security?.auth) {
      if (saved?.auth) s.security.auth.selectedType = saved.auth; else delete s.security.auth.selectedType;
      if (!Object.keys(s.security.auth).length) delete s.security.auth;
      if (!Object.keys(s.security).length) delete s.security;
    }
    writeJson(file, s);
  }
  setState('gemini', undefined);
  return file;
}

export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } } else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function statusGemini() {
  const file = geminiSettingsPath();
  let s = {};
  try { s = readJsonStrict(file, {}); } catch (e) { return { file, mode: 'error', baseUrl: null, model: null, error: e.message }; }
  let env = {};
  try { env = parseEnv(readEnvFile()); } catch { /* unreadable .env → treat as empty */ }
  const base = env.GOOGLE_GEMINI_BASE_URL || null;
  const mode = base ? (/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(base) ? 'router' : 'custom') : env.GEMINI_API_KEY ? 'apikey' : 'official';
  return { file, envFile: geminiEnvPath(), mode, baseUrl: base || (mode === 'apikey' ? 'https://generativelanguage.googleapis.com' : null), model: env.GEMINI_MODEL || s.model?.name || null };
}
