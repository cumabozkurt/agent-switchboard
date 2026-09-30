import fs from 'node:fs';
import { normalizeModels } from '../src/models.js';

const sources = {
  openrouter: 'https://openrouter.ai/api/v1/models',
  'opencode-zen': 'https://opencode.ai/zen/v1/models'
};
fs.mkdirSync('models', { recursive: true });
for (const [id, url] of Object.entries(sources)) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = normalizeModels(await r.json()).map(({ id, name, created, context }) => ({ id, name, created, context }));
    fs.writeFileSync(`models/${id}.json`, JSON.stringify(list, null, 2) + '\n');
    console.log(`${id}: ${list.length} model`);
  } catch (e) { console.error(`${id}: ${e.message}`); }
}
