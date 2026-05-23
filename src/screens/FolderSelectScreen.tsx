import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { UploadSessionInfo } from '../../electron/preload';

export interface FolderItem {
  id: string;
  name: string;
  gallery_id: string;
  is_default: boolean;
  folder_index: number;
  photo_count: number;
  created_at: string;
}

interface FolderSelectScreenProps {
  galleryId: string;
  galleryName: string;
  token: string;
  userId: string;
  onSelectFolder: (folderId: string, folderName: string) => void;
  onBack: () => void;
  uploadSessions?: UploadSessionInfo[];
  initialFolders?: FolderItem[];
  onFoldersLoaded?: (folders: FolderItem[]) => void;
}

export default function FolderSelectScreen({
  galleryId,
  galleryName,
  token: _token,
  userId,
  onSelectFolder,
  onBack,
  uploadSessions = [],
  initialFolders,
  onFoldersLoaded,
}: FolderSelectScreenProps) {
  const [folders, setFolders] = useState<FolderItem[]>(initialFolders ?? []);
  const [loading, setLoading] = useState(!initialFolders || initialFolders.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);

  const ensureDefaultFolder = useCallback(
    async () => {
      const folderId = `${galleryId}-folder-1`;
      const { error: insertError } = await supabase.from('gallery_folders').insert({
        id: folderId,
        name: galleryName,
        gallery_id: galleryId,
        photographer_id: userId,
        user_id: userId,
        parent_id: null,
        folder_index: 0,
        position: 0,
        is_default: true,
        photo_count: 0,
      });
      if (insertError) {
        console.log('Default folder insert:', insertError.message);
      }
    },
    [galleryId, galleryName, userId]
  );

  const fetchFolders = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError('');

      try {
        const { data, error: fetchError } = await supabase
          .from('gallery_folders')
          .select('*')
          .eq('gallery_id', galleryId)
          .order('folder_index', { ascending: true });

        if (fetchError) throw new Error(fetchError.message);

        const foldersWithCounts: FolderItem[] = [];
        if (data && data.length > 0) {
          const countPromises = data.map(async (folder: FolderItem) => {
            const { count, error: countError } = await supabase
              .from('gallery_photos')
              .select('*', { count: 'exact', head: true })
              .eq('folder_id', folder.id);
            return {
              ...folder,
              photo_count: !countError && count !== null ? count : folder.photo_count || 0,
            };
          });
          foldersWithCounts.push(...(await Promise.all(countPromises)));
        } else {
          await ensureDefaultFolder();
          const { data: newData } = await supabase
            .from('gallery_folders')
            .select('*')
            .eq('gallery_id', galleryId)
            .order('folder_index', { ascending: true });
          if (newData && newData.length > 0) {
            foldersWithCounts.push(
              ...newData.map((f: FolderItem) => ({ ...f, photo_count: f.photo_count || 0 }))
            );
          }
        }

        setFolders(foldersWithCounts);
        onFoldersLoaded?.(foldersWithCounts);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'שגיאה בטעינת התיקיות');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [galleryId, ensureDefaultFolder]
  );

  useEffect(() => {
    fetchFolders();
  }, [fetchFolders]);

  const handleCreateFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    setCreating(true);
    setError('');

    try {
      const maxIndex = folders.reduce((max, f) => Math.max(max, f.folder_index), -1);
      const maxFolderNum = folders.reduce((max, f) => {
        const match = f.id.match(/-folder-(\d+)$/);
        return match ? Math.max(max, parseInt(match[1], 10)) : max;
      }, 0);
      const folderId = `${galleryId}-folder-${maxFolderNum + 1}`;

      const { error: insertError } = await supabase.from('gallery_folders').insert({
        id: folderId,
        name: trimmed,
        gallery_id: galleryId,
        photographer_id: userId,
        user_id: userId,
        parent_id: null,
        folder_index: maxIndex + 1,
        position: 0,
        is_default: false,
        photo_count: 0,
      });
      if (insertError) throw new Error(insertError.message);

      setNewFolderName('');
      setShowNewFolder(false);
      await fetchFolders(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שגיאה ביצירת התיקייה');
    } finally {
      setCreating(false);
    }
  };

  // Get upload status for a specific folder
  const getFolderUploadStatus = (folderId: string) => {
    const sessions = uploadSessions.filter((s) => s.folderId === folderId);
    if (sessions.length === 0) return null;
    // Prefer uploading session over done
    const uploading = sessions.find((s) => s.status === 'uploading');
    if (uploading) return uploading;
    const done = sessions.find((s) => s.status === 'done');
    if (done) return done;
    return sessions[sessions.length - 1];
  };

  const totalPhotos = folders.reduce((sum, f) => sum + f.photo_count, 0);

  if (loading) {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-dark-bg">
        <div className="flex items-center justify-center flex-1">
          <div className="text-center">
            <svg className="animate-spin w-8 h-8 text-brand-primary mx-auto mb-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-gray-500 text-sm">טוען...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-dark-bg">
      {/* Header */}
      <div className="px-6 py-4 border-b border-dark-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="w-8 h-8 rounded-lg bg-dark-card border border-dark-border flex items-center justify-center text-gray-400 hover:text-gray-900 hover:border-brand-primary/50 transition-all"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div>
              <h1 className="text-lg font-bold text-gray-900">{galleryName}</h1>
              <p className="text-xs text-gray-500 mt-0.5">
                {folders.length} תיקיות · {totalPhotos} תמונות
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchFolders(true)}
              disabled={refreshing}
              className="w-8 h-8 rounded-lg bg-dark-card border border-dark-border flex items-center justify-center text-gray-500 hover:text-gray-900 hover:border-brand-primary/50 transition-all disabled:opacity-50"
              title="רענון"
            >
              <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={() => setShowNewFolder(true)}
              className="h-8 px-3 bg-brand-primary hover:bg-brand-hover text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
              </svg>
              תיקייה חדשה
            </button>
          </div>
        </div>
      </div>

      {/* New folder input */}
      {showNewFolder && (
        <div className="px-6 py-3 border-b border-dark-border bg-dark-card/50">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFolder();
                if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName(''); }
              }}
              placeholder="שם התיקייה..."
              autoFocus
              disabled={creating}
              className="flex-1 px-3 py-2 bg-dark-bg border border-dark-border rounded-lg text-gray-900 text-sm placeholder-gray-400 outline-none focus:border-brand-primary/50 transition-colors disabled:opacity-50"
            />
            <button
              onClick={handleCreateFolder}
              disabled={creating || !newFolderName.trim()}
              className="px-4 py-2 bg-brand-primary hover:bg-brand-hover text-white text-sm rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? 'יוצר...' : 'צור'}
            </button>
            <button
              onClick={() => { setShowNewFolder(false); setNewFolderName(''); }}
              className="px-3 py-2 text-gray-500 hover:text-gray-300 text-sm transition-colors"
            >
              ביטול
            </button>
          </div>
          {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-scroll p-5 min-h-0">
        {!showNewFolder && error ? (
          <div className="flex flex-col items-center justify-center h-full">
            <p className="text-red-400 text-sm mb-3">{error}</p>
            <button onClick={() => fetchFolders(false)} className="text-sm text-brand-primary hover:text-brand-hover transition-colors">
              נסו שוב
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {folders.map((folder) => {
              const uploadStatus = getFolderUploadStatus(folder.id);
              const isUploading = uploadStatus?.status === 'uploading';
              const isDone = uploadStatus?.status === 'done';
              const isActive = isUploading || isDone;

              return (
                <button
                  key={folder.id}
                  onClick={() => onSelectFolder(folder.id, folder.name)}
                  className={`w-full group flex items-center gap-4 p-3.5 border rounded-xl transition-all duration-200 text-right ${
                    isActive
                      ? 'bg-emerald-50 border-emerald-300 hover:border-emerald-400 hover:bg-emerald-100'
                      : 'bg-dark-card border-dark-border hover:border-brand-primary/30 hover:bg-dark-hover'
                  }`}
                >
                  {/* Folder icon */}
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors ${
                    isActive ? 'bg-emerald-100' : 'bg-dark-bg group-hover:bg-brand-primary/10'
                  }`}>
                    {isUploading ? (
                      <svg className="w-4 h-4 text-emerald-600 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : isDone ? (
                      <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-4.5 h-4.5 text-gray-500 group-hover:text-brand-primary transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                          d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                    )}
                  </div>

                  {/* Text */}
                  <div className="flex-1 min-w-0">
                    <h3 className={`text-sm font-medium truncate transition-colors ${
                      isActive ? 'text-emerald-800' : 'text-gray-900 group-hover:text-brand-hover'
                    }`}>
                      {folder.name}
                    </h3>
                    <p className={`text-xs mt-0.5 ${isActive ? 'text-emerald-600' : 'text-gray-600'}`}>
                      {isUploading
                        ? `מעלה... ${uploadStatus.completedFiles}/${uploadStatus.totalFiles} תמונות (${uploadStatus.percentage}%)`
                        : isDone
                        ? `✓ ${uploadStatus.completedFiles} תמונות הועלו`
                        : folder.photo_count > 0
                        ? `${folder.photo_count} תמונות`
                        : 'ריקה'}
                    </p>
                  </div>

                  {/* Progress bar for uploading */}
                  {isUploading && (
                    <div className="w-16 flex-shrink-0">
                      <div className="h-1.5 bg-emerald-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                          style={{ width: `${uploadStatus.percentage}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-emerald-600 text-center mt-0.5">{uploadStatus.percentage}%</p>
                    </div>
                  )}

                  {/* Arrow */}
                  {!isUploading && (
                    <svg
                      className={`w-4 h-4 flex-shrink-0 rotate-180 transition-colors ${
                        isDone ? 'text-emerald-500' : 'text-gray-700 group-hover:text-brand-primary'
                      }`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
