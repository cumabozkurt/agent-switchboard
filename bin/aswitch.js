#!/usr/bin/env node
import fs from 'node:fs';
import * as core from '../src/core.js';
import { startRouter } from '../src/router.js';
import { openRouterLogin } from '../src/oauth.js';
import { startUi } from '../src/ui/server.js';
import { flags, envLine, defaultShell } from '../src/cli.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `agent-switchboard (aswitch) ${VERSION} — Claude Code, Codex ve OpenCode için API/model yöneticisi

Kullanım:
  aswitch status                               Aktif sağlayıcı ve modelleri göster
  aswitch providers                            Hazır ve özel sağlayıcıları listele
  aswitch key set <sağlayıcı> [anahtar]        API anahtarını kaydet (boş bırakılırsa gizli sorar)
  aswitch key rm <sağlayıcı>                   Anahtarı sil
  aswitch key get <sağlayıcı>                  Anahtarı düz metin yazdır (Codex "--codex-key command" bunu kullanır)
  aswitch login openrouter [--port 3000]       OpenRouter OAuth (PKCE) ile anahtar al
  aswitch models <sağlayıcı> [--refresh] [--filter x] [--limit 50]
                                               Canlı model listesini çek (yeniden eskiye)
  aswitch use <sağlayıcı> [--model m] [--fast m] [--tools claude,codex,opencode] [--codex-key env|command]
                                               Sağlayıcıyı araçlara uygula (varsayılan: üç araç). Model "latest"
                                               veya "latest:opus" olabilir: uygulama anında en yenisi seçilir
  aswitch official [--tools claude,codex]      Aracın kendi resmî girişine dön (Pro/Max, ChatGPT OAuth)
  aswitch restore [--tools ...]                Dosyaları aswitch'ten önceki ORİJİNAL haline getir
  aswitch backups                              Zaman damgalı yedekleri listele
  aswitch provider add <id> --openai-base URL [--anthropic-base URL] [--models-url URL]
                           [--wire responses|chat] [--key-env AD] [--label ad]
  aswitch provider rm <id>
  aswitch router [--port 3456]                 Chat Completions sağlayıcılarını Claude Code ve Codex'e bağlayan yerel çevirici
  aswitch run <claude|codex|opencode> [argümanlar]  Aracı kayıtlı anahtarla başlat (argümanlar araca aynen geçer)
  aswitch env [--shell sh|fish|powershell|cmd] [--all]  Aktif Codex/OpenCode anahtarlarını ortam değişkeni olarak yazdır
  aswitch ui [--port 4567] [--no-open]         Masaüstü arayüzünü tarayıcıda aç
  aswitch --version
`;

// Gizli giriş: TTY'de ham mod ile karakterler ekrana yazılmaz; boru/dosyadan gelen girişte ilk satır okunur.
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
        if (ch === '\u0003') return done(new Error('İptal edildi.'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const toolsOf = f => (typeof f.tools === 'string' ? f.tools.split(',').map(s => s.trim()).filter(Boolean) : undefined);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') {
    // run: araç adından sonraki her şey araca aynen iletilir (bayraklar dahil).
    process.exitCode = await core.run(rest[0], rest.slice(1));
    return;
  }
  const f = flags(rest);
  switch (cmd) {
    case undefined: case 'help': case '-h': case '--help': console.log(HELP); break;
    case '-v': case '--version': case 'version': console.log(VERSION); break;
    case 'status': console.log(JSON.stringify(core.status(), null, 2)); break;
    case 'providers':
      for (const p of core.providers()) console.log(`${p.hasKey ? '●' : '○'} ${p.id.padEnd(14)} ${p.label}${p.codex ? (p.codexDirect ? '' : '  (Codex: yönlendirici ile)') : '  (Codex yok)'}${p.custom ? '  [özel]' : ''}`);
      break;
    case 'key': {
      const [sub, pid, val] = f._;
      if (!pid && sub) throw new Error('Sağlayıcı belirtin: aswitch key ' + sub + ' <sağlayıcı>');
      if (sub === 'set') {
        const key = val || await askHidden(`${pid} anahtarı: `);
        if (!key) throw new Error('Boş anahtar kaydedilmedi.');
        core.setKey(pid, key); console.log('Kaydedildi.');
      } else if (sub === 'rm') { core.setKey(pid, ''); console.log('Silindi.'); }
      else if (sub === 'get') {
        const k = core.getProviderKey(pid);
        if (!k) throw new Error(`${pid} için anahtar yok.`);
        process.stdout.write(k + '\n');
      } else { console.log(HELP); process.exitCode = 1; }
      break;
    }
    case 'login': {
      if (f._[0] !== 'openrouter') throw new Error('Şu an resmî OAuth akışı yalnızca OpenRouter için var. Claude/Codex aboneliği için "aswitch official" kullanın.');
      const key = await openRouterLogin({ port: Number(f.port) || 3000 });
      core.setKey('openrouter', key);
      console.log('OpenRouter anahtarı OAuth ile alındı ve kaydedildi.');
      break;
    }
    case 'models': {
      if (!f._[0]) throw new Error('Sağlayıcı belirtin: aswitch models <sağlayıcı>');
      let list = await core.models(f._[0], { refresh: !!f.refresh });
      if (typeof f.filter === 'string') list = list.filter(m => m.id.toLowerCase().includes(f.filter.toLowerCase()));
      if (f.json) { console.log(JSON.stringify(list, null, 2)); break; }
      for (const m of list.slice(0, Number(f.limit) || 50)) console.log(`${m.id}${m.created ? '  ' + new Date(m.created * 1000).toISOString().slice(0, 10) : ''}${m.context ? '  ' + m.context + ' bağlam' : ''}`);
      break;
    }
    case 'use': {
      const str = v => (typeof v === 'string' ? v : undefined);
      const r = await core.useProvider({ provider: f._[0], model: str(f.model), fastModel: str(f.fast), tools: toolsOf(f), port: f.port && Number(f.port), codexKey: str(f['codex-key']) });
      console.log(`${r.provider} uygulandı${r.model ? ` (model: ${r.model})` : ''}:`);
      for (const x of r.results) {
        console.log(`  ${x.tool.padEnd(9)} ${x.file}`);
        if (x.viaRouter) console.log('            Bu araç yerel yönlendirici üzerinden bağlanır: "aswitch router" açık olmalı.');
        if (x.keyEnv) console.log(`            Anahtar ${x.keyEnv} değişkeninden okunur: "aswitch run ${x.tool}" ile başlatın veya "aswitch env" çıktısını profilinize ekleyin.`);
      }
      break;
    }
    case 'official':
      for (const r of core.useOfficial(toolsOf(f))) console.log(`${r.tool}: ${r.note || 'resmî girişe dönüldü'}${r.file ? ` (${r.file})` : ''}`);
      break;
    case 'restore': for (const r of core.restore(toolsOf(f))) console.log(`${r.target}: ${r.restored ? 'orijinal hale getirildi' : r.reason}`); break;
    case 'backups': for (const b of core.listBackups()) console.log(`${b.id}  ${b.files.join(', ')}`); break;
    case 'provider': {
      const [sub, id] = f._;
      const str = v => (typeof v === 'string' ? v : undefined);
      if (sub === 'add') {
        const openaiBase = str(f['openai-base']);
        core.addProvider(id, { label: str(f.label), openaiBase, anthropicBase: str(f['anthropic-base']), modelsUrl: str(f['models-url']) || (openaiBase ? openaiBase.replace(/\/$/, '') + '/models' : undefined), codexWire: str(f.wire) || 'chat', keyEnv: str(f['key-env']) });
        console.log(`${id} eklendi.`);
      } else if (sub === 'rm') { core.removeProvider(id); console.log(`${id} silindi.`); }
      else { console.log(HELP); process.exitCode = 1; }
      break;
    }
    case 'router': {
      const t = core.routerTargets();
      const port = Number(f.port) || t.port;
      await startRouter({ port, targets: () => core.routerTargets() });
      console.log(`Yönlendirici http://127.0.0.1:${port} çalışıyor. Durdurmak için Ctrl+C.`);
      if (t.claude) console.log(`  Claude Code → ${t.claude.baseUrl} (${t.claude.model})`);
      if (t.codex) console.log(`  Codex       → ${t.codex.baseUrl} (${t.codex.model})`);
      break;
    }
    case 'env': {
      const env = core.toolEnv({ all: !!f.all });
      const shell = typeof f.shell === 'string' ? f.shell : defaultShell();
      if (!['sh', 'bash', 'zsh', 'fish', 'powershell', 'pwsh', 'cmd'].includes(shell)) throw new Error('--shell sh | fish | powershell | cmd olmalı');
      const sh = shell === 'pwsh' ? 'powershell' : ['bash', 'zsh'].includes(shell) ? 'sh' : shell;
      for (const [k, v] of Object.entries(env)) console.log(envLine(sh, k, v));
      if (!Object.keys(env).length) console.error('(Aktif Codex/OpenCode sağlayıcısı için anahtar yok; tüm kayıtlı anahtarlar için --all)');
      break;
    }
    case 'ui': { const { url } = await startUi({ port: Number(f.port) || 4567, open: !f['no-open'] }); console.log(`Arayüz: ${url}`); break; }
    default: console.log(HELP); process.exitCode = 1;
  }
}

main().catch(e => { console.error('Hata:', e.message); process.exitCode = 1; });
