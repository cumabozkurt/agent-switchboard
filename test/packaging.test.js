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

test('CLI giriş dosyası LF satır sonlu shebang ile başlar ve .gitattributes LF zorlar', () => {
  assert.ok(read('../bin/aswitch.js').startsWith('#!/usr/bin/env node\n'));
  assert.match(read('../.gitattributes'), /eol=lf/);
});

test('npm paketi çalışma zamanı dosyalarını ve iki dilli README dosyalarını içerir', () => {
  const root = JSON.parse(read('../package.json'));
  for (const f of ['bin', 'src', 'README.md', 'README.tr.md', 'CHANGELOG.md', 'LICENSE']) assert.ok(root.files.includes(f), f);
  for (const f of ['../README.md', '../README.tr.md', '../CHANGELOG.md', '../src/i18n/en.js', '../src/i18n/tr.js', '../src/ui/index.html']) assert.ok(fs.existsSync(new URL(f, import.meta.url)), f);
  assert.equal(root.bin.aswitch, 'bin/aswitch.js');
});

test('README dosyaları birbirine bağlantı verir ve yalnızca var olan ekran görüntülerini kullanır', () => {
  for (const [f, other] of [['../README.md', 'README.tr.md'], ['../README.tr.md', 'README.md']]) {
    const md = read(f);
    assert.ok(md.includes(`](${other})`), `${f} -> ${other}`);
    for (const m of md.matchAll(/\]\((docs\/images\/[^)]+)\)/g)) assert.ok(fs.existsSync(new URL('../' + m[1], import.meta.url)), m[1]);
  }
});

test('CHANGELOG mevcut sürümü içerir', () => {
  const root = JSON.parse(read('../package.json'));
  assert.match(read('../CHANGELOG.md'), new RegExp(`## \\[?${root.version.replace(/\./g, '\\.')}`));
});
