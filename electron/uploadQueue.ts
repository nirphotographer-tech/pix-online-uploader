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
  error?: string;
  abortController?: AbortController;
}

interface QueueOptions {
  concurrency: number;
  apiBaseUrl: string;
  token: string;
  galleryId: string;
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
  }

  addFiles(
    files: Array<{ path: string; name: string; size: number; type: string }>
  ): void {
    for (const file of files) {
      this.files.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        path: file.path,
        name: file.name,
        size: file.size,
        type: file.type || 'image/jpeg',
        status: 'pending',
        loaded: 0,
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
    try {
      // Step 1: Get presigned URL
      const presign = await this.presignFile(file);

      // Step 2: Upload to R2
      file.abortController = new AbortController();
      await this.uploadToR2(file, presign.uploadUrl);

      // Step 3: Process uploaded file
      file.status = 'processing';
      await this.processFile(file, presign);

      file.status = 'done';
      this.options.onFileComplete(file.id, true);
    } catch (err) {
      if (!this.isCancelled) {
        file.status = 'error';
        file.error = err instanceof Error ? err.message : 'שגיאה לא ידועה';
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
      const body = JSON.stringify({
        fileName: file.name,
        contentType: file.type,
        fileSize: file.size,
        galleryId: this.options.galleryId,
      });

      const url = new URL(`${this.options.apiBaseUrl}/api/r2/presign`);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

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
                resolve(JSON.parse(data) as PresignResponse);
              } catch {
                reject(new Error('תגובה לא תקינה מהשרת'));
              }
            } else {
              reject(new Error(`שגיאה בקבלת קישור העלאה: ${res.statusCode}`));
            }
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    });
  }

  private uploadToR2(file: FileEntry, uploadUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
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
              file.loaded = file.size;
              this.emitProgress(file);
              resolve();
            } else {
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
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        key: presign.key,
        baseKey: presign.baseKey,
        galleryId: this.options.galleryId,
        fileName: file.name,
        fileSize: file.size,
        fastMode: true,
      });

      const url = new URL(`${this.options.apiBaseUrl}/api/r2/process`);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

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
              resolve();
            } else {
              reject(new Error(`שגיאה בעיבוד הקובץ: ${res.statusCode}`));
            }
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    });
  }

  private emitProgress(currentFile: FileEntry): void {
    const now = Date.now();
    const totalLoaded = this.files.reduce((sum, f) => sum + f.loaded, 0);
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
      totalPercentage: totalSize > 0
        ? Math.round((totalLoaded / totalSize) * 100)
        : 0,
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
      this.options.onAllComplete({
        total: this.files.length,
        success,
        failed,
        totalTime,
      });
    }
  }
}
