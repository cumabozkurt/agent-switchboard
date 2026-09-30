import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aswitch-'));
  process.env.ASWITCH_HOME_OVERRIDE = dir;
  process.env.ASWITCH_DIR = path.join(dir, '.agent-switchboard');
  delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, '.config');
  // Tests assert Turkish messages unless they select a language explicitly (see i18n.test.js).
  if (!process.env.ASWITCH_TEST_KEEP_LANG) process.env.ASWITCH_LANG = 'tr';
  return dir;
}

// A fake provider: records every request and lets the test answer it. handler(body, res, req, n)
export async function fakeUpstream(handler) {
  const http = await import('node:http');
  const seen = [];
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { const body = b ? JSON.parse(b) : {}; seen.push({ url: req.url, body, headers: req.headers }); handler(body, res, req, seen.length); });
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ s, seen, root: `http://127.0.0.1:${s.address().port}`, base: `http://127.0.0.1:${s.address().port}/v1` })));
}
