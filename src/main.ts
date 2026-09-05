import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { Remote } from './remote';
import { DEFAULT_PROFILE, type Profile, type Credentials, type RemoteEvent } from './shared';

let window: BrowserWindow | undefined;
let connecting = false;
const remote = new Remote(async (host, fingerprint) => {
  const known = await readJSON('known-hosts.json', {}) as Record<string, string>;
  if (known[host] === fingerprint) return true;
  if (known[host]) {
    await dialog.showMessageBox(window!, { type: 'error', title: 'SSH host key changed',
      message: `The identity of ${host} has changed.`, detail: `Expected: ${known[host]}\nReceived: ${fingerprint}\n\nConnection refused. Verify the machine before removing its entry in ${path.join(app.getPath('userData'), 'known-hosts.json')}.` });
    return false;
  }
  const result = await dialog.showMessageBox(window!, { type: 'question', title: 'Trust this machine?',
    message: `Connect to ${host}?`, detail: `SSH host fingerprint:\n${fingerprint}\n\nCompare this with your machine’s host key. Its identity will be remembered for future connections.`,
    buttons: ['Cancel', 'Trust and connect'], defaultId: 0, cancelId: 0 });
  if (result.response !== 1) return false;
  known[host] = fingerprint;
  await saveJSON('known-hosts.json', known);
  return true;
});
async function readJSON(name: string, fallback: unknown) {
  try { return JSON.parse(await readFile(path.join(app.getPath('userData'), name), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
async function saveJSON(name: string, value: unknown) {
  const directory = app.getPath('userData');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await writeFile(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(file + '.tmp', file);
}
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender');
}
function handle(name: string, handler: (...args: any[]) => unknown) {
  ipcMain.handle(name, (event, ...args) => { trusted(event); return handler(...args); });
}
handle('profile', () => readJSON('profile.json', DEFAULT_PROFILE));
handle('choose-key', async () => {
  const result = await dialog.showOpenDialog(window!, { title: 'Choose your SSH private key', defaultPath: path.join(app.getPath('home'), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
  return result.canceled ? null : result.filePaths[0];
});
handle('connect', async (profile: Profile, credentials: Credentials) => {
  if (connecting) throw new Error('A connection attempt is already in progress');
  connecting = true;
  try {
    const snapshot = await remote.connect(profile, credentials);
    const { host, port, username, directory, auth, keyPath } = profile;
    await saveJSON('profile.json', { host, port, username, directory, auth, keyPath });
    return snapshot;
  } finally { connecting = false; }
});
handle('disconnect', () => remote.disconnect());
handle('refresh', () => remote.refresh());
handle('attach', (id, tmux, cols, rows) => remote.attach(id, tmux, cols, rows));
handle('detach', id => remote.detach(id));
for (const method of ['input', 'resize', 'ack'] as const) {
  ipcMain.on(method, (event, id, first, second) => {
    trusted(event);
    if (method === 'input') remote.input(id, first);
    else if (method === 'resize') remote.resize(id, first, second);
    else remote.ack(id, first);
  });
}
remote.on('event', (event: RemoteEvent) => { if (window && !window.isDestroyed()) window.webContents.send('remote-event', event); });

function createWindow() {
  window = new BrowserWindow({ width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'Workbench Remote', titleBarStyle: 'hiddenInset', backgroundColor: '#111413',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('closed', () => { remote.disconnect(); window = undefined; });
  void window.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
  createWindow();
  app.on('activate', () => { if (!window) createWindow(); });
});
app.on('before-quit', () => remote.disconnect());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
