import { useState, useCallback, useRef } from 'react';

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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

interface UploadScreenProps {
  galleryId: string;
  galleryName: string;
  folderId: string;
  folderName: string;
  token: string;
  onBack: () => void;
  onUploadStarted: () => void;
}

interface PendingFile {
  path: string;
  name: string;
  size: number;
  type: string;
}

export default function UploadScreen({
  galleryId,
  galleryName,
  folderId,
  folderName,
  token,
  onBack,
  onUploadStarted,
}: UploadScreenProps) {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [starting, setStarting] = useState(false);
  const dragCounter = useRef(0);

  const addFileInfos = useCallback((fileInfos: Array<{ path: string; name: string; size: number; type: string }>) => {
    setFiles((prev) => {
      const existingPaths = new Set(prev.map((f) => f.path));
      const newFiles = fileInfos.filter((f) => !existingPaths.has(f.path));
      return [...prev, ...newFiles];
    });
  }, []);

  const handleAddFiles = useCallback(async () => {
    const fileInfos = await window.electronAPI.dialog.openFiles();
    addFileInfos(fileInfos);
  }, [addFileInfos]);

  const handleAddFolder = useCallback(async () => {
    const fileInfos = await window.electronAPI.dialog.openFolder();
    addFileInfos(fileInfos);
  }, [addFileInfos]);

  const handleRemoveFile = (path: string) => {
    setFiles((prev) => prev.filter((f) => f.path !== path));
  };

  const handleStartUpload = async () => {
    if (files.length === 0) return;
    setStarting(true);

    try {
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      await window.electronAPI.upload.startSession(
        sessionId,
        files,
        galleryId,
        galleryName,
        folderId,
        folderName,
        token
      );

      // Upload started in background — navigate back
      onUploadStarted();
    } catch (err) {
      console.error('Failed to start upload:', err);
      setStarting(false);
    }
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

    const droppedFiles = Array.from(e.dataTransfer.files) as Array<File & { path: string }>;
    const imageFiles = droppedFiles.filter((f) => isImageFile(f.name));

    if (imageFiles.length > 0) {
      const newFiles: PendingFile[] = imageFiles.map((f) => ({
        name: f.name,
        size: f.size,
        path: f.path,
        type: getMimeType(f.name),
      }));
      addFileInfos(newFiles);
    }
  };

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  return (
    <div className="flex flex-col h-screen bg-dark-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-dark-border pt-8">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <div>
            <h1 className="text-lg font-semibold text-white">{galleryName}</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {folderName !== 'כל הגלריה' ? `📁 ${folderName} · ` : ''}
              {files.length > 0 ? `${files.length} קבצים · ${formatBytes(totalSize)}` : 'בחרו קבצים להעלאה'}
            </p>
          </div>
        </div>

        {/* Upload button */}
        {files.length > 0 && (
          <button
            onClick={handleStartUpload}
            disabled={starting}
            className="px-5 py-2 bg-brand-primary hover:bg-brand-hover text-white text-sm
                       font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {starting ? (
              <>
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                מתחיל...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                העלה {files.length} תמונות
              </>
            )}
          </button>
        )}
      </div>

      {/* Drop zone / File list */}
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
              <svg className="w-16 h-16 text-gray-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-gray-400 text-base mb-1">גררו תמונות לכאן</p>
              <p className="text-gray-600 text-xs mb-5">או</p>
              <div className="flex items-center gap-3 justify-center">
                <button
                  onClick={handleAddFiles}
                  className="px-5 py-2.5 bg-brand-primary hover:bg-brand-hover text-white text-sm
                             rounded-lg transition-colors font-medium"
                >
                  בחרו קבצים
                </button>
                <button
                  onClick={handleAddFolder}
                  className="px-5 py-2.5 bg-dark-card border border-dark-border text-gray-300 text-sm
                             rounded-lg hover:bg-dark-hover transition-colors"
                >
                  בחרו תיקייה
                </button>
              </div>
              <p className="text-gray-700 text-xs mt-5">
                JPG, PNG, WebP, TIFF, HEIC
              </p>
            </div>
          </div>
        ) : (
          <div>
            {/* Add more files */}
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
              <button
                onClick={() => setFiles([])}
                className="px-3 py-1.5 text-gray-600 hover:text-red-400 text-xs transition-colors mr-auto"
              >
                נקה הכל
              </button>
            </div>

            {/* Drag overlay when dragging onto file list */}
            {isDragging && (
              <div className="mb-4 p-4 border-2 border-dashed border-brand-primary rounded-xl bg-brand-primary/5 text-center">
                <p className="text-sm text-brand-primary">שחררו כאן להוספת קבצים</p>
              </div>
            )}

            {/* File list */}
            <div className="space-y-1">
              {files.map((file) => (
                <div
                  key={file.path}
                  className="flex items-center gap-3 px-3 py-2 bg-dark-card rounded-lg border border-dark-border group"
                >
                  <div className="w-5 h-5 flex-shrink-0 rounded-full border-2 border-gray-600" />

                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-300 truncate" dir="ltr">{file.name}</p>
                  </div>

                  <span className="text-xs text-gray-600 flex-shrink-0">
                    {file.size > 0 ? formatBytes(file.size) : ''}
                  </span>

                  <button
                    onClick={() => handleRemoveFile(file.path)}
                    className="text-gray-700 hover:text-red-400 transition-colors flex-shrink-0
                               opacity-0 group-hover:opacity-100"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
