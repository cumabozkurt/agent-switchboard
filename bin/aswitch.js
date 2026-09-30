#!/usr/bin/env node
import fs from 'node:fs';
import * as core from '../src/core.js';
import { startRouter } from '../src/router.js';
import { openRouterLogin } from '../src/oauth.js';
import { startUi } from '../src/ui/server.js';
import { flags, envLine, defaultShell, extractLang } from '../src/cli.js';
import { t, setLang, getLang, LANGS, LANG_NAMES } from '../src/i18n/index.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Hidden input: raw mode on a TTY so the key is never echoed; with piped stdin the first line is read.
function askHidden(q) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', c => { data += c; });
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0].trim()));
      stdin.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(q);
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = err => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); err ? reject(err) : resolve(buf.trim()); };
    const onData = s => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') return done(new Error(t('cli.cancelled')));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const toolsOf = f => (typeof f.tools === 'string' ? f.tools.split(',').map(s => s.trim()).filter(Boolean) : undefined);
const str = v => (typeof v === 'string' ? v : undefined);
async function rerouted(tool) {
  const r = await core.ensureRouted(tool);
  if (r) console.log(t('cli.rerouted', { tool: toolName(tool) }));
}
const toolName = id => ({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI' }[id] || id);
const listOf = v => (typeof v === 'string' ? v.split(',').map(x => x.trim()).filter(Boolean) : undefined);

function printStatus(s) {
  for (const tool of core.TOOLS) {
    const st = s[tool]; const a = s.active?.[tool];
    console.log(`${toolName(tool)}  [${t('ui.mode.' + st.mode)}]`);
    console.log(`  ${t('ui.col.provider').padEnd(10)} ${a ? a.provider : t('ui.none')}`);
    console.log(`  ${t('ui.col.model').padEnd(10)} ${st.model || t('ui.defaultModel')}`);
    if (st.baseUrl) console.log(`  ${t('ui.col.endpoint').padEnd(10)} ${st.baseUrl}`);
    console.log(`  ${t('ui.col.file').padEnd(10)} ${st.file}`);
    if (st.error) console.log(`  ! ${st.error}`);
  }
  const r = s.router;
  const needed = !!(r && core.ROUTED_TOOLS.some(k => r[k]));
  console.log(`${t('ui.tab.router')}  ${needed ? t('cli.routerNeeded', { port: r.port || core.DEFAULT_ROUTER_PORT }) : t('ui.router.notNeeded')}`);
  if (r?.claude) console.log(`  Claude Code → ${r.claude.provider} · ${r.claude.model}${r.claude.fastModel ? ' / ' + r.claude.fastModel : ''}`);
  if (r?.codex) console.log(`  Codex       → ${r.codex.provider} · ${r.codex.model}`);
  if (r?.gemini) console.log(`  Gemini CLI  → ${r.gemini.provider} · ${r.gemini.model}${r.gemini.fastModel ? ' / ' + r.gemini.fastModel : ''}`);
  for (const [tool, list] of Object.entries(r?.fallback || {})) if (list.length) console.log(`  ${t('ui.fallback.title')} ${toolName(tool)}: ${list.map(f => f.provider + ':' + f.model).join(' → ')}`);
  for (const [tool, g] of Object.entries(r?.balance || {})) if (g?.members?.length) console.log(`  ${t('ui.balance.title')} ${toolName(tool)}: ${g.members.map(m => `${m.provider}:${m.model}*${m.weight ?? 1}`).join('  ')}`);
  for (const [tool, m] of Object.entries(r?.scenarios || {})) if (Object.keys(m).length) console.log(`  ${t('ui.scenario.title')} ${toolName(tool)}: ${Object.entries(m).map(([n, v]) => `${n} → ${v.provider}:${v.model}`).join('  ')}`);
}

const fmtN = n => (n || 0).toLocaleString('en-US');
const fmtCost = c => (c == null ? '—' : '$' + c.toFixed(4));

async function main() {
  const argv = process.argv.slice(2);
  // `run` passes everything after the tool name through untouched, so --lang only counts before `run`.
  let i = 0, lead = null;
  while (i < argv.length && (argv[i] === '--lang' || argv[i].startsWith('--lang='))) {
    if (argv[i] === '--lang') { lead = argv[i + 1] ?? ''; i += 2; } else { lead = argv[i].slice(7); i++; }
  }
  if (argv[i] === 'run') {
    if (lead != null) setLang(lead);
    process.exitCode = await core.run(argv[i + 1], argv.slice(i + 2));
    return;
  }
  const { lang, rest: args } = extractLang(argv);
  if (lang != null) setLang(lang);
  const [cmd, ...rest] = args;
  const f = flags(rest);
  const help = () => console.log(t('cli.help', { version: VERSION }));
  switch (cmd) {
    case undefined: case 'help': case '-h': case '--help': help(); break;
    case '-v': case '--version': case 'version': console.log(VERSION); break;
    case 'status': {
      const s = core.status();
      if (f.json) console.log(JSON.stringify(s, null, 2)); else printStatus(s);
      if (!f.json && s.envConflicts?.length) console.log('\n⚠ ' + t('status.envConflicts', { list: s.envConflicts.map(c => `${c.name} (${toolName(c.tool)})`).join(', ') }));
      break;
    }
    case 'providers':
      for (const p of core.providers()) {
        const codex = p.codex ? (p.codexDirect ? '' : '  ' + t('cli.codexViaRouter')) : '  ' + t('cli.noCodex');
        console.log(`${p.hasKey || p.noKey ? '●' : '○'} ${p.id.padEnd(14)} ${p.label}${p.desc ? ' — ' + p.desc : ''}${codex}${p.custom ? '  ' + t('cli.custom') : ''}`);
      }
      break;
    case 'key': {
      const [sub, pid, val] = f._;
      if (!pid && sub) throw new Error(t('cli.keyNeedProvider', { sub }));
      if (sub === 'set') {
        const key = val || await askHidden(t('cli.keyPrompt', { id: pid }));
        if (!key) throw new Error(t('err.emptyKey'));
        core.setKey(pid, key); console.log(t('cli.saved'));
      } else if (sub === 'rm') { core.setKey(pid, ''); console.log(t('cli.removed')); }
      else if (sub === 'get') {
        const k = core.getProviderKey(pid);
        if (!k) throw new Error(t('cli.noKeyFor', { id: pid }));
        process.stdout.write(k + '\n');
      } else { help(); process.exitCode = 1; }
      break;
    }
    case 'login': {
      if (f._[0] !== 'openrouter') throw new Error(t('cli.loginOnlyOpenrouter'));
      const key = await openRouterLogin({ port: Number(f.port) || 3000 });
      core.setKey('openrouter', key);
      console.log(t('cli.loginDone'));
      break;
    }
    case 'models': {
      if (!f._[0]) throw new Error(t('cli.modelsNeedProvider'));
      let list = await core.models(f._[0], { refresh: !!f.refresh });
      if (typeof f.filter === 'string') list = list.filter(m => m.id.toLowerCase().includes(f.filter.toLowerCase()));
      if (f.json) { console.log(JSON.stringify(list, null, 2)); break; }
      for (const m of list.slice(0, Number(f.limit) || 50)) console.log(`${m.id}${m.created ? '  ' + new Date(m.created * 1000).toISOString().slice(0, 10) : ''}${m.context ? '  ' + t('cli.context', { n: m.context }) : ''}`);
      break;
    }
    case 'use': {
      const r = await core.useProvider({ provider: f._[0], model: str(f.model), fastModel: str(f.fast), tools: toolsOf(f), port: f.port && Number(f.port), codexKey: str(f['codex-key']), viaRouter: !!f['via-router'] });
      console.log(r.model ? t('cli.appliedModel', { provider: r.provider, model: r.model }) : t('cli.applied', { provider: r.provider }));
      for (const x of r.results) {
        console.log(`  ${x.tool.padEnd(9)} ${x.file}`);
        if (x.viaRouter) console.log('            ' + t('cli.viaRouter'));
        if (x.keyEnv) console.log('            ' + t('cli.keyEnvHint', { env: x.keyEnv, tool: x.tool }));
      }
      break;
    }
    case 'official':
      for (const r of core.useOfficial(toolsOf(f))) console.log(`${r.tool}: ${r.note || t('ui.restore.officialDone')}${r.file ? ` (${r.file})` : ''}`);
      break;
    case 'restore': for (const r of core.restore(toolsOf(f))) console.log(`${r.target}: ${r.restored ? t('restore.done') : r.reason}`); break;
    case 'backups': {
      if (f._[0] === 'restore') {
        const r = core.restoreBackup(String(f._[1] || ''), String(f._[2] || ''));
        console.log(t('ui.backups.restored', { tool: toolName(r.tool), file: r.file }));
        break;
      }
      const list = core.listBackups();
      if (!list.length) console.log(t('ui.backups.none'));
      for (const b of list) console.log(`${b.id}  ${b.files.join(', ')}`);
      break;
    }
    case 'provider': {
      const [sub, id] = f._;
      if (sub === 'add') {
        const openaiBase = str(f['openai-base']);
        core.addProvider(id, { label: str(f.label), openaiBase, anthropicBase: str(f['anthropic-base']), modelsUrl: str(f['models-url']) || (openaiBase ? openaiBase.replace(/\/$/, '') + '/models' : undefined), codexWire: str(f.wire) || 'chat', keyEnv: str(f['key-env']) });
        console.log(t('ui.providers.added', { id }));
      } else if (sub === 'rm') { core.removeProvider(id); console.log(t('ui.providers.removed', { id })); }
      else { help(); process.exitCode = 1; }
      break;
    }
    case 'router': {
      const tg = core.routerTargets();
      const port = Number(f.port) || tg.port;
      let server;
      try { server = await startRouter({ port, targets: () => core.routerTargets(), onUsage: await core.routerUsageHook() }); } catch (e) {
        if (e.code === 'EADDRINUSE') throw new Error(t('router.portInUse', { port }));
        throw e;
      }
      console.log(t('cli.routerRunning', { port }));
      if (port !== tg.port) console.log('  ' + t('cli.routerPortMismatch', { port: tg.port }));
      if (tg.claude) {
        for (const m of [...new Set([tg.claude.model, tg.claude.fastModel].filter(Boolean))]) {
          const api = tg.claude.apiFor ? tg.claude.apiFor(m) : 'chat';
          const where = api === 'messages' ? `${tg.claude.anthropicBase}/v1/messages` : `${tg.claude.baseUrl}/${api === 'responses' ? 'responses' : 'chat/completions'}`;
          console.log(`  Claude Code → ${where} (${m})`);
        }
      }
      if (tg.codex) console.log(`  Codex       → ${tg.codex.baseUrl}/chat/completions (${tg.codex.model})`);
      if (tg.gemini) console.log(`  Gemini CLI  → ${tg.gemini.provider} (${[tg.gemini.model, tg.gemini.fastModel].filter(Boolean).join(' / ')})`);
      for (const k of core.ROUTED_TOOLS) if (tg[k]?.fallbacks?.length) console.log(`  ${t('ui.fallback.title')} ${toolName(k)}: ${tg[k].fallbacks.map(f => f.provider + ':' + f.model).join(' → ')}`);
      if (!core.routerLogEnabled()) console.log('  ' + t('cli.logOff'));
      const shutdown = () => { server.close(); server.closeAllConnections?.(); console.log(t('ui.router.stopped')); process.exit(0); };
      process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
      break;
    }
    case 'env': {
      const env = core.toolEnv({ all: !!f.all });
      const shell = typeof f.shell === 'string' ? f.shell : defaultShell();
      if (!['sh', 'bash', 'zsh', 'fish', 'powershell', 'pwsh', 'cmd'].includes(shell)) throw new Error(t('cli.badShell'));
      const sh = shell === 'pwsh' ? 'powershell' : ['bash', 'zsh'].includes(shell) ? 'sh' : shell;
      for (const [k, v] of Object.entries(env)) console.log(envLine(sh, k, v));
      if (!Object.keys(env).length) console.error(t('cli.envEmpty'));
      break;
    }
    case 'lang': {
      const v = f._[0];
      if (!v) { console.log(`${getLang()} (${LANG_NAMES[getLang()]}) — ${t('cli.langAvailable', { langs: LANGS.join(', ') })}`); break; }
      const s = core.setSettings({ lang: v });
      setLang(null);
      console.log(t('cli.langSet', { lang: `${s.lang} (${LANG_NAMES[s.lang]})` }));
      break;
    }
    case 'ui': {
      const { url, stop } = await startUi({ port: Number(f.port) || 4567, open: !f['no-open'] });
      console.log(t('cli.uiAt', { url }));
      const shutdown = () => stop().then(() => process.exit(0));
      process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
      break;
    }
    case 'fallback': {
      const [sub, tool, ...specs] = f._;
      if (sub === 'set') { core.setFallback(tool, specs); console.log(t('cli.saved')); await rerouted(tool); }
      else if (sub === 'clear') { core.setFallback(tool, []); console.log(t('cli.removed')); }
      else if (sub && sub !== 'list') { help(); process.exitCode = 1; break; }
      const fb = core.getFallback();
      for (const [k, list] of Object.entries(fb)) console.log(`${toolName(k).padEnd(12)} ${list.length ? list.map(x => x.provider + ':' + x.model).join(' → ') : t('ui.none')}`);
      break;
    }
    case 'balance': {
      const [sub, tool, ...specs] = f._;
      if (sub === 'set') { core.setBalance(tool, specs, { strategy: str(f.strategy) || 'weighted' }); console.log(t('cli.saved')); await rerouted(tool); }
      else if (sub === 'clear') { core.setBalance(tool, []); console.log(t('cli.removed')); }
      else if (sub && sub !== 'list') { help(); process.exitCode = 1; break; }
      if (f.json) { console.log(JSON.stringify(core.getBalance(), null, 2)); break; }
      for (const [k, g] of Object.entries(core.getBalance())) console.log(`${toolName(k).padEnd(12)} ${g ? `[${t('ui.balance.strategy.' + g.strategy)}] ` + g.members.map(m => `${m.provider}:${m.model}*${m.weight}`).join('  ') : t('ui.none')}`);
      break;
    }
    case 'scenario': {
      const [sub, tool, name, spec] = f._;
      if (sub === 'set') { if (!spec) throw new Error(t('err.fallbackSpec', { spec: '' })); core.setScenario(tool, name, spec); console.log(t('cli.saved')); await rerouted(tool); }
      else if (sub === 'clear') { core.setScenario(tool, name || '*', null); console.log(t('cli.removed')); }
      else if (sub === 'threshold') { core.setLongContextThreshold(tool); console.log(t('cli.saved')); }
      else if (sub && sub !== 'list') { help(); process.exitCode = 1; break; }
      const sc = core.getScenarios();
      if (f.json) { console.log(JSON.stringify(sc, null, 2)); break; }
      for (const [k, m] of Object.entries(sc.tools)) {
        const e = Object.entries(m);
        console.log(`${toolName(k).padEnd(12)} ${e.length ? e.map(([n, v]) => `${n} → ${v.provider}:${v.model}`).join('  ') : t('ui.none')}`);
      }
      console.log(t('cli.longContext', { n: sc.longContextThreshold }));
      break;
    }
    case 'breaker': {
      const [sub] = f._;
      if (sub === 'on' || sub === 'off') core.setBreaker({ enabled: sub === 'on' });
      else if (sub === 'set') core.setBreaker({ failures: f.failures, cooldownSec: f.cooldown });
      else if (sub && sub !== 'status') { help(); process.exitCode = 1; break; }
      const b = core.getBreaker();
      const live = await core.routerHealth().catch(() => null);
      if (f.json) { console.log(JSON.stringify({ ...b, live: live?.breaker?.providers || null }, null, 2)); break; }
      console.log(t(b.enabled ? 'cli.breakerOn' : 'cli.breakerOff', { failures: b.failures, cooldown: b.cooldownSec }));
      if (!live) console.log('  ' + t('cli.breakerNoRouter'));
      else {
        const e = Object.entries(live.breaker?.providers || {});
        if (!e.length) console.log('  ' + t('cli.breakerAllClosed'));
        for (const [p, st] of e) console.log(`  ${p.padEnd(14)} ${t('ui.breaker.state.' + st.state)}  ${st.failures}×${st.retryInSec ? '  ' + t('ui.breaker.retryIn', { s: st.retryInSec }) : ''}`);
      }
      break;
    }
    case 'ping': {
      const list = await core.pingProviders(f._);
      if (f.json) { console.log(JSON.stringify(list, null, 2)); break; }
      if (!list.length) console.log(t('cli.pingNone'));
      for (const r of list.sort((a, b) => (b.ok - a.ok) || a.ms - b.ms)) {
        const state = r.ok ? t('ui.ping.ok') : r.auth === 'rejected' ? t('ui.ping.auth') : r.error ? t('ui.ping.fail', { reason: r.error }) : 'HTTP ' + r.status;
        console.log(`${r.ok ? '●' : '○'} ${r.id.padEnd(14)} ${String(r.ms).padStart(5)} ms  ${state}`);
      }
      break;
    }
    case 'usage': {
      if (f.clear) { core.clearUsage(); console.log(t('cli.removed')); break; }
      if (typeof f.log === 'string') { core.setRouterLog(f.log !== 'off'); console.log(t(f.log === 'off' ? 'cli.logOff' : 'cli.logOn')); break; }
      const rep = await core.usageReport({ days: f.days != null ? Number(f.days) : 7 });
      if (f.json) { console.log(JSON.stringify(rep, null, 2)); break; }
      if (f.recent) {
        for (const e of rep.recent.slice(0, Number(f.limit) || 20)) console.log(`${e.ts.replace('T', ' ').slice(0, 19)}  ${String(e.status).padEnd(3)} ${(e.tool || '').padEnd(7)} ${e.provider}:${e.model}  ${e.ms} ms  ${fmtN(e.in)}→${fmtN(e.out)}${e.fallback ? '  ↪' + e.fallback : ''}${e.error ? '  ! ' + e.error : ''}`);
        break;
      }
      console.log(t('cli.usageTotal', { days: rep.days || '∞', requests: fmtN(rep.total.requests), errors: fmtN(rep.total.errors), input: fmtN(rep.total.input), output: fmtN(rep.total.output), cost: fmtCost(rep.total.cost) }));
      for (const r of rep.rows) console.log(`  ${(r.provider + ':' + r.model).padEnd(46)} ${String(r.requests).padStart(5)}×  ${fmtN(r.input)}→${fmtN(r.output)}  ${r.avgMs} ms${r.avgTtft != null ? ' / TTFT ' + r.avgTtft + ' ms' : ''}  ${fmtCost(r.cost)}`);
      if (!core.routerLogEnabled()) console.log(t('cli.logOff'));
      break;
    }
    case 'profile': {
      const [sub, name] = f._;
      if (sub === 'save') { core.saveProfile(name, { tools: toolsOf(f) }); console.log(t('ui.profiles.saved', { name })); }
      else if (sub === 'use') {
        const r = await core.useProfile(name);
        console.log(t('ui.profiles.applied', { name }));
        for (const x of r.results) console.log(`  ${x.tool.padEnd(9)} ${x.provider}  ${x.file || ''}`);
      } else if (sub === 'rm') { core.removeProfile(name); console.log(t('cli.removed')); }
      else if (sub === 'project') { console.log(t('cli.projectSet', { file: core.setProjectProfile(name) })); }
      else if (!sub || sub === 'list') {
        const list = core.listProfiles();
        if (!list.length) console.log(t('ui.profiles.none'));
        for (const p of list) console.log(`${p.name.padEnd(16)} ${Object.entries(p.tools).map(([k, v]) => `${k}=${v.provider}${v.model ? ':' + v.model : ''}`).join('  ')}`);
        const pp = core.projectProfile();
        if (pp) console.log(t('cli.projectProfileFound', { profile: pp.profile, file: pp.file }));
      } else { help(); process.exitCode = 1; }
      break;
    }
    case 'export': {
      const data = JSON.stringify(core.exportConfig({ withKeys: !!f['with-keys'] }), null, 2) + '\n';
      if (f._[0]) { fs.writeFileSync(f._[0], data, { mode: 0o600 }); console.error(t('cli.exported', { file: f._[0] })); } else process.stdout.write(data);
      if (f['with-keys']) console.error(t('cli.exportKeysWarn'));
      break;
    }
    case 'import': {
      if (!f._[0]) throw new Error(t('cli.importNeedFile'));
      const c = core.importConfig(JSON.parse(fs.readFileSync(f._[0], 'utf8')), { overwrite: !!f.overwrite });
      console.log(t('ui.import.done', c));
      break;
    }
    case 'mcp': {
      const [sub] = f._;
      if (sub === 'sync') {
        const res = core.syncMcp({ from: str(f.from) || 'claude', to: listOf(f.to) || core.MCP_TARGETS, only: listOf(f.only), overwrite: !!f.overwrite });
        for (const r of res) console.log(`${toolName(r.tool).padEnd(12)} ${t('ui.mcp.syncResult', { added: r.added.length, skipped: r.skipped.length })}${r.added.length ? '  + ' + r.added.join(', ') : ''}  (${r.file})`);
        break;
      }
      if (sub && sub !== 'list') { help(); process.exitCode = 1; break; }
      const all = core.allMcp();
      if (f.json) { console.log(JSON.stringify(all, null, 2)); break; }
      for (const [tool, v] of Object.entries(all)) {
        console.log(`${toolName(tool)} (${v.servers.length})${v.error ? '  ! ' + v.error : ''}`);
        for (const sv of v.servers) console.log(`  ${sv.name.padEnd(20)} ${sv.type.padEnd(5)} ${sv.type === 'stdio' ? [sv.command, ...sv.args].join(' ') : sv.url}`);
      }
      break;
    }
    case 'update': {
      const u = await core.checkForUpdate(VERSION, { force: true });
      console.log(u.update ? t('cli.updateAvailable', { latest: u.latest, current: u.current }) : t('cli.upToDate', { current: u.current }));
      if (u.update) { console.log('  ' + u.install); console.log('  ' + u.url); }
      break;
    }
    default: console.error(t('cli.unknownCommand', { cmd })); process.exitCode = 1;
  }
}

main().catch(e => { console.error(t('cli.error', { msg: e.message })); process.exitCode = 1; });
