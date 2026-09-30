// Routing policy for the local router: scenario routing, load balancing and a circuit breaker.
// Pure functions + small state objects, so they can be unit-tested without HTTP.

export const SCENARIOS = ['image', 'longContext', 'webSearch', 'think', 'background'];
export const DEFAULT_LONG_CONTEXT = 60000; // estimated input tokens
export const BALANCE_STRATEGIES = ['weighted', 'round-robin'];
export const BREAKER_DEFAULTS = { enabled: true, failures: 3, cooldownSec: 30 };

const hasImage = parts => (parts || []).some(b => b && (b.type === 'image' || b.type === 'input_image' || (b.type === 'tool_result' && Array.isArray(b.content) && hasImage(b.content))));

// Which scenario a request belongs to (first match in SCENARIOS order), or null.
//  kind: 'claude' (Anthropic Messages; Gemini CLI requests are converted to this first) or 'codex' (Responses).
export function detectScenario(kind, body, { tokens = 0, threshold = DEFAULT_LONG_CONTEXT, requestedModel = '' } = {}) {
  if (!body || typeof body !== 'object') return null;
  if (kind === 'codex') {
    const input = Array.isArray(body.input) ? body.input : [];
    if (input.some(m => Array.isArray(m?.content) && hasImage(m.content))) return 'image';
    if (tokens > threshold) return 'longContext';
    if ((body.tools || []).some(t => /^web_search/.test(t?.type || ''))) return 'webSearch';
    if (['high', 'xhigh'].includes(body.reasoning?.effort)) return 'think';
    return null;
  }
  if ((body.messages || []).some(m => Array.isArray(m?.content) && hasImage(m.content))) return 'image';
  if (tokens > threshold) return 'longContext';
  if ((body.tools || []).some(t => /^web_search/.test(t?.type || '') || t?.name === 'web_search')) return 'webSearch';
  if (body.thinking?.type === 'enabled' || body.thinking?.type === 'adaptive') return 'think';
  if (/haiku|flash|lite/i.test(requestedModel || body.model || '')) return 'background';
  return null;
}

// Orders the members of a balance group for one request. Weighted: the first member is drawn at random
// proportionally to its weight, the rest follow by weight. Round-robin: rotate the list each request.
export function orderBalance(group, state, key, rand = Math.random) {
  const members = (group?.members || []).filter(m => (m.weight ?? 1) > 0);
  if (members.length < 2) return members;
  if (group.strategy === 'round-robin') {
    const n = state.get(key) || 0;
    state.set(key, n + 1);
    const i = n % members.length;
    return [...members.slice(i), ...members.slice(0, i)];
  }
  const total = members.reduce((s, m) => s + (m.weight ?? 1), 0);
  let r = rand() * total, first = members[members.length - 1];
  for (const m of members) { r -= (m.weight ?? 1); if (r < 0) { first = m; break; } }
  return [first, ...members.filter(m => m !== first).sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))];
}

// Circuit breaker per provider: closed → (N consecutive failures) → open for cooldown → half-open (one trial)
// → closed on success / open again on failure.
export function createBreaker(now = () => Date.now()) {
  const s = new Map();
  const get = k => s.get(k) || { state: 'closed', failures: 0, openedAt: 0, trial: false };
  return {
    allow(k, cfg = BREAKER_DEFAULTS) {
      if (!cfg.enabled) return true;
      const e = get(k);
      if (e.state !== 'open') return e.state !== 'half-open' || !e.trial;
      if (now() - e.openedAt >= cfg.cooldownSec * 1000) { s.set(k, { ...e, state: 'half-open', trial: false }); return true; }
      return false;
    },
    // Called right before a request is sent to k, so only one half-open trial is in flight.
    begin(k) { const e = get(k); if (e.state === 'half-open') s.set(k, { ...e, trial: true }); },
    success(k) { s.set(k, { state: 'closed', failures: 0, openedAt: 0, trial: false }); },
    failure(k, cfg = BREAKER_DEFAULTS) {
      if (!cfg.enabled) return;
      const e = get(k);
      const failures = e.failures + 1;
      if (e.state === 'half-open' || failures >= cfg.failures) s.set(k, { state: 'open', failures, openedAt: now(), trial: false });
      else s.set(k, { ...e, failures });
    },
    snapshot(cfg = BREAKER_DEFAULTS) {
      const out = {};
      for (const [k, e] of s) {
        const left = e.state === 'open' ? Math.max(0, Math.ceil((cfg.cooldownSec * 1000 - (now() - e.openedAt)) / 1000)) : 0;
        out[k] = { state: e.state === 'open' && left === 0 ? 'half-open' : e.state, failures: e.failures, retryInSec: left };
      }
      return out;
    },
    reset() { s.clear(); }
  };
}

// Parses "provider:model" or "provider:model*weight" (model ids may contain ':' themselves).
export function parseSpec(spec) {
  const str = String(spec).trim();
  const i = str.indexOf(':');
  if (i <= 0 || i >= str.length - 1) return null;
  let model = str.slice(i + 1), weight = 1;
  const w = model.match(/\*(\d+(?:\.\d+)?)$/);
  if (w) { weight = Number(w[1]); model = model.slice(0, -w[0].length); }
  if (!model || !(weight >= 0) || weight > 1000) return null;
  return { provider: str.slice(0, i), model, weight };
}

// Builds the ordered candidate list for one request: scenario target first, then the balance group
// (or the primary target), then the fallback chain; duplicates removed; providers with an open circuit
// skipped unless nothing else is left.
export function buildChain({ primary, scenario, balance, fallbacks = [], breaker, breakerCfg, balanceState, balanceKey }) {
  const list = [];
  if (scenario) list.push(scenario);
  list.push(...(balance?.members?.length ? orderBalance(balance, balanceState, balanceKey) : [primary]));
  list.push(...fallbacks);
  const seen = new Set();
  const uniq = list.filter(c => { const k = `${c.provider}|${c.model}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!breaker) return { chain: uniq, skipped: [] };
  const ok = uniq.filter(c => breaker.allow(c.provider, breakerCfg));
  const skipped = uniq.filter(c => !ok.includes(c)).map(c => c.provider);
  return { chain: ok.length ? ok : uniq, skipped: ok.length ? skipped : [] };
}
