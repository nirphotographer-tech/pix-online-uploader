import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

interface Folder {
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
}

export default function FolderSelectScreen({
  galleryId,
  galleryName,
  // token kept for future API calls
  token: _token,
  userId,
  onSelectFolder,
  onBack,
}: FolderSelectScreenProps) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);

  // Auto-create default folder if gallery has none
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
        // Folder might already exist (race condition) — that's fine
        console.log('Default folder insert:', insertError.message);
      }
    },
    [galleryId, galleryName, userId]
  );

  const fetchFolders = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError('');

      try {
        // Fetch folders directly from Supabase
        const { data, error: fetchError } = await supabase
          .from('gallery_folders')
          .select('*')
          .eq('gallery_id', galleryId)
          .order('folder_index', { ascending: true });

        if (fetchError) {
          throw new Error(fetchError.message);
        }

        // Get accurate photo counts per folder
        const foldersWithCounts: Folder[] = [];
        if (data && data.length > 0) {
          const countPromises = data.map(async (folder: Folder) => {
            const { count, error: countError } = await supabase
              .from('gallery_photos')
              .select('*', { count: 'exact', head: true })
              .eq('folder_id', folder.id);

            return {
              ...folder,
              photo_count: !countError && count !== null ? count : folder.photo_count || 0,
            };
          });
          const results = await Promise.all(countPromises);
          foldersWithCounts.push(...results);
        } else {
          // No folders exist — auto-create the default folder
          await ensureDefaultFolder();
          // Re-fetch after creating
          const { data: newData } = await supabase
            .from('gallery_folders')
            .select('*')
            .eq('gallery_id', galleryId)
            .order('folder_index', { ascending: true });
          if (newData && newData.length > 0) {
            foldersWithCounts.push(
              ...newData.map((f: Folder) => ({ ...f, photo_count: f.photo_count || 0 }))
            );
          }
        }

        setFolders(foldersWithCounts);
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
      // Determine the next folder_index
      const maxIndex = folders.reduce((max, f) => Math.max(max, f.folder_index), -1);
      const nextIndex = maxIndex + 1;

      // Generate folder ID in the same pattern as the website
      // Pattern: {gallery_id}-folder-{N}
      const maxFolderNum = folders.reduce((max, f) => {
        const match = f.id.match(/-folder-(\d+)$/);
        return match ? Math.max(max, parseInt(match[1], 10)) : max;
      }, 0);
      const nextFolderNum = maxFolderNum + 1;
      const folderId = `${galleryId}-folder-${nextFolderNum}`;

      const { error: insertError } = await supabase.from('gallery_folders').insert({
        id: folderId,
        name: trimmed,
        gallery_id: galleryId,
        photographer_id: userId,
        user_id: userId,
        parent_id: null,
        folder_index: nextIndex,
        position: 0,
        is_default: false,
        photo_count: 0,
      });

      if (insertError) {
        throw new Error(insertError.message);
      }

      setNewFolderName('');
      setShowNewFolder(false);
      await fetchFolders(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שגיאה ביצירת התיקייה');
    } finally {
      setCreating(false);
    }
  };

  const totalPhotos = folders.reduce((sum, f) => sum + f.photo_count, 0);

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
              {folders.length} תיקיות · {totalPhotos} תמונות
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => fetchFolders(true)}
            disabled={refreshing}
            className="text-gray-500 hover:text-white transition-colors disabled:opacity-50"
            title="רענון"
          >
            <svg
              className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
          <button
            onClick={() => setShowNewFolder(true)}
            className="px-3 py-1.5 bg-brand-primary hover:bg-brand-hover text-white text-sm
                       font-medium rounded-lg transition-colors flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            תיקייה חדשה
          </button>
        </div>
      </div>

      {/* New folder input */}
      {showNewFolder && (
        <div className="px-6 py-4 border-b border-dark-border bg-dark-card/50">
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFolder();
                if (e.key === 'Escape') {
                  setShowNewFolder(false);
                  setNewFolderName('');
                }
              }}
              placeholder="שם התיקייה..."
              autoFocus
              disabled={creating}
              className="flex-1 px-3 py-2 bg-dark-bg border border-dark-border rounded-lg
                         text-white text-sm placeholder-gray-600 outline-none
                         focus:border-brand-primary/50 transition-colors disabled:opacity-50"
            />
            <button
              onClick={handleCreateFolder}
              disabled={creating || !newFolderName.trim()}
              className="px-4 py-2 bg-brand-primary hover:bg-brand-hover text-white text-sm
                         rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? 'יוצר...' : 'צור'}
            </button>
            <button
              onClick={() => {
                setShowNewFolder(false);
                setNewFolderName('');
              }}
              className="px-3 py-2 text-gray-500 hover:text-gray-300 text-sm transition-colors"
            >
              ביטול
            </button>
          </div>
          {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <svg
                className="animate-spin w-8 h-8 text-brand-primary mx-auto mb-3"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="text-gray-500 text-sm">טוען תיקיות...</p>
            </div>
          </div>
        ) : !showNewFolder && error ? (
          <div className="flex flex-col items-center justify-center h-full">
            <p className="text-red-400 text-sm mb-3">{error}</p>
            <button
              onClick={() => fetchFolders(false)}
              className="text-sm text-brand-primary hover:text-brand-hover transition-colors"
            >
              נסו שוב
            </button>
          </div>
        ) : folders.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="text-center">
              <svg className="w-12 h-12 text-gray-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                />
              </svg>
              <p className="text-gray-400 text-sm mb-1">אין תיקיות בגלריה</p>
              <p className="text-gray-600 text-xs mb-4">צרו תיקייה חדשה כדי להתחיל להעלות תמונות</p>
              <button
                onClick={() => setShowNewFolder(true)}
                className="px-4 py-2 bg-brand-primary hover:bg-brand-hover text-white text-sm
                           rounded-lg transition-colors"
              >
                צרו תיקייה חדשה
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Upload to default folder option */}
            <button
              onClick={() => {
                const defaultFolder = folders.find((f) => f.is_default);
                if (defaultFolder) {
                  onSelectFolder(defaultFolder.id, 'כל הגלריה');
                } else {
                  // Fallback to the first folder if no default
                  onSelectFolder(folders[0].id, 'כל הגלריה');
                }
              }}
              className="w-full group flex items-center gap-4 p-4 bg-dark-card border border-dark-border
                         rounded-xl hover:border-brand-primary/50 hover:bg-dark-hover transition-all text-right"
            >
              <div className="w-10 h-10 rounded-lg bg-brand-primary/10 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-brand-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-white group-hover:text-brand-hover transition-colors">
                  העלאה לכל הגלריה
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  התמונות יתווספו לתיקיית ברירת המחדל
                </p>
              </div>
              <svg className="w-4 h-4 text-gray-600 group-hover:text-brand-primary transition-colors flex-shrink-0 rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>

            {/* Folder list */}
            {folders.map((folder) => (
              <button
                key={folder.id}
                onClick={() => onSelectFolder(folder.id, folder.name)}
                className="w-full group flex items-center gap-4 p-4 bg-dark-card border border-dark-border
                           rounded-xl hover:border-brand-primary/50 hover:bg-dark-hover transition-all text-right"
              >
                <div className="w-10 h-10 rounded-lg bg-dark-bg flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-gray-500 group-hover:text-brand-primary transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                    />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-white group-hover:text-brand-hover transition-colors truncate">
                      {folder.name}
                    </h3>
                    {folder.is_default && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 whitespace-nowrap">
                        ברירת מחדל
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {folder.photo_count} תמונות
                  </p>
                </div>
                <svg className="w-4 h-4 text-gray-600 group-hover:text-brand-primary transition-colors flex-shrink-0 rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
