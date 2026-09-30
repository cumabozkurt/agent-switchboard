import fs from 'node:fs';
import { codexConfigPath } from '../paths.js';
import { writeFileSafe, exists } from '../fsutil.js';
import { ensureOriginal, snapshot } from '../backup.js';

// Codex CLI, Codex IDE uzantısı ve Codex masaüstü uygulaması ~/.codex/config.toml okur.
const BEGIN = '# >>> agent-switchboard >>>';
const END = '# <<< agent-switchboard <<<';
const q = s => JSON.stringify(String(s)); // TOML temel dizge, JSON kaçışlarıyla uyumlu

export function stripManaged(text) {
  const re = new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`, 'g');
  return text.replace(re, '\n').replace(/^\n+/, '');
}

function removeTopLevelKeys(text, keys) {
  const lines = text.split(/\r?\n/);
  let inTable = false;
  return lines.filter(line => {
    if (/^\s*\[/.test(line)) inTable = true;
    if (inTable) return true;
    return !keys.some(k => new RegExp(`^\\s*${k}\\s*=`).test(line));
  }).join('\n');
}

export function buildCodexBlocks({ provider, model, keyEnvName, routerUrl }) {
  const baseUrl = provider.openaiBase || `${routerUrl}/v1`;
  const wire = provider.openaiBase ? (provider.codexWire || 'chat') : 'chat';
  const head = [BEGIN, `model_provider = "aswitch"`, model ? `model = ${q(model)}` : null, END].filter(Boolean).join('\n');
  const table = [
    BEGIN,
    '[model_providers.aswitch]',
    `name = ${q(provider.label || provider.id)}`,
    `base_url = ${q(baseUrl)}`,
    provider.noKey ? null : `env_key = ${q(keyEnvName)}`,
    `wire_api = ${q(wire)}`,
    END
  ].filter(Boolean).join('\n');
  return { head, table };
}

export function applyCodex(opts) {
  const file = codexConfigPath();
  ensureOriginal('codex', file);
  snapshot('codex', file);
  let text = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  text = stripManaged(text);
  text = removeTopLevelKeys(text, ['model', 'model_provider']);
  text = text.replace(/\n?\[model_providers\.aswitch\][\s\S]*?(?=\n\[|$)/, '');
  const { head, table } = buildCodexBlocks(opts);
  const out = `${head}\n${text.trim() ? text.trim() + '\n' : ''}\n${table}\n`;
  writeFileSafe(file, out);
  return file;
}

export function clearCodex() {
  const file = codexConfigPath();
  if (!exists(file)) return file;
  snapshot('codex', file);
  writeFileSafe(file, stripManaged(fs.readFileSync(file, 'utf8')));
  return file;
}

export function statusCodex() {
  const file = codexConfigPath();
  const text = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  const model = text.match(/^model\s*=\s*"([^"]*)"/m)?.[1];
  const base = text.includes(BEGIN) ? text.match(/base_url\s*=\s*"([^"]*)"/)?.[1] : null;
  return { file, baseUrl: base || '(resmî OpenAI / ChatGPT girişi)', model: model || '(varsayılan)' };
}
