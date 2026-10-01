import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Notification,
  powerSaveBlocker,
  powerMonitor,
} from 'electron';
import path from 'path';
import fs from 'fs';
import Store from 'electron-store';
import { UploadManager, UploadSessionInfo } from './uploadManager';
import {
  saveSession,
  markFileSettled,
  removeSession as removePersistSession,
  loadPendingSessions,
  getRemainingFiles,
  getSession as getPersistedSession,
  clearAllSessions,
  flushPersistence,
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

/** Like getFileInfo, but drops files that vanished or can't be read */
function getFileInfos(filePaths: string[]): ReturnType<typeof getFileInfo>[] {
  const result: ReturnType<typeof getFileInfo>[] = [];
  for (const p of filePaths) {
    try {
      const info = getFileInfo(p);
      if (info.size > 0) result.push(info);
    } catch (err) {
      console.warn('[Files] Cannot stat file, skipping:', p, err);
    }
  }
  return result;
}

/**
 * Hidden entries are never photos: macOS writes "._DSC0001.jpg" AppleDouble
 * files next to every photo on exFAT/FAT memory cards and external drives, and
 * they carry the .jpg extension.
 */
function isHiddenEntry(name: string): boolean {
  return name.startsWith('.') || name === '__MACOSX' || name === '$RECYCLE.BIN' || name === 'System Volume Information';
}

function scanFolderForImages(dirPath: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (isHiddenEntry(entry.name)) continue;
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

// ── Auth token ──
// The renderer owns the Supabase session and pushes every new access token
// here (login, auto-refresh, restore). Upload queues always read the newest
// one, so a long upload never keeps using an expired token.
let accessToken = '';
let refreshInFlight: Promise<string> | null = null;
let refreshResolve: ((token: string) => void) | null = null;

function setAccessToken(token: string): void {
  if (token) accessToken = token;
}

/**
 * Ask the renderer to refresh the session. Concurrent callers (several upload
 * sessions hitting 401 together) share one request — previously each call
 * replaced the last one's resolver, so all but one waited 10s and gave up.
 */
function requestFreshToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve('');
  refreshInFlight = new Promise<string>((resolve) => {
    const timer = setTimeout(() => finish(''), 20_000);
    function finish(token: string) {
      clearTimeout(timer);
      refreshResolve = null;
      refreshInFlight = null;
      setAccessToken(token);
      resolve(token);
    }
    refreshResolve = finish;
    mainWindow!.webContents.send('auth:refreshTokenRequest');
  });
  return refreshInFlight;
}

const isDev = process.argv.includes('--dev');
const API_BASE_URL = process.env.VITE_API_BASE_URL || 'https://www.pix-online.com';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://hxiwmsglhwvlcclwzzod.supabase.co';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh4aXdtc2dsaHd2bGNjbHd6em9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ3MDAyOTAsImV4cCI6MjA4MDI3NjI5MH0.MjtgrJ3H-zGLdr5Xu722eJG2nYE_O_b44s4WhYa5KDk';

function createWindow(): void {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#0f0f0f',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 15, y: 10 } } : {}),
    icon: path.join(__dirname, isMac ? 'icon.icns' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
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
  mainWindow.webContents.on('console-message', (_event, level, message, line, _sourceId) => {
    if (level >= 1) { // info/warn/error (excludes verbose)
      fileLog(`[RENDERER] level=${level} line=${line}: ${message}`);
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    fileLog('[RENDERER] did-finish-load ✓');
  });
  mainWindow.webContents.on('dom-ready', () => {
    fileLog('[RENDERER] dom-ready ✓');
  });

  // Closing the window mid-upload must not silently kill the upload
  mainWindow.on('close', (event) => {
    if (isQuitting || !uploadManager?.hasActiveSessions()) return;
    if (process.platform === 'darwin') {
      // macOS convention: the app keeps running; uploads continue in the background
      event.preventDefault();
      mainWindow?.hide();
      return;
    }
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['המשך להעלות ברקע', 'עצור וסגור'],
      defaultId: 0,
      cancelId: 0,
      title: 'יש העלאה פעילה',
      message: 'יש העלאה פעילה',
      detail: 'אם תסגרו עכשיו ההעלאה תיעצר, ותמשיך אוטומטית בפעם הבאה שתפתחו את התוכנה.',
    });
    if (choice === 0) {
      event.preventDefault();
      mainWindow?.minimize();
    } else {
      isQuitting = true;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

let isQuitting = false;

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
    if (mainWindow) showMainWindow();
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
    showMainWindow();
  });

  // Lid closed / computer asleep: requests in flight hang until their timeout.
  // On wake, restart them right away and refresh the (likely expired) token.
  powerMonitor.on('suspend', () => console.log('[Power] 💤 System suspending'));
  powerMonitor.on('resume', () => {
    console.log('[Power] ☀️ System resumed');
    if (uploadManager?.hasActiveSessions()) {
      requestFreshToken().finally(() => uploadManager?.onSystemResume());
    }
  });
  // Shutdown / restart must not be blocked by the "upload in progress" prompt
  powerMonitor.on('shutdown', () => {
    isQuitting = true;
    flushPersistence();
  });
});

app.on('before-quit', (event) => {
  if (!isQuitting && uploadManager?.hasActiveSessions()) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['המשך להעלות', 'עצור וצא'],
      defaultId: 0,
      cancelId: 0,
      message: 'יש העלאה פעילה',
      detail: 'אם תצאו עכשיו ההעלאה תיעצר, ותמשיך אוטומטית בפעם הבאה שתפתחו את התוכנה.',
    });
    if (choice === 0) {
      event.preventDefault();
      return;
    }
  }
  isQuitting = true;
  flushPersistence();
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
  return getFileInfos(result.filePaths);
});

ipcMain.handle('dialog:openFolder', async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.filePaths.length === 0) return [];
  return getFileInfos(scanFolderForImages(result.filePaths[0]));
});

ipcMain.handle('dialog:resolveDroppedFiles', (_event, filePaths: string[]) => {
  fileLog(`[DROP-IPC] resolveDroppedFiles called with ${filePaths.length} paths:`, filePaths);
  const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif', '.heic', '.heif']);
  const resolved: string[] = [];
  for (const p of filePaths) {
    try {
      const stat = fs.statSync(p);
      fileLog(`[DROP-IPC] path=${p} isDir=${stat.isDirectory()} ext=${path.extname(p).toLowerCase()}`);
      if (stat.isDirectory()) {
        const found = scanFolderForImages(p);
        fileLog(`[DROP-IPC] folder scan found ${found.length} images in ${p}`);
        resolved.push(...found);
      } else if (imageExts.has(path.extname(p).toLowerCase()) && !isHiddenEntry(path.basename(p))) {
        resolved.push(p);
      } else {
        fileLog(`[DROP-IPC] skipped (not image, not dir): ${p}`);
      }
    } catch (err) {
      fileLog(`[DROP-IPC] statSync failed for ${p}:`, err);
    }
  }
  fileLog(`[DROP-IPC] returning ${resolved.length} files`);
  return getFileInfos(resolved);
});

// Write dropped files (received as ArrayBuffer when file.path is unavailable) to OS temp dir
const os = require('os');
ipcMain.handle('dialog:writeFilesToTemp', async (_event, files: Array<{ name: string; buffer: ArrayBuffer }>) => {
  const tmpDir = path.join(os.tmpdir(), 'pix-uploader-drop');
  fs.mkdirSync(tmpDir, { recursive: true });
  fileLog(`[DROP-TMP] writing ${files.length} files to ${tmpDir}`);
  const results: ReturnType<typeof getFileInfo>[] = [];
  for (const file of files) {
    const safeName = `${Date.now()}-${path.basename(file.name)}`;
    const tmpPath = path.join(tmpDir, safeName);
    fs.writeFileSync(tmpPath, Buffer.from(file.buffer));
    const info = getFileInfo(tmpPath);
    info.name = file.name; // preserve original filename for display/dedup
    fileLog(`[DROP-TMP] wrote ${file.name} → ${tmpPath} (${info.size} bytes)`);
    results.push(info);
  }
  return results;
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
      // Shared by all folders uploading at once. Saving no longer runs sharp on
      // the server (instantSave), so it doesn't need the old 2-at-a-time limit.
      concurrency: 6,
      maxParallelSaves: 4,
      getToken: () => accessToken,
      refreshToken: requestFreshToken,
      onFileSettled: (sessionId, filePath, outcome) => markFileSettled(sessionId, filePath, outcome),
      onSessionUpdate: (session: UploadSessionInfo) => {
        mainWindow?.webContents.send('upload:sessionUpdate', session);
      },
      onSessionComplete: (session: UploadSessionInfo) => {
        mainWindow?.webContents.send('upload:sessionComplete', session);
        // Keep the session on disk only if some files can still be retried
        if (getRemainingFiles(session.sessionId).length === 0) {
          removePersistSession(session.sessionId);
        } else {
          flushPersistence();
        }
        const msg = session.errorMessage
          ? session.errorMessage
          : session.failedFiles > 0
            ? `${session.completedFiles} מתוך ${session.totalFiles} תמונות הועלו בהצלחה`
            : `${session.completedFiles} תמונות הועלו בהצלחה`;
        new Notification({
          title: session.errorMessage ? 'ההעלאה נעצרה' : `${session.galleryName} – ההעלאה הסתיימה`,
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

function preventSleep(): void {
  if (powerSaveId === null) {
    powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
  }
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
    setAccessToken(token);
    preventSleep();

    // Resolve file sizes from disk if missing
    const resolvedFiles = files.map((f) => {
      if (!f.size || f.size === 0) {
        try {
          return { ...f, size: fs.statSync(f.path).size };
        } catch {
          console.error(`[Upload] Cannot stat file: ${f.path}`);
        }
      }
      return f;
    });

    // Persist first, so even an immediate crash can be resumed
    saveSession(sessionId, galleryId, galleryName, folderId, folderName, resolvedFiles as PersistedFile[]);
    getUploadManager().startSession(sessionId, resolvedFiles, galleryId, galleryName, folderId, folderName);
  }
);

ipcMain.handle('upload:cancelSession', (_event, sessionId: string) => {
  uploadManager?.cancelSession(sessionId);
  // Remove from persistence — user explicitly stopped this upload
  removePersistSession(sessionId);
});

ipcMain.handle('upload:dismissSession', (_event, sessionId: string) => {
  uploadManager?.dismissSession(sessionId);
  // Dismissing a finished session also gives up on its failed files
  if (!uploadManager?.getSession(sessionId)) removePersistSession(sessionId);
});

ipcMain.handle('upload:getSessions', () => {
  return uploadManager?.getAllSessions() || [];
});

ipcMain.handle('upload:hasActiveSessions', () => {
  return uploadManager?.hasActiveSessions() || false;
});

// Window controls (for custom title bar on Windows)
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:close', () => mainWindow?.close());

// API base URL
ipcMain.handle('config:getApiBaseUrl', () => {
  return API_BASE_URL;
});

// Token refresh IPC
ipcMain.on('auth:freshToken', (_event, token: string) => {
  if (refreshResolve) refreshResolve(token);
  else setAccessToken(token);
});

ipcMain.on('auth:setToken', (_event, token: string) => {
  setAccessToken(token);
});

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
    if (fileNames.length === 0) return [];
    // Small batches: one URL with thousands of names exceeds URL limits and the
    // whole check silently failed for big folders.
    const BATCH = 80;
    // PostgREST in-list: quote every value, escape backslashes and quotes
    const quote = (n: string) => `"${n.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const rows: { id: string; file_name: string; size_bytes: number | null }[] = [];
    try {
      for (let i = 0; i < fileNames.length; i += BATCH) {
        const batch = Array.from(new Set(fileNames.slice(i, i + BATCH)));
        const namesParam = `(${batch.map(quote).join(',')})`;
        let url = `${SUPABASE_URL}/rest/v1/gallery_photos?gallery_id=eq.${encodeURIComponent(galleryId)}&file_name=in.${encodeURIComponent(namesParam)}&select=id,file_name,size_bytes`;
        if (folderId) url += `&folder_id=eq.${encodeURIComponent(folderId)}`;

        const res = await fetch(url, {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${token || accessToken}`,
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          console.warn(`[DupCheck] HTTP ${res.status}: ${await res.text()}`);
          continue; // On error, allow upload (don't block)
        }
        rows.push(...((await res.json()) as typeof rows));
      }
      console.log(`[DupCheck] Found ${rows.length} existing photos matching ${fileNames.length} file names`);
      return rows;
    } catch (err) {
      console.warn('[DupCheck] Error:', err);
      return rows; // On error, allow upload
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
    setAccessToken(token);
    const persisted = getPersistedSession(sessionId);
    if (!persisted) return { resumed: false, reason: 'session_not_found' };

    // Already running in memory (e.g. 'online' fired while it retries) — leave it alone
    const manager = getUploadManager();
    const live = manager.getSession(sessionId);
    if (live && (live.status === 'uploading' || live.status === 'queued')) {
      return { resumed: false, reason: 'already_running' };
    }

    const remaining = getRemainingFiles(sessionId);
    // Files deleted/moved since — mark them skipped so they don't block the session forever
    const existingFiles = remaining.filter((f) => {
      try { fs.statSync(f.path); return true; } catch {
        markFileSettled(sessionId, f.path, 'skipped');
        return false;
      }
    });

    if (existingFiles.length === 0) {
      removePersistSession(sessionId);
      return { resumed: false, reason: remaining.length === 0 ? 'no_remaining_files' : 'files_not_found' };
    }

    preventSleep();

    // Keep the ORIGINAL sessionId so the website sees the same session
    // continuing (same Realtime broadcast key) instead of a brand-new one.
    const alreadyCompleted = persisted.completedPaths.length;
    const alreadyFailed = persisted.skippedPaths.length;
    manager.startSession(
      sessionId,
      existingFiles,
      persisted.galleryId,
      persisted.galleryName,
      persisted.folderId,
      persisted.folderName,
      { alreadyCompleted, alreadyFailed, originalTotal: persisted.totalFiles }
    );

    console.log(`[Resume] Resumed session ${sessionId} with ${existingFiles.length} remaining files (${alreadyCompleted}/${persisted.totalFiles} already done)`);
    return { resumed: true, newSessionId: sessionId, remainingCount: existingFiles.length };
  }
);
