/**
 * Upload Persistence — saves/loads pending upload sessions to disk.
 * Allows the app to show a "resume upload" banner after a restart.
 *
 * File stored at: <userData>/pending-uploads.json
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';

export interface PendingFile {
  path: string;
  name: string;
  size: number;
  type: string;
}

export interface PendingSession {
  sessionId: string;
  galleryId: string;
  galleryName: string;
  folderId: string;
  folderName: string;
  /** All files that were part of the session */
  files: PendingFile[];
  /** File names (not paths) that already completed successfully */
  completedFileNames: string[];
  /** Auth token — may be stale; renderer will refresh before resuming */
  token: string;
  savedAt: number;
}

interface PersistenceData {
  sessions: PendingSession[];
}

function getPersistencePath(): string {
  return path.join(app.getPath('userData'), 'pending-uploads.json');
}

function readData(): PersistenceData {
  try {
    const raw = fs.readFileSync(getPersistencePath(), 'utf-8');
    const parsed = JSON.parse(raw) as PersistenceData;
    if (!Array.isArray(parsed.sessions)) return { sessions: [] };
    return parsed;
  } catch {
    return { sessions: [] };
  }
}

function writeData(data: PersistenceData): void {
  try {
    fs.writeFileSync(getPersistencePath(), JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Persistence] Failed to write:', err);
  }
}

/** Save (or update) a pending session */
export function savePendingSession(session: PendingSession): void {
  const data = readData();
  const idx = data.sessions.findIndex((s) => s.sessionId === session.sessionId);
  if (idx >= 0) {
    data.sessions[idx] = session;
  } else {
    data.sessions.push(session);
  }
  writeData(data);
  console.log(`[Persistence] Saved session ${session.sessionId} (${session.files.length - session.completedFileNames.length} remaining)`);
}

/** Remove a session that completed or was cancelled */
export function removePendingSession(sessionId: string): void {
  const data = readData();
  const before = data.sessions.length;
  data.sessions = data.sessions.filter((s) => s.sessionId !== sessionId);
  if (data.sessions.length < before) {
    writeData(data);
    console.log(`[Persistence] Removed session ${sessionId}`);
  }
}

/** Mark a file as completed within a session */
export function markFileCompleted(sessionId: string, fileName: string): void {
  const data = readData();
  const session = data.sessions.find((s) => s.sessionId === sessionId);
  if (session && !session.completedFileNames.includes(fileName)) {
    session.completedFileNames.push(fileName);
    writeData(data);
  }
}

/** Load all pending sessions from disk */
export function loadPendingSessions(): PendingSession[] {
  const data = readData();
  // Filter out sessions where all files are already done
  return data.sessions.filter(
    (s) => s.files.length > s.completedFileNames.length
  );
}

/** Remove all pending sessions (e.g. on logout) */
export function clearAllPendingSessions(): void {
  writeData({ sessions: [] });
  console.log('[Persistence] Cleared all pending sessions');
}
