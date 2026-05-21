/**
 * Upload Persistence — saves active upload sessions to disk.
 * When the app is closed mid-upload and restarted, the user can resume.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface PersistedFile {
  path: string;
  name: string;
  size: number;
  type: string;
}

export interface PersistedSession {
  sessionId: string;
  galleryId: string;
  galleryName: string;
  folderId: string;
  folderName: string;
  files: PersistedFile[];
  completedFileNames: Set<string> | string[]; // string[] on disk, Set in memory
  totalFiles: number;
  startedAt: number;
}

type DiskSession = Omit<PersistedSession, 'completedFileNames'> & {
  completedFileNames: string[];
};

type PersistedStore = Record<string, DiskSession>;

function getStorePath(): string {
  return path.join(app.getPath('userData'), 'pending-uploads.json');
}

function readStore(): PersistedStore {
  try {
    const raw = fs.readFileSync(getStorePath(), 'utf-8');
    const parsed = JSON.parse(raw) as PersistedStore;
    // Self-heal: old format was { "sessions": [] } — reset to empty object
    if (Array.isArray(parsed) || ('sessions' in parsed && !('sessionId' in parsed))) {
      writeStore({});
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function writeStore(store: PersistedStore): void {
  try {
    fs.writeFileSync(getStorePath(), JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Persistence] Failed to write store:', err);
  }
}

/** Save a new session to disk when upload starts */
export function saveSession(
  sessionId: string,
  galleryId: string,
  galleryName: string,
  folderId: string,
  folderName: string,
  files: PersistedFile[],
  options?: { preserveCompleted?: boolean; originalTotal?: number }
): void {
  const store = readStore();
  const existing = store[sessionId];
  const completedFileNames =
    options?.preserveCompleted && existing ? existing.completedFileNames : [];
  const totalFiles = options?.originalTotal ?? files.length;
  store[sessionId] = {
    sessionId,
    galleryId,
    galleryName,
    folderId,
    folderName,
    files,
    completedFileNames,
    totalFiles,
    startedAt: existing?.startedAt ?? Date.now(),
  };
  writeStore(store);
  console.log(`[Persistence] Saved session ${sessionId} (${files.length} remaining, ${completedFileNames.length} already done, ${totalFiles} total)`);
}

/** Mark a file as completed so we don't re-upload it on resume */
export function markFileCompleted(sessionId: string, fileName: string): void {
  const store = readStore();
  const session = store[sessionId];
  if (!session) return;
  if (!session.completedFileNames.includes(fileName)) {
    session.completedFileNames.push(fileName);
    writeStore(store);
  }
}

/** Remove a session from disk (completed, cancelled, or dismissed) */
export function removeSession(sessionId: string): void {
  const store = readStore();
  if (store[sessionId]) {
    delete store[sessionId];
    writeStore(store);
    console.log(`[Persistence] Removed session ${sessionId}`);
  }
}

/** Load all sessions that were interrupted (not yet completed) */
export function loadPendingSessions(): DiskSession[] {
  const store = readStore();
  // Filter out malformed entries (e.g. from old format { "sessions": [] })
  return Object.values(store).filter(
    (s): s is DiskSession =>
      s !== null &&
      typeof s === 'object' &&
      !Array.isArray(s) &&
      typeof (s as DiskSession).sessionId === 'string' &&
      Array.isArray((s as DiskSession).completedFileNames),
  );
}

/** Get remaining (not yet completed) files for a session */
export function getRemainingFiles(sessionId: string): PersistedFile[] {
  const store = readStore();
  const session = store[sessionId];
  if (!session) return [];
  const done = new Set(session.completedFileNames);
  return session.files.filter((f) => !done.has(f.name));
}

export function clearAllSessions(): void {
  writeStore({});
}
