import { app, BrowserWindow, dialog, ipcMain, nativeImage, session, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

app.setName('Grove');
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

  const iconPath = path.resolve(__dirname, '../assets/icon.png');
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    backgroundColor: '#0d1117',
    titleBarStyle: 'hiddenInset',
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: path.resolve(__dirname, 'preload.js'),
    },
  });
  // Replace the default Electron dock icon with our app icon in dev too.
  if (app.dock && nativeImage) {
    try { app.dock.setIcon(nativeImage.createFromPath(iconPath)); } catch {}
  }
  state.manage(win);

  const devUrl = process.env.GROVE_DEV_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.resolve(__dirname, '../../frontend/dist/index.html'));
  }

  // DevTools no longer auto-open in dev; toggle with View → Toggle Developer
  // Tools (⌥⌘I) when you need them.

  // Forward sub-frame navigations (e.g. the BrowserPanel iframe) to the
  // renderer so its address bar can reflect the real URL after links inside
  // the embedded page are clicked. Same-origin policy blocks reading this
  // from the renderer side.
  const sendFrameNav = (url: string, isMain: boolean) => {
    if (isMain) return;
    if (!/^https?:/i.test(url)) return;
    win.webContents.send('grove:frame-nav', url);
  };
  win.webContents.on('did-frame-navigate', (_e, url, _httpResponseCode, _httpStatusText, isMainFrame) => {
    sendFrameNav(url, isMainFrame);
  });
  win.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    sendFrameNav(url, isMainFrame);
  });
  // Surface sub-frame load failures (server down, DNS error, refused, etc.)
  // so the renderer can show a Chrome-style error page instead of a blank
  // iframe. errorCode -3 is "aborted" which fires on intentional navigation
  // away — ignore so we don't flash an error on every link click.
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame) return;
    if (errorCode === -3) return;
    if (!/^https?:/i.test(validatedUrl)) return;
    win.webContents.send('grove:frame-fail', { url: validatedUrl, code: errorCode, message: errorDescription });
  });
  win.webContents.on('did-frame-finish-load', (_e, isMainFrame) => {
    if (isMainFrame) return;
    win.webContents.send('grove:frame-loaded');
  });
}

ipcMain.handle('grove:open-external', async (_event, url: string) => {
  if (typeof url !== 'string') return;
  // Only allow http(s) to avoid file:// or other scheme abuse.
  if (!/^https?:\/\//i.test(url)) return;
  await shell.openExternal(url);
});

ipcMain.handle('grove:pick-folder', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose workspace folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Strip framing-prevention headers from localhost responses so the Browser
// panel can iframe-embed dev servers that ship X-Frame-Options: SAMEORIGIN
// (Calypso, Rails, etc.). We only touch hosts on private/loopback addresses
// so public sites keep their original protection.
function stripFramingHeadersForLocalhost() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    try {
      const u = new URL(details.url);
      const host = u.hostname;
      const isLocal =
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host.startsWith('192.168.') ||
        host.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host);
      if (!isLocal) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      const headers: Record<string, string | string[]> = { ...(details.responseHeaders ?? {}) };
      for (const key of Object.keys(headers)) {
        const k = key.toLowerCase();
        if (k === 'x-frame-options') {
          delete headers[key];
        } else if (k === 'content-security-policy') {
          const v = headers[key];
          const list = Array.isArray(v) ? v : [v];
          // Drop frame-ancestors directives but keep the rest of the CSP intact.
          headers[key] = list.map((s) =>
            s.split(';').filter((d) => !d.trim().toLowerCase().startsWith('frame-ancestors')).join(';'),
          );
        }
      }
      callback({ responseHeaders: headers });
    } catch {
      callback({ responseHeaders: details.responseHeaders });
    }
  });
}

app.whenReady().then(() => {
  if (!process.env.GROVE_DEV_URL) startBackend();
  stripFramingHeadersForLocalhost();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (backend) backend.kill();
  if (process.platform !== 'darwin') app.quit();
});
