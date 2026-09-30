import path from 'node:path';
import { appDir } from './paths.js';
import { readJson, writeJson } from './fsutil.js';

// Notify-only update check against GitHub Releases (no download, no install, no telemetry: one anonymous
// GET to api.github.com at most every 12 hours). Disabled with ASWITCH_NO_UPDATE_CHECK=1.
export const REPO = 'cumabozkurt/agent-switchboard';
const TTL = 12 * 60 * 60 * 1000;
const cacheFile = () => path.join(appDir(), 'update-check.json');

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map(x => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map(x => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < 3; i++) { const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0); if (d) return Math.sign(d); }
  // 1.0.0-beta < 1.0.0
  if (pa.length !== pb.length) return pa.length > pb.length ? -1 : 1;
  return 0;
}

export async function checkForUpdate(current, { force = false, fetchImpl = fetch } = {}) {
  if (process.env.ASWITCH_NO_UPDATE_CHECK === '1' && !force) return { current, latest: null, update: false, disabled: true };
  const cache = readJson(cacheFile(), {});
  let latest = cache.latest, url = cache.url, notes = cache.notes;
  if (force || !cache.at || Date.now() - cache.at > TTL) {
    const r = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-switchboard' }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json();
      latest = String(j.tag_name || '').replace(/^v/, ''); url = j.html_url; notes = String(j.body || '').slice(0, 4000);
    } else if (r.status === 403 || r.status === 429) {
      // Anonymous API rate limit (shared IPs, CI, VPN): fall back to the releases/latest redirect of github.com.
      const w = await fetchImpl(`https://github.com/${REPO}/releases/latest`, { redirect: 'manual', headers: { 'user-agent': 'agent-switchboard' }, signal: AbortSignal.timeout(8000) });
      const m = String(w.headers?.get?.('location') || '').match(/\/releases\/tag\/v?([^/?#]+)/);
      if (!m) throw new Error(`GitHub API HTTP ${r.status}`);
      latest = decodeURIComponent(m[1]); url = `https://github.com/${REPO}/releases/tag/v${latest}`; notes = '';
    } else throw new Error(`GitHub API HTTP ${r.status}`);
    writeJson(cacheFile(), { at: Date.now(), latest, url, notes });
  }
  return { current, latest, url, notes, update: !!latest && compareVersions(latest, current) > 0, install: `npm install -g github:${REPO}#v${latest}` };
}
