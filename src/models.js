import path from 'node:path';
import { checkOutboundUrl } from './netguard.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appDir } from './paths.js';
import { readJson, writeJson } from './fsutil.js';
import { t } from './i18n/index.js';

const cachePath = () => path.join(appDir(), 'models-cache.json');
const TTL_MS = 6 * 60 * 60 * 1000;

// Sağlayıcının canlı /models uç noktasından en güncel listeyi çeker (6 saat önbellek).
export async function fetchModels(provider, key, { refresh = false, fetchImpl = fetch } = {}) {
  const cache = readJson(cachePath(), {});
  const hit = cache[provider.id];
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.models;
  if (!provider.modelsUrl) throw new Error(t('err.noModelsUrl', { id: provider.id }));
  const headers = { accept: 'application/json' };
  if (provider.modelsAuth === 'anthropic') {
    headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
  } else if (key && !provider.noKey) {
    headers.authorization = `Bearer ${key}`;
  }
  const url = checkOutboundUrl(provider.modelsAuth === 'anthropic' ? `${provider.modelsUrl}?limit=1000` : provider.modelsUrl, 'modelsUrl');
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    // Offline: fall back to the last cached list, then to the daily snapshot bundled with aswitch.
    const offline = hit?.models || bundledModels(provider.id);
    if (offline?.length) return Object.assign([...offline], { offline: true });
    throw new Error(t('err.modelsUnreachable', { id: provider.id, url, reason: e.cause?.code || e.cause?.errors?.[0]?.code || e.cause?.message || e.message }));
  }
  if (!res.ok) {
    const hint = (res.status === 401 || res.status === 403) && !key ? t('err.modelsNeedKey', { id: provider.id }) : '';
    throw new Error(t('err.modelsHttp', { id: provider.id, status: res.status }) + hint);
  }
  const body = await res.json();
  const models = normalizeModels(body);
  cache[provider.id] = { at: Date.now(), models };
  writeJson(cachePath(), cache);
  return models;
}

export function normalizeModels(body) {
  const arr = Array.isArray(body) ? body : body?.data || body?.models || [];
  // Untrusted network data: keep only typed, bounded fields (ids ≤ 200 chars, no control characters, ≤ 5000 models).
  const str = v => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) : '');
  const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
  const list = (Array.isArray(arr) ? arr : []).slice(0, 5000).filter(m => m && typeof m === 'object').map(m => {
    const id = str(m.id) || str(m.name);
    return {
      id,
      name: str(m.display_name) || str(m.name) || id,
      created: toEpoch(m.created ?? m.created_at),
      context: num(m.context_length || m.context_window) || null,
      ...(m.pricing && typeof m.pricing === 'object' ? { pricing: { prompt: num(m.pricing.prompt), completion: num(m.pricing.completion) } } : {})
    };
  }).filter(m => m.id);
  // Bazı uç noktalar (ör. OpenCode Zen/Go) her modelin "created" alanına isteğin anını yazar;
  // bu durumda tarih bilgi taşımaz ve sıralama/"latest" sürüm numarasına göre yapılır.
  if (list.length > 1 && list.every(m => m.created === list[0].created)) for (const m of list) m.created = 0;
  return list.sort(newestFirst);
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
// Önce oluşturulma tarihi, eşitse sürüm numarası (claude-opus-5-5 > claude-opus-5 > claude-opus-4-8).
function newestFirst(a, b) {
  return (b.created || 0) - (a.created || 0) || collator.compare(b.id, a.id);
}

function toEpoch(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return !Number.isFinite(v) || v < 0 ? 0 : v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

// "latest" veya "latest:opus" gibi takma adları o anki en yeni modele çevirir.
export function resolveModelAlias(spec, models) {
  if (!spec || !spec.startsWith('latest')) return spec;
  const filter = spec.split(':').slice(1).join(':').toLowerCase();
  const pool = filter ? models.filter(m => m.id.toLowerCase().includes(filter)) : models;
  if (!pool.length) throw new Error(t('err.noModelMatch', { spec }));
  // OpenRouter'ın ":free", ":batch", ":extended" gibi varyantları ve "~" takma adları yalnızca
  // filtre açıkça istediğinde seçilir; aksi hâlde asıl model tercih edilir.
  const plain = filter.includes(':') || filter.startsWith('~') ? pool : pool.filter(m => !m.id.includes(':') && !m.id.startsWith('~'));
  return [...(plain.length ? plain : pool)].sort(newestFirst)[0].id;
}

// Daily snapshots (models/<id>.json) refreshed by the models-snapshot workflow and shipped in the package.
export function bundledModels(id) {
  if (!/^[a-z0-9._-]+$/.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../models/${id}.json`, import.meta.url)), 'utf8')); } catch { return null; }
}
