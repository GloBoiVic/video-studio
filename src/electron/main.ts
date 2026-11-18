// Electron main: starts the Studio (project store, preview origin, API, agents), opens the window, and provides the
// offscreen frame host for looks, annotations and export.
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Studio } from '../server/studio.js';
import { startApi } from '../server/api.js';
import { agentPath } from '../server/agents.js';
import { isInside } from '../core/paths.js';
import { electronFrameHost } from './frame-host.js';
import { runSelfTest } from './selftest.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
process.env.PATH = agentPath();
app.setName('Video Studio');
// a failure in one job (a frame, a pipe to a child process) must not take the editor down
const logFile = process.env.VIDEO_STUDIO_LOG;
const log = (...a: unknown[]) => {
  const line = `${new Date().toISOString()} ${a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  if (logFile) appendFileSync(logFile, line);
  else process.stderr.write(line);
};
process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandled rejection', e));

const userDir = process.env.VIDEO_STUDIO_HOME ?? app.getPath('userData');
const projectsDir = process.env.VIDEO_STUDIO_PROJECTS ?? join(app.getPath('documents'), 'Video Studio');
const token = process.env.VIDEO_STUDIO_TOKEN || randomBytes(24).toString('hex');

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (ev, url) => {
    const allowed = url.startsWith('http://127.0.0.1:') || url.startsWith('data:');
    if (!allowed) ev.preventDefault();
  });
});
// offscreen render windows come and go; only closing the editor itself (off macOS) quits
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !process.env.VIDEO_STUDIO_HEADLESS) app.quit();
});

let studio: Studio;
let url = '';

function openWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'Video Studio',
    backgroundColor: '#0e0f12',
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void win.loadURL(`${url}/#token=${token}`);
  return win;
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'));
  studio = new Studio({
    libraryDir: join(appRoot, 'library'),
    userDir,
    projectsDir,
    host: electronFrameHost(),
    // the MCP server runs on Electron's own Node, so no separate Node install is needed
    mcp: { command: process.execPath, args: [join(here, 'mcp.js')], env: { ELECTRON_RUN_AS_NODE: '1' } },
  });
  const api = await startApi(studio, { uiDir: join(here, 'ui'), token, port: Number(process.env.PORT) || 0 });
  url = api.url;
  console.log(`Video Studio at ${url}`);

  ipcMain.handle('pick-files', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('reveal', (_e, p: string) => {
    if (studio.store && isInside(studio.store.root, p)) shell.showItemInFolder(p);
  });

  if (process.env.VIDEO_STUDIO_SELFTEST) {
    const ok = await runSelfTest(studio, { reportFile: process.env.VIDEO_STUDIO_SELFTEST, appRoot });
    if (!process.env.VIDEO_STUDIO_KEEP_OPEN) app.exit(ok ? 0 : 1);
  }
  if (!process.env.VIDEO_STUDIO_HEADLESS) openWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && openWindow());
});
