import path from 'node:path';
import { appDir } from './paths.js';
import { readJson, writeJson } from './fsutil.js';

const cachePath = () => path.join(appDir(), 'models-cache.json');
const TTL_MS = 6 * 60 * 60 * 1000;

// Sağlayıcının canlı /models uç noktasından en güncel listeyi çeker (6 saat önbellek).
export async function fetchModels(provider, key, { refresh = false, fetchImpl = fetch } = {}) {
  const cache = readJson(cachePath(), {});
  const hit = cache[provider.id];
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.models;
  if (!provider.modelsUrl) throw new Error(`${provider.id} için model listesi uç noktası yok; modeli elle yazın.`);
  const headers = { accept: 'application/json' };
  if (provider.modelsAuth === 'anthropic') {
    headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
  } else if (key && !provider.noKey) {
    headers.authorization = `Bearer ${key}`;
  }
  const url = provider.modelsAuth === 'anthropic' ? `${provider.modelsUrl}?limit=1000` : provider.modelsUrl;
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`${provider.id} model listesi alınamadı: HTTP ${res.status}`);
  const body = await res.json();
  const models = normalizeModels(body);
  cache[provider.id] = { at: Date.now(), models };
  writeJson(cachePath(), cache);
  return models;
}

export function normalizeModels(body) {
  const arr = Array.isArray(body) ? body : body.data || body.models || [];
  return arr.map(m => ({
    id: m.id || m.name,
    name: m.display_name || m.name || m.id,
    created: toEpoch(m.created ?? m.created_at),
    context: m.context_length || m.context_window || null
  })).filter(m => m.id).sort((a, b) => (b.created || 0) - (a.created || 0));
}

function toEpoch(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

// "latest" veya "latest:opus" gibi takma adları o anki en yeni modele çevirir.
export function resolveModelAlias(spec, models) {
  if (!spec || !spec.startsWith('latest')) return spec;
  const filter = spec.split(':').slice(1).join(':').toLowerCase();
  const pool = filter ? models.filter(m => m.id.toLowerCase().includes(filter)) : models;
  if (!pool.length) throw new Error(`"${spec}" ile eşleşen model bulunamadı.`);
  return [...pool].sort((a, b) => (b.created || 0) - (a.created || 0))[0].id;
}
