import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, session, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Custom scheme used to serve the built renderer in packaged builds. Loading
// the bundle from file:// breaks dynamic import() of code-split chunks because
// Chromium treats their fetch as a CORS request against a null origin. Serving
// from a registered standard scheme gives the renderer a normal origin so
// React.lazy chunks load.
const APP_SCHEME = 'grove';
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.setName('Grove');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const windowStateKeeper = require('electron-window-state');

let backend: ChildProcess | null = null;

function startBackend() {
  // In a packaged build the backend lives at
  // app.asar.unpacked/backend/dist (see electron-builder asarUnpack). Replace
  // the asar segment so spawn can find the real filesystem path. In dev the
  // path doesn't contain "app.asar" and the replace is a no-op.
  const raw = path.resolve(__dirname, '../../backend/dist/index.js');
  const backendEntry = raw.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  backend = spawn(process.execPath, [backendEntry], {
    // ELECTRON_RUN_AS_NODE makes the spawned Electron binary behave as a
    // plain Node runtime (skips the GUI / main script lookup).
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GROVE_BACKEND_PORT: '4317' },
    stdio: 'inherit',
  });
}

// Poll /health until fastify is listening so the renderer never observes the
// "ECONNREFUSED → 8 retries → give up" race. ~10s budget is generous; a healthy
// backend comes up in under a second.
async function waitForBackend(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:4317/health');
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error('[grove] backend /health never responded within', timeoutMs, 'ms');
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
    win.loadURL(`${APP_SCHEME}://app/index.html`);
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

// Persisted UI state — origin-independent (tabs, panels, recents).
// localStorage is keyed by origin, which differs between dev (http://) and
// packaged (file://) renderers, so state would otherwise be siloed. The
// file lives next to the other userData, atomically rewritten via tmp+rename.
const STATE_FILE = path.join(app.getPath('userData'), 'grove-state.json');

ipcMain.handle('grove:state-get', async () => {
  try { return fs.readFileSync(STATE_FILE, 'utf8'); }
  catch { return null; }
});

ipcMain.handle('grove:state-set', async (_e, content: string) => {
  if (typeof content !== 'string') return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('[grove] state-set failed', err);
  }
});

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

function registerAppProtocol() {
  // Resolve any request under grove://app/<relative> to the corresponding file
  // inside frontend/dist. Anchored to __dirname so it works the same in dev
  // (electron/dist/main.js → ../../frontend/dist) and packaged (inside asar).
  const distRoot = path.resolve(__dirname, '../../frontend/dist');
  protocol.handle(APP_SCHEME, (req) => {
    const url = new URL(req.url);
    // Strip leading slash and normalize. Reject any path that would escape
    // distRoot (e.g. via "..") so the scheme can't be coaxed into reading
    // arbitrary files.
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html';
    const resolved = path.resolve(distRoot, rel);
    if (!resolved.startsWith(distRoot + path.sep) && resolved !== distRoot) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

app.whenReady().then(async () => {
  if (!process.env.GROVE_DEV_URL) {
    startBackend();
    await waitForBackend();
  }
  registerAppProtocol();
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
