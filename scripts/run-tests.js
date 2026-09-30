import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
// Node 18–22 arasında ve Windows'ta aynı şekilde çalışsın diye test dosyaları açıkça listelenir.
const files = fs.readdirSync('test').filter(f => f.endsWith('.test.js')).map(f => `test/${f}`);
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
