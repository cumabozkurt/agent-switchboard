import fs from 'node:fs';
import path from 'node:path';
import { home, codexConfigPath, geminiSettingsPath } from './paths.js';
import { readJsonStrict, writeJson, writeFileSafe, exists } from './fsutil.js';
import { ensureOriginal, snapshot } from './backup.js';
import { opencodeFile } from './targets/opencode.js';
import { t } from './i18n/index.js';

// MCP server view + one-way sync between coding tools.
// Common shape: { name, type: 'stdio'|'http'|'sse', command, args[], env{}, url, headers{} }
// Sources: Claude Code (~/.claude.json "mcpServers", user scope — read only), Codex ([mcp_servers.*] in
// config.toml), OpenCode ("mcp" in opencode.json), Gemini CLI ("mcpServers" in settings.json).
// Claude Code is a source only: ~/.claude.json is rewritten by Claude Code itself while it runs.
export const MCP_TOOLS = ['claude', 'codex', 'opencode', 'gemini'];
export const MCP_TARGETS = ['codex', 'opencode', 'gemini'];
const BEGIN = '# >>> agent-switchboard mcp >>>';
const END = '# <<< agent-switchboard mcp <<<';
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function claudeJsonPath() {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home(), '.claude.json');
}

const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const strs = v => (Array.isArray(v) ? v.map(String) : []);

function fromClaudeLike(name, s) {
  const type = s.type === 'http' || s.type === 'sse' ? s.type : s.url || s.httpUrl ? (s.httpUrl ? 'http' : s.type || 'sse') : 'stdio';
  if (type === 'stdio') return { name, type, command: String(s.command || ''), args: strs(s.args), env: obj(s.env) };
  return { name, type, url: String(s.httpUrl || s.url || ''), headers: obj(s.headers) };
}

// Minimal TOML reader for [mcp_servers.<name>] tables: string, string-array and inline-table values.
export function parseCodexMcp(text) {
  const out = {};
  let cur = null, sub = null;
  const val = raw => {
    raw = raw.trim();
    if (raw.startsWith('"')) { try { return JSON.parse(raw.match(/^"(?:[^"\\]|\\.)*"/)[0]); } catch { return raw; } }
    if (raw.startsWith("'")) return raw.slice(1, raw.indexOf("'", 1));
    if (raw.startsWith('[')) return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(m => m[1] != null ? JSON.parse(`"${m[1]}"`) : m[2]);
    if (raw.startsWith('{')) return Object.fromEntries([...raw.matchAll(/([A-Za-z0-9_-]+|"[^"]+")\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)].map(m => [m[1].replace(/"/g, ''), val(m[2])]));
    if (raw === 'true' || raw === 'false') return raw === 'true';
    return raw.replace(/\s+#.*$/, '');
  };
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.(env|http_headers))?\s*\]\s*(#.*)?$/);
    if (h) { cur = out[h[1] ?? h[2]] ||= {}; sub = h[3] || null; continue; }
    if (/^\s*\[/.test(line)) { cur = null; sub = null; continue; }
    if (!cur) continue;
    const kv = line.match(/^\s*("?)([A-Za-z0-9_-]+)\1\s*=\s*(.+)$/);
    if (!kv) continue;
    if (sub) (cur[sub] ||= {})[kv[2]] = val(kv[3]); else cur[kv[2]] = val(kv[3]);
  }
  return Object.entries(out).map(([name, s]) => s.url
    ? { name, type: 'http', url: String(s.url), headers: obj(s.http_headers) }
    : { name, type: 'stdio', command: String(s.command || ''), args: strs(s.args), env: obj(s.env) });
}

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

export function listMcp(tool) {
  if (tool === 'claude') return Object.entries(obj(readJsonStrict(claudeJsonPath(), {}).mcpServers)).map(([n, s]) => fromClaudeLike(n, obj(s)));
  if (tool === 'gemini') return Object.entries(obj(readJsonStrict(geminiSettingsPath(), {}).mcpServers)).map(([n, s]) => fromClaudeLike(n, obj(s)));
  if (tool === 'codex') return parseCodexMcp(readText(codexConfigPath()));
  if (tool === 'opencode') {
    const c = readJsonStrict(opencodeFile(), {}, { jsonc: true });
    return Object.entries(obj(c.mcp)).map(([name, s]) => s.type === 'remote'
      ? { name, type: 'http', url: String(s.url || ''), headers: obj(s.headers) }
      : { name, type: 'stdio', command: String(strs(s.command)[0] || ''), args: strs(s.command).slice(1), env: obj(s.environment) });
  }
  throw Object.assign(new Error(t('err.unknownTool', { tool })), { code: 'err.unknownTool' });
}

export function allMcp() {
  const out = {};
  for (const tool of MCP_TOOLS) {
    try { out[tool] = { servers: listMcp(tool) }; } catch (e) { out[tool] = { servers: [], error: e.message }; }
  }
  return out;
}

const q = s => JSON.stringify(String(s));
const tomlKey = k => (/^[A-Za-z0-9_-]+$/.test(k) ? k : q(k));
const inline = o => `{ ${Object.entries(o).map(([k, v]) => `${tomlKey(k)} = ${q(v)}`).join(', ')} }`;

function codexTable(s) {
  const lines = [`[mcp_servers.${tomlKey(s.name)}]`];
  if (s.type === 'stdio') {
    lines.push(`command = ${q(s.command)}`);
    if (s.args?.length) lines.push(`args = [${s.args.map(q).join(', ')}]`);
    if (Object.keys(s.env || {}).length) lines.push(`env = ${inline(s.env)}`);
  } else {
    lines.push(`url = ${q(s.url)}`);
    if (Object.keys(s.headers || {}).length) lines.push(`http_headers = ${inline(s.headers)}`);
  }
  return lines;
}

// Removes our MCP block from config.toml text and returns [rest, namesInsideBlock].
function stripCodexMcp(text) {
  const out = [], inside = [];
  let skip = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === BEGIN) { skip = true; continue; }
    if (line.trim() === END) { skip = false; continue; }
    if (skip) { const h = line.match(/^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]/); if (h) inside.push(h[1] ?? h[2]); continue; }
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return [out.join('\n'), inside];
}

function toTarget(tool, s) {
  if (tool === 'opencode') {
    return s.type === 'stdio'
      ? { type: 'local', command: [s.command, ...(s.args || [])], ...(Object.keys(s.env || {}).length ? { environment: s.env } : {}), enabled: true }
      : { type: 'remote', url: s.url, ...(Object.keys(s.headers || {}).length ? { headers: s.headers } : {}), enabled: true };
  }
  // gemini
  return s.type === 'stdio'
    ? { command: s.command, ...(s.args?.length ? { args: s.args } : {}), ...(Object.keys(s.env || {}).length ? { env: s.env } : {}) }
    : { [s.type === 'sse' ? 'url' : 'httpUrl']: s.url, ...(Object.keys(s.headers || {}).length ? { headers: s.headers } : {}) };
}

// Copies servers from one tool to others. Existing servers with the same name are kept unless overwrite.
// Returns [{ tool, file, added: [...], skipped: [...] }].
export function syncMcp({ from = 'claude', to = MCP_TARGETS, only, overwrite = false } = {}) {
  if (!MCP_TOOLS.includes(from)) throw Object.assign(new Error(t('err.unknownTool', { tool: from })), { code: 'err.unknownTool' });
  let servers = listMcp(from).filter(s => NAME_RE.test(s.name) && (s.type === 'stdio' ? s.command : s.url));
  if (only?.length) servers = servers.filter(s => only.includes(s.name));
  const results = [];
  for (const tool of to) {
    if (tool === from) continue;
    if (!MCP_TARGETS.includes(tool)) throw Object.assign(new Error(t('err.mcpTarget', { tool, targets: MCP_TARGETS.join(' | ') })), { code: 'err.mcpTarget' });
    const added = [], skipped = [];
    let file;
    if (tool === 'codex') {
      file = codexConfigPath();
      const text = readText(file);
      const [rest, managed] = stripCodexMcp(text);
      const outside = new Set(parseCodexMcp(rest).map(s => s.name));
      // Keep servers we added earlier that are not part of this sync.
      const previous = parseCodexMcp(text).filter(s => managed.includes(s.name));
      const keep = new Map(previous.map(s => [s.name, s]));
      for (const s of servers) {
        if (outside.has(s.name) || (keep.has(s.name) && !overwrite)) { skipped.push(s.name); continue; }
        keep.set(s.name, s); added.push(s.name);
      }
      if (!added.length) { results.push({ tool, file, added, skipped }); continue; }
      ensureOriginal('codex', file); snapshot('codex', file);
      const block = [BEGIN, ...[...keep.values()].flatMap(s => ['', ...codexTable(s)]), END];
      writeFileSafe(file, (rest ? rest + '\n\n' : '') + block.join('\n') + '\n');
    } else {
      file = tool === 'opencode' ? opencodeFile() : geminiSettingsPath();
      const c = readJsonStrict(file, tool === 'opencode' ? { $schema: 'https://opencode.ai/config.json' } : {}, { jsonc: tool === 'opencode' });
      const key = tool === 'opencode' ? 'mcp' : 'mcpServers';
      const cur = obj(c[key]);
      for (const s of servers) {
        if (cur[s.name] && !overwrite) { skipped.push(s.name); continue; }
        cur[s.name] = toTarget(tool, s); added.push(s.name);
      }
      if (!added.length) { results.push({ tool, file, added, skipped }); continue; }
      ensureOriginal(tool, file); snapshot(tool, file);
      c[key] = cur;
      writeJson(file, c);
    }
    results.push({ tool, file, added, skipped });
  }
  return results;
}

export { exists };
