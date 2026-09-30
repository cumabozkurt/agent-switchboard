import fs from 'node:fs';
import path from 'node:path';
import { appDir } from './paths.js';
import { mkdirPrivate, readJson } from './fsutil.js';

// Request log + usage statistics for the local router. Only metadata is stored (time, tool, provider,
// model, status, latency, token counts, estimated cost) — never prompts, answers or keys.
// File: <appDir>/usage.jsonl (owner-only). Trimmed to the newest MAX_LINES entries.
const MAX_LINES = 5000;
export const usagePath = () => path.join(appDir(), 'usage.jsonl');

export function recordUsage(entry) {
  try {
    mkdirPrivate(appDir());
    fs.appendFileSync(usagePath(), JSON.stringify(entry) + '\n', { mode: 0o600 });
    const st = fs.statSync(usagePath());
    if (st.size > MAX_LINES * 400) {
      const lines = fs.readFileSync(usagePath(), 'utf8').trim().split('\n');
      if (lines.length > MAX_LINES) fs.writeFileSync(usagePath(), lines.slice(-MAX_LINES).join('\n') + '\n', { mode: 0o600 });
    }
  } catch { /* logging must never break a request */ }
}

export function readUsage({ since = 0, limit = MAX_LINES } = {}) {
  let text = '';
  try { text = fs.readFileSync(usagePath(), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (!since || Date.parse(e.ts) >= since) out.push(e); } catch { /* skip */ }
  }
  return out.slice(-limit);
}

export function clearUsage() { try { fs.rmSync(usagePath(), { force: true }); } catch { /* ignore */ } }

// Per-token prices from cached model lists (OpenRouter publishes pricing in /models). Returns null when unknown.
export function priceFor(provider, model) {
  const cache = readJson(path.join(appDir(), 'models-cache.json'), {});
  const m = cache[provider]?.models?.find(x => x.id === model);
  return m?.pricing && (m.pricing.prompt != null || m.pricing.completion != null) ? m.pricing : null;
}

export function estimateCost(provider, model, input, output) {
  const p = priceFor(provider, model);
  if (!p) return null;
  const c = (Number(p.prompt) || 0) * (input || 0) + (Number(p.completion) || 0) * (output || 0);
  return Number.isFinite(c) ? Math.round(c * 1e6) / 1e6 : null;
}

export function summarizeUsage(entries) {
  const groups = new Map();
  const total = { requests: 0, errors: 0, input: 0, output: 0, cost: 0, costKnown: 0 };
  for (const e of entries) {
    const k = `${e.provider}\u0000${e.model}`;
    const g = groups.get(k) || { provider: e.provider, model: e.model, requests: 0, errors: 0, input: 0, output: 0, cost: 0, costKnown: 0, ms: 0, ttft: 0, ttftN: 0, last: e.ts };
    for (const o of [g, total]) {
      o.requests++; if (e.status >= 400 || e.error) o.errors++;
      o.input += e.in || 0; o.output += e.out || 0;
      if (e.cost != null) { o.cost += e.cost; o.costKnown++; }
    }
    g.ms += e.ms || 0; if (e.ttft != null) { g.ttft += e.ttft; g.ttftN++; }
    if (e.ts > g.last) g.last = e.ts;
    groups.set(k, g);
  }
  const rows = [...groups.values()].map(g => ({ provider: g.provider, model: g.model, requests: g.requests, errors: g.errors, input: g.input, output: g.output, cost: g.costKnown ? Math.round(g.cost * 1e4) / 1e4 : null, avgMs: Math.round(g.ms / g.requests), avgTtft: g.ttftN ? Math.round(g.ttft / g.ttftN) : null, last: g.last }));
  rows.sort((a, b) => b.requests - a.requests);
  return { total: { ...total, cost: total.costKnown ? Math.round(total.cost * 1e4) / 1e4 : null }, rows };
}

// Wraps an HTTP response: measures time to first byte and total time and picks token usage out of the
// (Anthropic, OpenAI Responses or Gemini) JSON/SSE body as it streams through.
export function meter(res, onDone) {
  const m = { status: 0, ttft: null, in: 0, out: 0, started: Date.now() };
  const dec = new TextDecoder();
  let buf = '';
  const grab = raw => {
    const s = raw.trim().replace(/^data:\s*/, '');
    if (!s.includes('sage')) return; // "usage" / "usageMetadata"
    let o; try { o = JSON.parse(s); } catch { return; }
    const u = o.usage || o.message?.usage || o.response?.usage || o.usageMetadata;
    if (!u) return;
    const i = u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount;
    const out = u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount;
    if (i > m.in) m.in = i;
    if (out > m.out) m.out = out;
  };
  const scan = text => {
    buf += text;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { grab(buf.slice(0, i)); buf = buf.slice(i + 1); }
    if (buf.length > 4e6) buf = buf.slice(-1e6);
  };
  let done = false;
  const w = {
    get headersSent() { return res.headersSent; },
    writeHead(code, headers) { m.status = code; res.writeHead(code, headers); return w; },
    write(chunk) {
      if (m.ttft == null) m.ttft = Date.now() - m.started;
      scan(typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true }));
      return res.write(chunk);
    },
    end(chunk) {
      if (chunk) w.write(chunk);
      if (buf) grab(buf);
      res.end();
      if (!done) { done = true; m.ms = Date.now() - m.started; m.status ||= res.statusCode; try { onDone(m); } catch { /* ignore */ } }
      return w;
    }
  };
  return w;
}
