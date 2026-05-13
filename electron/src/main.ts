import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const windowStateKeeper = require('electron-window-state');

let backend: ChildProcess | null = null;

function startBackend() {
  const backendEntry = path.resolve(__dirname, '../../backend/dist/index.js');
  backend = spawn(process.execPath, [backendEntry], {
    env: { ...process.env, GROVE_BACKEND_PORT: '4317' },
    stdio: 'inherit',
  });
}

function createWindow() {
  const state = windowStateKeeper({ defaultWidth: 1280, defaultHeight: 800 });

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    backgroundColor: '#0d1117',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.resolve(__dirname, 'preload.js'),
    },
  });
  state.manage(win);

  const devUrl = process.env.GROVE_DEV_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.resolve(__dirname, '../../frontend/dist/index.html'));
  }

  if (process.env.GROVE_DEV_URL) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

ipcMain.handle('grove:pick-folder', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose workspace folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

app.whenReady().then(() => {
  if (!process.env.GROVE_DEV_URL) startBackend();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (backend) backend.kill();
  if (process.platform !== 'darwin') app.quit();
});
