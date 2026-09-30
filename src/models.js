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
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(`${provider.id} model listesine ulaşılamadı (${url}): ${e.cause?.code || e.message}`);
  }
  if (!res.ok) {
    const hint = (res.status === 401 || res.status === 403) && !key ? ` — anahtar gerekli: "aswitch key set ${provider.id}"` : '';
    throw new Error(`${provider.id} model listesi alınamadı: HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  const models = normalizeModels(body);
  cache[provider.id] = { at: Date.now(), models };
  writeJson(cachePath(), cache);
  return models;
}

export function normalizeModels(body) {
  const arr = Array.isArray(body) ? body : body?.data || body?.models || [];
  const list = arr.filter(m => m && typeof m === 'object').map(m => ({
    id: m.id || m.name,
    name: m.display_name || m.name || m.id,
    created: toEpoch(m.created ?? m.created_at),
    context: m.context_length || m.context_window || null
  })).filter(m => typeof m.id === 'string' && m.id);
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
  // OpenRouter'ın ":free", ":batch", ":extended" gibi varyantları ve "~" takma adları yalnızca
  // filtre açıkça istediğinde seçilir; aksi hâlde asıl model tercih edilir.
  const plain = filter.includes(':') || filter.startsWith('~') ? pool : pool.filter(m => !m.id.includes(':') && !m.id.startsWith('~'));
  return [...(plain.length ? plain : pool)].sort(newestFirst)[0].id;
}
