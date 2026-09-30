import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('masaüstü paketi app-src içerir ve sürümü CLI ile aynı', () => {
  const d = JSON.parse(read('../desktop/package.json'));
  const root = JSON.parse(read('../package.json'));
  assert.equal(d.version, root.version);
  assert.ok(d.build.files.includes('app-src/**'));
  assert.match(read('../desktop/main.js'), /\.\/app-src\/ui\/server\.js/);
});

test('macOS paketleri hem arm64 hem x64 için üretilir; Windows çıktılarının adları çakışmaz', () => {
  const b = JSON.parse(read('../desktop/package.json')).build;
  for (const t of b.mac.target) assert.deepEqual([...t.arch].sort(), ['arm64', 'x64']);
  assert.notEqual(b.nsis.artifactName, b.portable.artifactName);
});

test('çalışma zamanı bağımlılığı yok', () => {
  const root = JSON.parse(read('../package.json'));
  assert.equal(root.dependencies, undefined);
});
