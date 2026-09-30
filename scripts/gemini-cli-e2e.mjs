#!/usr/bin/env node
// Real Gemini CLI end-to-end check (CI job "gemini-cli", or run by hand):
//   installs @google/gemini-cli into a temp dir, points it at the aswitch router with `aswitch use`, and runs it
//   headless against a local mock OpenAI-compatible upstream (no Google account, no real API key, no internet
//   except the npm install). Verifies: plain answer (streaming), a tool-call round-trip, `aswitch run gemini`,
//   and a trusted folder picking up ~/.gemini/.env. Everything happens in a throw-away HOME.
//
//   node scripts/gemini-cli-e2e.mjs            (GEMINI_CLI_VERSION=0.62.0 to pin a version)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'bin', 'aswitch.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aswitch-gemini-'));
const home = path.join(tmp, 'home'), work = path.join(tmp, 'work'), inst = path.join(tmp, 'cli');
for (const d of [home, work, inst, path.join(home, '.gemini')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(work, 'a.txt'), 'hello\n');
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const free = () => new Promise(r => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// ---- mock upstream (OpenAI chat completions, streaming + one tool call when the prompt says LIST_DIR)
const seen = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => { b += c; });
  req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    seen.push({ url: req.url, auth: req.headers.authorization, model: body.model, stream: !!body.stream, tools: (body.tools || []).length, messages: body.messages || [] });
    if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"mock-large"}]}'); }
    const msgs = body.messages || [];
    const text = JSON.stringify(msgs.filter(m => m.role === 'user').at(-1)?.content || '');
    const hadTool = msgs.some(m => m.role === 'tool');
    const tool = /LIST_DIR/.test(text) && !hadTool ? (body.tools || []).find(t => /list_directory/.test(t.function?.name)) : null;
    const reply = hadTool ? 'TOOL_RESULT_SEEN' : 'Hello from the mock upstream!';
    const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (tool) {
      send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool.function.name, arguments: '' } }] } }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ dir_path: '.' }) } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
    } else {
      for (const w of reply.split(' ')) send({ choices: [{ index: 0, delta: { content: w + ' ' } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
    }
    res.end('data: [DONE]\n\n');
  });
});
const mockPort = await free();
await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));
const routerPort = await free();

// ---- sandboxed environment: never the real ~/.gemini
const env = { ...process.env, HOME: home, USERPROFILE: home, ASWITCH_HOME_OVERRIDE: home, ASWITCH_DIR: path.join(home, '.agent-switchboard'), XDG_CONFIG_HOME: path.join(home, '.config'), ASWITCH_LANG: 'en', ASWITCH_NO_UPDATE_CHECK: '1', TERM: 'dumb', NO_COLOR: '1' };
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_MODEL', 'GEMINI_CLI_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT']) delete env[k];
const aswitch = (...a) => { const r = spawnSync(process.execPath, [bin, ...a], { env, encoding: 'utf8' }); if (r.status) throw new Error(`aswitch ${a.join(' ')}: ${r.stderr}`); return r.stdout; };

const version = process.env.GEMINI_CLI_VERSION || 'latest';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const ins = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--prefix', inst, `@google/gemini-cli@${version}`], { encoding: 'utf8', shell: process.platform === 'win32' });
if (ins.status) { console.error(ins.stderr); process.exit(1); }
const gpkg = path.join(inst, 'node_modules', '@google', 'gemini-cli');
const gver = JSON.parse(fs.readFileSync(path.join(gpkg, 'package.json'), 'utf8')).version;
const gbin = path.join(gpkg, JSON.parse(fs.readFileSync(path.join(gpkg, 'package.json'), 'utf8')).bin.gemini);
console.log(`@google/gemini-cli ${gver}`);

aswitch('provider', 'add', 'mock', '--openai-base', `http://127.0.0.1:${mockPort}/v1`);
aswitch('key', 'set', 'mock', 'mock-key-123');
const cfgFile = path.join(env.ASWITCH_DIR, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); cfg.router = { ...(cfg.router || {}), port: routerPort }; fs.writeFileSync(cfgFile, JSON.stringify(cfg));
aswitch('use', 'mock', '--model', 'mock-large', '--tools', 'gemini');
const genv = fs.readFileSync(path.join(home, '.gemini', '.env'), 'utf8');
check('aswitch wrote ~/.gemini/.env for the router', genv.includes(`GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:${routerPort}`));

const router = spawn(process.execPath, [bin, 'router'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => { router.stdout.on('data', d => { if (/127\.0\.0\.1/.test(String(d))) resolve(); }); router.on('exit', c => reject(new Error('router exited ' + c))); setTimeout(() => reject(new Error('router timeout')), 15000); });

const run = (args, { viaAswitch = false } = {}) => new Promise(resolve => {
  const cmd = viaAswitch ? [bin, 'run', 'gemini', ...args] : [gbin, ...args];
  const p = spawn(process.execPath, cmd, { cwd: work, env: { ...env, PATH: path.dirname(gbin) + path.delimiter + path.join(inst, 'node_modules', '.bin') + path.delimiter + env.PATH } });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const timer = setTimeout(() => p.kill(), 120000);
  p.on('exit', code => { clearTimeout(timer); resolve({ code, out }); });
});

try {
  let r = await run(['-p', 'say hi']);
  check('untrusted folder: Gemini CLI ignores ~/.gemini/.env / refuses headless mode (its folder-trust policy)', r.code !== 0 && /trust|GEMINI_API_KEY/i.test(r.out), `exit ${r.code}`);
  r = await run(['--skip-trust', '-p', 'say hi']);
  check('gemini -p → router → mock upstream (streaming answer)', r.code === 0 && r.out.includes('Hello from the mock upstream!'), r.out.split('\n').filter(l => !/^Warning|STARTUP/.test(l)).join(' | ').slice(0, 200));
  const first = seen.find(s => s.url === '/v1/chat/completions');
  check('upstream got the saved key, the chosen model, streaming and the CLI tools', first?.auth === 'Bearer mock-key-123' && first?.model === 'mock-large' && first?.stream && first?.tools > 0, JSON.stringify({ model: first?.model, tools: first?.tools }));
  seen.length = 0;
  r = await run(['--skip-trust', '-p', 'LIST_DIR please']);
  const toolMsg = seen.flatMap(s => s.messages).find(m => m.role === 'tool');
  check('tool-call round-trip (list_directory executed by Gemini CLI, result sent back)', r.code === 0 && r.out.includes('TOOL_RESULT_SEEN') && /a\.txt/.test(toolMsg?.content || ''), (toolMsg?.content || '').slice(0, 80));
  r = await run(['--skip-trust', '-p', 'say hi'], { viaAswitch: true });
  check('aswitch run gemini passes the router settings as environment', r.code === 0 && r.out.includes('Hello from the mock upstream!'));
  fs.writeFileSync(path.join(home, '.gemini', 'trustedFolders.json'), JSON.stringify({ [fs.realpathSync(work)]: 'TRUST_FOLDER' }));
  r = await run(['-p', 'say hi']);
  check('trusted folder: plain `gemini` picks up ~/.gemini/.env', r.code === 0 && r.out.includes('Hello from the mock upstream!'), `exit ${r.code}`);
  const usage = JSON.parse(aswitch('usage', '--json'));
  check('router usage log recorded the Gemini CLI requests', usage.total.requests >= 4, `${usage.total.requests} requests`);
} finally {
  router.kill(); mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed (Gemini CLI ${gver})`);
process.exit(failed ? 1 : 0);
