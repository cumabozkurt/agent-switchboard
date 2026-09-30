import { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUi } from './app-src/ui/server.js';
import { t, getLang } from './app-src/i18n/index.js';

const REPO = 'https://github.com/cumabozkurt/agent-switchboard';
let ui = null;
let win = null;
let quitting = false;
let tray = null;
const here = path.dirname(fileURLToPath(import.meta.url));

// aswitch:// deep links (share a provider/profile). The page shows a confirmation dialog; nothing is applied
// automatically and links never carry keys. Windows/Linux pass the link on the command line, macOS via open-url.
const linkIn = argv => (argv || []).find(a => typeof a === 'string' && /^aswitch:\/\//i.test(a) && a.length <= 16384) || null;
let pendingLink = linkIn(process.argv);
function deliverLink(url) {
  if (!url) return;
  if (!win || win.webContents.isLoading()) { pendingLink = url; return; }
  showWindow();
  win.webContents.executeJavaScript(`window.openDeepLink && window.openDeepLink(${JSON.stringify(url)})`).catch(() => {});
}
app.on('open-url', (e, url) => { e.preventDefault(); deliverLink(url); });
// Register the scheme only for the installed app (dev/test runs must not touch the desktop's protocol handlers).
if (app.isPackaged && !process.env.ASWITCH_NO_PROTOCOL) app.setAsDefaultProtocolClient('aswitch');

// One instance only: a second launch focuses the existing window (two apps would fight over the router port).
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (e, argv) => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } deliverLink(linkIn(argv)); });

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [
      { role: 'about', label: t('menu.about') }, { type: 'separator' },
      { role: 'hide', label: t('menu.hide') }, { role: 'hideOthers', label: t('menu.hideOthers') }, { role: 'unhide', label: t('menu.showAll') },
      { type: 'separator' }, { role: 'quit', label: t('menu.quit') }] }] : []),
    { label: t('menu.file'), submenu: [isMac ? { role: 'close', label: t('menu.close') } : { role: 'quit', label: t('menu.quit') }] },
    { label: t('menu.edit'), submenu: [
      { role: 'undo', label: t('menu.undo') }, { role: 'redo', label: t('menu.redo') }, { type: 'separator' },
      { role: 'cut', label: t('menu.cut') }, { role: 'copy', label: t('menu.copy') }, { role: 'paste', label: t('menu.paste') }, { role: 'selectAll', label: t('menu.selectAll') }] },
    { label: t('menu.view'), submenu: [
      { role: 'reload', label: t('menu.reload') }, { type: 'separator' },
      { role: 'resetZoom', label: t('menu.resetZoom') }, { role: 'zoomIn', label: t('menu.zoomIn') }, { role: 'zoomOut', label: t('menu.zoomOut') },
      { type: 'separator' }, { role: 'togglefullscreen', label: t('menu.fullscreen') }, { role: 'toggleDevTools', label: t('menu.devtools') }] },
    { label: t('menu.window'), submenu: [{ role: 'minimize', label: t('menu.minimize') }, ...(isMac ? [{ role: 'zoom', label: t('menu.zoom') }] : [])] },
    { label: t('menu.help'), submenu: [
      { label: t('menu.docs'), click: () => shell.openExternal(REPO + (getLang() === 'tr' ? '/blob/main/README.tr.md' : '#readme')) },
      { label: t('menu.issues'), click: () => shell.openExternal(REPO + '/issues') }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (win) win.setTitle(`Agent Switchboard — ${t('ui.tagline')}`);
}

// Calls the panel's own local API (same token as the window), so tray actions go through the same code path.
async function panel(p, body) {
  const base = ui.url.split('#')[0];
  const token = ui.url.split('#')[1];
  const r = await fetch(base + 'api/' + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aswitch-token': token }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

function showWindow() { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }

// Tray / menu bar quick switch: apply a saved profile, go back to official logins, start/stop the router.
async function buildTray() {
  if (!tray) {
    try {
      const icon = nativeImage.createFromPath(path.join(here, 'assets', 'tray.png'));
      tray = new Tray(icon);
      tray.setToolTip('Agent Switchboard');
      tray.on('click', showWindow);
      globalThis.aswitchTray = tray; // lets the e2e test see the tray
    } catch { tray = null; return; } // no system tray (e.g. some Linux desktops)
  }
  let profiles = [], status = null;
  try { profiles = (await panel('profiles')).profiles; status = await panel('status'); } catch { /* panel not ready */ }
  const act = fn => () => fn().then(() => { buildTray(); if (win) win.webContents.executeJavaScript('typeof refresh === "function" && refresh()').catch(() => {}); })
    .catch(e => dialog.showErrorBox('Agent Switchboard', e.message));
  const running = status?.router?.state === 'running';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('menu.tray.open'), click: showWindow },
    { type: 'separator' },
    { label: t('menu.tray.profiles'), submenu: profiles.length
      ? profiles.map(p => ({ label: p.name, type: 'radio', checked: status?.activeProfile === p.name, click: act(() => panel('profile/use', { name: p.name })) }))
      : [{ label: t('ui.profiles.none'), enabled: false }] },
    { label: t('menu.tray.official'), click: act(() => panel('official', { tools: ['claude', 'codex', 'gemini'] })) },
    { type: 'separator' },
    running ? { label: t('menu.tray.routerStop'), click: act(() => panel('router/stop')) }
      : { label: t('menu.tray.routerStart'), enabled: !!status?.router?.needed, click: act(() => panel('router/start')) },
    { type: 'separator' },
    { label: t('menu.quit'), click: () => app.quit() }
  ]));
}

async function create() {
  try {
    ui = await startUi({ port: 0, open: false, locale: app.getLocale(), onLangChange: () => { buildMenu(); buildTray(); } });
  } catch (e) {
    dialog.showErrorBox('Agent Switchboard', e.message);
    app.quit();
    return;
  }
  buildMenu();
  buildTray();
  setInterval(() => { if (tray) buildTray(); }, 15000);
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 720, minHeight: 520, show: false,
    title: `Agent Switchboard — ${t('ui.tagline')}`,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  win.once('ready-to-show', () => win.show());
  // Links (key pages, GitHub) open in the default browser; the window itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ui.url.split('#')[0])) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  win.on('page-title-updated', e => e.preventDefault());
  win.on('closed', () => { win = null; });
  await win.loadURL(ui.url);
  if (pendingLink) { const u = pendingLink; pendingLink = null; deliverLink(u); }
}

app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
// Stop the router and the local server cleanly before exiting, so the port is released immediately.
app.on('before-quit', e => {
  if (quitting || !ui) return;
  e.preventDefault();
  quitting = true;
  Promise.race([ui.stop(), new Promise(r => setTimeout(r, 3000))]).finally(() => app.quit());
});
