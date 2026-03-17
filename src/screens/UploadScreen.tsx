import { useState, useEffect, useCallback, useRef } from 'react';
import type { UploadProgress, UploadStats } from '../../electron/preload';

interface FileItem {
  id: string;
  name: string;
  size: number;
  path: string;
  type: string;
  status: 'pending' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
}

interface UploadScreenProps {
  galleryId: string;
  galleryName: string;
  token: string;
  onBack: () => void;
}

type UploadState = 'idle' | 'uploading' | 'paused' | 'done';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return '--';
  if (seconds < 60) return `${seconds} שניות`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} דקות`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, '0')} שעות`;
}

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif', 'heic', 'heif'];

function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.includes(ext);
}

function getMimeType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    heic: 'image/heic',
    heif: 'image/heif',
  };
  return mimeMap[ext] || 'image/jpeg';
}

export default function UploadScreen({
  galleryId,
  galleryName,
  token,
  onBack,
}: UploadScreenProps) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [totalProgress, setTotalProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [eta, setEta] = useState(0);
  const [stats, setStats] = useState<UploadStats | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  // Listen to upload events
  useEffect(() => {
    const unsubProgress = window.electronAPI.upload.onProgress(
      (progress: UploadProgress) => {
        setTotalProgress(progress.totalPercentage);
        setSpeed(progress.speed);
        setEta(progress.eta);

        setFiles((prev) =>
          prev.map((f) =>
            f.id === progress.fileId
              ? { ...f, progress: progress.percentage, status: 'uploading' }
              : f
          )
        );
      }
    );

    const unsubFileComplete = window.electronAPI.upload.onFileComplete(
      (result) => {
        setFiles((prev) =>
          prev.map((f) =>
            f.id === result.fileId
              ? {
                  ...f,
                  status: result.success ? 'done' : 'error',
                  progress: result.success ? 100 : f.progress,
                  error: result.error,
                }
              : f
          )
        );
      }
    );

    const unsubAllComplete = window.electronAPI.upload.onAllComplete(
      async (completionStats: UploadStats) => {
        setUploadState('done');
        setStats(completionStats);
        await window.electronAPI.power.allowSleep();
        await window.electronAPI.notification.show(
          'ההעלאה הסתיימה',
          `${completionStats.success} מתוך ${completionStats.total} תמונות הועלו בהצלחה`
        );
      }
    );

    return () => {
      unsubProgress();
      unsubFileComplete();
      unsubAllComplete();
    };
  }, []);

  const handleAddFiles = useCallback(async () => {
    const paths = await window.electronAPI.dialog.openFiles();
    addFilePaths(paths);
  }, []);

  const handleAddFolder = useCallback(async () => {
    const paths = await window.electronAPI.dialog.openFolder();
    // For folders, we need to handle differently — the main process returns folder paths
    // We'll need to expand them. For simplicity, we treat them as file paths.
    addFilePaths(paths);
  }, []);

  const addFilePaths = (paths: string[]) => {
    const newFiles: FileItem[] = paths
      .filter((p) => isImageFile(p))
      .filter((p) => !files.some((f) => f.path === p))
      .map((filePath) => {
        const name = filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
        return {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name,
          size: 0, // Will be resolved by main process
          path: filePath,
          type: getMimeType(name),
          status: 'pending' as const,
          progress: 0,
        };
      });

    setFiles((prev) => [...prev, ...newFiles]);
  };

  const handleRemoveFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const handleClearFiles = () => {
    setFiles([]);
    setStats(null);
    setUploadState('idle');
    setTotalProgress(0);
  };

  const handleStartUpload = async () => {
    if (files.length === 0) return;

    setUploadState('uploading');
    setTotalProgress(0);
    setStats(null);

    await window.electronAPI.power.preventSleep();

    const uploadFiles = files.map((f) => ({
      path: f.path,
      name: f.name,
      size: f.size,
      type: f.type,
    }));

    await window.electronAPI.upload.start(uploadFiles, galleryId, token);
  };

  const handlePause = async () => {
    setUploadState('paused');
    await window.electronAPI.upload.pause();
  };

  const handleResume = async () => {
    setUploadState('uploading');
    await window.electronAPI.upload.resume();
  };

  const handleCancel = async () => {
    await window.electronAPI.upload.cancel();
    await window.electronAPI.power.allowSleep();
    setUploadState('idle');
    setTotalProgress(0);
    setFiles((prev) =>
      prev.map((f) => ({ ...f, status: 'pending' as const, progress: 0, error: undefined }))
    );
  };

  // Drag & drop
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);

    // In Electron, File objects have a `path` property
    const droppedFiles = Array.from(e.dataTransfer.files) as Array<File & { path: string }>;
    const imageFiles = droppedFiles.filter((f) => isImageFile(f.name));

    if (imageFiles.length > 0) {
      const newFiles: FileItem[] = imageFiles
        .filter((f) => !files.some((existing) => existing.path === f.path))
        .map((f) => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: f.name,
          size: f.size,
          path: f.path,
          type: getMimeType(f.name),
          status: 'pending' as const,
          progress: 0,
        }));

      setFiles((prev) => [...prev, ...newFiles]);
    }
  };

  const isUploading = uploadState === 'uploading' || uploadState === 'paused';
  const completedCount = files.filter((f) => f.status === 'done').length;
  const failedCount = files.filter((f) => f.status === 'error').length;

  return (
    <div className="flex flex-col h-screen bg-dark-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-dark-border pt-8">
        <div className="flex items-center gap-3">
          {!isUploading && (
            <button
              onClick={onBack}
              className="text-gray-400 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
          <div>
            <h1 className="text-lg font-semibold text-white">{galleryName}</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {files.length} קבצים נבחרו
              {completedCount > 0 && ` · ${completedCount} הועלו`}
              {failedCount > 0 && ` · ${failedCount} נכשלו`}
            </p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {uploadState === 'idle' && files.length > 0 && (
            <button
              onClick={handleStartUpload}
              className="px-4 py-2 bg-brand-primary hover:bg-brand-hover text-white text-sm
                         font-medium rounded-lg transition-colors"
            >
              התחל העלאה
            </button>
          )}
          {uploadState === 'uploading' && (
            <>
              <button
                onClick={handlePause}
                className="px-3 py-2 bg-yellow-600/20 text-yellow-400 text-sm rounded-lg
                           hover:bg-yellow-600/30 transition-colors"
              >
                השהה
              </button>
              <button
                onClick={handleCancel}
                className="px-3 py-2 bg-red-600/20 text-red-400 text-sm rounded-lg
                           hover:bg-red-600/30 transition-colors"
              >
                ביטול
              </button>
            </>
          )}
          {uploadState === 'paused' && (
            <>
              <button
                onClick={handleResume}
                className="px-3 py-2 bg-green-600/20 text-green-400 text-sm rounded-lg
                           hover:bg-green-600/30 transition-colors"
              >
                המשך
              </button>
              <button
                onClick={handleCancel}
                className="px-3 py-2 bg-red-600/20 text-red-400 text-sm rounded-lg
                           hover:bg-red-600/30 transition-colors"
              >
                ביטול
              </button>
            </>
          )}
          {uploadState === 'done' && (
            <button
              onClick={handleClearFiles}
              className="px-4 py-2 bg-dark-card border border-dark-border text-white text-sm
                         rounded-lg hover:bg-dark-hover transition-colors"
            >
              העלאה חדשה
            </button>
          )}
        </div>
      </div>

      {/* Total progress bar */}
      {isUploading && (
        <div className="px-6 py-3 border-b border-dark-border bg-dark-card/50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-300">
              {uploadState === 'paused' ? 'מושהה' : 'מעלה...'}
              {' '}{totalProgress}%
            </span>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>{formatSpeed(speed)}</span>
              <span>זמן משוער: {formatEta(eta)}</span>
            </div>
          </div>
          <div className="w-full h-1.5 bg-dark-bg rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-primary rounded-full transition-all duration-300"
              style={{ width: `${totalProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Completion stats */}
      {uploadState === 'done' && stats && (
        <div className="px-6 py-4 border-b border-dark-border bg-green-500/5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
              <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="text-sm text-green-400 font-medium">ההעלאה הסתיימה</p>
              <p className="text-xs text-gray-500">
                {stats.success} הועלו בהצלחה
                {stats.failed > 0 && ` · ${stats.failed} נכשלו`}
                {' · '}סה״כ {stats.totalTime} שניות
              </p>
            </div>
          </div>
        </div>
      )}

      {/* File list / Drop zone */}
      <div
        className="flex-1 overflow-y-auto p-6"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {files.length === 0 ? (
          <div
            className={`flex flex-col items-center justify-center h-full border-2 border-dashed
                        rounded-2xl transition-colors ${
                          isDragging
                            ? 'border-brand-primary bg-brand-primary/5'
                            : 'border-dark-border'
                        }`}
          >
            <div className="text-center">
              <svg className="w-12 h-12 text-gray-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-gray-400 text-sm mb-1">גררו תמונות לכאן</p>
              <p className="text-gray-600 text-xs mb-4">או</p>
              <div className="flex items-center gap-2 justify-center">
                <button
                  onClick={handleAddFiles}
                  className="px-4 py-2 bg-brand-primary hover:bg-brand-hover text-white text-sm
                             rounded-lg transition-colors"
                >
                  בחרו קבצים
                </button>
                <button
                  onClick={handleAddFolder}
                  className="px-4 py-2 bg-dark-card border border-dark-border text-gray-300 text-sm
                             rounded-lg hover:bg-dark-hover transition-colors"
                >
                  בחרו תיקייה
                </button>
              </div>
              <p className="text-gray-700 text-xs mt-4">
                JPG, PNG, WebP, TIFF, HEIC
              </p>
            </div>
          </div>
        ) : (
          <div>
            {/* Add more files buttons */}
            {uploadState === 'idle' && (
              <div className="flex items-center gap-2 mb-4">
                <button
                  onClick={handleAddFiles}
                  className="px-3 py-1.5 bg-dark-card border border-dark-border text-gray-300
                             text-xs rounded-lg hover:bg-dark-hover transition-colors"
                >
                  + הוסיפו קבצים
                </button>
                <button
                  onClick={handleAddFolder}
                  className="px-3 py-1.5 bg-dark-card border border-dark-border text-gray-300
                             text-xs rounded-lg hover:bg-dark-hover transition-colors"
                >
                  + הוסיפו תיקייה
                </button>
              </div>
            )}

            {/* File list */}
            <div className="space-y-1">
              {files.map((file) => (
                <div
                  key={file.id}
                  className="flex items-center gap-3 px-3 py-2 bg-dark-card rounded-lg border border-dark-border"
                >
                  {/* Status icon */}
                  <div className="w-5 h-5 flex-shrink-0">
                    {file.status === 'pending' && (
                      <div className="w-full h-full rounded-full border-2 border-gray-600" />
                    )}
                    {file.status === 'uploading' && (
                      <svg className="animate-spin w-full h-full text-brand-primary" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    )}
                    {file.status === 'done' && (
                      <svg className="w-full h-full text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {file.status === 'error' && (
                      <svg className="w-full h-full text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                  </div>

                  {/* File info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-300 truncate" dir="ltr">{file.name}</p>
                    {file.error && (
                      <p className="text-xs text-red-400 mt-0.5">{file.error}</p>
                    )}
                  </div>

                  {/* Size */}
                  <span className="text-xs text-gray-600 flex-shrink-0">
                    {file.size > 0 ? formatBytes(file.size) : ''}
                  </span>

                  {/* Progress bar (during upload) */}
                  {file.status === 'uploading' && (
                    <div className="w-20 flex-shrink-0">
                      <div className="w-full h-1 bg-dark-bg rounded-full overflow-hidden">
                        <div
                          className="h-full bg-brand-primary rounded-full transition-all duration-150"
                          style={{ width: `${file.progress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Remove button (only when idle) */}
                  {uploadState === 'idle' && (
                    <button
                      onClick={() => handleRemoveFile(file.id)}
                      className="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
