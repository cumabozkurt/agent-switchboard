import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.js';

const dir = sandbox();
const i18n = await import('../src/i18n/index.js');
const { extractLang } = await import('../src/cli.js');
const { en, tr } = i18n.CATALOGS;
const root = new URL('..', import.meta.url);
const read = rel => fs.readFileSync(new URL(rel, root), 'utf8');
const codeFiles = () => ['bin/aswitch.js', 'desktop/main.js', 'src/ui/index.html',
  ...fs.readdirSync(new URL('src', root), { recursive: true }).filter(f => /\.js$/.test(f) && !f.startsWith('i18n')).map(f => 'src/' + f.split(path.sep).join('/'))];
const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

test('i18n: en ve tr kataloglarının anahtarları ve yer tutucuları birebir aynı', () => {
  assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort());
  for (const k of Object.keys(en)) {
    assert.equal(typeof en[k], 'string'); assert.ok(en[k].trim() && tr[k].trim(), `boş metin: ${k}`);
    assert.equal(placeholders(tr[k]), placeholders(en[k]), `yer tutucular farklı: ${k}`);
  }
});

test('i18n: Türkçe katalog çevrilmiş (İngilizceyle aynı kalan yalnızca "Model")', () => {
  const same = Object.keys(en).filter(k => en[k] === tr[k] && en[k] !== 'Model');
  assert.deepEqual(same, []);
  assert.match(tr['ui.tab.switch'], /[ğüşıöç]/);
});

test('i18n: kodda kullanılan her anahtar katalogda var (dinamik aileler dahil)', () => {
  const used = new Set();
  for (const f of codeFiles()) {
    for (const m of read(f).matchAll(/['"`]((?:err|ui|cli|router|restore|key|oauth|codex|menu|provider)\.[A-Za-z0-9_.-]+)['"`]/g)) if (!m[1].endsWith('.')) used.add(m[1]);
  }
  assert.ok(used.size > 200, 'anahtar taraması çalışmalı');
  const missing = [...used].filter(k => !(k in en));
  assert.deepEqual(missing, []);
  const dynamic = [
    ...['official', 'apikey', 'custom', 'router', 'default', 'error'].map(m => 'ui.mode.' + m),
    ...['running', 'external', 'stopped'].map(s => 'ui.router.state.' + s),
    ...['sh', 'fish', 'powershell', 'cmd'].map(s => 'ui.env.where.' + s)
  ];
  for (const k of dynamic) assert.ok(k in en, k);
});

test('i18n: her hazır sağlayıcının açıklaması iki dilde var', async () => {
  const { PRESETS } = await import('../src/providers.js');
  for (const id of Object.keys(PRESETS)) assert.ok(en['provider.' + id] && tr['provider.' + id], id);
});

test('i18n: kodda (yorumlar dışında) sabit Türkçe metin kalmadı', () => {
  const offenders = [];
  for (const f of codeFiles()) {
    read(f).split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const code = line.replace(/(^|\s)\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (/[çğışöüÇĞİŞÖÜ]/.test(code)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('i18n: dil çözümleme sırası ve normalleştirme', () => {
  assert.equal(i18n.normalizeLang('tr_TR.UTF-8'), 'tr');
  assert.equal(i18n.normalizeLang('en-US'), 'en');
  assert.equal(i18n.normalizeLang('de_DE'), null);
  const saved = { ...process.env };
  try {
    for (const k of ['ASWITCH_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) delete process.env[k];
    process.env.LANG = 'tr_TR.UTF-8';
    assert.equal(i18n.systemLang(), 'tr');
    process.env.LANG = 'de_DE.UTF-8';
    assert.equal(i18n.systemLang(), 'en', 'desteklenmeyen dil İngilizceye düşer');
    process.env.LANG = 'C.UTF-8';
    assert.ok(['en', 'tr'].includes(i18n.systemLang()), 'C yereli Intl ile çözülür');
    assert.equal(i18n.systemLang('tr-TR'), 'tr', 'Electron app.getLocale() ipucu');
    process.env.LANG = 'en_US.UTF-8';
    i18n.setLocaleHint('tr'); assert.equal(i18n.getLang(), 'tr', 'ipucu, ortamdan önce gelir');
    fs.mkdirSync(path.join(dir, '.agent-switchboard'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agent-switchboard', 'config.json'), JSON.stringify({ lang: 'en' }));
    i18n.resetLangCache(); assert.equal(i18n.getLang(), 'en', 'config.json ipucundan önce gelir');
    process.env.ASWITCH_LANG = 'tr';
    i18n.resetLangCache(); assert.equal(i18n.getLang(), 'tr', 'ASWITCH_LANG config.json\'dan önce gelir');
    i18n.setLang('en'); assert.equal(i18n.getLang(), 'en', 'setLang (ör. --lang) her şeyden önce gelir');
    assert.equal(i18n.t('err.unknownTool', { tool: 'x' }), 'Unknown tool: x (claude | codex | opencode | gemini)');
    assert.equal(i18n.t('err.unknownTool', { tool: 'x' }, 'tr'), 'Bilinmeyen araç: x (claude | codex | opencode | gemini)');
    assert.throws(() => i18n.setLang('xx'), /xx/);
  } finally {
    i18n.setLang(null); i18n.setLocaleHint(null);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(path.join(dir, '.agent-switchboard', 'config.json'), { force: true });
    i18n.resetLangCache();
  }
});

test('i18n: --lang yalnızca "run" öncesinde yakalanır', () => {
  assert.deepEqual(extractLang(['--lang', 'en', 'status']), { lang: 'en', rest: ['status'] });
  assert.deepEqual(extractLang(['status', '--lang=tr']), { lang: 'tr', rest: ['status'] });
});

test('i18n: CLI --lang, ASWITCH_LANG ve "aswitch lang" kalıcı ayarı', () => {
  const bin = fileURLToPath(new URL('../bin/aswitch.js', import.meta.url));
  const env = { ...process.env }; delete env.ASWITCH_LANG;
  const cli = (args, extra = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  assert.match(cli(['--lang', 'en', 'help']).stdout, /Usage:/);
  assert.match(cli(['help', '--lang', 'tr']).stdout, /Kullanım:/);
  assert.match(cli(['help'], { ASWITCH_LANG: 'tr' }).stdout, /Kullanım:/);
  assert.match(cli(['--lang', 'en', 'use', 'nope']).stderr, /Error: Unknown provider: nope/);
  assert.match(cli(['--lang', 'tr', 'use', 'nope']).stderr, /Hata: Bilinmeyen sağlayıcı: nope/);
  assert.match(cli(['lang', 'tr']).stdout, /Türkçe/);
  assert.match(cli(['help'], { LANG: 'en_US.UTF-8' }).stdout, /Kullanım:/, 'kalıcı ayar sistem dilinden önce gelir');
  assert.match(cli(['lang', 'en']).stdout, /English/);
  assert.match(cli(['help'], { LANG: 'tr_TR.UTF-8' }).stdout, /Usage:/);
  assert.notEqual(cli(['lang', 'xx']).status, 0);
  cli(['lang', 'auto']);
  assert.match(cli(['help'], { LANG: 'tr_TR.UTF-8', LC_ALL: '' }).stdout, /Kullanım:/, 'auto: sistem diline döner');
});
