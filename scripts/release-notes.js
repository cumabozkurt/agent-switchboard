#!/usr/bin/env node
// Builds GitHub release notes for a version from CHANGELOG.md (EN) and CHANGELOG.tr.md (TR).
// Usage: node scripts/release-notes.js v0.3.0 > notes.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function extractSection(md, version) {
  const v = version.replace(/^v/, '');
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^## \\[${v.replace(/\./g, '\\.')}\\]`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

export function buildNotes(version, { en, tr, repo = 'cumabozkurt/agent-switchboard' } = {}) {
  const tag = 'v' + version.replace(/^v/, '');
  const enSec = extractSection(en, tag);
  if (!enSec) throw new Error(`CHANGELOG.md has no section for ${tag}`);
  const trSec = tr ? extractSection(tr, tag) : null;
  const out = [enSec, ''];
  out.push('### Install', '',
    `- Desktop app: download the file for your OS below (builds are unsigned — see the README for the one-time macOS/Windows prompt).`,
    `- CLI: \`npm install -g github:${repo}#${tag}\``, '');
  if (trSec) out.push('---', '', '## Türkçe', '', trSec, '',
    '### Kurulum', '',
    '- Masaüstü uygulaması: aşağıdan işletim sisteminize uygun dosyayı indirin (derlemeler imzasızdır — ilk açılış uyarısı için README\'ye bakın).',
    `- CLI: \`npm install -g github:${repo}#${tag}\``, '');
  return out.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const read = f => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return null; } };
  try {
    process.stdout.write(buildNotes(version, { en: read('CHANGELOG.md') || '', tr: read('CHANGELOG.tr.md'), repo: process.env.GITHUB_REPOSITORY || undefined }));
  } catch (e) { console.error(e.message); process.exit(1); }
}
