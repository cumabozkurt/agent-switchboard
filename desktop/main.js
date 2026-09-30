import { app, BrowserWindow, shell } from 'electron';
import { startUi } from './app-src/ui/server.js';

let ui;
async function create() {
  ui = await startUi({ port: 0, open: false });
  const win = new BrowserWindow({ width: 1080, height: 760, title: 'Agent Switchboard', webPreferences: { contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  await win.loadURL(ui.url);
}
app.whenReady().then(create);
app.on('window-all-closed', () => { ui?.server.close(); app.quit(); });
