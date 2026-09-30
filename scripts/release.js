#!/usr/bin/env node
// One-command release: node scripts/release.js 0.4.0 [--dry-run] [--no-push]
// Checks the tree, bumps both package.json files, verifies CHANGELOG sections (EN + TR),
// runs the tests, commits, tags and pushes. The release-desktop workflow does the rest.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractSection } from './release-notes.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const noPush = args.includes('--no-push');
const version = (args.find(a => !a.startsWith('--')) || '').replace(/^v/, '');
const die = m => { console.error('✗ ' + m); process.exit(1); };
const sh = (cmd, a, opts = {}) => {
  const r = spawnSync(cmd, a, { cwd: root, encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe', shell: process.platform === 'win32' });
  if (r.status !== 0 && !opts.allowFail) die(`${cmd} ${a.join(' ')} failed\n${r.stderr || ''}`);
  return (r.stdout || '').trim();
};

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) die('usage: node scripts/release.js <x.y.z> [--dry-run] [--no-push]');
const tag = 'v' + version;
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') die(`releases are cut from main (current: ${branch})`);
if (sh('git', ['tag', '-l', tag])) die(`tag ${tag} already exists`);
const dirty = sh('git', ['status', '--porcelain']).split('\n').filter(Boolean)
  .filter(l => !/ (package\.json|desktop\/package\.json)$/.test(l));
if (dirty.length && !dry) die('working tree has uncommitted changes:\n' + dirty.join('\n'));

for (const f of ['CHANGELOG.md', 'CHANGELOG.tr.md']) {
  const p = path.join(root, f);
  if (!fs.existsSync(p) || !extractSection(fs.readFileSync(p, 'utf8'), tag)) die(`${f} has no "## [${version}]" section`);
}
console.log(`✓ CHANGELOG sections found for ${tag}`);

for (const f of ['package.json', 'desktop/package.json']) {
  const p = path.join(root, f);
  const s = fs.readFileSync(p, 'utf8');
  const next = s.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`);
  if (dry) console.log(`• would set ${f} → ${version}`);
  else fs.writeFileSync(p, next);
}
if (!dry) console.log('✓ versions bumped');

console.log('• running tests…');
sh(process.execPath, ['scripts/run-tests.js'], { inherit: true });
console.log('✓ tests passed');

if (dry) { console.log(`dry run: would commit "release: ${tag}", tag ${tag} and push main + tag`); process.exit(0); }
sh('git', ['add', 'package.json', 'desktop/package.json']);
if (sh('git', ['diff', '--cached', '--name-only'])) sh('git', ['commit', '-m', `release: ${tag}`]);
sh('git', ['tag', '-a', tag, '-m', tag]);
console.log(`✓ tagged ${tag}`);
if (noPush) { console.log(`not pushed; run: git push origin main ${tag}`); process.exit(0); }
sh('git', ['push', 'origin', 'main'], { inherit: true });
sh('git', ['push', 'origin', tag], { inherit: true });
console.log(`✓ pushed. The release-desktop workflow will build and publish ${tag}.`);
