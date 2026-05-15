import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, shell, WebContentsView, type WebContents } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { registerWorktreeHandlers } from './worktree/ipc';
import { atomicWriteFile } from './atomicWrite';

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
let mainWindow: BrowserWindow | null = null;

// Embedded browser surface for the BrowserPanel. A WebContentsView is a real
// top-level browsing context (no X-Frame-Options/CSP embedding limits) layered
// above the renderer's DOM. Kept alive across panel open/close so page state
// survives toggling; destroyed only when the window closes.
let browserView: WebContentsView | null = null;
let browserViewUrl: string | null = null;

// --- Crash/error logging ---------------------------------------------------
// "Aw Snap" renderer crashes and uncaught main-process errors leave nothing
// behind once the terminal is gone, so mirror them to a file under userData.
// Tail it with: tail -f "$(...)/grove.log".
const LOG_FILE = path.join(app.getPath('userData'), 'grove.log');

function logLine(line: string) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* logging must never throw */ }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 3 })))
    .join(' ');
}

function setupLogging() {
  // Roll the file over once it gets large so it can't grow unbounded.
  try {
    if (fs.statSync(LOG_FILE).size > 5_000_000) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch { /* file may not exist yet */ }
  logLine(`--- session start (electron ${process.versions.electron}, chrome ${process.versions.chrome}) ---`);
  console.log('[grove] logging to', LOG_FILE);

  // Mirror the main process's own console.error/.warn to the log — the
  // webContents `console-message` event only covers renderer output, not this
  // process. Originals still print to the terminal.
  for (const method of ['error', 'warn'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      logLine(`[main:${method}] ${formatArgs(args)}`);
    };
  }

  process.on('uncaughtException', (err) => {
    logLine(`[main] uncaughtException: ${err?.stack ?? String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    logLine(`[main] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  });
  // GPU / utility / pid-host subprocess crashes.
  app.on('child-process-gone', (_e, details) => {
    logLine(`[main] child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  });
}

// Mirror a webContents' console errors/warnings and crash events to the log.
function attachWebContentsLogging(wc: WebContents, label: string) {
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    // level: 0 verbose, 1 info, 2 warning, 3 error — only keep the noisy ones.
    if (level < 2) return;
    logLine(`[${label}:${level === 3 ? 'error' : 'warn'}] ${message} (${sourceId}:${line})`);
  });
  wc.on('render-process-gone', (_e, details) => {
    logLine(`[${label}] render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  wc.on('unresponsive', () => logLine(`[${label}] unresponsive`));
  wc.on('preload-error', (_e, preloadPath, error) => {
    logLine(`[${label}] preload-error (${preloadPath}): ${error?.stack ?? String(error)}`);
  });
}

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
    // GROVE_LOG_FILE tells the backend we're teeing its stdio into the log so
    // it skips its own (would-be duplicate) file logging.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GROVE_BACKEND_PORT: '4317', GROVE_LOG_FILE: LOG_FILE },
    // Pipe (not 'inherit') so backend output can be teed into the log file.
    // It's still echoed to our own stdout/stderr so the dev terminal is
    // unchanged.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tee = (stream: NodeJS.ReadableStream | null, out: NodeJS.WriteStream, tag: string) => {
    stream?.on('data', (chunk: Buffer) => {
      out.write(chunk);
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) logLine(`[backend:${tag}] ${line}`);
      }
    });
  };
  tee(backend.stdout, process.stdout, 'out');
  tee(backend.stderr, process.stderr, 'err');
  backend.on('exit', (code, signal) => logLine(`[backend] exited code=${code} signal=${signal}`));
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
  mainWindow = win;
  attachWebContentsLogging(win.webContents, 'renderer');
  win.on('closed', () => {
    if (browserView) {
      browserView.webContents.close();
      browserView = null;
      browserViewUrl = null;
    }
    if (mainWindow === win) mainWindow = null;
  });

  const devUrl = process.env.GROVE_DEV_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadURL(`${APP_SCHEME}://app/index.html`);
  }

  // DevTools no longer auto-open in dev; toggle with View → Toggle Developer
  // Tools (⌥⌘I) when you need them.
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
  atomicWriteFile(STATE_FILE, content);
});

ipcMain.handle('grove:open-external', async (_event, url: string) => {
  if (typeof url !== 'string') return;
  // Only allow http(s) to avoid file:// or other scheme abuse.
  if (!/^https?:\/\//i.test(url)) return;
  await shell.openExternal(url);
});

ipcMain.handle('grove:reveal-path', async (_e, target: string) => {
  if (typeof target !== 'string' || !target) return;
  try { shell.showItemInFolder(target); } catch { /* missing path */ }
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

// --- Embedded browser (BrowserPanel) ---------------------------------------
// The view is created lazily on first open and reused for the window's
// lifetime so page state survives panel toggling.
function ensureBrowserView(): WebContentsView {
  if (browserView) return browserView;
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const wc = view.webContents;
  attachWebContentsLogging(wc, 'browser-view');
  // Push the current address + history availability so the panel's URL bar
  // and back/forward buttons stay in sync with the real navigation state.
  const sendNav = (url: string) => {
    if (!/^https?:/i.test(url)) return;
    browserViewUrl = url;
    mainWindow?.webContents.send('grove:browser-nav', url);
    mainWindow?.webContents.send('grove:browser-navstate', {
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
  };
  wc.on('did-navigate', (_e, url) => sendNav(url));
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) sendNav(url); });
  wc.on('did-start-loading', () => mainWindow?.webContents.send('grove:browser-loading', true));
  wc.on('did-stop-loading', () => mainWindow?.webContents.send('grove:browser-loading', false));
  // errorCode -3 is ERR_ABORTED — fires on intentional navigation away, not a
  // real failure, so ignore it to avoid flashing an error page on every click.
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    mainWindow?.webContents.send('grove:browser-fail', {
      url: validatedUrl, code: errorCode, message: errorDescription,
    });
  });
  // Links that try to open a new window navigate the embedded view instead.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      browserViewUrl = url;
      wc.loadURL(url);
    }
    return { action: 'deny' };
  });
  browserView = view;
  return view;
}

ipcMain.handle('grove:browser-open', (_e, url: string) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  const view = ensureBrowserView();
  if (mainWindow && !mainWindow.contentView.children.includes(view)) {
    mainWindow.contentView.addChildView(view);
  }
  if (browserViewUrl !== url) {
    browserViewUrl = url;
    view.webContents.loadURL(url);
  }
});

ipcMain.handle('grove:browser-close', () => {
  if (browserView && mainWindow?.contentView.children.includes(browserView)) {
    mainWindow.contentView.removeChildView(browserView);
  }
});

ipcMain.handle('grove:browser-set-bounds', (_e, b: { x: number; y: number; width: number; height: number; zoom?: number } | null) => {
  if (!browserView) return;
  // A null/empty rect parks the view offscreen — used while a DOM overlay
  // (e.g. the load-error page) needs to show in the view's place.
  if (!b || b.width <= 0 || b.height <= 0) {
    browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    return;
  }
  browserView.setBounds({
    x: Math.round(b.x), y: Math.round(b.y),
    width: Math.round(b.width), height: Math.round(b.height),
  });
  // zoomFactor < 1 keeps a wider logical (CSS) viewport than the physical
  // panel — used to preserve a desktop layout in a narrow panel.
  browserView.webContents.setZoomFactor(b.zoom && b.zoom > 0 ? b.zoom : 1);
});

ipcMain.handle('grove:browser-navigate', (_e, url: string) => {
  if (!browserView || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  browserViewUrl = url;
  browserView.webContents.loadURL(url);
});

ipcMain.handle('grove:browser-reload', () => {
  browserView?.webContents.reload();
});

ipcMain.handle('grove:browser-back', () => {
  const nav = browserView?.webContents.navigationHistory;
  if (nav?.canGoBack()) nav.goBack();
});

ipcMain.handle('grove:browser-forward', () => {
  const nav = browserView?.webContents.navigationHistory;
  if (nav?.canGoForward()) nav.goForward();
});

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
  setupLogging();
  if (!process.env.GROVE_DEV_URL) {
    startBackend();
    await waitForBackend();
  }
  registerAppProtocol();
  registerWorktreeHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (backend) backend.kill();
  if (process.platform !== 'darwin') app.quit();
});
