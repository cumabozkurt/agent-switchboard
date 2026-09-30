import fs from 'node:fs';
import { normalizeModels } from '../src/models.js';

// Herkese açık (anahtarsız) model listeleri. normalizeModels, anlamsız "created" değerlerini
// (ör. Zen/Go'nun her istekte güncel zamanı yazması) sıfırlar; böylece liste değişmedikçe dosya da değişmez.
const sources = {
  openrouter: 'https://openrouter.ai/api/v1/models',
  'opencode-zen': 'https://opencode.ai/zen/v1/models',
  'opencode-go': 'https://opencode.ai/zen/go/v1/models'
};
fs.mkdirSync('models', { recursive: true });
let ok = 0;
for (const [id, url] of Object.entries(sources)) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = normalizeModels(await r.json()).map(({ id, name, created, context }) => ({ id, name, created, context }));
    if (!list.length) throw new Error('boş liste');
    fs.writeFileSync(`models/${id}.json`, JSON.stringify(list, null, 2) + '\n');
    console.log(`${id}: ${list.length} model`);
    ok++;
  } catch (e) { console.error(`${id}: ${e.message}`); }
}
if (!ok) process.exit(1);
