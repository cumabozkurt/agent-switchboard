import fs from 'node:fs';
// Paylaşılan çekirdeği (../src) ve günlük model anlık görüntülerini (../models) uygulama paketine kopyalar;
// CLI ile masaüstü aynı kodu kullanır.
for (const [from, to] of [['../src', './app-src'], ['../models', './models']]) {
  fs.rmSync(new URL(to, import.meta.url), { recursive: true, force: true });
  fs.cpSync(new URL(from, import.meta.url), new URL(to, import.meta.url), { recursive: true });
}
console.log('src -> desktop/app-src, models -> desktop/models copied');
