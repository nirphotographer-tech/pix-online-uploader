/**
 * Upload Persistence — saves active upload sessions to disk.
 * When the app is closed mid-upload (or the computer restarts), the session is
 * resumed on the next launch, skipping files that were already uploaded.
 *
 * Files are tracked by full path, not name: a folder scan often contains the
 * same camera file name (DSC_0001.jpg) in several sub-folders.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface PersistedFile {
  path: string;
  name: string;
  size: number;
  type: string;
  /** "Replace" chosen: the file takes this existing photo's place */
  replacePhotoId?: string;
}

export interface DiskSession {
  sessionId: string;
  galleryId: string;
  galleryName: string;
  folderId: string;
  folderName: string;
  files: PersistedFile[];
  /** Uploaded successfully */
  completedPaths: string[];
  /** Failed for good (bad file, rejected by the server) — not retried */
  skippedPaths: string[];
  totalFiles: number;
  startedAt: number;
}

/** Shape sent to the renderer */
export interface PendingSessionSummary {
  sessionId: string;
  galleryId: string;
  galleryName: string;
  folderId: string;
  folderName: string;
  totalFiles: number;
  completedCount: number;
  remainingCount: number;
  startedAt: number;
}

type PersistedStore = Record<string, DiskSession>;

let cache: PersistedStore | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function getStorePath(): string {
  return path.join(app.getPath('userData'), 'pending-uploads.json');
}

/** v2.4.x stored completed file *names*; convert to paths */
function migrate(raw: Record<string, unknown>): DiskSession | null {
  const s = raw as Partial<DiskSession> & { completedFileNames?: string[] };
  if (!s || typeof s !== 'object' || typeof s.sessionId !== 'string' || !Array.isArray(s.files)) return null;
  if (Array.isArray(s.completedPaths)) {
    return { ...s, skippedPaths: Array.isArray(s.skippedPaths) ? s.skippedPaths : [] } as DiskSession;
  }
  const doneNames = new Set(s.completedFileNames || []);
  return {
    sessionId: s.sessionId,
    galleryId: s.galleryId || '',
    galleryName: s.galleryName || '',
    folderId: s.folderId || '',
    folderName: s.folderName || '',
    files: s.files,
    completedPaths: s.files.filter((f) => doneNames.has(f.name)).map((f) => f.path),
    skippedPaths: [],
    totalFiles: s.totalFiles || s.files.length,
    startedAt: s.startedAt || Date.now(),
  };
}

function readStore(): PersistedStore {
  if (cache) return cache;
  cache = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(getStorePath(), 'utf-8')) as Record<string, Record<string, unknown>>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, raw] of Object.entries(parsed)) {
        const session = migrate(raw);
        if (session) cache[id] = session;
      }
    }
  } catch {
    // Missing or unreadable file → start empty
  }
  return cache;
}

/**
 * Write atomically (temp file + rename): a crash, forced quit or power loss
 * mid-write must never leave a truncated JSON that loses every pending session.
 */
function writeNow(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!cache) return;
  const target = getStorePath();
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('[Persistence] Failed to write store:', err);
  }
}

/** Per-file updates are frequent — batch them */
function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(writeNow, 1000);
}

/** Write pending changes immediately (call before the app quits) */
export function flushPersistence(): void {
  if (writeTimer) writeNow();
}

/** Save a new session to disk when upload starts */
export function saveSession(
  sessionId: string,
  galleryId: string,
  galleryName: string,
  folderId: string,
  folderName: string,
  files: PersistedFile[],
): void {
  const store = readStore();
  store[sessionId] = {
    sessionId,
    galleryId,
    galleryName,
    folderId,
    folderName,
    // replacePhotoId too: a "replace" resumed after a restart must still replace
    files: files.map(({ path: p, name, size, type, replacePhotoId }) => ({ path: p, name, size, type, ...(replacePhotoId && { replacePhotoId }) })),
    completedPaths: [],
    skippedPaths: [],
    totalFiles: files.length,
    startedAt: Date.now(),
  };
  writeNow();
  console.log(`[Persistence] Saved session ${sessionId} (${files.length} files)`);
}

/** Record a file's final outcome so it isn't uploaded again on resume */
export function markFileSettled(sessionId: string, filePath: string, outcome: 'completed' | 'skipped'): void {
  const session = readStore()[sessionId];
  if (!session) return;
  const list = outcome === 'completed' ? session.completedPaths : session.skippedPaths;
  if (!list.includes(filePath)) {
    list.push(filePath);
    scheduleWrite();
  }
}

/** A newer "replace" took the file over — it no longer belongs to this session */
export function withdrawFile(sessionId: string, filePath: string): void {
  const session = readStore()[sessionId];
  if (!session) return;
  const before = session.files.length;
  session.files = session.files.filter((f) => f.path !== filePath);
  if (session.files.length === before) return;
  session.totalFiles = Math.max(0, session.totalFiles - 1);
  session.skippedPaths = session.skippedPaths.filter((p) => p !== filePath);
  scheduleWrite();
}

/** Remove a session from disk (completed, cancelled, or dismissed) */
export function removeSession(sessionId: string): void {
  const store = readStore();
  if (store[sessionId]) {
    delete store[sessionId];
    writeNow();
    console.log(`[Persistence] Removed session ${sessionId}`);
  }
}

export function getSession(sessionId: string): DiskSession | undefined {
  return readStore()[sessionId];
}

/** Files of a session that still need uploading */
export function getRemainingFiles(sessionId: string): PersistedFile[] {
  const session = readStore()[sessionId];
  if (!session) return [];
  const settled = new Set([...session.completedPaths, ...session.skippedPaths]);
  return session.files.filter((f) => !settled.has(f.path));
}

/** Load all sessions that still have files to upload */
export function loadPendingSessions(): PendingSessionSummary[] {
  return Object.values(readStore()).map((s) => ({
    sessionId: s.sessionId,
    galleryId: s.galleryId,
    galleryName: s.galleryName,
    folderId: s.folderId,
    folderName: s.folderName,
    totalFiles: s.totalFiles,
    completedCount: s.completedPaths.length,
    remainingCount: getRemainingFiles(s.sessionId).length,
    startedAt: s.startedAt,
  }));
}

export function clearAllSessions(): void {
  cache = {};
  writeNow();
}
