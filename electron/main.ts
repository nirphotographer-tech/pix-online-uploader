import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Notification,
  powerSaveBlocker,
} from 'electron';
import path from 'path';
import Store from 'electron-store';
import { UploadQueue, ProgressPayload, StatsPayload } from './uploadQueue';

interface StoreSchema {
  session: {
    access_token: string;
    refresh_token: string;
    user_id: string;
    email: string;
  } | null;
}

const store = new Store<StoreSchema>({
  defaults: {
    session: null,
  },
});

let mainWindow: BrowserWindow | null = null;
let powerSaveId: number | null = null;
let uploadQueue: UploadQueue | null = null;

const isDev = process.argv.includes('--dev');
const API_BASE_URL = process.env.VITE_API_BASE_URL || 'https://www.pix-online.com';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#0f0f0f',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Deep link support
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('pix-uploader', process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient('pix-uploader');
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const deepLink = commandLine.find((arg) => arg.startsWith('pix-uploader://'));
    if (deepLink) {
      handleDeepLink(deepLink);
    }
  });
}

app.on('open-url', (_event, url) => {
  handleDeepLink(url);
});

function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url);
    const action = parsed.searchParams.get('action');
    const galleryId = parsed.searchParams.get('galleryId');
    const galleryName = parsed.searchParams.get('galleryName');

    if (action === 'upload' && galleryId && mainWindow) {
      mainWindow.webContents.send('deep-link', {
        action,
        galleryId,
        galleryName: galleryName || '',
      });
    }
  } catch {
    console.error('Invalid deep link URL:', url);
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ── IPC Handlers ──

// Session persistence
ipcMain.handle('store:getSession', () => {
  return store.get('session');
});

ipcMain.handle('store:setSession', (_event, session: StoreSchema['session']) => {
  store.set('session', session);
});

ipcMain.handle('store:clearSession', () => {
  store.set('session', null);
});

// File picker
ipcMain.handle('dialog:openFiles', async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'תמונות',
        extensions: ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif', 'heic', 'heif'],
      },
    ],
  });
  return result.filePaths;
});

ipcMain.handle('dialog:openFolder', async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.filePaths;
});

// Power save blocker
ipcMain.handle('power:preventSleep', () => {
  if (powerSaveId === null) {
    powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
  }
  return powerSaveId;
});

ipcMain.handle('power:allowSleep', () => {
  if (powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
  }
});

// Notifications
ipcMain.handle('notification:show', (_event, title: string, body: string) => {
  new Notification({ title, body }).show();
});

// Upload queue
ipcMain.handle(
  'upload:start',
  async (
    _event,
    files: Array<{ path: string; name: string; size: number; type: string }>,
    galleryId: string,
    token: string
  ) => {
    if (!mainWindow) return;

    uploadQueue = new UploadQueue({
      concurrency: 4,
      apiBaseUrl: API_BASE_URL,
      token,
      galleryId,
      onProgress: (progress: ProgressPayload) => {
        mainWindow?.webContents.send('upload:progress', progress);
      },
      onFileComplete: (fileId: string, success: boolean, error?: string) => {
        mainWindow?.webContents.send('upload:fileComplete', { fileId, success, error });
      },
      onAllComplete: (stats: StatsPayload) => {
        mainWindow?.webContents.send('upload:allComplete', stats);
      },
    });

    uploadQueue.addFiles(files);
    uploadQueue.start();
  }
);

ipcMain.handle('upload:pause', () => {
  uploadQueue?.pause();
});

ipcMain.handle('upload:resume', () => {
  uploadQueue?.resume();
});

ipcMain.handle('upload:cancel', () => {
  uploadQueue?.cancel();
  uploadQueue = null;
});

// API base URL
ipcMain.handle('config:getApiBaseUrl', () => {
  return API_BASE_URL;
});
