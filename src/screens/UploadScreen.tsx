import { useState, useCallback, useRef, useEffect } from 'react';
import { checkFolder } from '../lib/folderCheck';
import { onFoldersChanged } from '../lib/galleryChannel';
import { supabase } from '../lib/supabase';
import { classifyFiles, hasDuplicates } from '../lib/duplicates';
import DuplicateDialog, { type DuplicateChoice, type DuplicateDialogState } from '../components/DuplicateDialog';

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif', 'heic', 'heif'];
const SUPPORTED_FORMATS_DISPLAY = ['JPG', 'PNG', 'WebP', 'TIFF', 'HEIC'];

function isImageFile(name: string): boolean {
  if (name.startsWith('.')) return false; // macOS "._" metadata files on memory cards
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

interface UploadScreenProps {
  galleryId: string;
  galleryName: string;
  folderId: string;
  folderName: string;
  token: string;
  onBack: () => void;
  onUploadStarted: () => void;
  /** The gallery itself was deleted on the website */
  onGalleryDeleted: () => void;
}

interface FileInfo {
  path: string;
  name: string;
  size: number;
  type: string;
  /** "Replace" chosen: takes this existing photo's place */
  replacePhotoId?: string;
}

interface RejectedFilesInfo {
  count: number;
  names: string[];
  extensions: string[];
}

/** Of these photos, how many has any client marked as a favorite (null = couldn't tell) */
async function countFavorited(galleryId: string, photoIds: string[]): Promise<number | null> {
  if (photoIds.length === 0) return 0;
  try {
    const { data: gallery } = await supabase.from('galleries').select('share_id').eq('id', galleryId).maybeSingle();
    if (!gallery?.share_id) return null;
    const marked = new Set<string>();
    for (let i = 0; i < photoIds.length; i += 80) {
      const { data, error } = await supabase
        .from('favorites')
        .select('photo_public_id')
        .eq('gallery_id', gallery.share_id)
        .in('photo_public_id', photoIds.slice(i, i + 80));
      if (error) return null;
      for (const row of data ?? []) marked.add(row.photo_public_id);
    }
    return marked.size;
  } catch {
    return null;
  }
}

export default function UploadScreen({
  galleryId,
  galleryName,
  folderId,
  folderName,
  token,
  onBack,
  onUploadStarted,
  onGalleryDeleted,
}: UploadScreenProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [rejectedFiles, setRejectedFiles] = useState<RejectedFilesInfo | null>(null);
  /** Some picked files are already in the gallery (or the check failed) — waiting for a choice */
  const [dupDialog, setDupDialog] = useState<{ state: DuplicateDialogState; files: FileInfo[] } | null>(null);
  const dragCounter = useRef(0);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The folder can be renamed or deleted on the website while this screen is open
  const [currentFolderName, setCurrentFolderName] = useState(folderName);
  const currentFolderNameRef = useRef(folderName);
  currentFolderNameRef.current = currentFolderName;
  const leftRef = useRef(false);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const onGalleryDeletedRef = useRef(onGalleryDeleted);
  onGalleryDeletedRef.current = onGalleryDeleted;

  /** false = the folder (or gallery) is gone and we're leaving this screen */
  const verifyFolder = useCallback(async (): Promise<boolean> => {
    if (leftRef.current) return false;
    const result = await checkFolder(galleryId, folderId);
    if (leftRef.current) return false;
    switch (result.state) {
      case 'ok':
        if (result.name !== currentFolderNameRef.current) setCurrentFolderName(result.name);
        return true;
      case 'folder-deleted':
        leftRef.current = true;
        window.alert(`התיקייה "${currentFolderNameRef.current}" נמחקה באתר.`);
        onBackRef.current();
        return false;
      case 'gallery-deleted':
        leftRef.current = true;
        onGalleryDeletedRef.current();
        return false;
      default:
        // not-created-yet: the upload creates the default folder; unknown: let the upload find out
        return true;
    }
  }, [galleryId, folderId]);

  useEffect(() => {
    verifyFolder();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') verifyFolder();
    }, 15_000);
    const onFocus = () => verifyFolder();
    window.addEventListener('focus', onFocus);
    const unsubscribe = onFoldersChanged(galleryId, () => verifyFolder());
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      unsubscribe();
    };
  }, [galleryId, verifyFolder]);

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
    setDupDialog(null);
    if (fileInfos.length === 0) return;
    setStarting(true);
    try {
      // Last check right before starting — the folder may have been deleted on the site
      if (!(await verifyFolder())) return;
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      await window.electronAPI.upload.startSession(
        sessionId, fileInfos, galleryId, galleryName, folderId, currentFolderNameRef.current, token
      );
      onUploadStarted();
    } catch (err) {
      console.error('Failed to start upload:', err);
      setStarting(false);
    }
  }, [galleryId, galleryName, folderId, token, onUploadStarted, verifyFolder]);

  const checkAndUpload = useCallback(async (acceptedFiles: FileInfo[]) => {
    if (acceptedFiles.length === 0) return;

    setChecking(true);
    setDupDialog(null);
    try {
      // The whole gallery (a copy may sit in another folder) plus what's still uploading
      const [existingPhotos, uploadingFiles] = await Promise.all([
        window.electronAPI.gallery.checkDuplicates(galleryId, acceptedFiles.map((f) => f.name), token),
        window.electronAPI.upload.getActiveFiles(galleryId),
      ]);

      const report = classifyFiles(acceptedFiles, folderId, existingPhotos, uploadingFiles);
      if (!hasDuplicates(report)) {
        autoUpload(acceptedFiles);
        return;
      }

      const [folderRows, favoritedCount] = await Promise.all([
        report.inOtherFolders.size > 0
          ? supabase.from('gallery_folders').select('id, name').eq('gallery_id', galleryId).then((r) => r.data ?? [])
          : Promise.resolve([] as Array<{ id: string; name: string }>),
        countFavorited(galleryId, report.edited.map((e) => e.photoId)),
      ]);

      setDupDialog({
        files: acceptedFiles,
        state: {
          kind: 'ask',
          report,
          total: acceptedFiles.length,
          folderName: currentFolderNameRef.current,
          folderNames: new Map(folderRows.map((f) => [f.id, f.name])),
          favoritedCount,
        },
      });
    } catch (err) {
      console.error('Duplicate check failed:', err);
      setDupDialog({ files: acceptedFiles, state: { kind: 'failed', total: acceptedFiles.length } });
    } finally {
      setChecking(false);
    }
  }, [galleryId, folderId, token, autoUpload]);

  const handleDuplicateChoice = useCallback((choice: DuplicateChoice) => {
    if (!dupDialog) return;
    const { state, files } = dupDialog;
    if (choice === 'cancel') return setDupDialog(null);
    if (choice === 'retry') return void checkAndUpload(files);
    if (choice === 'all' || state.kind !== 'ask') return void autoUpload(files);
    // Replace: edited versions take the old photos' place, new files are added,
    // copies that already exist (or are uploading) are not sent again
    const { newFiles, edited } = state.report;
    autoUpload([...newFiles, ...edited.map((e) => ({ ...e.file, replacePhotoId: e.photoId }))]);
  }, [dupDialog, autoUpload, checkAndUpload]);

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

    const rawFiles = Array.from(e.dataTransfer.files);
    console.log(`[DROP] ${rawFiles.length} items dropped`);

    // Real paths (files AND folders). File.path no longer exists since
    // Electron 32 — without this every drop fell back to copying whole photos
    // through memory, and dropped folders were ignored.
    const filePaths = rawFiles
      .map((f) => window.electronAPI.dialog.getPathForFile(f))
      .filter((p): p is string => !!p);

    let fileInfos: Array<{ name: string; size: number; path: string }> = [];

    if (filePaths.length > 0) {
      setChecking(true);
      try {
        fileInfos = await window.electronAPI.dialog.resolveDroppedFiles(filePaths);
      } finally {
        setChecking(false);
      }
      console.log('[DROP] resolveDroppedFiles returned:', fileInfos.length, 'files');
    }

    // Last-resort fallback (no path available, e.g. a drag from another app):
    // copy files to a temp folder one at a time, so memory never holds them all.
    if (filePaths.length === 0 && rawFiles.length > 0) {
      console.warn('[DROP] no paths available — copying dropped files to temp dir');
      for (const f of rawFiles) {
        if (!f.type && f.size === 0) continue; // a folder — can't be read this way
        try {
          const [info] = await window.electronAPI.dialog.writeFilesToTemp([{ name: f.name, buffer: await f.arrayBuffer() }]);
          if (info) fileInfos.push(info);
        } catch (err) {
          console.error('[DROP] temp copy failed for', f.name, err);
        }
      }
    }

    if (fileInfos.length === 0) {
      console.warn('[DROP] no files resolved — nothing to upload');
      // Say so instead of silently doing nothing (e.g. a folder without photos)
      setRejectedFiles({
        count: rawFiles.length,
        names: rawFiles.slice(0, 5).map((f) => f.name),
        extensions: [],
      });
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
    <div className="flex flex-col h-full overflow-hidden bg-dark-bg">
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
          {currentFolderName && currentFolderName !== 'כל הגלריה' && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="inline-flex items-center gap-1 text-xs text-brand-primary/70 bg-brand-primary/10 px-2 py-0.5 rounded-md">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                {currentFolderName}
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

      {dupDialog && <DuplicateDialog state={dupDialog.state} onChoose={handleDuplicateChoice} />}

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
