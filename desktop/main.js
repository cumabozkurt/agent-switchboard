import { app, BrowserWindow, Menu, shell, dialog } from 'electron';
import { startUi } from './app-src/ui/server.js';
import { t, getLang } from './app-src/i18n/index.js';

const REPO = 'https://github.com/cumabozkurt/agent-switchboard';
let ui = null;
let win = null;
let quitting = false;

// One instance only: a second launch focuses the existing window (two apps would fight over the router port).
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

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

async function create() {
  try {
    ui = await startUi({ port: 0, open: false, locale: app.getLocale(), onLangChange: () => buildMenu() });
  } catch (e) {
    dialog.showErrorBox('Agent Switchboard', e.message);
    app.quit();
    return;
  }
  buildMenu();
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
