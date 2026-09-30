#!/usr/bin/env node
import readline from 'node:readline';
import * as core from '../src/core.js';
import { startRouter } from '../src/router.js';
import { openRouterLogin } from '../src/oauth.js';
import { startUi } from '../src/ui/server.js';

const HELP = `agent-switchboard (aswitch) — Claude Code, Codex ve OpenCode için API/model yöneticisi

Kullanım:
  aswitch status                               Aktif sağlayıcı ve modelleri göster
  aswitch providers                            Hazır ve özel sağlayıcıları listele
  aswitch key set <sağlayıcı> [anahtar]        API anahtarını kaydet (boş bırakılırsa gizli sorar)
  aswitch key rm <sağlayıcı>                   Anahtarı sil
  aswitch login openrouter                     OpenRouter OAuth (PKCE) ile anahtar al
  aswitch models <sağlayıcı> [--refresh] [--filter x]  Canlı model listesini çek (yeniden eskiye)
  aswitch use <sağlayıcı> [--model m] [--fast m] [--tools claude,codex,opencode]
                                               Sağlayıcıyı araçlara uygula. Model "latest" veya
                                               "latest:opus" olabilir: her seferinde en yenisi seçilir
  aswitch official [--tools claude,codex]      Aracın kendi resmî girişine dön (Pro/Max, ChatGPT OAuth)
  aswitch restore [--tools ...]                Dosyaları aswitch'ten önceki ORİJİNAL haline getir
  aswitch backups                              Zaman damgalı yedekleri listele
  aswitch provider add <id> --openai-base URL [--anthropic-base URL] [--models-url URL] [--label ad]
  aswitch provider rm <id>
  aswitch router [--port 3456]                 OpenAI-uyumlu sağlayıcıları Claude Code'a bağlayan yerel çevirici
  aswitch run <claude|codex|opencode> [argümanlar]  Aracı kayıtlı anahtarlarla başlat
  aswitch env [--shell powershell]             Anahtarları ortam değişkeni olarak yazdır
  aswitch ui [--port 4567]                     Masaüstü arayüzünü tarayıcıda aç
`;

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function askHidden(q) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); res(a.trim()); });
  });
}

const tools = f => (f.tools ? String(f.tools).split(',').map(s => s.trim()).filter(Boolean) : undefined);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  switch (cmd) {
    case undefined: case 'help': case '-h': case '--help': console.log(HELP); break;
    case 'status': console.log(JSON.stringify(core.status(), null, 2)); break;
    case 'providers':
      for (const p of core.providers()) console.log(`${p.hasKey ? '●' : '○'} ${p.id.padEnd(14)} ${p.label}${p.codex ? '' : '  (Codex yok)'}${p.custom ? '  [özel]' : ''}`);
      break;
    case 'key': {
      const [sub, pid, val] = f._;
      if (sub === 'set') { core.setKey(pid, val || await askHidden(`${pid} anahtarı: `)); console.log('Kaydedildi.'); }
      else if (sub === 'rm') { core.setKey(pid, ''); console.log('Silindi.'); }
      else console.log(HELP);
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
      let list = await core.models(f._[0], { refresh: !!f.refresh });
      if (f.filter) list = list.filter(m => m.id.toLowerCase().includes(String(f.filter).toLowerCase()));
      for (const m of list.slice(0, Number(f.limit) || 50)) console.log(`${m.id}${m.created ? '  ' + new Date(m.created * 1000).toISOString().slice(0, 10) : ''}${m.context ? '  ' + m.context + ' bağlam' : ''}`);
      break;
    }
    case 'use': {
      const r = await core.useProvider({ provider: f._[0], model: f.model, fastModel: f.fast, tools: tools(f), port: f.port && Number(f.port) });
      console.log(`${r.provider} uygulandı${r.model ? ` (model: ${r.model})` : ''}:`);
      for (const x of r.results) {
        console.log(`  ${x.tool.padEnd(9)} ${x.file}`);
        if (x.viaRouter) console.log('            Bu sağlayıcı için "aswitch router" çalışır durumda olmalı.');
        if (x.keyEnv) console.log(`            Anahtar ${x.keyEnv} değişkeninden okunur: "aswitch run ${x.tool}" ile başlatın veya "aswitch env" çıktısını profilinize ekleyin.`);
      }
      break;
    }
    case 'official': for (const r of core.useOfficial(tools(f))) console.log(`${r.tool}: resmî girişe dönüldü (${r.file || ''})`); break;
    case 'restore': for (const r of core.restore(tools(f))) console.log(`${r.target}: ${r.restored ? 'orijinal hale getirildi' : r.reason}`); break;
    case 'backups': for (const b of core.listBackups()) console.log(`${b.id}  ${b.files.join(', ')}`); break;
    case 'provider': {
      const [sub, id] = f._;
      if (sub === 'add') {
        core.addProvider(id, { label: f.label, openaiBase: f['openai-base'], anthropicBase: f['anthropic-base'], modelsUrl: f['models-url'] || (f['openai-base'] ? f['openai-base'].replace(/\/$/, '') + '/models' : undefined), codexWire: f.wire || 'chat', keyEnv: f['key-env'] });
        console.log(`${id} eklendi.`);
      } else if (sub === 'rm') { core.removeProvider(id); console.log(`${id} silindi.`); }
      else console.log(HELP);
      break;
    }
    case 'router': {
      const t = core.routerTarget();
      const port = Number(f.port) || t.port || core.DEFAULT_ROUTER_PORT;
      await startRouter({ port, target: t });
      console.log(`Yönlendirici http://127.0.0.1:${port} → ${t.baseUrl} (${t.model || 'istekteki model'}). Durdurmak için Ctrl+C.`);
      break;
    }
    case 'run': process.exitCode = await core.run(f._[0], process.argv.slice(4)); break;
    case 'env': {
      const env = core.toolEnv();
      const ps = f.shell === 'powershell' || (process.platform === 'win32' && f.shell !== 'sh');
      for (const [k, v] of Object.entries(env)) console.log(ps ? `$env:${k}="${v}"` : `export ${k}='${v}'`);
      break;
    }
    case 'ui': { const { url } = await startUi({ port: Number(f.port) || 4567, open: !f['no-open'] }); console.log(`Arayüz: ${url}`); break; }
    default: console.log(HELP); process.exitCode = 1;
  }
}

main().catch(e => { console.error('Hata:', e.message); process.exitCode = 1; });
