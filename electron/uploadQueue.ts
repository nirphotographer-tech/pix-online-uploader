import fs from 'fs';
import sizeOf from 'image-size';
import { net } from 'electron';

// ============================================================================
// Types
// ============================================================================

interface FileEntry {
  id: string;
  path: string;
  name: string;
  size: number;
  type: string;
  status: 'pending' | 'uploading' | 'processing' | 'done' | 'error';
  loaded: number;
  peakLoaded: number;
  error?: string;
  /** false = retrying later won't help (bad file, rejected by server) */
  retryable?: boolean;
  lastModified?: number;
  processResult?: ProcessResult;
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
  onAllComplete: (stats: StatsPayload) => void;
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
const R2_PUT_TIMEOUT = 180_000;  // 3 minutes for large files
const PROCESS_TIMEOUT = 120_000; // 2 minutes — covers Vercel cold start + DB write

// Node's fetch reports network failures as "fetch failed" with the OS error in
// err.cause.code — the browser-style "Failed to fetch" never shows up here.
const NETWORK_ERROR_RE = /fetch failed|Failed to fetch|NetworkError|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EPIPE|UND_ERR|socket hang up|other side closed/i;

// Status codes where sending the same request again can't succeed
const PERMANENT_HTTP_STATUSES = new Set([400, 403, 413, 415, 422]);

const SESSION_ERROR_GALLERY_DELETED = 'הגלריה נמחקה מהאתר — ההעלאה נעצרה';

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
  private activeUploads = 0;
  private startTime = 0;
  private totalBytesAtLastCheck = 0;
  private lastCheckTime = 0;
  private currentSpeed = 0;
  private lastEmitTime = 0;
  // Limit concurrent /api/r2/process calls
  private activeProcessCalls = 0;
  private readonly maxProcessConcurrency = 2;
  private processWaiters: Array<() => void> = [];
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
    console.log(`[Upload] Queue created: galleryId=${options.galleryId}, folderId=${options.folderId || 'NONE'}, concurrency=${options.concurrency}`);
  }

  addFiles(files: Array<{ path: string; name: string; size: number; type: string }>): void {
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
      .then((canProceed) => {
        if (canProceed) this.processNext();
      })
      .catch((err) => {
        console.error('[Upload] Storage pre-check failed:', err);
        // On error, proceed anyway — server will block if needed
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
        this.failSession(`אין מספיק מקום באחסון (${usedGB}GB / ${limitGB}GB). שדרגו את החבילה.`);
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
      if (file.status !== 'done' && file.status !== 'error') {
        file.status = 'error';
        file.error = message;
        file.retryable = false;
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
      if (file.status !== 'done' && file.status !== 'error') {
        file.status = 'error';
        file.error = 'ההעלאה בוטלה';
        file.retryable = false;
      }
    }
    this.backgroundQueue = [];
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

  /** Get the file for a given file id (used by UploadManager for persistence) */
  getFile(fileId: string): { path: string; name: string } | undefined {
    return this.files.find((f) => f.id === fileId);
  }

  // ============================================================================
  // Core loop — picks next pending file and runs the pipeline
  // ============================================================================

  private processNext(): void {
    if (this.isCancelled || this.isPaused || this.sessionErrorMsg) return;

    while (this.activeUploads < this.options.concurrency) {
      const nextFile = this.files.find((f) => f.status === 'pending');
      if (!nextFile) break;

      nextFile.status = 'uploading';
      this.activeUploads++;

      // Small stagger between starting concurrent files to avoid thundering herd on API
      const stagger = (this.activeUploads - 1) * 200;

      const start = async () => {
        if (stagger > 0) await this.sleep(stagger);
        return this.uploadFile(nextFile);
      };

      start()
        .catch((err) => { console.error(`[Upload] Unexpected error for ${nextFile.name}:`, describeError(err)); })
        .finally(() => {
          this.activeUploads--;
          this.checkCompletion();
          this.processNext();
        });
    }
  }

  // ============================================================================
  // Per-file pipeline: presign → R2 PUT → process → verify
  // ============================================================================

  private async uploadFile(file: FileEntry): Promise<void> {
    let lastError: Error | null = null;
    let presign: PresignResponse | null = null;
    let uploadedToR2 = false;
    let imageWidth = 0;
    let imageHeight = 0;
    // Set after a network-wait so we skip the normal retry-delay on the next
    // attempt (we already waited for the network; no need to double-sleep).
    let skipNextRetryDelay = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.isCancelled || this.sessionErrorMsg) return;
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
            throw Object.assign(new Error('הקובץ ריק'), { code: 'EMPTYFILE' });
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
          const presignResult = await httpPost<{ success: boolean; data: PresignResponse; error?: string }>(
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

          if (!presignResult.success || !presignResult.data?.uploadUrl) {
            throw new Error(`Presign failed: ${presignResult.error || 'no uploadUrl'}`);
          }
          presign = presignResult.data;

          await httpPut(presign.uploadUrl, fileBuffer, file.type, R2_PUT_TIMEOUT, signal);

          file.loaded = file.size;
          file.peakLoaded = file.size;
          this.emitProgress(file);
          uploadedToR2 = true;
        }

        // ---- Step 3: Save the photo record (server-side) ----
        file.status = 'processing';
        this.emitProgress(file);

        await this.acquireProcessSlot();
        try {
          const processResult = await httpPost<{ success: boolean; data?: { id?: string; storageKey?: string; needsResponsiveProcessing?: boolean }; error?: string }>(
            `${this.options.apiBaseUrl}/api/r2/process`,
            {
              key: presign!.key,
              baseKey: presign!.baseKey,
              galleryId: this.options.galleryId,
              fileName: file.name,
              fileSize: file.size,
              instantSave: true,
              ...(imageWidth && imageHeight && { imageWidth, imageHeight }),
              ...(this.options.folderId && { folderId: this.options.folderId }),
              ...(file.lastModified && { captureTime: new Date(file.lastModified).toISOString() }),
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
            storageKey: processResult.data?.storageKey || presign!.key,
            needsResponsiveProcessing: processResult.data?.needsResponsiveProcessing ?? true,
          };
        } finally {
          this.releaseProcessSlot();
        }

        // ---- Verify photo was saved to DB ----
        const photoId = file.processResult?.id;
        if (photoId && photoId !== 'unknown') {
          const verifyOk = await this.verifyPhotoInDb(photoId);
          if (!verifyOk) {
            throw new Error(`DB verification failed: photo ${photoId} not found after process`);
          }
        }

        // ---- SUCCESS ----
        file.status = 'done';
        this.emitProgress(file);
        console.log(`[Upload] ✅ DONE: ${file.name}`);
        this.options.onFileComplete(file.id, true);
        if (file.processResult?.needsResponsiveProcessing && photoId && photoId !== 'unknown') {
          this.enqueueBackgroundProcessing(file.processResult);
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
            ? 'הקובץ ריק או פגום'
            : code === 'ENOENT'
              ? 'הקובץ לא נמצא במחשב (הועבר או נמחק?)'
              : 'אין הרשאה לקרוא את הקובץ';
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

          // The folder row is gone (e.g. deleted by an autosave on the site) — recreate it once
          if (body.includes('gallery_photos_folder_id_fkey') && !this.folderEnsured) {
            this.folderEnsured = true;
            await this.ensureFolderExists();
            skipNextRetryDelay = true;
            continue;
          }

          if (status === 403 && !lastError.message.startsWith('R2 PUT') && /storage/i.test(body)) {
            this.failSession('אין מספיק מקום באחסון. שדרגו את החבילה.');
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
    this.failFile(file, lastError ? describeError(lastError) : 'שגיאה לא ידועה', true);
  }

  private failFile(file: FileEntry, message: string, retryable: boolean, detail?: string): void {
    file.status = 'error';
    file.error = message;
    file.retryable = retryable;
    console.error(`[Upload] 💀 FAILED (${retryable ? 'retryable' : 'permanent'}): ${file.name} — ${message}${detail && detail !== message ? ` [${detail}]` : ''}`);
    this.options.onFileComplete(file.id, false, message, retryable);
  }

  /**
   * Recreate the target folder if it was deleted while uploading.
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
          name: this.options.folderName || 'תיקייה',
          user_id: userId,
          photographer_id: userId,
          parent_id: null,
          folder_index: 999,
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
  // DB verification — confirm photo was actually saved
  // ============================================================================

  private async verifyPhotoInDb(photoId: string): Promise<boolean> {
    try {
      const url = `${this.options.supabaseUrl}/rest/v1/gallery_photos?id=eq.${encodeURIComponent(photoId)}&select=id`;
      const res = await fetch(url, {
        headers: {
          'apikey': this.options.supabaseKey,
          'Authorization': `Bearer ${this.options.getToken()}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.warn(`[Upload] DB verify HTTP ${res.status} for ${photoId}`);
        return true; // Don't block on verification errors — assume OK
      }
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) return true;
      console.warn(`[Upload] ⚠️ DB verify: photo ${photoId} NOT found — will retry`);
      return false;
    } catch (err) {
      console.warn(`[Upload] DB verify error for ${photoId}:`, describeError(err));
      return true; // Don't block on verification errors
    }
  }

  // ============================================================================
  // Process concurrency limiter
  // ============================================================================

  private acquireProcessSlot(): Promise<void> {
    if (this.activeProcessCalls < this.maxProcessConcurrency) {
      this.activeProcessCalls++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.processWaiters.push(() => {
        this.activeProcessCalls++;
        resolve();
      });
    });
  }

  private releaseProcessSlot(): void {
    this.activeProcessCalls--;
    const next = this.processWaiters.shift();
    if (next) setTimeout(next, 500); // small gap between process calls to avoid overwhelming Vercel
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

    const totalLoaded = this.files.reduce((sum, f) => sum + f.peakLoaded, 0);
    const totalSize = this.files.reduce((sum, f) => sum + f.size, 0);

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
    for (const f of this.files) {
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
    const allDone = this.files.every((f) => f.status === 'done' || f.status === 'error');
    // Wait for in-flight workers to exit, so nothing reports after completion
    if (!allDone || this.files.length === 0 || this.activeUploads > 0) return;
    this.isFinished = true;

    const totalTime = Math.round((Date.now() - this.startTime) / 1000);
    const success = this.files.filter((f) => f.status === 'done').length;
    const failedFiles = this.files.filter((f) => f.status === 'error');
    const retryableFailed = failedFiles.filter((f) => f.retryable).length;

    console.log(`[Upload] 📊 Complete: ${success} success, ${failedFiles.length} failed (${retryableFailed} retryable), ${totalTime}s`);

    this.options.onAllComplete({
      total: this.files.length,
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
