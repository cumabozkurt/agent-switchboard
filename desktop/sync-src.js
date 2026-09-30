import fs from 'node:fs';
// Paylaşılan çekirdeği (../src) uygulama paketine kopyalar; CLI ile masaüstü aynı kodu kullanır.
fs.rmSync(new URL('./app-src', import.meta.url), { recursive: true, force: true });
fs.cpSync(new URL('../src', import.meta.url), new URL('./app-src', import.meta.url), { recursive: true });
console.log('src → desktop/app-src kopyalandı');
