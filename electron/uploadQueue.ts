import fs from 'fs';
import https from 'https';
import http from 'http';
import { URL } from 'url';

interface FileEntry {
  id: string;
  path: string;
  name: string;
  size: number;
  type: string;
  status: 'pending' | 'uploading' | 'processing' | 'done' | 'error';
  loaded: number;
  peakLoaded: number; // highest loaded value - never goes down
  error?: string;
  abortController?: AbortController;
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

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 5000]; // ms

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

  constructor(options: QueueOptions) {
    this.options = options;
    console.log(`[Upload] Queue created: galleryId=${options.galleryId}, folderId=${options.folderId || 'NONE'}, concurrency=${options.concurrency}`);
  }

  addFiles(
    files: Array<{ path: string; name: string; size: number; type: string }>
  ): void {
    for (const file of files) {
      console.log(`[Upload] addFiles: name=${file.name}, path=${file.path}, size=${file.size}`);
      // Get file lastModified time from disk
      let lastModified: number | undefined;
      try {
        const stat = fs.statSync(file.path);
        lastModified = stat.mtimeMs;
      } catch {
        // ignore
      }

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

  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    this.isPaused = false;
    this.processNext();
  }

  cancel(): void {
    this.isCancelled = true;
    for (const file of this.files) {
      if (file.status === 'uploading' && file.abortController) {
        file.abortController.abort();
      }
      if (file.status === 'pending' || file.status === 'uploading') {
        file.status = 'error';
        file.error = 'ההעלאה בוטלה';
      }
    }
  }

  private processNext(): void {
    if (this.isCancelled || this.isPaused) return;

    while (this.activeUploads < this.options.concurrency) {
      const nextFile = this.files.find((f) => f.status === 'pending');
      if (!nextFile) break;

      nextFile.status = 'uploading';
      this.activeUploads++;
      this.uploadFile(nextFile).catch(() => {
        // Error handled in uploadFile
      });
    }
  }

  private async uploadFile(file: FileEntry): Promise<void> {
    let lastError: Error | null = null;

    try {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 1) {
            console.log(`[Upload] Retry ${attempt}/${MAX_RETRIES} for ${file.name}`);
            await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 2]));
            file.loaded = 0;
          }
          console.log(`[Upload] === Starting upload: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB) ===`);

          // Step 1: Get presigned URL
          const presign = await this.presignFile(file);

          // Step 2: Upload to R2
          file.abortController = new AbortController();
          await this.uploadToR2(file, presign.uploadUrl);

          // Step 3: Process uploaded file
          file.status = 'processing';
          this.emitProgress(file); // broadcast processing state
          const processResult = await this.processFile(file, presign);
          file.processResult = processResult;

          // Step 4: Assign to correct folder via Supabase if folderId specified
          if (this.options.folderId && processResult.id && processResult.id !== 'unknown') {
            await this.updatePhotoFolder(processResult.id, this.options.folderId);
          }

          file.status = 'done';
          this.emitProgress(file); // broadcast done state — weighted progress now 100% for this file
          console.log(`[Upload] === DONE: ${file.name} ===`);
          this.options.onFileComplete(file.id, true);
          return; // success — exit retry loop
        } catch (err) {
          lastError = err instanceof Error ? err : new Error('שגיאה לא ידועה');
          if (this.isCancelled) break; // don't retry if cancelled
          if (attempt < MAX_RETRIES) {
            console.warn(`[Upload] Attempt ${attempt} failed for ${file.name}: ${lastError.message}`);
          }
        }
      }

      // All retries exhausted
      if (!this.isCancelled) {
        file.status = 'error';
        file.error = lastError?.message || 'שגיאה לא ידועה';
        console.error(`[Upload] === FAILED after ${MAX_RETRIES} attempts: ${file.name} — ${file.error} ===`);
        this.options.onFileComplete(file.id, false, file.error);
      }
    } finally {
      this.activeUploads--;
      this.checkCompletion();
      this.processNext();
    }
  }

  private presignFile(file: FileEntry): Promise<PresignResponse> {
    return new Promise((resolve, reject) => {
      const captureTime = file.lastModified
        ? new Date(file.lastModified).toISOString()
        : undefined;

      const body = JSON.stringify({
        fileName: file.name,
        contentType: file.type,
        fileSize: file.size,
        galleryId: this.options.galleryId,
        ...(captureTime && { captureTime }),
      });

      const url = new URL(`${this.options.apiBaseUrl}/api/r2/presign`);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      console.log(`[Upload] Presigning ${file.name} for gallery ${this.options.galleryId}`);

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${this.options.token}`,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(data);
                // API returns { success: true, data: { uploadUrl, key, baseKey, ... } }
                const presignData = parsed.data || parsed;
                if (!presignData.uploadUrl || !presignData.key) {
                  console.error('[Upload] Presign response missing fields:', JSON.stringify(parsed));
                  reject(new Error('תגובה חסרה מהשרת - אין קישור העלאה'));
                  return;
                }
                console.log(`[Upload] Presign OK: key=${presignData.key}`);
                resolve(presignData as PresignResponse);
              } catch {
                console.error('[Upload] Presign parse error, raw:', data);
                reject(new Error('תגובה לא תקינה מהשרת'));
              }
            } else {
              console.error(`[Upload] Presign failed: ${res.statusCode}`, data);
              reject(new Error(`שגיאה בקבלת קישור העלאה: ${res.statusCode} - ${data}`));
            }
          });
        }
      );

      req.on('error', (err) => {
        console.error('[Upload] Presign network error:', err.message);
        reject(err);
      });
      req.write(body);
      req.end();
    });
  }

  private uploadToR2(file: FileEntry, uploadUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[Upload] uploadToR2: file.path=${file.path}, uploadUrl=${uploadUrl?.substring(0, 80)}...`);
      const fileBuffer = fs.readFileSync(file.path);
      const url = new URL(uploadUrl);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'PUT',
          headers: {
            'Content-Type': file.type,
            'Content-Length': fileBuffer.length,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              console.log(`[Upload] PUT to R2 OK for ${file.name} (status ${res.statusCode})`);
              file.loaded = file.size;
              this.emitProgress(file);
              resolve();
            } else {
              console.error(`[Upload] PUT to R2 FAILED for ${file.name}: ${res.statusCode}`, data);
              reject(new Error(`שגיאה בהעלאת קובץ: ${res.statusCode} - ${data}`));
            }
          });
        }
      );

      // Track upload progress using drain events
      let bytesWritten = 0;
      const chunkSize = 64 * 1024; // 64KB chunks
      let offset = 0;

      const writeChunk = (): void => {
        if (this.isCancelled || file.abortController?.signal.aborted) {
          req.destroy();
          reject(new Error('ההעלאה בוטלה'));
          return;
        }

        let canWrite = true;
        while (canWrite && offset < fileBuffer.length) {
          const end = Math.min(offset + chunkSize, fileBuffer.length);
          const chunk = fileBuffer.subarray(offset, end);
          canWrite = req.write(chunk);
          bytesWritten += chunk.length;
          offset = end;

          file.loaded = bytesWritten;
          this.emitProgress(file);
        }

        if (offset >= fileBuffer.length) {
          req.end();
        }
      };

      req.on('drain', writeChunk);
      req.on('error', (err) => reject(err));

      writeChunk();
    });
  }

  private processFile(
    file: FileEntry,
    presign: PresignResponse
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const captureTime = file.lastModified
        ? new Date(file.lastModified).toISOString()
        : undefined;

      const body = JSON.stringify({
        key: presign.key,
        baseKey: presign.baseKey,
        galleryId: this.options.galleryId,
        fileName: file.name,
        fileSize: file.size,
        fastMode: true,
        ...(captureTime && { captureTime }),
      });

      const url = new URL(`${this.options.apiBaseUrl}/api/r2/process`);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      console.log(`[Upload] Processing ${file.name} (key: ${presign.key}, folderId: ${this.options.folderId || 'NONE'})`);

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${this.options.token}`,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(data);
                if (parsed.success === false) {
                  console.error(`[Upload] Process API returned success:false for ${file.name}:`, parsed.error);
                  reject(new Error(`שגיאה בעיבוד: ${parsed.error || 'unknown'}`));
                  return;
                }
                console.log(`[Upload] Process response for ${file.name}:`, JSON.stringify(parsed.data || parsed).substring(0, 300));
                const result: ProcessResult = {
                  id: parsed.data?.id || 'unknown',
                  storageKey: parsed.data?.storageKey || presign.key,
                  needsResponsiveProcessing: parsed.data?.needsResponsiveProcessing ?? true,
                };
                console.log(`[Upload] Process OK for ${file.name}: photo id=${result.id}`);
                resolve(result);
              } catch {
                // If response isn't JSON but status is 2xx, still OK
                console.log(`[Upload] Process OK for ${file.name} (non-JSON response)`);
                resolve({ id: 'unknown', storageKey: presign.key, needsResponsiveProcessing: true });
              }
            } else {
              console.error(`[Upload] Process FAILED for ${file.name}: ${res.statusCode}`, data);
              reject(new Error(`שגיאה בעיבוד הקובץ: ${res.statusCode} - ${data}`));
            }
          });
        }
      );

      req.on('error', (err) => {
        console.error('[Upload] Process network error:', err.message);
        reject(err);
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Update photo's folder_id directly via Supabase REST API
   * Called after process step succeeds to assign photo to the correct folder
   */
  private updatePhotoFolder(photoId: string, folderId: string): Promise<void> {
    return new Promise((resolve) => {
      const body = JSON.stringify({ folder_id: folderId });

      // PATCH gallery_photos where id = photoId
      const url = new URL(
        `${this.options.supabaseUrl}/rest/v1/gallery_photos?id=eq.${photoId}`
      );
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      console.log(`[Upload] Updating folder for photo ${photoId} → ${folderId}`);

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            apikey: this.options.supabaseKey,
            Authorization: `Bearer ${this.options.supabaseKey}`,
            Prefer: 'return=minimal',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              console.log(`[Upload] ✅ Folder updated for photo ${photoId}`);
              resolve();
            } else {
              console.warn(`[Upload] ⚠️ Folder update failed for photo ${photoId}: ${res.statusCode}`, data);
              // Non-fatal: photo uploaded OK, just folder assignment failed
              resolve();
            }
          });
        }
      );

      req.on('error', (err) => {
        console.warn(`[Upload] ⚠️ Folder update error for ${photoId}:`, err.message);
        resolve(); // non-fatal
      });
      req.write(body);
      req.end();
    });
  }

  private emitProgress(currentFile: FileEntry): void {
    const now = Date.now();

    // Update peakLoaded - never goes down
    currentFile.peakLoaded = Math.max(currentFile.peakLoaded, currentFile.loaded);

    // For total progress: use peakLoaded so retries don't cause progress to go backwards
    const totalLoaded = this.files.reduce((sum, f) => sum + f.peakLoaded, 0);
    const totalSize = this.files.reduce((sum, f) => sum + f.size, 0);

    // Calculate speed every 500ms
    if (now - this.lastCheckTime > 500) {
      const timeDelta = (now - this.lastCheckTime) / 1000;
      const bytesDelta = totalLoaded - this.totalBytesAtLastCheck;
      this.currentSpeed = bytesDelta / timeDelta;
      this.totalBytesAtLastCheck = totalLoaded;
      this.lastCheckTime = now;
    }

    const remaining = totalSize - totalLoaded;
    const eta =
      this.currentSpeed > 0 ? Math.round(remaining / this.currentSpeed) : 0;

    // Weighted progress: upload bytes = 80% of progress, processing = 20%
    // This prevents the progress bar from jumping to 100% before processing is done
    const UPLOAD_WEIGHT = 0.8;
    let weightedProgress = 0;

    for (const f of this.files) {
      const uploadShare = f.size > 0 ? (f.peakLoaded / f.size) : 0;
      let fileProgress: number;
      if (f.status === 'done') {
        fileProgress = 1.0; // fully done
      } else if (f.status === 'processing') {
        fileProgress = UPLOAD_WEIGHT; // upload done, processing in progress
      } else {
        fileProgress = uploadShare * UPLOAD_WEIGHT; // uploading
      }
      weightedProgress += fileProgress * f.size;
    }

    const weightedPercentage = totalSize > 0
      ? Math.round((weightedProgress / totalSize) * 100)
      : 0;

    this.options.onProgress({
      fileId: currentFile.id,
      fileName: currentFile.name,
      loaded: currentFile.loaded,
      total: currentFile.size,
      percentage: currentFile.size > 0
        ? Math.round((currentFile.loaded / currentFile.size) * 100)
        : 0,
      speed: this.currentSpeed,
      totalLoaded,
      totalSize,
      totalPercentage: Math.min(weightedPercentage, 99), // never show 100% until truly done
      eta,
    });
  }

  private checkCompletion(): void {
    const allDone = this.files.every(
      (f) => f.status === 'done' || f.status === 'error'
    );
    if (allDone && this.files.length > 0) {
      const totalTime = Math.round((Date.now() - this.startTime) / 1000);
      const success = this.files.filter((f) => f.status === 'done').length;
      const failed = this.files.filter((f) => f.status === 'error').length;

      // 🚀 Trigger background processing for responsive versions (non-blocking)
      this.triggerBackgroundProcessing();

      this.options.onAllComplete({
        total: this.files.length,
        success,
        failed,
        totalTime,
      });
    }
  }

  /**
   * Background processing: PUT /api/r2/process for responsive image versions
   * Runs after all uploads complete, 2 at a time, non-blocking
   */
  private triggerBackgroundProcessing(): void {
    const photosToProcess = this.files
      .filter((f) => f.status === 'done' && f.processResult?.needsResponsiveProcessing)
      .map((f) => f.processResult!);

    if (photosToProcess.length === 0) {
      console.log('[Upload] No photos need background processing');
      return;
    }

    console.log(`[Upload] 🔄 Starting background processing for ${photosToProcess.length} photos...`);
    const CONCURRENT = 2;

    const processQueue = async () => {
      for (let i = 0; i < photosToProcess.length; i += CONCURRENT) {
        const batch = photosToProcess.slice(i, i + CONCURRENT);
        await Promise.all(batch.map((photo) => this.backgroundProcess(photo)));
      }
      console.log(`[Upload] ✅ Background processing complete for all ${photosToProcess.length} photos`);
    };

    // Fire and forget
    processQueue().catch((err) => {
      console.error('[Upload] Background processing error:', err);
    });
  }

  private backgroundProcess(photo: ProcessResult): Promise<void> {
    return new Promise((resolve) => {
      const body = JSON.stringify({
        photoId: photo.id,
        galleryId: this.options.galleryId,
        storageKey: photo.storageKey,
      });

      const url = new URL(`${this.options.apiBaseUrl}/api/r2/process`);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${this.options.token}`,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              console.log(`[Upload] ✅ Background process OK for photo ${photo.id}`);
            } else {
              console.warn(`[Upload] ⚠️ Background process failed for photo ${photo.id}: ${res.statusCode}`);
            }
            resolve(); // always resolve — background processing is optional
          });
        }
      );

      req.on('error', (err) => {
        console.warn(`[Upload] ⚠️ Background process error for ${photo.id}:`, err.message);
        resolve(); // non-fatal
      });
      req.write(body);
      req.end();
    });
  }
}
