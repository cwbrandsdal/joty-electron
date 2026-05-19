const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 39179;
const isDev = !app.isPackaged;
const DEV_URL = 'http://127.0.0.1:39173';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

let server = null;
let mainWindow = null;
let updaterConfigured = false;
let appUpdateState = {
  phase: 'unsupported',
  currentVersion: app.getVersion(),
};

function isAuthFlowUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'api.workos.com' ||
      parsed.hostname.endsWith('.authkit.app') ||
      (parsed.hostname === '127.0.0.1' && parsed.port === String(PORT))
    );
  } catch {
    return false;
  }
}

function startStaticServer(root) {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
      let filePath = path.join(root, url.pathname);

      // Directory → try index.html inside it
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      } catch {
        // file doesn't exist — SPA fallback below
      }

      // If file doesn't exist → SPA fallback to index.html
      if (!fs.existsSync(filePath)) {
        filePath = path.join(root, 'index.html');
      }

      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        });
        res.end(data);
      } catch {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });

    server.listen(PORT, '127.0.0.1', () => {
      console.log(`Static server running at http://127.0.0.1:${PORT}`);
      resolve(server);
    });
  });
}

function updateAppUpdateState(nextState) {
  appUpdateState = nextState;
  mainWindow?.webContents.send('jotly:app-update-state', appUpdateState);
}

function normalizeReleaseNotes(releaseNotes) {
  if (!releaseNotes) return undefined;
  if (typeof releaseNotes === 'string') return releaseNotes;

  const notes = releaseNotes
    .map((entry) => entry.note?.trim())
    .filter(Boolean);

  return notes.length ? notes.join('\n\n') : undefined;
}

function configureAutoUpdater() {
  if (updaterConfigured) return;
  updaterConfigured = true;

  if (!app.isPackaged) {
    updateAppUpdateState({
      phase: 'unsupported',
      currentVersion: app.getVersion(),
      error: 'App updates are only available in packaged builds.',
    });
    return;
  }

  updateAppUpdateState({
    phase: 'idle',
    currentVersion: app.getVersion(),
  });

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    updateAppUpdateState({
      phase: 'checking',
      currentVersion: app.getVersion(),
      checkedAt: new Date().toISOString(),
      error: undefined,
    });
  });

  autoUpdater.on('update-available', (info) => {
    updateAppUpdateState({
      phase: 'available',
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      releaseName: info.releaseName ?? undefined,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      checkedAt: new Date().toISOString(),
      error: undefined,
    });
  });

  autoUpdater.on('update-not-available', () => {
    updateAppUpdateState({
      phase: 'not-available',
      currentVersion: app.getVersion(),
      checkedAt: new Date().toISOString(),
      availableVersion: undefined,
      releaseName: undefined,
      releaseNotes: undefined,
      percent: undefined,
      bytesPerSecond: undefined,
      transferred: undefined,
      total: undefined,
      downloadedFile: undefined,
      error: undefined,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    updateAppUpdateState({
      ...appUpdateState,
      phase: 'downloading',
      currentVersion: app.getVersion(),
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
      error: undefined,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateAppUpdateState({
      phase: 'downloaded',
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      releaseName: info.releaseName ?? undefined,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      checkedAt: new Date().toISOString(),
      downloadedFile: info.downloadedFile,
      percent: 100,
      error: undefined,
    });
  });

  autoUpdater.on('error', (error) => {
    updateAppUpdateState({
      ...appUpdateState,
      phase: 'error',
      currentVersion: app.getVersion(),
      error: error?.message ?? String(error),
    });
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => {
      updateAppUpdateState({
        ...appUpdateState,
        phase: 'error',
        currentVersion: app.getVersion(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 3000);
}

function registerIpc() {
  ipcMain.handle('jotly:get-app-update-state', async () => appUpdateState);

  ipcMain.handle('jotly:check-for-app-updates', async () => {
    if (!app.isPackaged) {
      updateAppUpdateState({
        phase: 'unsupported',
        currentVersion: app.getVersion(),
        error: 'App updates are only available in packaged builds.',
      });
      return appUpdateState;
    }

    await autoUpdater.checkForUpdates();
    return appUpdateState;
  });

  ipcMain.handle('jotly:download-app-update', async () => {
    if (!app.isPackaged) {
      updateAppUpdateState({
        phase: 'unsupported',
        currentVersion: app.getVersion(),
        error: 'App updates are only available in packaged builds.',
      });
      return appUpdateState;
    }

    await autoUpdater.downloadUpdate();
    return appUpdateState;
  });

  ipcMain.handle('jotly:install-app-update', async () => {
    if (appUpdateState.phase !== 'downloaded') return;
    setImmediate(() => {
      autoUpdater.quitAndInstall();
    });
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Jotly',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    show: false,
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const currentUrl = mainWindow.webContents.getURL();
    const isSpawnedFromAuthFlow = isAuthFlowUrl(currentUrl);

    if (isAuthFlowUrl(url) || isSpawnedFromAuthFlow) {
      mainWindow.loadURL(url);
    } else if (url.startsWith('http')) {
      shell.openExternal(url);
    }

    return { action: 'deny' };
  });

  // Show window when content is ready (avoids white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools();
  } else {
    const rendererPath = path.join(app.getAppPath(), 'dist', 'renderer');
    await startStaticServer(rendererPath);
    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  }

  registerIpc();
  configureAutoUpdater();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (server) server.close();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
