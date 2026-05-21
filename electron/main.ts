import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Notification,
  powerSaveBlocker,
} from 'electron';
import path from 'path';
import fs from 'fs';
import Store from 'electron-store';
import { UploadManager, UploadSessionInfo } from './uploadManager';
import {
  saveSession,
  markFileCompleted,
  removeSession as removePersistSession,
  loadPendingSessions,
  getRemainingFiles,
  clearAllSessions,
  PersistedFile,
} from './uploadPersistence';

// File-based logging for debugging
const LOG_FILE = path.join(require("os").homedir(), "pix-uploader-debug.log");
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
function fileLog(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}
console.log = (...args: unknown[]) => { origLog(...args); fileLog("LOG:", ...args); };
console.error = (...args: unknown[]) => { origErr(...args); fileLog("ERR:", ...args); };
console.warn = (...args: unknown[]) => { origWarn(...args); fileLog("WARN:", ...args); };
fileLog("=== PIX UPLOADER STARTED ===");

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif', '.heic', '.heif'];

function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

function getFileInfo(filePath: string): { path: string; name: string; size: number; type: string } {
  const stat = fs.statSync(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', tiff: 'image/tiff', tif: 'image/tiff',
    heic: 'image/heic', heif: 'image/heif',
  };
  return { path: filePath, name, size: stat.size, type: mimeMap[ext] || 'image/jpeg' };
}

function scanFolderForImages(dirPath: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanFolderForImages(fullPath));
      } else if (entry.isFile() && isImageFile(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch (err) {
    console.error('Error scanning folder:', dirPath, err);
  }
  return results;
}

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
let uploadManager: UploadManager | null = null;
let pendingDeepLinkUrl: string | null = null;

// Token refresh: renderer sends fresh tokens here when requested
let tokenRefreshResolve: ((token: string) => void) | null = null;

function requestFreshToken(): Promise<string> {
  return new Promise((resolve) => {
    tokenRefreshResolve = resolve;
    // Ask the renderer to refresh the token via Supabase
    mainWindow?.webContents.send('auth:refreshTokenRequest');
    // Timeout after 10s
    setTimeout(() => {
      if (tokenRefreshResolve === resolve) {
        tokenRefreshResolve = null;
        resolve(''); // empty = refresh failed
      }
    }, 10000);
  });
}

// Token refresh: renderer sends fresh tokens here when requested

const isDev = process.argv.includes('--dev');
const API_BASE_URL = process.env.VITE_API_BASE_URL || 'https://www.pix-online.com';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://hxiwmsglhwvlcclwzzod.supabase.co';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh4aXdtc2dsaHd2bGNjbHd6em9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ3MDAyOTAsImV4cCI6MjA4MDI3NjI5MH0.MjtgrJ3H-zGLdr5Xu722eJG2nYE_O_b44s4WhYa5KDk';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#0f0f0f',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    icon: path.join(__dirname, 'icon.icns'),
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

  // Capture renderer errors for debugging
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    fileLog(`[RENDERER] did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    fileLog(`[RENDERER] render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) { // warn/error only
      fileLog(`[RENDERER CONSOLE] level=${level} line=${line} src=${sourceId}: ${message}`);
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    fileLog('[RENDERER] did-finish-load ✓');
  });
  mainWindow.webContents.on('dom-ready', () => {
    fileLog('[RENDERER] dom-ready ✓');
  });

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

function sendDeepLinkPayload(url: string): void {
  try {
    const parsed = new URL(url);
    const action = parsed.hostname || parsed.searchParams.get('action');
    const galleryId = parsed.searchParams.get('galleryId');
    const galleryName = parsed.searchParams.get('galleryName');
    const folderId = parsed.searchParams.get('folderId');
    const folderName = parsed.searchParams.get('folderName');

    if (action === 'upload' && galleryId && mainWindow) {
      mainWindow.webContents.send('deep-link', {
        action,
        galleryId,
        galleryName: galleryName || '',
        folderId: folderId || '',
        folderName: folderName || '',
      });
    }
  } catch {
    console.error('Invalid deep link URL:', url);
  }
}

function handleDeepLink(url: string): void {
  if (mainWindow && mainWindow.webContents) {
    // Window exists — send immediately
    sendDeepLinkPayload(url);
  } else {
    // Window not ready yet (cold start) — queue it
    pendingDeepLinkUrl = url;
  }
}

app.whenReady().then(() => {
  createWindow();

  // If a deep link arrived before the window was ready, send it now
  if (pendingDeepLinkUrl && mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
      if (pendingDeepLinkUrl) {
        sendDeepLinkPayload(pendingDeepLinkUrl);
        pendingDeepLinkUrl = null;
      }
    });
  }

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
  return result.filePaths.map(getFileInfo);
});

ipcMain.handle('dialog:openFolder', async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.filePaths.length === 0) return [];
  const imagePaths = scanFolderForImages(result.filePaths[0]);
  return imagePaths.map(getFileInfo);
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

// Upload Manager (multi-session)
function getUploadManager(): UploadManager {
  if (!uploadManager) {
    uploadManager = new UploadManager({
      apiBaseUrl: API_BASE_URL,
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_ANON_KEY,
      concurrency: 3,
      tokenRefresher: requestFreshToken,
      onSessionUpdate: (session: UploadSessionInfo) => {
        mainWindow?.webContents.send('upload:sessionUpdate', session);
      },
      onSessionComplete: (session: UploadSessionInfo) => {
        mainWindow?.webContents.send('upload:sessionComplete', session);
        // Remove from persistence — session finished
        removePersistSession(session.sessionId);
        // Show notification
        const msg = session.errorMessage
          ? session.errorMessage
          : session.failedFiles > 0
            ? `${session.completedFiles} מתוך ${session.totalFiles} תמונות הועלו בהצלחה`
            : `${session.completedFiles} תמונות הועלו בהצלחה`;
        new Notification({
          title: session.errorMessage ? 'חריגה ממכסת אחסון' : `${session.galleryName} – ההעלאה הסתיימה`,
          body: msg,
        }).show();
      },
      onAllSessionsComplete: () => {
        mainWindow?.webContents.send('upload:allSessionsComplete');
        // Allow sleep when all sessions are done
        if (powerSaveId !== null) {
          powerSaveBlocker.stop(powerSaveId);
          powerSaveId = null;
        }
      },
    });
  }
  return uploadManager;
}

ipcMain.handle(
  'upload:startSession',
  async (
    _event,
    sessionId: string,
    files: Array<{ path: string; name: string; size: number; type: string }>,
    galleryId: string,
    galleryName: string,
    folderId: string,
    folderName: string,
    token: string
  ) => {
    // Prevent sleep while uploading
    if (powerSaveId === null) {
      powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
    }

    // Resolve file sizes from disk if missing
    const resolvedFiles = files.map((f) => {
      if (!f.size || f.size === 0) {
        try {
          const stat = fs.statSync(f.path);
          return { ...f, size: stat.size };
        } catch {
          console.error(`[Upload] Cannot stat file: ${f.path}`);
          return f;
        }
      }
      return f;
    });

    const manager = getUploadManager();
    manager.startSession(
      sessionId,
      resolvedFiles,
      galleryId,
      galleryName,
      folderId,
      folderName,
      token,
      // per-file completion callback for persistence
      (fileName: string) => markFileCompleted(sessionId, fileName)
    );

    // Persist session to disk so it can be resumed after restart
    saveSession(sessionId, galleryId, galleryName, folderId, folderName, resolvedFiles as PersistedFile[]);
  }
);

ipcMain.handle('upload:cancelSession', (_event, sessionId: string) => {
  uploadManager?.cancelSession(sessionId);
  // Remove from persistence — user explicitly stopped this upload
  removePersistSession(sessionId);
});

ipcMain.handle('upload:dismissSession', (_event, sessionId: string) => {
  uploadManager?.dismissSession(sessionId);
});

ipcMain.handle('upload:getSessions', () => {
  return uploadManager?.getAllSessions() || [];
});

ipcMain.handle('upload:hasActiveSessions', () => {
  return uploadManager?.hasActiveSessions() || false;
});

// API base URL
ipcMain.handle('config:getApiBaseUrl', () => {
  return API_BASE_URL;
});

// Token refresh IPC
ipcMain.on('auth:freshToken', (_event, token: string) => {
  if (tokenRefreshResolve) {
    tokenRefreshResolve(token);
    tokenRefreshResolve = null;
  }
});

// Token refresh IPC

// Duplicate check: query existing photos in gallery by file_name + size_bytes
ipcMain.handle(
  'gallery:checkDuplicates',
  async (
    _event,
    galleryId: string,
    folderId: string,
    fileNames: string[],
    token: string
  ): Promise<{ file_name: string; id: string; size_bytes: number | null }[]> => {
    try {
      if (fileNames.length === 0) return [];

      // Build filter: gallery_id + file_name in list
      // Supabase REST API supports `in` operator
      const namesParam = `(${fileNames.map((n) => `"${n}"`).join(',')})`;
      let url = `${SUPABASE_URL}/rest/v1/gallery_photos?gallery_id=eq.${galleryId}&file_name=in.${encodeURIComponent(namesParam)}&select=id,file_name,size_bytes`;

      // Add folder filter if not the default "full gallery" folder
      if (folderId) {
        url += `&folder_id=eq.${folderId}`;
      }

      const res = await fetch(url, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        console.warn(`[DupCheck] HTTP ${res.status}: ${await res.text()}`);
        return []; // On error, allow upload (don't block)
      }

      const rows = (await res.json()) as { id: string; file_name: string; size_bytes: number | null }[];
      console.log(`[DupCheck] Found ${rows.length} existing photos matching ${fileNames.length} file names`);
      return rows;
    } catch (err) {
      console.warn('[DupCheck] Error:', err);
      return []; // On error, allow upload
    }
  }
);

// ── Pending sessions IPC (resume after restart) ──

ipcMain.handle('upload:getPendingSessions', () => {
  return loadPendingSessions();
});

ipcMain.handle('upload:dismissPendingSession', (_event, sessionId: string) => {
  removePersistSession(sessionId);
});

ipcMain.handle('upload:clearPendingSessions', () => {
  clearAllSessions();
});

ipcMain.handle(
  'upload:resumePendingSession',
  async (
    _event,
    sessionId: string,
    token: string
  ) => {
    const remaining = getRemainingFiles(sessionId);
    if (remaining.length === 0) {
      removePersistSession(sessionId);
      return { resumed: false, reason: 'no_remaining_files' };
    }

    // Check which files still exist on disk
    const existingFiles = remaining.filter((f) => {
      try { fs.statSync(f.path); return true; } catch { return false; }
    });

    if (existingFiles.length === 0) {
      removePersistSession(sessionId);
      return { resumed: false, reason: 'files_not_found' };
    }

    // Prevent sleep while uploading
    if (powerSaveId === null) {
      powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
    }

    const manager = getUploadManager();

    // Get gallery/folder info from persisted session first (needed for duplicate check)
    const sessions = loadPendingSessions();
    const persisted = sessions.find((s) => s.sessionId === sessionId);
    if (!persisted) return { resumed: false, reason: 'session_not_found' };

    // ⚠️ Anti-double-upload guard: if the same folder is already uploading in
    // memory (e.g. this was triggered by the 'online' event while retries are
    // still running), skip — the in-memory queue will recover on its own now
    // that the network is back (waitForNetwork in uploadQueue).
    const activeSessions = manager.getAllSessions();
    const folderAlreadyActive = activeSessions.some(
      (s) => s.folderId === persisted.folderId &&
              s.galleryId === persisted.galleryId &&
              s.status === 'uploading'
    );
    if (folderAlreadyActive) {
      console.log(`[Resume] Skipping resume for ${sessionId} — folder ${persisted.folderId} already uploading in memory`);
      return { resumed: false, reason: 'already_running' };
    }

    // Use a new session ID so it shows as a fresh session in the UI
    const newSessionId = `resume-${Date.now()}`;

    const alreadyCompleted = persisted.completedFileNames.length;
    const originalTotal = persisted.totalFiles;

    manager.startSession(
      newSessionId,
      existingFiles,
      persisted.galleryId,
      persisted.galleryName,
      persisted.folderId,
      persisted.folderName,
      token,
      (fileName: string) => markFileCompleted(newSessionId, fileName),
      alreadyCompleted,
      originalTotal
    );

    // Save new session, remove old one
    saveSession(newSessionId, persisted.galleryId, persisted.galleryName, persisted.folderId, persisted.folderName, existingFiles as PersistedFile[]);
    removePersistSession(sessionId);

    console.log(`[Resume] Resumed session ${sessionId} → ${newSessionId} with ${existingFiles.length} files`);
    return { resumed: true, newSessionId, remainingCount: existingFiles.length };
  }
);
