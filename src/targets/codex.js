import fs from 'node:fs';
import { codexConfigPath } from '../paths.js';
import { writeFileSafe, exists } from '../fsutil.js';
import { ensureOriginal, snapshot } from '../backup.js';
import { t } from '../i18n/index.js';

// Codex CLI, Codex IDE uzantısı ve Codex masaüstü uygulaması ~/.codex/config.toml okur.
// Alanlar: https://developers.openai.com/codex/config-reference (model_provider, model_providers.<id>.*)
const BEGIN = '# >>> agent-switchboard >>>';
const END = '# <<< agent-switchboard <<<';
const SAVED = '# aswitch-saved: ';
const MANAGED_TOP_KEYS = ['model', 'model_provider'];
const q = s => JSON.stringify(String(s)); // TOML temel dizge, JSON kaçışlarıyla uyumlu
const HEADER = /^\s*\[\[?\s*[^\[\]#=]+?\s*\]\]?\s*(#.*)?$/;
const topKeyOf = line => line.match(/^\s*("?)([A-Za-z0-9_-]+)\1\s*=/)?.[2];

function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, eol };
}

// Yönetilen blokları çıkarır; blokların içinde saklanmış kullanıcı satırlarını (aswitch-saved) döndürür.
function extractManaged(lines) {
  const out = [], saved = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== BEGIN) { out.push(lines[i]); continue; }
    let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== END; j++) {
      if (lines[j].startsWith(SAVED)) saved.push(lines[j].slice(SAVED.length));
    }
    // Tablo bloğunun önüne koyduğumuz tek boş satırı da kaldır.
    if (out.length && out[out.length - 1].trim() === '' && (j + 1 >= lines.length || lines[j + 1].trim() === '')) out.pop();
    i = j; // END satırı da atlanır
  }
  return { lines: out, saved };
}

function removeTopLevelKeys(lines, keys) {
  const kept = [], removed = [];
  let inTable = false;
  for (const line of lines) {
    if (HEADER.test(line)) inTable = true;
    if (!inTable && keys.includes(topKeyOf(line))) removed.push(line); else kept.push(line);
  }
  return { lines: kept, removed };
}

// Blok dışında kalmış [model_providers.aswitch] ve alt tablolarını kaldırır.
function removeAswitchTables(lines) {
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (HEADER.test(line)) skipping = /^\s*\[\s*model_providers\.aswitch(\.[^\]]*)?\s*\]/.test(line);
    if (!skipping) out.push(line);
  }
  return out;
}

const trimBlank = arr => {
  const a = [...arr];
  while (a.length && a[a.length - 1].trim() === '') a.pop();
  return a;
};

// keyMode: 'env' (env_key; önerilen) | 'command' ([model_providers.aswitch.auth] ile anahtarı aswitch verir)
export function buildCodexBlocks({ provider, model, keyEnvName, baseUrl, keyMode = 'env', authCommand, saved = [] }) {
  const head = [
    BEGIN,
    ...saved.map(l => SAVED + l),
    'model_provider = "aswitch"',
    model ? `model = ${q(model)}` : null,
    END
  ].filter(v => v != null);
  const table = [
    BEGIN,
    '[model_providers.aswitch]',
    `name = ${q(`aswitch: ${provider.label || provider.id}`)}`,
    `base_url = ${q(baseUrl)}`,
    // Güncel Codex yalnızca "responses" destekler; yalnız Chat Completions sunan sağlayıcılar
    // için base_url yerel yönlendiriciyi gösterir ve çeviri orada yapılır.
    'wire_api = "responses"'
  ];
  if (keyEnvName && keyMode === 'command' && authCommand) {
    table.push('', '[model_providers.aswitch.auth]', `command = ${q(authCommand.command)}`,
      `args = [${authCommand.args.map(q).join(', ')}]`, 'refresh_interval_ms = 0');
  } else if (keyEnvName) {
    table.push(`env_key = ${q(keyEnvName)}`,
      `env_key_instructions = ${q(t('codex.envKeyInstructions', { env: keyEnvName }))}`);
  }
  table.push(END);
  return { head, table };
}

export function renderCodex(text, opts) {
  const { lines: raw, eol } = splitLines(text || '');
  let { lines, saved } = extractManaged(raw);
  const r = removeTopLevelKeys(lines, MANAGED_TOP_KEYS);
  lines = removeAswitchTables(r.lines);
  // Kullanıcının blok dışında yeni yazdığı model/model_provider satırları eskisinin yerine saklanır.
  for (const line of r.removed) {
    const k = topKeyOf(line);
    saved = saved.filter(l => topKeyOf(l) !== k);
    saved.push(line);
  }
  const { head, table } = buildCodexBlocks({ ...opts, saved });
  const body = trimBlank(lines);
  const out = [...head, ...body, '', ...table];
  return out.join(eol) + eol;
}

export function stripCodex(text) {
  const { lines: raw, eol } = splitLines(text || '');
  const { lines, saved } = extractManaged(raw);
  const body = [...saved, ...lines];
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  return body.length ? body.join(eol) + eol : '';
}

// Eski adla uyumluluk (testler ve dış kullanım için)
export const stripManaged = stripCodex;

export function applyCodex(opts) {
  const file = codexConfigPath();
  const text = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  ensureOriginal('codex', file);
  snapshot('codex', file);
  writeFileSafe(file, renderCodex(text, opts));
  return file;
}

// Resmî girişe dönüş: yönetilen blokları kaldırır ve aswitch'in kaldırdığı model/model_provider
// satırlarını geri koyar; kullanıcının sonradan yaptığı diğer değişiklikler korunur.
export function clearCodex() {
  const file = codexConfigPath();
  if (!exists(file)) return file;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(BEGIN)) return file;
  snapshot('codex', file);
  writeFileSafe(file, stripCodex(text));
  return file;
}

export function statusCodex() {
  const file = codexConfigPath();
  const text = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  const { lines } = splitLines(text);
  let inBlock = false, inTable = false, model, base;
  for (const line of lines) {
    const t = line.trim();
    if (t === BEGIN) { inBlock = true; continue; }
    if (t === END) { inBlock = false; continue; }
    if (HEADER.test(line)) inTable = true;
    if (!inTable && !model) model = line.match(/^\s*model\s*=\s*"([^"]*)"/)?.[1];
    if (inBlock && !base) base = line.match(/^\s*base_url\s*=\s*"([^"]*)"/)?.[1];
  }
  const mode = !base ? 'official' : /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(base) ? 'router' : 'custom';
  return { file, mode, baseUrl: base || null, model: model || null };
}
