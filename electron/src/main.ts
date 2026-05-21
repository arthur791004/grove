import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  net,
  Notification,
  protocol,
  shell,
  WebContentsView,
  type WebContents,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { registerWorktreeHandlers } from './worktree/ipc';
import { atomicWriteFile } from './atomicWrite';
import { ensureDaemon, shutdownDaemon } from './daemon';
import { startCdpProxy, type CdpProxyHandle } from './cdpProxy';
import { writePlaywrightMcpConfig, deleteMcpConfig, pruneStaleMcpConfigs } from './mcpConfig';

// Custom scheme used to serve the built renderer in packaged builds. Loading
// the bundle from file:// breaks dynamic import() of code-split chunks because
// Chromium treats their fetch as a CORS request against a null origin. Serving
// from a registered standard scheme gives the renderer a normal origin so
// React.lazy chunks load.
const APP_SCHEME = 'grove';
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

app.setName('Grove');

// Expose Chromium's CDP endpoint so Playwright MCP (and other CDP clients)
// can drive the embedded browser panel. Must be set before app.whenReady().
// Port is `GROVE_CDP_PORT` env var or 9222 (Chrome's default). Conflicts with
// VS Code's JS debugger and other Electron apps using the same port.
const CDP_PORT = (() => {
  const raw = Number(process.env.GROVE_CDP_PORT);
  return Number.isFinite(raw) && raw > 0 ? raw : 9222;
})();
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const windowStateKeeper = require('electron-window-state');

let mainWindow: BrowserWindow | null = null;
let attentionPending = false;

// Embedded browser surface for the BrowserPanel. A WebContentsView is a real
// top-level browsing context (no X-Frame-Options/CSP embedding limits) layered
// above the renderer's DOM. Kept alive across panel open/close so page state
// survives toggling; destroyed only when the window closes.
let browserView: WebContentsView | null = null;
let browserViewUrl: string | null = null;

// Lazy-started filtering proxy in front of the raw CDP port. See cdpProxy.ts.
// The proxy itself binds on a fresh ephemeral port each launch; nothing
// persisted.
let cdpProxy: CdpProxyHandle | null = null;

// --- Crash/error logging ---------------------------------------------------
// "Aw Snap" renderer crashes and uncaught main-process errors leave nothing
// behind once the terminal is gone, so mirror them to a file under userData.
// Tail it with: tail -f "$(...)/grove.log".
const LOG_FILE = path.join(app.getPath('userData'), 'grove.log');

function logLine(line: string) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never throw */
  }
}

function formatArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 3 }))).join(' ');
}

function setupLogging() {
  // Roll the file over once it gets large so it can't grow unbounded.
  try {
    if (fs.statSync(LOG_FILE).size > 5_000_000) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch {
    /* file may not exist yet */
  }
  logLine(
    `--- session start (electron ${process.versions.electron}, chrome ${process.versions.chrome}) ---`,
  );
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
    logLine(
      `[main] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`,
    );
  });
  // GPU / utility / pid-host subprocess crashes.
  app.on('child-process-gone', (_e, details) => {
    logLine(
      `[main] child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`,
    );
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
    logLine(
      `[${label}] render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`,
    );
  });
  wc.on('unresponsive', () => logLine(`[${label}] unresponsive`));
  wc.on('preload-error', (_e, preloadPath, error) => {
    logLine(`[${label}] preload-error (${preloadPath}): ${error?.stack ?? String(error)}`);
  });
}

// Backend lifecycle now lives in ./daemon.ts. Electron connects to a persistent
// daemon on 127.0.0.1:4317 instead of spawning it as a child — see the Grove
// Daemon Persistence design doc.

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
    try {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    } catch {}
  }
  state.manage(win);
  mainWindow = win;
  attachWebContentsLogging(win.webContents, 'renderer');
  win.on('focus', () => {
    if (!attentionPending) return;
    attentionPending = false;
    app.dock?.setBadge('');
  });
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
  try {
    return fs.readFileSync(STATE_FILE, 'utf8');
  } catch {
    return null;
  }
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
  try {
    shell.showItemInFolder(target);
  } catch {
    /* missing path */
  }
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
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) sendNav(url);
  });
  wc.on('did-start-loading', () => mainWindow?.webContents.send('grove:browser-loading', true));
  wc.on('did-stop-loading', () => mainWindow?.webContents.send('grove:browser-loading', false));
  // errorCode -3 is ERR_ABORTED — fires on intentional navigation away, not a
  // real failure, so ignore it to avoid flashing an error page on every click.
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    mainWindow?.webContents.send('grove:browser-fail', {
      url: validatedUrl,
      code: errorCode,
      message: errorDescription,
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

ipcMain.handle(
  'grove:browser-set-bounds',
  (_e, b: { x: number; y: number; width: number; height: number; zoom?: number } | null) => {
    if (!browserView) return;
    // A null/empty rect parks the view offscreen — used while a DOM overlay
    // (e.g. the load-error page) needs to show in the view's place.
    if (!b || b.width <= 0 || b.height <= 0) {
      browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    browserView.setBounds({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
    });
    // zoomFactor < 1 keeps a wider logical (CSS) viewport than the physical
    // panel — used to preserve a desktop layout in a narrow panel.
    browserView.webContents.setZoomFactor(b.zoom && b.zoom > 0 ? b.zoom : 1);
  },
);

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

// --- Playwright MCP wiring -------------------------------------------------
// Resolves the CDP target id of the active browser panel by matching its
// current URL against /json. Fragile if two targets share a URL — fine for
// v1 where Grove has a single browser panel.
async function resolveActiveTargetId(): Promise<string | null> {
  if (!browserView) return null;
  const url = browserView.webContents.getURL();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    if (!res.ok) return null;
    const targets = (await res.json()) as Array<{ id: string; type: string; url: string }>;
    const match = targets.find((t) => t.type === 'page' && t.url === url);
    return match?.id ?? null;
  } catch (err) {
    logLine(`[grove] resolveActiveTargetId failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// Lazy-starts the filtering proxy on first use; subsequent calls reuse it.
// Tear-down happens at before-quit alongside the daemon.
async function ensureCdpProxy(): Promise<number | null> {
  if (cdpProxy) return cdpProxy.port;
  try {
    cdpProxy = await startCdpProxy({
      realPort: CDP_PORT,
      getActiveTargetId: resolveActiveTargetId,
    });
    logLine(`[grove] cdp proxy listening on 127.0.0.1:${cdpProxy.port}`);
    return cdpProxy.port;
  } catch (err) {
    logLine(`[grove] cdp proxy failed to start: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// Called by a Claude-mode tab before spawning `claude` so its `--mcp-config`
// flag has a file to point at. Returns null — and the caller falls back to
// plain `claude` — when there's no browser panel on a page to wire up.
ipcMain.handle('mcp:writePlaywrightConfig', async (_e, tabId: string) => {
  if (typeof tabId !== 'string' || !tabId) return null;
  const [targetId, proxyPort] = await Promise.all([resolveActiveTargetId(), ensureCdpProxy()]);
  if (!targetId || !proxyPort) return null;
  try {
    return writePlaywrightMcpConfig(tabId, {
      cdpEndpoint: `http://127.0.0.1:${proxyPort}`,
    });
  } catch (err) {
    logLine(
      `[grove] mcp:writePlaywrightConfig failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
});

ipcMain.handle('mcp:deleteConfig', (_e, tabId: string) => {
  if (typeof tabId === 'string' && tabId) deleteMcpConfig(tabId);
});

// app.dock is undefined off-darwin, so this is a no-op on Win/Linux.
// `attentionPending` coalesces bursts: one bounce per away-period, not one per command.
ipcMain.handle('grove:notify-attention', () => {
  if (mainWindow?.isFocused() || attentionPending) return;
  attentionPending = true;
  app.dock?.setBadge('•');
  app.dock?.bounce('informational');
});

// Native notifications are held until dismissed/clicked — without a reference
// the OS notification can be GC'd before the user interacts with it.
const liveNotifications = new Set<Notification>();

interface BlockedNotice {
  tabId: string;
  title: string;
  workspace: string;
  question: string;
  choices: Array<{ label: string; send: string }>;
}

// Raised when a Claude tab the user isn't looking at hits a permission /
// yes-no / multiple-choice prompt. Each choice becomes a notification action
// button; clicking one routes the answer straight back to that tab's pty,
// clicking the body just brings the tab forward.
ipcMain.handle('grove:notify-blocked', (_e, notice: BlockedNotice) => {
  if (!Notification.isSupported() || !notice || typeof notice.tabId !== 'string') return;
  const choices = Array.isArray(notice.choices) ? notice.choices.slice(0, 6) : [];
  const n = new Notification({
    title: notice.title || 'Claude needs your input',
    subtitle: notice.workspace || undefined,
    body: notice.question || 'Claude is waiting for your response.',
    actions: choices.map((c) => ({ type: 'button', text: c.label })),
  });
  liveNotifications.add(n);
  n.on('close', () => liveNotifications.delete(n));
  n.on('action', (_ev, index) => {
    const choice = choices[index];
    if (choice) {
      mainWindow?.webContents.send('grove:notification-respond', {
        tabId: notice.tabId,
        send: choice.send,
      });
    }
  });
  n.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    mainWindow?.webContents.send('grove:notification-respond', {
      tabId: notice.tabId,
      send: null,
    });
  });
  n.show();
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
  pruneStaleMcpConfigs();
  if (!process.env.GROVE_DEV_URL) {
    try {
      await ensureDaemon();
    } catch (err) {
      logLine(`[grove] ensureDaemon failed: ${err instanceof Error ? err.stack : String(err)}`);
      dialog.showErrorBox(
        'Grove daemon failed to start',
        `${err instanceof Error ? err.message : String(err)}\n\nSee ~/.grove/daemon.log for details.`,
      );
      app.exit(1);
      return;
    }
  }
  registerAppProtocol();
  registerWorktreeHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Window-all-closed: on macOS the app stays in the dock and the daemon keeps
// running — closing a window is "I'll be back". On other platforms we follow
// the conventional "close = quit" model, which fires before-quit below.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// before-quit fires on ⌘Q / File → Quit / app.quit(). This is the only place
// we tear the daemon down — survives window close, dies with the app.
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  if (process.env.GROVE_DEV_URL) return; // dev runs its own backend
  event.preventDefault();
  quitting = true;
  Promise.all([
    shutdownDaemon().catch((err) =>
      logLine(`[grove] shutdownDaemon failed: ${err instanceof Error ? err.stack : String(err)}`),
    ),
    cdpProxy
      ?.close()
      .catch((err) =>
        logLine(`[grove] cdp proxy close failed: ${err instanceof Error ? err.message : err}`),
      ),
  ]).finally(() => app.exit(0));
});
