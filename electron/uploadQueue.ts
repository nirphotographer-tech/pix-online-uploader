import fs from 'fs';
import sizeOf from 'image-size';
import { net } from 'electron';
import { UploadSlots, Semaphore } from './slotPool';

// ============================================================================
// Types
// ============================================================================

interface FileEntry {
  id: string;
  path: string;
  name: string;
  size: number;
  type: string;
  /** 'withdrawn' = a newer "replace" took this file over; it leaves the session */
  status: 'pending' | 'uploading' | 'processing' | 'done' | 'error' | 'withdrawn';
  /** Taken over while sending bytes — the pipeline stops before saving */
  withdrawn?: boolean;
  /** takeOver() calls waiting for this file to finish saving */
  waiters?: Array<() => void>;
  loaded: number;
  peakLoaded: number;
  error?: string;
  /** false = retrying later won't help (bad file, rejected by server) */
  retryable?: boolean;
  lastModified?: number;
  /** "Replace" chosen: the server puts this file in that existing photo's place */
  replacePhotoId?: string;
  processResult?: ProcessResult;
  /** Upload URL fetched ahead of time in a batch (valid for an hour) */
  presign?: PresignResponse & { size: number; at: number };
  /** What was sent to /api/r2/process — kept to save again if the row goes missing */
  saved?: { key: string; baseKey: string; width: number; height: number };
  resaves?: number;
  timings?: { presign: number; upload: number; save: number };
}

interface QueueOptions {
  concurrency: number;
  apiBaseUrl: string;
  galleryId: string;
  folderId?: string;
  folderName?: string;
  supabaseUrl: string;
  supabaseKey: string;
  /** Always returns the newest access token known to the main process */
  getToken: () => string;
  /** Asks the renderer for a fresh token; resolves with the new token or '' */
  refreshToken: () => Promise<string>;
  onProgress: (progress: ProgressPayload) => void;
  onFileComplete: (fileId: string, success: boolean, error?: string, retryable?: boolean) => void;
  /**
   * The server confirmed the save. Fired before the batched DB check, so a quit
   * in that window doesn't upload the photo again (as a duplicate) on resume.
   */
  onFileSaved?: (fileId: string) => void;
  onAllComplete: (stats: StatsPayload) => void;
  /** A newer "replace" took the file over: it no longer counts in this session */
  onFileWithdrawn?: (fileId: string, previous: { failed: boolean; retryable: boolean }) => void;
  /** Upload slots shared by all sessions (defaults to a private pool of `concurrency`) */
  uploadSlots?: UploadSlots;
  /** Limit on concurrent save calls shared by all sessions */
  processSlots?: Semaphore;
}

export interface ProgressPayload {
  fileId: string;
  fileName: string;
  loaded: number;
  total: number;
  percentage: number;
  speed: number;
  totalLoaded: number;
  totalSize: number;
  totalPercentage: number;
  eta: number;
}

export interface StatsPayload {
  total: number;
  success: number;
  failed: number;
  /** failed files that may succeed if retried later (network, server errors) */
  retryableFailed: number;
  totalTime: number;
  errorMessage?: string;
}

interface PresignResponse {
  uploadUrl: string;
  key: string;
  baseKey: string;
}

interface ProcessResult {
  id: string;
  storageKey: string;
  needsResponsiveProcessing?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_RETRIES = 7;
const RETRY_DELAYS = [2000, 4000, 8000, 15000, 30000, 45000, 60000];
const PRESIGN_TIMEOUT = 30_000;
const R2_PUT_MIN_TIMEOUT = 180_000; // 3 minutes, more for big files on a slow line
const PROCESS_TIMEOUT = 120_000; // 2 minutes — covers Vercel cold start + DB write

// One /api/r2/presign-batch call signs up to this many files (server cap: UPLOAD_CONFIG.PARALLEL_UPLOADS)
const PRESIGN_BATCH_MAX = 7;
// Presigned URLs live for an hour; don't use one that is close to expiring
const PRESIGN_MAX_AGE = 45 * 60_000;
// Saved photos are confirmed in the DB in batches: one query per VERIFY_BATCH photos
const VERIFY_BATCH = 25;
const VERIFY_DELAY = 4000;
const MAX_RESAVES = 2;

// Node's fetch reports network failures as "fetch failed" with the OS error in
// err.cause.code — the browser-style "Failed to fetch" never shows up here.
const NETWORK_ERROR_RE = /fetch failed|Failed to fetch|NetworkError|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EPIPE|UND_ERR|socket hang up|other side closed/i;

// Status codes where sending the same request again can't succeed
const PERMANENT_HTTP_STATUSES = new Set([400, 403, 413, 415, 422]);

const SESSION_ERROR_GALLERY_DELETED = 'The gallery was deleted on the website, upload stopped';
const SESSION_ERROR_FOLDER_DELETED = 'The folder was deleted on the website, upload stopped';

// ============================================================================
// HTTP helpers
// ============================================================================

class HttpError extends Error {
  constructor(public status: number, public body: string, prefix = 'HTTP') {
    super(`${prefix} ${status}: ${body.substring(0, 200)}`);
  }

  /** The server's `error` field, for showing to the photographer */
  get serverMessage(): string {
    try {
      const parsed = JSON.parse(this.body) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch { /* not JSON */ }
    return this.message;
  }
}

/** Combine a caller signal (cancel / system resume) with a per-request timeout */
function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function httpPost<T>(url: string, body: object, token: string, timeoutMs: number, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'x-uploader-source': 'desktop',
    },
    body: JSON.stringify(body),
    signal: withTimeout(signal, timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text);
  return JSON.parse(text) as T;
}

/** Enough time for the file at ~100KB/s, never less than R2_PUT_MIN_TIMEOUT */
function putTimeout(bytes: number): number {
  return Math.max(R2_PUT_MIN_TIMEOUT, 60_000 + Math.round(bytes / 100));
}

async function httpPut(url: string, body: Buffer, contentType: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
    },
    body: body,
    signal: withTimeout(signal, timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new HttpError(res.status, text, 'R2 PUT');
  }
}

/** Id of the photo row this file was saved as (null if unknown) */
function savedPhotoId(file: FileEntry): string | null {
  const id = file.processResult?.id;
  return id && id !== 'unknown' ? id : null;
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  return cause ? `${err.message} (${cause.code || cause.message || 'unknown cause'})` : err.message;
}

function userIdFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}


// ============================================================================
// Upload Queue
// ============================================================================

export class UploadQueue {
  private files: FileEntry[] = [];
  private options: QueueOptions;
  private isPaused = false;
  private isCancelled = false;
  private isFinished = false;
  // Files currently sending bytes to R2 (each holds a slot from uploadSlots)
  private activeUploads = 0;
  // Files anywhere in the pipeline (uploading, waiting to save, saving)
  private activeWorkers = 0;
  private startedCount = 0;
  private startTime = 0;
  private totalBytesAtLastCheck = 0;
  private lastCheckTime = 0;
  private currentSpeed = 0;
  private lastEmitTime = 0;
  private readonly uploadSlots: UploadSlots;
  private readonly processSlots: Semaphore;
  private readonly starter = () => this.tryStartOne();
  // file id → the batch presign request that will cover it
  private presignInFlight = new Map<string, Promise<void>>();
  private batchPresignUnavailable = false;
  // Saved photos waiting for the batched DB check
  private verifyQueue: FileEntry[] = [];
  private verifyTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionErrorMsg: string | null = null;
  // Aborts every in-flight request; replaced after each abort so new requests get a fresh one
  private abortController = new AbortController();
  // Bumped on system resume — requests aborted by it are retried without charging an attempt
  private resumeEpoch = 0;
  private folderEnsured = false;
  // Responsive versions are generated per photo as soon as it's saved, so a
  // closed app leaves only the last few photos for the server cron to pick up.
  private backgroundQueue: ProcessResult[] = [];
  private backgroundRunning = false;

  constructor(options: QueueOptions) {
    this.options = options;
    this.uploadSlots = options.uploadSlots ?? new UploadSlots(options.concurrency);
    this.processSlots = options.processSlots ?? new Semaphore(options.concurrency);
    console.log(`[Upload] Queue created: galleryId=${options.galleryId}, folderId=${options.folderId || 'NONE'}, concurrency=${options.concurrency}`);
  }

  addFiles(files: Array<{ path: string; name: string; size: number; type: string; replacePhotoId?: string }>): void {
    for (const file of files) {
      let lastModified: number | undefined;
      try {
        lastModified = fs.statSync(file.path).mtimeMs;
      } catch { /* missing files fail with a clear message when their turn comes */ }

      this.files.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        path: file.path,
        name: file.name,
        size: file.size,
        type: file.type || 'image/jpeg',
        status: 'pending',
        loaded: 0,
        peakLoaded: 0,
        lastModified,
        replacePhotoId: file.replacePhotoId,
      });
    }
    console.log(`[Upload] addFiles: ${files.length} files`);
  }

  start(): void {
    this.startTime = Date.now();
    this.lastCheckTime = Date.now();
    this.isCancelled = false;
    this.isPaused = false;

    // Pre-upload storage check — block entire batch if not enough space
    this.checkStorageBeforeStart()
      .catch((err) => {
        console.error('[Upload] Storage pre-check failed:', err);
        return true; // On error, proceed anyway — server will block if needed
      })
      .then((canProceed) => {
        if (!canProceed || this.isCancelled || this.isFinished) return;
        this.uploadSlots.register(this.starter);
        this.processNext();
      });
  }

  /**
   * Check storage quota before starting uploads.
   * Returns true if we can proceed, false if storage is full.
   */
  private async checkStorageBeforeStart(): Promise<boolean> {
    try {
      const totalBatchSize = this.files.reduce((sum, f) => sum + f.size, 0);
      console.log(`[Upload] 📊 Pre-upload storage check: ${this.files.length} files, ${(totalBatchSize / 1024 / 1024).toFixed(0)}MB total`);

      const res = await fetch(`${this.options.apiBaseUrl}/api/storage/check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.options.getToken()}`,
        },
        body: JSON.stringify({ userId: null }), // server extracts from token
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        console.warn(`[Upload] Storage check HTTP ${res.status} — proceeding anyway`);
        return true;
      }

      const data = await res.json() as { info?: { can_upload: boolean; used_bytes: number; limit_bytes: number | null; plan_name: string } };
      const info = data.info;
      if (!info) {
        console.warn('[Upload] Storage check returned no info — proceeding');
        return true;
      }

      console.log(`[Upload] 📊 Storage: ${(info.used_bytes / 1024 / 1024 / 1024).toFixed(2)}GB / ${info.limit_bytes ? (info.limit_bytes / 1024 / 1024 / 1024).toFixed(1) + 'GB' : 'UNLIMITED'} (${info.plan_name})`);

      const tooBig = !info.can_upload
        || (info.limit_bytes !== null && totalBatchSize > info.limit_bytes - info.used_bytes);
      if (tooBig) {
        console.error('[Upload] 🚫 Not enough storage — blocking entire batch');
        const usedGB = (info.used_bytes / 1024 / 1024 / 1024).toFixed(2);
        const limitGB = info.limit_bytes ? (info.limit_bytes / 1024 / 1024 / 1024).toFixed(1) : 'unlimited';
        this.failSession(`Not enough storage (${usedGB}GB / ${limitGB}GB). Please upgrade your plan.`);
        return false;
      }

      console.log('[Upload] ✅ Storage check passed — proceeding with uploads');
      return true;
    } catch (err) {
      console.warn('[Upload] Storage pre-check error (proceeding anyway):', describeError(err));
      return true;
    }
  }

  /**
   * Stop the whole session: every file that hasn't finished fails with `message`.
   * Used when continuing can't help (storage full, gallery deleted).
   */
  private failSession(message: string): void {
    if (this.sessionErrorMsg) return;
    this.sessionErrorMsg = message;
    for (const file of this.files) {
      if (file.status !== 'done' && file.status !== 'error' && file.status !== 'withdrawn') {
        file.status = 'error';
        file.error = message;
        file.retryable = false;
        this.notifySettled(file);
      }
    }
    // Abort in-flight requests so their workers exit right away
    this.abortInFlight();
    this.checkCompletion();
  }

  pause(): void { this.isPaused = true; }

  resume(): void {
    this.isPaused = false;
    this.processNext();
  }

  cancel(): void {
    this.isCancelled = true;
    for (const file of this.files) {
      if (file.status !== 'done' && file.status !== 'error' && file.status !== 'withdrawn') {
        file.status = 'error';
        file.error = 'Upload cancelled';
        file.retryable = false;
        this.notifySettled(file);
      }
    }
    this.backgroundQueue = [];
    this.verifyQueue = [];
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = null;
    this.uploadSlots.unregister(this.starter);
    this.abortInFlight();
  }

  /**
   * Called after the computer wakes from sleep. Requests that were in flight
   * when the lid closed usually hang until their timeout (up to 3 minutes);
   * abort them so they retry right away, without using up a retry attempt.
   */
  onSystemResume(): void {
    if (this.isCancelled || this.isFinished) return;
    this.resumeEpoch++;
    console.log(`[Upload] 💤 System resumed — restarting in-flight requests (${this.activeUploads} active)`);
    this.abortInFlight();
  }

  private abortInFlight(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  /**
   * "Replace" in a newer upload picked these files again (key = "name|size").
   * A file not saved yet leaves this session; one already saved — or being
   * saved — reports its photo id, so the new file takes that photo's place.
   */
  async takeOver(keys: Set<string>): Promise<Array<{ key: string; photoId: string | null }>> {
    const results: Array<{ key: string; photoId: string | null }> = [];
    const waits: Promise<void>[] = [];
    for (const file of this.files) {
      const key = `${file.name}|${file.size}`;
      if (!keys.has(key) || file.status === 'withdrawn' || file.withdrawn) continue;
      if (file.status === 'done') {
        results.push({ key, photoId: savedPhotoId(file) });
      } else if (file.status === 'processing') {
        waits.push(this.waitSettled(file).then(() => {
          if (file.status === 'done') {
            results.push({ key, photoId: savedPhotoId(file) });
          } else {
            // The save failed — don't let a retry add it after all
            this.withdraw(file);
            results.push({ key, photoId: null });
          }
        }));
      } else {
        this.withdraw(file);
        results.push({ key, photoId: null });
      }
    }
    await Promise.all(waits);
    if (results.length > 0) console.log(`[Upload] 🔁 Taken over by a newer upload: ${results.length} file(s)`);
    this.checkCompletion();
    this.processNext();
    return results;
  }

  private withdraw(file: FileEntry): void {
    const previous = { failed: file.status === 'error', retryable: file.status === 'error' && !!file.retryable };
    if (file.status === 'uploading') {
      // Bytes are on their way — the pipeline stops before the save
      file.withdrawn = true;
    } else {
      file.status = 'withdrawn';
      this.notifySettled(file);
    }
    this.options.onFileWithdrawn?.(file.id, previous);
  }

  /** The pipeline noticed the file was taken over */
  private finishWithdraw(file: FileEntry): void {
    file.status = 'withdrawn';
    console.log(`[Upload] 🔁 ${file.name} dropped — a newer upload replaces it`);
    this.notifySettled(file);
  }

  private waitSettled(file: FileEntry): Promise<void> {
    if (file.status === 'done' || file.status === 'error' || file.status === 'withdrawn') return Promise.resolve();
    return new Promise((resolve) => (file.waiters ??= []).push(resolve));
  }

  private notifySettled(file: FileEntry): void {
    const waiters = file.waiters;
    file.waiters = undefined;
    waiters?.forEach((resolve) => resolve());
  }

  /** Get the file for a given file id (used by UploadManager for persistence) */
  getFile(fileId: string): { path: string; name: string } | undefined {
    return this.files.find((f) => f.id === fileId);
  }

  // ============================================================================
  // Core loop — picks next pending file and runs the pipeline
  // ============================================================================

  private processNext(): void {
    this.uploadSlots.pump();
  }

  /**
   * Start the next pending file if this session and the shared pool have room.
   * Called by UploadSlots whenever a slot frees up.
   */
  private tryStartOne(): boolean {
    if (this.isCancelled || this.isPaused || this.sessionErrorMsg || this.isFinished) return false;
    const limit = this.options.concurrency;
    // Files that finished uploading but wait to be saved don't hold an upload
    // slot; cap them so a slow server can't pile up unsaved originals.
    if (this.activeUploads >= limit || this.activeWorkers >= limit * 2) return false;
    const nextFile = this.files.find((f) => f.status === 'pending');
    if (!nextFile) return false;
    if (!this.uploadSlots.tryAcquire()) return false;

    nextFile.status = 'uploading';
    this.activeUploads++;
    this.activeWorkers++;

    // Stagger only the first wave, so a new session doesn't fire every request at once
    const stagger = this.startedCount < limit ? this.startedCount * 200 : 0;
    this.startedCount++;

    let holdsSlot = true;
    const leaveUploadPhase = () => {
      if (!holdsSlot) return;
      holdsSlot = false;
      this.activeUploads--;
      this.uploadSlots.release();
    };

    const run = async () => {
      if (stagger > 0) await this.sleep(stagger);
      return this.uploadFile(nextFile, leaveUploadPhase);
    };

    run()
      .catch((err) => { console.error(`[Upload] Unexpected error for ${nextFile.name}:`, describeError(err)); })
      .finally(() => {
        this.activeWorkers--;
        leaveUploadPhase();
        // Last worker out: confirm the remaining saved photos right away
        if (this.activeWorkers === 0) this.flushVerify();
        this.checkCompletion();
        this.processNext();
      });
    return true;
  }

  // ============================================================================
  // Per-file pipeline: presign → R2 PUT → save (→ batched DB check)
  // ============================================================================

  private async uploadFile(file: FileEntry, leaveUploadPhase: () => void): Promise<void> {
    let lastError: Error | null = null;
    let presign: PresignResponse | null = null;
    let uploadedToR2 = false;
    let imageWidth = 0;
    let imageHeight = 0;
    // Set after a network-wait so we skip the normal retry-delay on the next
    // attempt (we already waited for the network; no need to double-sleep).
    let skipNextRetryDelay = false;
    const timings = { presign: 0, upload: 0, save: 0 };

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.isCancelled || this.sessionErrorMsg) return;
      if (file.withdrawn) return this.finishWithdraw(file);
      const epochAtStart = this.resumeEpoch;
      const signal = this.abortController.signal;

      try {
        if (attempt > 1 && !skipNextRetryDelay) {
          const delay = RETRY_DELAYS[attempt - 2] || 30000;
          console.log(`[Upload] ⏳ Retry ${attempt}/${MAX_RETRIES} for ${file.name} (waiting ${delay}ms)`);
          await this.sleep(delay);
          if (this.isCancelled || this.sessionErrorMsg) return;
        }
        skipNextRetryDelay = false;

        // ---- Step 1+2: Presign and upload to R2 (skipped if already uploaded) ----
        if (!uploadedToR2) {
          file.loaded = 0;
          file.status = 'uploading';

          // Async read: a synchronous read of a file that lives only in iCloud
          // (macOS "Optimize Mac Storage") blocks the whole app while it downloads.
          const fileBuffer = await fs.promises.readFile(file.path);
          if (fileBuffer.length === 0) {
            throw Object.assign(new Error('The file is empty'), { code: 'EMPTYFILE' });
          }
          // The file may have changed since it was picked — sign the size we actually send
          file.size = fileBuffer.length;
          try {
            const dims = sizeOf(fileBuffer);
            imageWidth = dims.width || 0;
            imageHeight = dims.height || 0;
          } catch (dimErr) {
            console.warn(`[Upload] Could not read dimensions of ${file.name}:`, describeError(dimErr));
          }

          console.log(`[Upload] [${attempt}/${MAX_RETRIES}] Presigning: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
          let t = Date.now();
          presign = await this.getPresign(file, attempt === 1, signal);
          timings.presign = Date.now() - t;

          t = Date.now();
          await httpPut(presign.uploadUrl, fileBuffer, file.type, putTimeout(fileBuffer.length), signal);
          timings.upload = Date.now() - t;

          file.loaded = file.size;
          file.peakLoaded = file.size;
          this.emitProgress(file);
          uploadedToR2 = true;
          // Bytes are sent — let the next file start uploading while this one is saved
          leaveUploadPhase();
        }

        // ---- Step 3: Save the photo record (server-side) ----
        // Taken over while uploading: nothing is saved, the newer upload adds it
        if (file.withdrawn) return this.finishWithdraw(file);
        file.status = 'processing';
        this.emitProgress(file);

        file.saved = { key: presign!.key, baseKey: presign!.baseKey, width: imageWidth, height: imageHeight };
        const t = Date.now();
        await this.saveRecord(file, signal);
        timings.save = Date.now() - t;
        file.timings = timings;

        // ---- Saved. The DB check runs in batches (one query per VERIFY_BATCH photos) ----
        this.options.onFileSaved?.(file.id);
        const photoId = file.processResult?.id;
        if (photoId && photoId !== 'unknown') {
          this.enqueueVerify(file);
        } else {
          this.markDone(file);
        }
        return;

      } catch (err: unknown) {
        if (this.isCancelled || this.sessionErrorMsg) return;
        lastError = err instanceof Error ? err : new Error(String(err));
        const errMsg = describeError(err);
        const code = (err as { code?: string }).code;

        // ---- Local file problems: retrying won't bring the file back ----
        if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'EMPTYFILE') {
          const message = code === 'EMPTYFILE'
            ? 'The file is empty or damaged'
            : code === 'ENOENT'
              ? 'File not found on this computer (moved or deleted?)'
              : 'No permission to read the file';
          return this.failFile(file, message, false, errMsg);
        }

        // ---- Laptop woke up / network dropped: wait, don't charge an attempt ----
        const abortedByResume = this.resumeEpoch !== epochAtStart;
        const looksLikeNetworkError = abortedByResume || !net.isOnline() || NETWORK_ERROR_RE.test(errMsg);
        if (looksLikeNetworkError) {
          console.log(`[Upload] 🌐 ${abortedByResume ? 'Woke from sleep' : 'Network error'} for ${file.name}: ${errMsg} — waiting for connection (attempt ${attempt}/${MAX_RETRIES} preserved)`);
          await this.waitForNetwork();
          if (this.isCancelled || this.sessionErrorMsg) return;
          await this.sleep(2000); // brief grace period after reconnect
          attempt--; // Don't charge this attempt — the for-loop will re-increment
          skipNextRetryDelay = true;
          continue;
        }

        if (lastError instanceof HttpError) {
          const status = lastError.status;
          const body = lastError.body;

          // The gallery was deleted while uploading — stop everything
          if (body.includes('gallery_photos_gallery_id_fkey')) {
            console.error(`[Upload] 🚫 Gallery ${this.options.galleryId} no longer exists — stopping session`);
            this.failSession(SESSION_ERROR_GALLERY_DELETED);
            return;
          }

          // The target folder row doesn't exist
          if (body.includes('gallery_photos_folder_id_fkey')) {
            const hasFolders = await this.galleryHasFolders();
            if (this.isCancelled || this.sessionErrorMsg) return;
            if (hasFolders === true) {
              // The gallery has other folders, so the photographer deleted this
              // one on the site (the site never deletes the last folder). Don't
              // bring it back — stop the session.
              console.error(`[Upload] 🚫 Folder ${this.options.folderId} was deleted on the site — stopping session`);
              this.failSession(SESSION_ERROR_FOLDER_DELETED);
              return;
            }
            if (hasFolders === false && !this.folderEnsured) {
              // No folders at all: the site's default folder was never saved yet — create it once
              this.folderEnsured = true;
              await this.ensureFolderExists();
              skipNextRetryDelay = true;
              continue;
            }
            // Couldn't tell (network) — normal retry below
          }

          if (status === 403 && !lastError.message.startsWith('R2 PUT') && /storage/i.test(body)) {
            this.failSession('Not enough storage. Please upgrade your plan.');
            return;
          }

          if (status === 401) {
            console.log(`[Upload] 🔑 Got 401 for ${file.name}, refreshing token...`);
            await this.options.refreshToken();
            if (attempt === 1) skipNextRetryDelay = true;
          } else if (status === 403 && lastError.message.startsWith('R2 PUT')) {
            // Presigned URL rejected (expired / clock skew) — get a fresh one
            uploadedToR2 = false;
          } else if (PERMANENT_HTTP_STATUSES.has(status)) {
            return this.failFile(file, lastError.serverMessage, false, errMsg);
          } else if (status === 404 && lastError.message.includes('HTTP 404')) {
            // Server can't find the uploaded original — upload it again
            uploadedToR2 = false;
          }
        }

        const isTimeout = lastError.name === 'AbortError' || lastError.name === 'TimeoutError';
        console.error(`[Upload] ❌ [${attempt}/${MAX_RETRIES}] ${isTimeout ? 'TIMEOUT' : 'ERROR'} for ${file.name}: ${errMsg}`);
      }
    }

    // All retries exhausted — a later retry (button / next app start) may still work
    this.failFile(file, lastError ? describeError(lastError) : 'Unknown error', true);
  }

  private failFile(file: FileEntry, message: string, retryable: boolean, detail?: string): void {
    if (file.withdrawn) return this.finishWithdraw(file);
    file.status = 'error';
    file.error = message;
    file.retryable = retryable;
    console.error(`[Upload] 💀 FAILED (${retryable ? 'retryable' : 'permanent'}): ${file.name} — ${message}${detail && detail !== message ? ` [${detail}]` : ''}`);
    this.notifySettled(file);
    this.options.onFileComplete(file.id, false, message, retryable);
  }

  /** Does the gallery have any folder rows? null = couldn't tell */
  private async galleryHasFolders(): Promise<boolean | null> {
    try {
      const url = `${this.options.supabaseUrl}/rest/v1/gallery_folders?gallery_id=eq.${encodeURIComponent(this.options.galleryId)}&select=id&limit=1`;
      const res = await fetch(url, {
        headers: {
          'apikey': this.options.supabaseKey,
          'Authorization': `Bearer ${this.options.getToken()}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.warn(`[Upload] Folder check HTTP ${res.status}`);
        return null;
      }
      const rows = await res.json();
      return Array.isArray(rows) ? rows.length > 0 : null;
    } catch (err) {
      console.warn('[Upload] Folder check error:', describeError(err));
      return null;
    }
  }

  /**
   * Create the target folder when the gallery has no folder rows at all (the
   * site shows a default folder before it is first saved). Never used for a
   * folder that was deleted on the site.
   * Insert-or-ignore, so an existing folder (and its name) is never touched.
   */
  private async ensureFolderExists(): Promise<void> {
    const folderId = this.options.folderId;
    const token = this.options.getToken();
    const userId = userIdFromToken(token);
    if (!folderId || !userId) return;
    try {
      const res = await fetch(`${this.options.supabaseUrl}/rest/v1/gallery_folders?on_conflict=id`, {
        method: 'POST',
        headers: {
          'apikey': this.options.supabaseKey,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=ignore-duplicates,return=minimal',
        },
        body: JSON.stringify({
          id: folderId,
          gallery_id: this.options.galleryId,
          name: this.options.folderName || 'Folder',
          user_id: userId,
          photographer_id: userId,
          parent_id: null,
          folder_index: 0,
          position: 0,
          is_default: /-folder-1$/.test(folderId),
          photo_count: 0,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      console.log(`[Upload] 📁 Folder ${folderId} was missing — recreate: HTTP ${res.status}`);
    } catch (err) {
      console.warn('[Upload] 📁 Recreating folder failed:', describeError(err));
    }
  }

  // ============================================================================
  // Presign — batched and fetched ahead, so a free slot can start uploading at once
  // ============================================================================

  private hasFreshPresign(file: FileEntry): boolean {
    return !!file.presign && file.presign.size === file.size && Date.now() - file.presign.at < PRESIGN_MAX_AGE;
  }

  /**
   * Upload URL for `file`. On a first attempt it comes from a batch (fetched
   * ahead for the next files); retries and any batch problem use /api/r2/presign.
   */
  private async getPresign(file: FileEntry, allowBatch: boolean, signal: AbortSignal): Promise<PresignResponse> {
    if (allowBatch && !this.batchPresignUnavailable) {
      const inFlight = this.presignInFlight.get(file.id);
      if (inFlight) await inFlight;
      if (!this.hasFreshPresign(file)) {
        try {
          await this.requestPresignBatch(this.pickPresignBatch(file), signal);
        } catch (err) {
          // Same handling as a single presign: refresh the token / stop on a full storage
          if (err instanceof HttpError && (err.status === 401 || (err.status === 403 && /storage/i.test(err.body)))) throw err;
          if (err instanceof HttpError && (err.status === 404 || err.status === 405)) this.batchPresignUnavailable = true;
          console.warn(`[Upload] Batch presign failed for ${file.name}, using single presign:`, describeError(err));
        }
      }
      if (this.hasFreshPresign(file)) {
        const { size: _size, at: _at, ...presign } = file.presign!;
        file.presign = undefined; // a retry must not reuse a URL that may have failed
        this.prefetchPresigns();
        return presign;
      }
    }

    file.presign = undefined;
    const result = await httpPost<{ success: boolean; data: PresignResponse; error?: string }>(
      `${this.options.apiBaseUrl}/api/r2/presign`,
      {
        fileName: file.name,
        contentType: file.type,
        fileSize: file.size,
        galleryId: this.options.galleryId,
        ...(file.lastModified && { captureTime: new Date(file.lastModified).toISOString() }),
      },
      this.options.getToken(),
      PRESIGN_TIMEOUT,
      signal,
    );
    if (!result.success || !result.data?.uploadUrl) {
      throw new Error(`Presign failed: ${result.error || 'no uploadUrl'}`);
    }
    return result.data;
  }

  /** `first` plus the next pending files that have no URL yet */
  private pickPresignBatch(first?: FileEntry): FileEntry[] {
    const rest = this.files.filter((f) =>
      f !== first && f.status === 'pending' && !this.hasFreshPresign(f) && !this.presignInFlight.has(f.id));
    return (first ? [first, ...rest] : rest).slice(0, PRESIGN_BATCH_MAX);
  }

  private requestPresignBatch(files: FileEntry[], signal: AbortSignal): Promise<void> {
    const request = (async () => {
      const result = await httpPost<{ success: boolean; data?: PresignResponse[]; error?: string }>(
        `${this.options.apiBaseUrl}/api/r2/presign-batch`,
        {
          galleryId: this.options.galleryId,
          files: files.map((f) => ({
            fileName: f.name,
            fileSize: f.size,
            contentType: f.type,
            ...(f.lastModified && { captureTime: new Date(f.lastModified).toISOString() }),
          })),
        },
        this.options.getToken(),
        PRESIGN_TIMEOUT,
        signal,
      );
      if (!result.success || !Array.isArray(result.data)) {
        throw new Error(`Batch presign failed: ${result.error || 'no data'}`);
      }
      const at = Date.now();
      // The server answers in request order (and may sign fewer than asked)
      result.data.forEach((data, i) => {
        const f = files[i];
        if (f && data?.uploadUrl) f.presign = { ...data, size: f.size, at };
      });
    })();
    const tracked: Promise<void> = request.catch(() => {}).finally(() => {
      for (const f of files) if (this.presignInFlight.get(f.id) === tracked) this.presignInFlight.delete(f.id);
    });
    for (const f of files) this.presignInFlight.set(f.id, tracked);
    return request;
  }

  /** Keep about one round of URLs ready ahead of the upload slots */
  private prefetchPresigns(): void {
    if (this.batchPresignUnavailable || this.isCancelled || this.isPaused || this.sessionErrorMsg) return;
    if (this.presignInFlight.size > 0) return;
    const ready = this.files.filter((f) => f.status === 'pending' && this.hasFreshPresign(f)).length;
    if (ready >= this.options.concurrency) return;
    const batch = this.pickPresignBatch();
    if (batch.length === 0) return;
    this.requestPresignBatch(batch, this.abortController.signal)
      .catch((err) => console.warn('[Upload] Presign prefetch failed (files will presign on their turn):', describeError(err)));
  }

  // ============================================================================
  // Save the photo record, and confirm saved photos in the DB in batches
  // ============================================================================

  private async saveRecord(file: FileEntry, signal: AbortSignal): Promise<void> {
    const saved = file.saved!;
    await this.processSlots.acquire();
    try {
      const processResult = await httpPost<{ success: boolean; data?: { id?: string; storageKey?: string; needsResponsiveProcessing?: boolean }; error?: string }>(
        `${this.options.apiBaseUrl}/api/r2/process`,
        {
          key: saved.key,
          baseKey: saved.baseKey,
          galleryId: this.options.galleryId,
          fileName: file.name,
          fileSize: file.size,
          instantSave: true,
          ...(saved.width && saved.height && { imageWidth: saved.width, imageHeight: saved.height }),
          ...(this.options.folderId && { folderId: this.options.folderId }),
          ...(file.lastModified && { captureTime: new Date(file.lastModified).toISOString() }),
          ...(file.replacePhotoId && { replacePhotoId: file.replacePhotoId }),
        },
        this.options.getToken(),
        PROCESS_TIMEOUT,
        signal,
      );

      if (!processResult.success) {
        throw new Error(`Process failed: ${processResult.error || 'unknown'}`);
      }

      file.processResult = {
        id: processResult.data?.id || 'unknown',
        storageKey: processResult.data?.storageKey || saved.key,
        needsResponsiveProcessing: processResult.data?.needsResponsiveProcessing ?? true,
      };
    } finally {
      this.processSlots.release();
    }
  }

  private markDone(file: FileEntry): void {
    if (file.status !== 'processing') return;
    file.status = 'done';
    this.notifySettled(file);
    this.emitProgress(file);
    const t = file.timings;
    console.log(`[Upload] ✅ DONE: ${file.name}${t ? ` (presign ${(t.presign / 1000).toFixed(2)}s, upload ${(t.upload / 1000).toFixed(2)}s, save ${(t.save / 1000).toFixed(2)}s)` : ''}`);
    this.options.onFileComplete(file.id, true);
    const photo = file.processResult;
    if (photo?.needsResponsiveProcessing && photo.id !== 'unknown') {
      this.enqueueBackgroundProcessing(photo);
    }
    this.checkCompletion();
  }

  private enqueueVerify(file: FileEntry): void {
    this.verifyQueue.push(file);
    if (this.verifyQueue.length >= VERIFY_BATCH) {
      this.flushVerify();
    } else if (!this.verifyTimer) {
      this.verifyTimer = setTimeout(() => this.flushVerify(), VERIFY_DELAY);
    }
  }

  /**
   * One query confirms a whole batch of saved photos. A photo missing from the
   * DB is saved again; verification errors don't block (same as before).
   */
  private async flushVerify(): Promise<void> {
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = null;
    const batch = this.verifyQueue.splice(0, VERIFY_BATCH * 2).filter((f) => f.status === 'processing');
    if (this.verifyQueue.length > 0) this.verifyTimer = setTimeout(() => this.flushVerify(), 0);
    if (batch.length === 0) return;

    const ids = batch.map((f) => f.processResult!.id);
    let found: Set<string> | null = null;
    try {
      const inList = ids.map((id) => `"${id}"`).join(',');
      const url = `${this.options.supabaseUrl}/rest/v1/gallery_photos?id=in.(${encodeURIComponent(inList)})&select=id`;
      const res = await fetch(url, {
        headers: {
          'apikey': this.options.supabaseKey,
          'Authorization': `Bearer ${this.options.getToken()}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const rows = await res.json() as Array<{ id: string }>;
        found = new Set(Array.isArray(rows) ? rows.map((r) => r.id) : ids);
      } else {
        console.warn(`[Upload] DB verify HTTP ${res.status} for ${ids.length} photos`);
      }
    } catch (err) {
      console.warn(`[Upload] DB verify error for ${ids.length} photos:`, describeError(err));
    }

    for (const file of batch) {
      if (this.isCancelled || file.status !== 'processing') continue;
      if (!found || found.has(file.processResult!.id)) this.markDone(file);
      else void this.resave(file);
    }
  }

  private async resave(file: FileEntry): Promise<void> {
    file.resaves = (file.resaves ?? 0) + 1;
    console.warn(`[Upload] ⚠️ DB verify: photo ${file.processResult?.id} NOT found — saving again (${file.resaves}/${MAX_RESAVES})`);
    if (file.resaves > MAX_RESAVES) {
      this.failFile(file, 'The photo uploaded but wasn’t saved to the gallery', true);
      this.checkCompletion();
      return;
    }
    try {
      await this.saveRecord(file, this.abortController.signal);
      this.enqueueVerify(file);
    } catch (err) {
      if (this.isCancelled || this.sessionErrorMsg) return;
      this.failFile(file, describeError(err), true);
      this.checkCompletion();
    }
  }

  // ============================================================================
  // Progress reporting
  // ============================================================================

  private emitProgress(currentFile: FileEntry): void {
    const now = Date.now();

    currentFile.peakLoaded = Math.max(currentFile.peakLoaded, currentFile.loaded);

    // Throttle to max 5/sec (unless file completed)
    const isComplete = currentFile.status === 'done' || currentFile.status === 'processing';
    if (!isComplete && now - this.lastEmitTime < 200) return;
    this.lastEmitTime = now;

    const counted = this.files.filter((f) => f.status !== 'withdrawn');
    const totalLoaded = counted.reduce((sum, f) => sum + f.peakLoaded, 0);
    const totalSize = counted.reduce((sum, f) => sum + f.size, 0);

    // Speed calculation
    if (now - this.lastCheckTime > 500) {
      const timeDelta = (now - this.lastCheckTime) / 1000;
      const bytesDelta = totalLoaded - this.totalBytesAtLastCheck;
      this.currentSpeed = bytesDelta / timeDelta;
      this.totalBytesAtLastCheck = totalLoaded;
      this.lastCheckTime = now;
    }

    const remaining = totalSize - totalLoaded;
    const eta = this.currentSpeed > 0 ? Math.round(remaining / this.currentSpeed) : 0;

    // Weighted progress: 80% upload + 20% processing
    const UPLOAD_WEIGHT = 0.8;
    let weightedProgress = 0;
    for (const f of counted) {
      const uploadShare = f.size > 0 ? (f.peakLoaded / f.size) : 0;
      let fileProgress: number;
      if (f.status === 'done' || f.status === 'error') fileProgress = 1.0;
      else if (f.status === 'processing') fileProgress = UPLOAD_WEIGHT;
      else fileProgress = uploadShare * UPLOAD_WEIGHT;
      weightedProgress += fileProgress * f.size;
    }

    const weightedPercentage = totalSize > 0 ? Math.round((weightedProgress / totalSize) * 100) : 0;

    this.options.onProgress({
      fileId: currentFile.id,
      fileName: currentFile.name,
      loaded: currentFile.loaded,
      total: currentFile.size,
      percentage: currentFile.size > 0 ? Math.round((currentFile.loaded / currentFile.size) * 100) : 0,
      speed: this.currentSpeed,
      totalLoaded,
      totalSize,
      totalPercentage: Math.min(weightedPercentage, 99),
      eta,
    });
  }

  // ============================================================================
  // Completion check
  // ============================================================================

  private checkCompletion(): void {
    if (this.isFinished || this.isCancelled) return;
    const allDone = this.files.every((f) => f.status === 'done' || f.status === 'error' || f.status === 'withdrawn');
    // Wait for in-flight workers to exit, so nothing reports after completion
    if (!allDone || this.files.length === 0 || this.activeWorkers > 0) return;
    this.isFinished = true;
    this.uploadSlots.unregister(this.starter);

    const totalTime = Math.round((Date.now() - this.startTime) / 1000);
    const success = this.files.filter((f) => f.status === 'done').length;
    const failedFiles = this.files.filter((f) => f.status === 'error');
    const retryableFailed = failedFiles.filter((f) => f.retryable).length;

    console.log(`[Upload] 📊 Complete: ${success} success, ${failedFiles.length} failed (${retryableFailed} retryable), ${totalTime}s`);

    this.options.onAllComplete({
      total: this.files.filter((f) => f.status !== 'withdrawn').length,
      success,
      failed: failedFiles.length,
      retryableFailed,
      totalTime,
      errorMessage: this.sessionErrorMsg || undefined,
    });
  }

  // ============================================================================
  // Background responsive processing (display/blur/tablet versions)
  // ============================================================================

  private enqueueBackgroundProcessing(photo: ProcessResult): void {
    this.backgroundQueue.push(photo);
    if (!this.backgroundRunning) {
      this.backgroundRunning = true;
      this.runBackgroundProcessing().finally(() => { this.backgroundRunning = false; });
    }
  }

  private async runBackgroundProcessing(): Promise<void> {
    while (this.backgroundQueue.length > 0 && !this.isCancelled) {
      const photo = this.backgroundQueue.shift()!;
      try {
        const res = await fetch(`${this.options.apiBaseUrl}/api/r2/process`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.options.getToken()}`,
            'x-uploader-source': 'desktop',
          },
          body: JSON.stringify({
            photoId: photo.id,
            galleryId: this.options.galleryId,
            storageKey: photo.storageKey,
          }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) console.warn(`[Upload] ⚠️ Background HTTP ${res.status}: ${photo.id}`);
      } catch (err) {
        // Not critical — the server cron picks up anything left unprocessed
        console.warn(`[Upload] ⚠️ Background failed: ${photo.id}`, describeError(err));
      }
      await this.sleep(300);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Wait until the network is back online (using Electron's net.isOnline()).
   * Returns immediately if already online. Checks every 3 seconds.
   * Also returns if the queue is cancelled (to avoid hanging forever).
   */
  private waitForNetwork(): Promise<void> {
    if (net.isOnline()) return Promise.resolve();
    console.log('[Upload] 🌐 Network offline — waiting for connection...');
    return new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (this.isCancelled || this.sessionErrorMsg || net.isOnline()) {
          clearInterval(interval);
          if (!this.isCancelled) console.log('[Upload] 🌐 Network restored — resuming upload');
          resolve();
        }
      }, 3000);
    });
  }
}
