import fs from 'fs';

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
  lastModified?: number;
  processResult?: ProcessResult;
}

interface QueueOptions {
  concurrency: number;
  apiBaseUrl: string;
  token: string;
  galleryId: string;
  folderId?: string;
  supabaseUrl: string;
  supabaseKey: string;
  onProgress: (progress: ProgressPayload) => void;
  onFileComplete: (fileId: string, success: boolean, error?: string) => void;
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
  totalTime: number;
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
const PROCESS_TIMEOUT = 180_000; // 3 minutes for Sharp processing (incl Vercel cold start)

// ============================================================================
// Simple HTTP helpers using fetch (Node 22 / Electron 41)
// ============================================================================

async function httpPost<T>(url: string, body: object, token: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.substring(0, 200)}`);
    }

    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function httpPut(url: string, body: Buffer, contentType: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.length),
      },
      body: body,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`R2 PUT ${res.status}: ${text.substring(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
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

  constructor(options: QueueOptions) {
    this.options = options;
    console.log(`[Upload] Queue created: galleryId=${options.galleryId}, folderId=${options.folderId || 'NONE'}, concurrency=${options.concurrency}`);
  }

  addFiles(files: Array<{ path: string; name: string; size: number; type: string }>): void {
    for (const file of files) {
      console.log(`[Upload] addFiles: name=${file.name}, size=${file.size}`);
      let lastModified: number | undefined;
      try {
        lastModified = fs.statSync(file.path).mtimeMs;
      } catch { /* ignore */ }

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
  }

  start(): void {
    this.startTime = Date.now();
    this.lastCheckTime = Date.now();
    this.isCancelled = false;
    this.isPaused = false;
    this.processNext();
  }

  pause(): void { this.isPaused = true; }

  resume(): void {
    this.isPaused = false;
    this.processNext();
  }

  cancel(): void {
    this.isCancelled = true;
    for (const file of this.files) {
      if (file.status === 'pending' || file.status === 'uploading') {
        file.status = 'error';
        file.error = 'ההעלאה בוטלה';
      }
    }
  }

  // ============================================================================
  // Core loop — picks next pending file and runs the pipeline
  // ============================================================================

  private processNext(): void {
    if (this.isCancelled || this.isPaused) return;

    while (this.activeUploads < this.options.concurrency) {
      const nextFile = this.files.find((f) => f.status === 'pending');
      if (!nextFile) break;

      nextFile.status = 'uploading';
      this.activeUploads++;

      // Small stagger between starting concurrent files to avoid thundering herd on API
      const stagger = (this.activeUploads - 1) * 500;

      const start = async () => {
        if (stagger > 0) await this.sleep(stagger);
        return this.uploadFile(nextFile);
      };

      start()
        .catch(() => { /* handled inside */ })
        .finally(() => {
          this.activeUploads--;
          this.checkCompletion();
          this.processNext();
        });
    }
  }

  // ============================================================================
  // Per-file pipeline: presign → R2 PUT → process → folder assign
  // ============================================================================

  private async uploadFile(file: FileEntry): Promise<void> {
    let lastError: Error | null = null;
    let presign: PresignResponse | null = null;
    let uploadedToR2 = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.isCancelled) break;

      try {
        if (attempt > 1) {
          const delay = RETRY_DELAYS[attempt - 2] || 30000;
          console.log(`[Upload] ⏳ Retry ${attempt}/${MAX_RETRIES} for ${file.name} (waiting ${delay}ms)`);
          await this.sleep(delay);
        }

        // ---- Step 1: Presign (skip if R2 upload already succeeded) ----
        if (!uploadedToR2) {
          file.loaded = 0;
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
            this.options.token,
            PRESIGN_TIMEOUT,
          );

          if (!presignResult.success || !presignResult.data?.uploadUrl) {
            throw new Error(`Presign failed: ${presignResult.error || 'no uploadUrl'}`);
          }
          presign = presignResult.data;
          console.log(`[Upload] [${attempt}] Presign OK: key=${presign.key}`);

          // ---- Step 2: Upload file to R2 ----
          console.log(`[Upload] [${attempt}] Uploading to R2: ${file.name}`);
          const fileBuffer = fs.readFileSync(file.path);
          await httpPut(presign.uploadUrl, fileBuffer, file.type, R2_PUT_TIMEOUT);

          file.loaded = file.size;
          file.peakLoaded = file.size;
          this.emitProgress(file);
          uploadedToR2 = true;
          console.log(`[Upload] [${attempt}] R2 upload OK: ${file.name}`);
        } else {
          console.log(`[Upload] [${attempt}] Skipping R2 upload (already uploaded): ${file.name}`);
        }

        // ---- Step 3: Process (server-side Sharp) ----
        file.status = 'processing';
        this.emitProgress(file);

        await this.acquireProcessSlot();
        try {
          console.log(`[Upload] [${attempt}] Processing: ${file.name}`);
          const processResult = await httpPost<{ success: boolean; data?: { id?: string; storageKey?: string; needsResponsiveProcessing?: boolean }; error?: string }>(
            `${this.options.apiBaseUrl}/api/r2/process`,
            {
              key: presign!.key,
              baseKey: presign!.baseKey,
              galleryId: this.options.galleryId,
              fileName: file.name,
              fileSize: file.size,
              fastMode: true,
              ...(this.options.folderId && { folderId: this.options.folderId }),
              ...(file.lastModified && { captureTime: new Date(file.lastModified).toISOString() }),
            },
            this.options.token,
            PROCESS_TIMEOUT,
          );

          if (!processResult.success) {
            throw new Error(`Process failed: ${processResult.error || 'unknown'}`);
          }

          file.processResult = {
            id: processResult.data?.id || 'unknown',
            storageKey: processResult.data?.storageKey || presign!.key,
            needsResponsiveProcessing: processResult.data?.needsResponsiveProcessing ?? true,
          };
          console.log(`[Upload] [${attempt}] Process OK: ${file.name} → id=${file.processResult.id}`);
        } finally {
          this.releaseProcessSlot();
        }

          // folder_id is set by the process API (folderId is sent in the request body)

        // ---- SUCCESS ----
        file.status = 'done';
        this.emitProgress(file);
        console.log(`[Upload] ✅ DONE: ${file.name}`);
        this.options.onFileComplete(file.id, true);
        return;

      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Mark as uploading again for retry
        file.status = 'uploading';
        
        const isAbort = lastError.name === 'AbortError' || lastError.message.includes('abort');
        const label = isAbort ? 'TIMEOUT' : 'ERROR';
        console.error(`[Upload] ❌ [${attempt}/${MAX_RETRIES}] ${label} for ${file.name}: ${lastError.message}`);
      }
    }

    // All retries exhausted
    file.status = 'error';
    file.error = lastError?.message || 'שגיאה לא ידועה';
    console.error(`[Upload] 💀 FAILED after ${MAX_RETRIES} attempts: ${file.name} — ${file.error}`);
    this.options.onFileComplete(file.id, false, file.error);
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
    if (next) setTimeout(next, 1500); // 1.5s gap between process calls to avoid overwhelming Vercel
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
      if (f.status === 'done') fileProgress = 1.0;
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
  // Completion check + background responsive processing
  // ============================================================================

  private checkCompletion(): void {
    const allDone = this.files.every((f) => f.status === 'done' || f.status === 'error');
    if (!allDone || this.files.length === 0) return;

    const totalTime = Math.round((Date.now() - this.startTime) / 1000);
    const success = this.files.filter((f) => f.status === 'done').length;
    const failed = this.files.filter((f) => f.status === 'error').length;

    console.log(`[Upload] 📊 Complete: ${success} success, ${failed} failed, ${totalTime}s`);

    // Log failed files for debugging
    if (failed > 0) {
      const failedFiles = this.files.filter((f) => f.status === 'error');
      for (const f of failedFiles) {
        console.error(`[Upload] ❌ Failed: ${f.name} — ${f.error}`);
      }
    }

    // Background responsive processing (fire and forget)
    this.triggerBackgroundProcessing();

    this.options.onAllComplete({ total: this.files.length, success, failed, totalTime });
  }

  private triggerBackgroundProcessing(): void {
    const photos = this.files
      .filter((f) => f.status === 'done' && f.processResult?.needsResponsiveProcessing)
      .map((f) => f.processResult!);

    if (photos.length === 0) return;

    console.log(`[Upload] 🔄 Background processing for ${photos.length} photos...`);

    const run = async () => {
      for (const photo of photos) {
        try {
          await fetch(`${this.options.apiBaseUrl}/api/r2/process`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.options.token}`,
            },
            body: JSON.stringify({
              photoId: photo.id,
              galleryId: this.options.galleryId,
              storageKey: photo.storageKey,
            }),
            signal: AbortSignal.timeout(120_000),
          });
          console.log(`[Upload] ✅ Background OK: ${photo.id}`);
        } catch (err) {
          console.warn(`[Upload] ⚠️ Background failed: ${photo.id}`, err);
        }
        // Small delay between calls
        await this.sleep(1000);
      }
    };

    run().catch(() => {});
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
