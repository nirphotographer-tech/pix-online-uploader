/**
 * Upload Manager — manages multiple concurrent upload sessions.
 * Each session uploads files to a specific gallery+folder, and multiple
 * sessions can run in parallel (e.g., uploading to different folders).
 * A second upload to a folder that is already uploading waits its turn.
 */

import { UploadQueue, ProgressPayload, StatsPayload } from './uploadQueue';
import { UploadSlots, Semaphore } from './slotPool';

export interface UploadSessionInfo {
  sessionId: string;
  galleryId: string;
  galleryName: string;
  folderId: string;
  folderName: string;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  /** Failed files worth retrying (network/server errors) */
  retryableFiles: number;
  totalSize: number;
  totalLoaded: number;
  percentage: number;
  speed: number;
  eta: number;
  status: 'queued' | 'uploading' | 'done' | 'error';
  errorMessage?: string;
}

type SessionFile = { path: string; name: string; size: number; type: string };

interface SessionEntry {
  queue: UploadQueue | null; // null while queued behind another session
  info: UploadSessionInfo;
  files: SessionFile[];
  alreadyCompleted: number;
  alreadyFailed: number;
}

interface UploadManagerOptions {
  apiBaseUrl: string;
  supabaseUrl: string;
  supabaseKey: string;
  /** Files uploading at once, across all sessions */
  concurrency: number;
  /** Save calls (/api/r2/process) at once, across all sessions */
  maxParallelSaves: number;
  getToken: () => string;
  refreshToken: () => Promise<string>;
  onSessionUpdate: (session: UploadSessionInfo) => void;
  onSessionComplete: (session: UploadSessionInfo) => void;
  onAllSessionsComplete: () => void;
  /** A file reached its final state: uploaded, or failed for good */
  onFileSettled: (sessionId: string, filePath: string, outcome: 'completed' | 'skipped') => void;
}

export interface StartSessionOptions {
  /** Files already uploaded in an earlier run of this session (resume) */
  alreadyCompleted?: number;
  /** Files that failed for good in an earlier run (resume) */
  alreadyFailed?: number;
  /** Total file count of the original session (resume) */
  originalTotal?: number;
}

export class UploadManager {
  private sessions = new Map<string, SessionEntry>();
  private options: UploadManagerOptions;
  // Shared by every session: more folders at once don't mean more load
  private uploadSlots: UploadSlots;
  private processSlots: Semaphore;

  constructor(options: UploadManagerOptions) {
    this.options = options;
    this.uploadSlots = new UploadSlots(options.concurrency);
    this.processSlots = new Semaphore(options.maxParallelSaves);
  }

  /**
   * Create a new upload session. Starts immediately, or queues behind a
   * session that is already uploading to the same folder.
   */
  startSession(
    sessionId: string,
    files: SessionFile[],
    galleryId: string,
    galleryName: string,
    folderId: string,
    folderName: string,
    opts: StartSessionOptions = {},
  ): void {
    const existing = this.sessions.get(sessionId);
    if (existing && (existing.info.status === 'uploading' || existing.info.status === 'queued')) {
      console.log(`[UploadManager] Session ${sessionId} already running, ignoring`);
      return;
    }

    const alreadyCompleted = opts.alreadyCompleted ?? 0;
    const alreadyFailed = opts.alreadyFailed ?? 0;
    const effectiveTotal = opts.originalTotal ?? files.length;
    const info: UploadSessionInfo = {
      sessionId,
      galleryId,
      galleryName,
      folderId,
      folderName,
      totalFiles: effectiveTotal,
      completedFiles: alreadyCompleted,
      failedFiles: alreadyFailed,
      retryableFiles: 0,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      totalLoaded: 0,
      percentage: effectiveTotal > 0 ? Math.round(((alreadyCompleted + alreadyFailed) / effectiveTotal) * 100) : 0,
      speed: 0,
      eta: 0,
      status: 'queued',
    };
    const entry: SessionEntry = { queue: null, info, files, alreadyCompleted, alreadyFailed };
    this.sessions.set(sessionId, entry);

    if (this.isFolderBusy(galleryId, folderId, sessionId)) {
      console.log(`[UploadManager] Session ${sessionId} queued — folder ${folderId} is busy`);
      this.options.onSessionUpdate({ ...info });
      return;
    }
    this.runSession(entry);
  }

  private isFolderBusy(galleryId: string, folderId: string, exceptSessionId: string): boolean {
    return Array.from(this.sessions.values()).some(
      (e) => e.info.sessionId !== exceptSessionId &&
        e.info.galleryId === galleryId &&
        e.info.folderId === folderId &&
        e.info.status === 'uploading'
    );
  }

  private runSession(entry: SessionEntry): void {
    const { info, files, alreadyCompleted, alreadyFailed } = entry;
    const sessionId = info.sessionId;
    const effectiveTotal = info.totalFiles;
    info.status = 'uploading';

    const queue = new UploadQueue({
      concurrency: this.options.concurrency,
      uploadSlots: this.uploadSlots,
      processSlots: this.processSlots,
      apiBaseUrl: this.options.apiBaseUrl,
      galleryId: info.galleryId,
      folderId: info.folderId,
      folderName: info.folderName,
      supabaseUrl: this.options.supabaseUrl,
      supabaseKey: this.options.supabaseKey,
      getToken: this.options.getToken,
      refreshToken: this.options.refreshToken,
      onProgress: (progress: ProgressPayload) => {
        info.totalLoaded = progress.totalLoaded;
        // Scale percentage to account for files settled in an earlier run
        const doneRatio = (alreadyCompleted + alreadyFailed) / effectiveTotal;
        const remainingRatio = files.length / effectiveTotal;
        info.percentage = Math.round(doneRatio * 100 + remainingRatio * progress.totalPercentage);
        info.speed = progress.speed;
        info.eta = progress.eta;
        this.options.onSessionUpdate({ ...info });
      },
      onFileComplete: (fileId: string, success: boolean, _error?: string, retryable?: boolean) => {
        const file = queue.getFile(fileId);
        if (success) {
          info.completedFiles++;
        } else {
          info.failedFiles++;
          if (retryable) info.retryableFiles++;
        }
        // Retryable failures stay pending on disk, so a retry / next launch picks them up
        if (file && (success || !retryable)) {
          this.options.onFileSettled(sessionId, file.path, success ? 'completed' : 'skipped');
        }
        this.options.onSessionUpdate({ ...info });
      },
      onAllComplete: (stats: StatsPayload) => {
        info.status = stats.failed > 0 && stats.success === 0 && alreadyCompleted === 0 ? 'error' : 'done';
        if (stats.errorMessage) info.errorMessage = stats.errorMessage;
        info.percentage = 100;
        info.speed = 0;
        info.eta = 0;
        info.completedFiles = alreadyCompleted + stats.success;
        info.failedFiles = alreadyFailed + stats.failed;
        info.retryableFiles = stats.retryableFailed;
        this.options.onSessionUpdate({ ...info });
        this.options.onSessionComplete({ ...info });
        this.startNextQueued();
        this.checkAllComplete();
      },
    });

    entry.queue = queue;
    queue.addFiles(files);
    queue.start();
    this.options.onSessionUpdate({ ...info });

    console.log(
      `[UploadManager] Started session ${sessionId}: ${files.length} files → ${info.galleryName}/${info.folderName}`
    );
  }

  /** Start any queued session whose folder is now free */
  private startNextQueued(): void {
    for (const entry of this.sessions.values()) {
      if (entry.info.status !== 'queued') continue;
      if (this.isFolderBusy(entry.info.galleryId, entry.info.folderId, entry.info.sessionId)) continue;
      console.log(`[UploadManager] Starting queued session ${entry.info.sessionId}`);
      this.runSession(entry);
    }
  }

  /** Cancel a specific session (running or queued) */
  cancelSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.queue?.cancel();
    this.sessions.delete(sessionId);
    console.log(`[UploadManager] Cancelled session ${sessionId}`);
    this.startNextQueued();
    this.checkAllComplete();
  }

  /** Remove a completed/errored session from tracking */
  dismissSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry && (entry.info.status === 'uploading' || entry.info.status === 'queued')) return;
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): UploadSessionInfo | undefined {
    const entry = this.sessions.get(sessionId);
    return entry ? { ...entry.info } : undefined;
  }

  getAllSessions(): UploadSessionInfo[] {
    return Array.from(this.sessions.values()).map((e) => ({ ...e.info }));
  }

  /** True while any session is uploading or waiting to upload */
  hasActiveSessions(): boolean {
    return Array.from(this.sessions.values()).some(
      (e) => e.info.status === 'uploading' || e.info.status === 'queued'
    );
  }

  /** The computer woke from sleep — restart requests that hung while it slept */
  onSystemResume(): void {
    for (const entry of this.sessions.values()) {
      if (entry.info.status === 'uploading') entry.queue?.onSystemResume();
    }
  }

  private checkAllComplete(): void {
    if (!this.hasActiveSessions()) {
      this.options.onAllSessionsComplete();
    }
  }
}
