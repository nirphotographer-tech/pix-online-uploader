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

interface UploadScreenProps {
  galleryId: string;
  galleryName: string;
  folderId: string;
  folderName: string;
  token: string;
  onBack: () => void;
  onUploadStarted: () => void;
}

interface FileInfo {
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
  const [isDragging, setIsDragging] = useState(false);
  const [starting, setStarting] = useState(false);
  const dragCounter = useRef(0);

  const autoUpload = useCallback(async (fileInfos: FileInfo[]) => {
    if (fileInfos.length === 0) return;
    setStarting(true);
    try {
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      await window.electronAPI.upload.startSession(
        sessionId,
        fileInfos,
        galleryId,
        galleryName,
        folderId,
        folderName,
        token
      );
      onUploadStarted();
    } catch (err) {
      console.error('Failed to start upload:', err);
      setStarting(false);
    }
  }, [galleryId, galleryName, folderId, folderName, token, onUploadStarted]);

  const handleAddFiles = useCallback(async () => {
    const fileInfos = await window.electronAPI.dialog.openFiles();
    if (fileInfos.length > 0) autoUpload(fileInfos);
  }, [autoUpload]);

  const handleAddFolder = useCallback(async () => {
    const fileInfos = await window.electronAPI.dialog.openFolder();
    if (fileInfos.length > 0) autoUpload(fileInfos);
  }, [autoUpload]);

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
      const newFiles: FileInfo[] = imageFiles.map((f) => ({
        name: f.name,
        size: f.size,
        path: f.path,
        type: getMimeType(f.name),
      }));
      autoUpload(newFiles);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-dark-bg">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-dark-border pt-8">
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
            {folderName !== 'כל הגלריה' ? `📁 ${folderName}` : ''}
          </p>
        </div>
      </div>

      {/* Drop zone - always shown */}
      <div
        className="flex-1 overflow-y-auto p-6"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div
          className={`flex flex-col items-center justify-center h-full border-2 border-dashed
                      rounded-2xl transition-colors ${
                        starting
                          ? 'border-brand-primary/50 bg-brand-primary/5'
                          : isDragging
                            ? 'border-brand-primary bg-brand-primary/10'
                            : 'border-dark-border'
                      }`}
        >
          {starting ? (
            <div className="text-center">
              <svg className="animate-spin w-12 h-12 text-brand-primary mx-auto mb-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="text-brand-primary text-base font-medium">מתחיל העלאה...</p>
              <p className="text-gray-500 text-xs mt-1">ההעלאה תמשיך ברקע</p>
            </div>
          ) : (
            <div className="text-center">
              <svg className="w-16 h-16 text-gray-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-gray-400 text-base mb-1">גררו תמונות לכאן</p>
              <p className="text-gray-600 text-xs mb-1">ההעלאה תתחיל אוטומטית</p>
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
          )}
        </div>
      </div>
    </div>
  );
}
