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
  onSessionUpdate: (session: UploadSessionInfo) => void;
  onSessionComplete: (session: UploadSessionInfo) => void;
  onAllSessionsComplete: () => void;
}

export class UploadManager {
  private sessions = new Map<string, SessionEntry>();
  private options: UploadManagerOptions;

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
    token: string
  ): void {
    // If session already exists, ignore (prevent double-start)
    if (this.sessions.has(sessionId)) {
      console.log(`[UploadManager] Session ${sessionId} already exists, ignoring`);
      return;
    }

    const info: UploadSessionInfo = {
      sessionId,
      galleryId,
      galleryName,
      folderId,
      folderName,
      totalFiles: files.length,
      completedFiles: 0,
      failedFiles: 0,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      totalLoaded: 0,
      percentage: 0,
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
      onProgress: (progress: ProgressPayload) => {
        info.totalLoaded = progress.totalLoaded;
        info.percentage = progress.totalPercentage;
        info.speed = progress.speed;
        info.eta = progress.eta;
        this.options.onSessionUpdate({ ...info });
      },
      onFileComplete: (_fileId: string, success: boolean) => {
        if (success) {
          info.completedFiles++;
        } else {
          info.failedFiles++;
        }
        this.options.onSessionUpdate({ ...info });
      },
      onAllComplete: (stats: StatsPayload) => {
        info.status = stats.failed > 0 && stats.success === 0 ? 'error' : 'done';
        info.percentage = 100;
        info.completedFiles = stats.success;
        info.failedFiles = stats.failed;
        this.options.onSessionUpdate({ ...info });
        this.options.onSessionComplete({ ...info });
        this.checkAllComplete();
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
      this.checkAllComplete();
    }
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
