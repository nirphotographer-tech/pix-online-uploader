/**
 * Upload Manager — manages multiple concurrent upload sessions.
 * Each session uploads files to a specific gallery+folder, and multiple
 * sessions can run in parallel (e.g., uploading to different folders).
 */

import { UploadQueue, ProgressPayload, StatsPayload } from './uploadQueue';

export interface UploadSessionInfo {
  sessionId: string;
  galleryId: string;
  galleryName: string;
  folderId: string;
  folderName: string;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  totalSize: number;
  totalLoaded: number;
  percentage: number;
  speed: number;
  eta: number;
  status: 'uploading' | 'done' | 'error';
  errorMessage?: string;
}

interface SessionEntry {
  queue: UploadQueue;
  info: UploadSessionInfo;
}

interface UploadManagerOptions {
  apiBaseUrl: string;
  supabaseUrl: string;
  supabaseKey: string;
  concurrency: number;
  tokenRefresher: () => Promise<string>;
  onSessionUpdate: (session: UploadSessionInfo) => void;
  onSessionComplete: (session: UploadSessionInfo) => void;
  onAllSessionsComplete: () => void;
}

export class UploadManager {
  private sessions = new Map<string, SessionEntry>();
  private options: UploadManagerOptions;
  // Queue for uploads to the same folder — new files wait for the current session to finish
  private folderQueues = new Map<string, Array<{
    sessionId: string;
    files: Array<{ path: string; name: string; size: number; type: string }>;
    galleryId: string;
    galleryName: string;
    folderId: string;
    folderName: string;
    token: string;
    onFilePersistedComplete?: (fileName: string) => void;
    alreadyCompleted: number;
    originalTotal?: number;
  }>>();

  constructor(options: UploadManagerOptions) {
    this.options = options;
  }

  /**
   * Create a new upload session and start uploading immediately.
   */
  startSession(
    sessionId: string,
    files: Array<{ path: string; name: string; size: number; type: string }>,
    galleryId: string,
    galleryName: string,
    folderId: string,
    folderName: string,
    token: string,
    onFilePersistedComplete?: (fileName: string) => void,
    alreadyCompleted = 0,
    originalTotal?: number
  ): void {
    // If the same folder is already uploading, queue this session to start after
    const folderBusy = Array.from(this.sessions.values()).some(
      (e) => e.info.folderId === folderId && e.info.status === 'uploading'
    );
    if (folderBusy) {
      const q = this.folderQueues.get(folderId) || [];
      q.push({ sessionId, files, galleryId, galleryName, folderId, folderName, token,
        onFilePersistedComplete, alreadyCompleted: alreadyCompleted ?? 0, originalTotal });
      this.folderQueues.set(folderId, q);
      console.log(`[UploadManager] Session ${sessionId} queued — folder ${folderId} is busy`);
      return;
    }

    // If session already exists, ignore (prevent double-start)
    if (this.sessions.has(sessionId)) {
      console.log(`[UploadManager] Session ${sessionId} already exists, ignoring`);
      return;
    }

    const effectiveTotal = originalTotal ?? files.length;
    const info: UploadSessionInfo = {
      sessionId,
      galleryId,
      galleryName,
      folderId,
      folderName,
      totalFiles: effectiveTotal,
      completedFiles: alreadyCompleted,
      failedFiles: 0,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      totalLoaded: 0,
      percentage: effectiveTotal > 0 ? Math.round((alreadyCompleted / effectiveTotal) * 100) : 0,
      speed: 0,
      eta: 0,
      status: 'uploading',
    };

    const queue = new UploadQueue({
      concurrency: this.options.concurrency,
      apiBaseUrl: this.options.apiBaseUrl,
      token,
      galleryId,
      folderId,
      supabaseUrl: this.options.supabaseUrl,
      supabaseKey: this.options.supabaseKey,
      tokenRefresher: this.options.tokenRefresher,
      onProgress: (progress: ProgressPayload) => {
        info.totalLoaded = progress.totalLoaded;
        // Scale percentage to account for already-completed files
        const doneRatio = alreadyCompleted / effectiveTotal;
        const remainingRatio = files.length / effectiveTotal;
        info.percentage = Math.round(doneRatio * 100 + remainingRatio * progress.totalPercentage);
        info.speed = progress.speed;
        info.eta = progress.eta;
        this.options.onSessionUpdate({ ...info });
      },
      onFileComplete: (_fileId: string, success: boolean) => {
        if (success) {
          info.completedFiles++;
          // Persist completion so we can resume after restart
          const fileName = queue.getFileName(_fileId);
          if (fileName) onFilePersistedComplete?.(fileName);
        } else {
          info.failedFiles++;
        }
        this.options.onSessionUpdate({ ...info });
      },
      onAllComplete: (stats: StatsPayload) => {
        info.status = stats.failed > 0 && stats.success === 0 ? 'error' : 'done';
        if (stats.errorMessage) info.errorMessage = stats.errorMessage;
        info.percentage = 100;
        info.completedFiles = alreadyCompleted + stats.success;
        info.failedFiles = stats.failed;
        this.options.onSessionUpdate({ ...info });
        this.options.onSessionComplete({ ...info });
        this.checkAllComplete();
        // Start next queued session for this folder (if any)
        this.startNextInFolderQueue(folderId);
      },
    });

    this.sessions.set(sessionId, { queue, info });
    queue.addFiles(files);
    queue.start();

    console.log(
      `[UploadManager] Started session ${sessionId}: ${files.length} files → ${galleryName}/${folderName}`
    );
  }

  /**
   * Cancel a specific session
   */
  cancelSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.queue.cancel();
      this.sessions.delete(sessionId);
      console.log(`[UploadManager] Cancelled session ${sessionId}`);
      // Also remove from any folder queues
      for (const [folderId, q] of this.folderQueues) {
        const filtered = q.filter((item) => item.sessionId !== sessionId);
        if (filtered.length !== q.length) {
          this.folderQueues.set(folderId, filtered);
          console.log(`[UploadManager] Removed queued session ${sessionId} from folder queue ${folderId}`);
        }
        // If we just freed a slot, start the next one
        if (filtered.length === 0) {
          this.folderQueues.delete(folderId);
        }
      }
      this.checkAllComplete();
      // If this folder has a queued session waiting, start it now
      const folderId = entry.info.folderId;
      this.startNextInFolderQueue(folderId);
    }
  }

  /** Start the next queued session for a folder, if any */
  private startNextInFolderQueue(folderId: string): void {
    const q = this.folderQueues.get(folderId);
    if (!q || q.length === 0) return;
    const next = q.shift()!;
    if (q.length === 0) this.folderQueues.delete(folderId);
    console.log(`[UploadManager] Starting queued session ${next.sessionId} for folder ${folderId}`);
    this.startSession(
      next.sessionId, next.files, next.galleryId, next.galleryName,
      next.folderId, next.folderName, next.token, next.onFilePersistedComplete,
      next.alreadyCompleted, next.originalTotal
    );
  }

  /**
   * Remove a completed/errored session from tracking
   */
  dismissSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Get info for all active sessions
   */
  getAllSessions(): UploadSessionInfo[] {
    return Array.from(this.sessions.values()).map((e) => ({ ...e.info }));
  }

  /**
   * Check if there are any active (uploading) sessions
   */
  hasActiveSessions(): boolean {
    return Array.from(this.sessions.values()).some(
      (e) => e.info.status === 'uploading'
    );
  }

  private checkAllComplete(): void {
    if (!this.hasActiveSessions() && this.sessions.size > 0) {
      this.options.onAllSessionsComplete();
    }
  }
}
