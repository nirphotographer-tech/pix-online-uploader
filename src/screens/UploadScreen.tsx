import { useState, useCallback, useRef, useEffect } from 'react';

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif', 'heic', 'heif'];
const SUPPORTED_FORMATS_DISPLAY = ['JPG', 'PNG', 'WebP', 'TIFF', 'HEIC'];

function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.includes(ext);
}

function getFileExtension(name: string): string {
  return name.split('.').pop()?.toUpperCase() || '???';
}

function getMimeType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', tiff: 'image/tiff', tif: 'image/tiff',
    heic: 'image/heic', heif: 'image/heif',
  };
  return mimeMap[ext] || 'image/jpeg';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

interface RejectedFilesInfo {
  count: number;
  names: string[];
  extensions: string[];
}

interface DuplicateInfo {
  duplicates: FileInfo[];
  newFiles: FileInfo[];
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
  const [checking, setChecking] = useState(false);
  const [rejectedFiles, setRejectedFiles] = useState<RejectedFilesInfo | null>(null);
  const [duplicateInfo, setDuplicateInfo] = useState<DuplicateInfo | null>(null);
  const [allPendingFiles, setAllPendingFiles] = useState<FileInfo[]>([]);
  const dragCounter = useRef(0);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss rejected files toast
  useEffect(() => {
    if (rejectedFiles) {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      dismissTimer.current = setTimeout(() => {
        setRejectedFiles(null);
      }, 6000);
    }
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, [rejectedFiles]);

  const processFiles = useCallback((allFiles: Array<{ name: string; size: number; path: string }>): { accepted: FileInfo[]; rejected: RejectedFilesInfo | null } => {
    const accepted: FileInfo[] = [];
    const rejectedNames: string[] = [];
    const rejectedExts = new Set<string>();

    for (const f of allFiles) {
      if (isImageFile(f.name)) {
        accepted.push({
          name: f.name,
          size: f.size,
          path: f.path,
          type: getMimeType(f.name),
        });
      } else {
        rejectedNames.push(f.name);
        rejectedExts.add(getFileExtension(f.name));
      }
    }

    const rejected = rejectedNames.length > 0
      ? { count: rejectedNames.length, names: rejectedNames.slice(0, 5), extensions: Array.from(rejectedExts) }
      : null;

    return { accepted, rejected };
  }, []);

  const autoUpload = useCallback(async (fileInfos: FileInfo[]) => {
    if (fileInfos.length === 0) return;
    setStarting(true);
    setDuplicateInfo(null);
    setAllPendingFiles([]);
    try {
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      await window.electronAPI.upload.startSession(
        sessionId, fileInfos, galleryId, galleryName, folderId, folderName, token
      );
      onUploadStarted();
    } catch (err) {
      console.error('Failed to start upload:', err);
      setStarting(false);
    }
  }, [galleryId, galleryName, folderId, folderName, token, onUploadStarted]);

  const checkAndUpload = useCallback(async (acceptedFiles: FileInfo[]) => {
    if (acceptedFiles.length === 0) return;

    setChecking(true);
    try {
      const fileNames = acceptedFiles.map((f) => f.name);
      const existingPhotos = await window.electronAPI.gallery.checkDuplicates(
        galleryId, folderId, fileNames, token
      );

      if (existingPhotos.length === 0) {
        // No duplicates — upload immediately
        autoUpload(acceptedFiles);
        return;
      }

      // Match by file_name + size_bytes (if size is available in DB)
      // Build a lookup: name → list of existing records
      const existingByName = new Map<string, { id: string; size_bytes: number | null }[]>();
      for (const p of existingPhotos) {
        const list = existingByName.get(p.file_name) || [];
        list.push({ id: p.id, size_bytes: p.size_bytes });
        existingByName.set(p.file_name, list);
      }

      const duplicates: FileInfo[] = [];
      const newFiles: FileInfo[] = [];

      for (const file of acceptedFiles) {
        const matches = existingByName.get(file.name);
        if (!matches || matches.length === 0) {
          newFiles.push(file);
          continue;
        }

        // Check if any match also has the same size (or size is null = legacy, treat as dup by name)
        const isDuplicate = matches.some(
          (m) => m.size_bytes === null || m.size_bytes === file.size
        );

        if (isDuplicate) {
          duplicates.push(file);
        } else {
          // Same name but different size — likely a different/updated file, still flag as duplicate
          // (user probably re-edited the photo — let them decide)
          duplicates.push(file);
        }
      }

      if (duplicates.length === 0) {
        autoUpload(acceptedFiles);
        return;
      }

      setDuplicateInfo({ duplicates, newFiles });
      setAllPendingFiles(acceptedFiles);
    } catch (err) {
      console.error('Duplicate check failed, uploading anyway:', err);
      autoUpload(acceptedFiles);
    } finally {
      setChecking(false);
    }
  }, [galleryId, folderId, token, autoUpload]);

  // Duplicate dialog actions
  const handleUploadAll = useCallback(() => {
    autoUpload(allPendingFiles);
  }, [allPendingFiles, autoUpload]);

  const handleSkipDuplicates = useCallback(() => {
    if (duplicateInfo && duplicateInfo.newFiles.length > 0) {
      autoUpload(duplicateInfo.newFiles);
    } else {
      setDuplicateInfo(null);
      setAllPendingFiles([]);
    }
  }, [duplicateInfo, autoUpload]);

  const handleCancelUpload = useCallback(() => {
    setDuplicateInfo(null);
    setAllPendingFiles([]);
  }, []);

  const handleAddFiles = useCallback(async () => {
    const fileInfos = await window.electronAPI.dialog.openFiles();
    if (fileInfos.length > 0) checkAndUpload(fileInfos);
  }, [checkAndUpload]);

  const handleAddFolder = useCallback(async () => {
    const fileInfos = await window.electronAPI.dialog.openFolder();
    if (fileInfos.length > 0) checkAndUpload(fileInfos);
  }, [checkAndUpload]);

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

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);

    console.log('[DROP] handleDrop fired');
    console.log('[DROP] dataTransfer.files count:', e.dataTransfer.files.length);
    console.log('[DROP] dataTransfer.items count:', e.dataTransfer.items.length);

    const rawFiles = Array.from(e.dataTransfer.files) as Array<File & { path?: string }>;
    rawFiles.forEach((f, i) => {
      console.log(`[DROP] file[${i}]: name=${f.name} size=${f.size} path=${JSON.stringify((f as any).path)}`);
    });

    // ── Path-based flow (Electron normally provides file.path) ──
    const filePaths = rawFiles.map((f) => (f as any).path as string | undefined).filter((p): p is string => !!p);
    console.log('[DROP] resolved filePaths:', filePaths);

    let fileInfos: Array<{ name: string; size: number; path: string }> = [];

    if (filePaths.length > 0) {
      console.log('[DROP] calling resolveDroppedFiles via IPC...');
      fileInfos = await window.electronAPI.dialog.resolveDroppedFiles(filePaths);
      console.log('[DROP] resolveDroppedFiles returned:', fileInfos.length, 'files');
    }

    // ── ArrayBuffer fallback: file.path unavailable (Electron 41+ on macOS Sequoia) ──
    if (fileInfos.length === 0 && rawFiles.length > 0) {
      console.warn('[DROP] file.path unavailable — reading files as ArrayBuffer and writing to temp dir');
      try {
        const toWrite: Array<{ name: string; buffer: ArrayBuffer }> = [];
        for (const f of rawFiles) {
          // Skip directories (size 0, no type) — folders can't be read this way
          if (!f.type && f.size === 0) {
            console.warn(`[DROP] skipping likely-directory: ${f.name}`);
            continue;
          }
          const buf = await f.arrayBuffer();
          toWrite.push({ name: f.name, buffer: buf });
        }
        if (toWrite.length > 0) {
          fileInfos = await window.electronAPI.dialog.writeFilesToTemp(toWrite);
          console.log('[DROP] writeFilesToTemp returned:', fileInfos.length, 'files');
        }
      } catch (err) {
        console.error('[DROP] ArrayBuffer fallback failed:', err);
      }
    }

    if (fileInfos.length === 0) {
      console.warn('[DROP] no files resolved — nothing to upload');
      return;
    }

    const { accepted, rejected } = processFiles(fileInfos);
    console.log('[DROP] accepted:', accepted.length, 'rejected:', rejected?.count ?? 0);
    if (rejected) setRejectedFiles(rejected);
    if (accepted.length > 0) checkAndUpload(accepted);
  };

  const dismissRejected = () => {
    setRejectedFiles(null);
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-dark-bg">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-dark-border">
        <button
          onClick={onBack}
          className="w-8 h-8 rounded-lg bg-dark-card border border-dark-border flex items-center justify-center text-gray-400 hover:text-gray-900 hover:border-brand-primary/50 transition-all"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-gray-900 truncate">{galleryName}</h1>
          {folderName && folderName !== 'כל הגלריה' && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="inline-flex items-center gap-1 text-xs text-brand-primary/70 bg-brand-primary/10 px-2 py-0.5 rounded-md">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                {folderName}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Rejected files toast */}
      {rejectedFiles && (
        <div className="mx-5 mt-3 animate-slide-down">
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-red-300 text-sm font-medium mb-0.5" dir="rtl">
                {rejectedFiles.count === 1
                  ? 'קובץ אחד לא נתמך'
                  : `${rejectedFiles.count} קבצים לא נתמכים`}
              </p>
              <p className="text-red-400/60 text-xs leading-relaxed" dir="rtl">
                {rejectedFiles.names.length <= 3
                  ? rejectedFiles.names.join(', ')
                  : `${rejectedFiles.names.slice(0, 3).join(', ')} ועוד ${rejectedFiles.count - 3}...`
                }
              </p>
              <p className="text-red-400/40 text-[10px] mt-1" dir="rtl">
                פורמטים נתמכים: {SUPPORTED_FORMATS_DISPLAY.join(', ')}
              </p>
            </div>
            <button
              onClick={dismissRejected}
              className="w-6 h-6 rounded-md flex items-center justify-center text-red-400/50 hover:text-red-300 hover:bg-red-500/10 transition-all flex-shrink-0"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Duplicate files modal */}
      {duplicateInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-dark-card border border-dark-border rounded-2xl shadow-2xl w-[420px] max-h-[80vh] flex flex-col mx-4 animate-slide-down">
            {/* Modal header */}
            <div className="px-5 pt-5 pb-4 border-b border-dark-border">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-gray-900 text-base font-bold" dir="rtl">נמצאו קבצים כפולים</h2>
                  <p className="text-gray-500 text-xs" dir="rtl">
                    {duplicateInfo.duplicates.length === 1
                      ? 'קובץ אחד כבר קיים בגלריה'
                      : `${duplicateInfo.duplicates.length} קבצים כבר קיימים בגלריה`}
                  </p>
                </div>
              </div>
            </div>

            {/* Duplicate file list */}
            <div className="flex-1 overflow-y-auto px-5 py-3 min-h-0">
              <div className="space-y-2">
                {duplicateInfo.duplicates.slice(0, 10).map((file) => (
                  <div key={file.path} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-dark-bg/60 border border-amber-500/10">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center flex-shrink-0">
                      <svg className="w-4 h-4 text-amber-400/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-700 text-xs font-medium truncate">{file.name}</p>
                      <p className="text-gray-600 text-[10px]">{formatFileSize(file.size)}</p>
                    </div>
                    <span className="text-[10px] text-amber-400/60 bg-amber-500/10 px-1.5 py-0.5 rounded">כפול</span>
                  </div>
                ))}
                {duplicateInfo.duplicates.length > 10 && (
                  <p className="text-gray-600 text-xs text-center py-1" dir="rtl">
                    ועוד {duplicateInfo.duplicates.length - 10} קבצים כפולים...
                  </p>
                )}
              </div>

              {/* Summary */}
              <div className="mt-3 pt-3 border-t border-dark-border/50">
                <div className="flex items-center justify-between text-xs" dir="rtl">
                  <span className="text-gray-500">סה״כ קבצים:</span>
                  <span className="text-gray-700">{allPendingFiles.length}</span>
                </div>
                <div className="flex items-center justify-between text-xs mt-1" dir="rtl">
                  <span className="text-amber-400/70">כפולים:</span>
                  <span className="text-amber-400">{duplicateInfo.duplicates.length}</span>
                </div>
                {duplicateInfo.newFiles.length > 0 && (
                  <div className="flex items-center justify-between text-xs mt-1" dir="rtl">
                    <span className="text-emerald-400/70">חדשים:</span>
                    <span className="text-emerald-400">{duplicateInfo.newFiles.length}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Modal actions */}
            <div className="px-5 py-4 border-t border-dark-border space-y-2">
              {/* Upload all anyway */}
              <button
                onClick={handleUploadAll}
                className="w-full py-2.5 bg-brand-primary hover:bg-brand-hover text-white text-sm rounded-md transition-all duration-200 font-semibold hover:shadow-lg hover:shadow-brand-primary/20"
              >
                העלו הכל בכל זאת ({allPendingFiles.length})
              </button>

              {/* Skip duplicates */}
              {duplicateInfo.newFiles.length > 0 && (
                <button
                  onClick={handleSkipDuplicates}
                  className="w-full py-2.5 bg-dark-bg border border-gray-400 text-gray-700 text-sm rounded-md hover:bg-dark-hover hover:border-brand-primary/30 hover:text-gray-900 transition-all duration-200"
                >
                  דלגו על כפולים, העלו רק חדשים ({duplicateInfo.newFiles.length})
                </button>
              )}

              {/* Cancel */}
              <button
                onClick={handleCancelUpload}
                className="w-full py-2 text-gray-600 text-xs hover:text-gray-400 transition-colors"
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drop zone */}
      <div
        className="flex-1 overflow-y-scroll p-5 min-h-0"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div
          className={`relative flex flex-col items-center justify-center h-full rounded-2xl transition-all duration-300 overflow-hidden ${
            starting
              ? 'bg-brand-primary/5'
              : checking
                ? 'bg-amber-500/5'
                : isDragging
                  ? 'bg-brand-primary/[0.08]'
                  : 'bg-dark-card/50'
          }`}
        >
          {/* Animated border */}
          <div className={`absolute inset-0 rounded-2xl transition-all duration-300 pointer-events-none ${
            isDragging
              ? 'border-2 border-brand-primary shadow-[inset_0_0_30px_rgba(99,102,241,0.1)]'
              : starting
                ? 'border-2 border-brand-primary/40'
                : checking
                  ? 'border-2 border-amber-500/30'
                  : 'border-2 border-dashed border-dark-border'
          }`} />

          {/* Drag active glow */}
          {isDragging && (
            <div className="absolute inset-0 rounded-2xl pointer-events-none">
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 bg-brand-primary/20 rounded-full blur-3xl" />
            </div>
          )}

          {checking ? (
            /* Checking for duplicates state */
            <div className="text-center relative z-10">
              <div className="relative w-16 h-16 mx-auto mb-4">
                <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center">
                  <svg className="animate-spin w-7 h-7 text-amber-400" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              </div>
              <p className="text-amber-400 text-sm font-medium mb-1">בודק כפילויות...</p>
              <p className="text-gray-600 text-xs">מוודא שאין קבצים שכבר קיימים בגלריה</p>
            </div>
          ) : starting ? (
            <div className="text-center relative z-10">
              <div className="relative w-20 h-20 mx-auto mb-5">
                <div className="absolute inset-0 rounded-full bg-brand-primary/20 animate-ping" />
                <div className="absolute inset-2 rounded-full bg-brand-primary/10 animate-pulse" />
                <div className="relative w-20 h-20 rounded-full bg-gradient-to-br from-brand-primary/20 to-brand-primary/5 flex items-center justify-center">
                  <svg className="animate-spin w-8 h-8 text-brand-primary" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              </div>
              <p className="text-brand-primary text-base font-semibold mb-1">מתחיל העלאה...</p>
              <p className="text-gray-500 text-xs">ההעלאה תמשיך ברקע, ניתן לנווט חופשי</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center text-center relative z-10 px-6 w-full">
              {/* Cloud upload icon */}
              <div className={`relative w-20 h-20 mx-auto mb-5 transition-all duration-300 ${isDragging ? 'scale-110 -translate-y-2' : ''}`}>
                <div className={`w-20 h-20 rounded-2xl flex items-center justify-center transition-all duration-300 ${
                  isDragging
                    ? 'bg-brand-primary/20 shadow-lg shadow-brand-primary/10'
                    : 'bg-gradient-to-br from-dark-card to-dark-bg border border-dark-border'
                }`}>
                  <svg className={`w-9 h-9 transition-all duration-300 ${isDragging ? 'text-brand-primary' : 'text-gray-500'}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.2}
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                </div>
                {/* Decorative dots */}
                <div className={`absolute -top-1 -right-1 w-3 h-3 rounded-full transition-all duration-300 ${isDragging ? 'bg-brand-primary/60 scale-100' : 'bg-dark-border scale-75'}`} />
                <div className={`absolute -bottom-1 -left-1 w-2 h-2 rounded-full transition-all duration-300 ${isDragging ? 'bg-brand-hover/50 scale-100' : 'bg-dark-border scale-75'}`} />
              </div>

              {isDragging ? (
                <>
                  <p className="text-brand-primary text-lg font-semibold mb-1">שחררו כאן! ✨</p>
                  <p className="text-brand-primary/60 text-sm">ההעלאה תתחיל מיד</p>
                </>
              ) : (
                <>
                  <p className="text-gray-900 text-base font-semibold mb-1">גררו תמונות לכאן</p>
                  <p className="text-gray-500 text-xs mb-6">ההעלאה תתחיל אוטומטית ברגע שתשחררו</p>

                  <div className="flex items-center gap-3 justify-center mb-6">
                    <button
                      onClick={handleAddFiles}
                      className="px-6 py-2.5 bg-brand-primary hover:bg-brand-hover text-white text-sm rounded-md transition-all duration-200 font-semibold hover:shadow-lg hover:shadow-brand-primary/20 hover:-translate-y-0.5 active:translate-y-0"
                    >
                      ✨ בחרו קבצים
                    </button>
                    <button
                      onClick={handleAddFolder}
                      className="px-6 py-2.5 bg-dark-card border border-gray-400 text-gray-700 text-sm rounded-md hover:bg-dark-hover hover:border-brand-primary/50 hover:text-gray-900 transition-all duration-200 font-medium"
                    >
                      📁 בחרו תיקייה
                    </button>
                  </div>

                  <div className="flex items-center justify-center gap-1.5 flex-wrap">
                    {SUPPORTED_FORMATS_DISPLAY.map((fmt) => (
                      <span key={fmt} className="px-2 py-0.5 text-[10px] text-gray-600 bg-dark-bg rounded-md border border-dark-border/50">
                        {fmt}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
