import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSection, buildNotes } from '../scripts/release-notes.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const dpkg = JSON.parse(read('desktop/package.json'));

test('release notes: section extraction', () => {
  const md = '# C\n\n## [1.1.0] - x\n\n### Added\n- a\n\n## [1.0.0]\n- old\n';
  assert.equal(extractSection(md, 'v1.1.0'), '### Added\n- a');
  assert.equal(extractSection(md, '1.0.0'), '- old');
  assert.equal(extractSection(md, '2.0.0'), null);
  const notes = buildNotes('1.1.0', { en: md, tr: '## [1.1.0]\n- b\n', repo: 'o/r' });
  assert.match(notes, /- a/);
  assert.match(notes, /## Türkçe[\s\S]*- b/);
  assert.match(notes, /github:o\/r#v1\.1\.0/);
  assert.throws(() => buildNotes('9.9.9', { en: md }));
});

test('current version has EN and TR changelog sections', () => {
  assert.ok(extractSection(read('CHANGELOG.md'), pkg.version), 'CHANGELOG.md');
  assert.ok(extractSection(read('CHANGELOG.tr.md'), pkg.version), 'CHANGELOG.tr.md');
});

test('CLI and desktop versions agree', () => {
  assert.equal(pkg.version, dpkg.version);
});

test('packaging includes model snapshots, tray icons and sources', () => {
  assert.ok(pkg.files.includes('models'));
  for (const f of ['main.js', 'app-src/**', 'assets/**', 'models/**']) assert.ok(dpkg.build.files.includes(f), f);
  for (const f of ['tray.png', 'tray@2x.png', 'icon.png']) assert.ok(fs.existsSync(path.join(root, 'desktop/assets', f)), f);
  for (const id of ['openrouter', 'opencode-zen', 'opencode-go']) assert.ok(fs.existsSync(path.join(root, 'models', id + '.json')), id);
  assert.match(read('desktop/sync-src.js'), /models/);
});

test('automation files are present', () => {
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/workflows/codeql.yml',
    '.github/workflows/models-refresh.yml', '.github/dependabot.yml', 'scripts/release.js']) assert.ok(fs.existsSync(path.join(root, f)), f);
  const rel = read('.github/workflows/release.yml');
  assert.match(rel, /release-notes\.js/);
  assert.match(rel, /SHA256SUMS/);
  assert.match(read('.github/workflows/ci.yml'), /xvfb-run/);
});
