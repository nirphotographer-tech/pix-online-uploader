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
  const [autoSkipped, setAutoSkipped] = useState(false);

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
              ...newData.map((f: Folder) => ({ ...f, photo_count: f.photo_count || 0 }))
            );
          }
        }

        setFolders(foldersWithCounts);

        // Auto-skip: if only one folder (default), go straight to upload
        if (!isRefresh && !autoSkipped && foldersWithCounts.length === 1) {
          setAutoSkipped(true);
          const single = foldersWithCounts[0];
          onSelectFolder(single.id, 'כל הגלריה');
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'שגיאה בטעינת התיקיות');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [galleryId, ensureDefaultFolder, autoSkipped, onSelectFolder]
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

  const totalPhotos = folders.reduce((sum, f) => sum + f.photo_count, 0);

  // Show loading during auto-skip too
  if (loading || (autoSkipped && folders.length <= 1)) {
    return (
      <div className="flex flex-col h-screen bg-dark-bg">
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
    <div className="flex flex-col h-screen bg-dark-bg">
      {/* Header */}
      <div className="px-6 py-4 border-b border-dark-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="w-8 h-8 rounded-lg bg-dark-card border border-dark-border flex items-center justify-center text-gray-400 hover:text-gray-900 hover:border-brand-primary/50 transition-all"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
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
              className="h-8 px-3 bg-brand-primary hover:bg-brand-hover text-white text-xs
                         font-medium rounded-lg transition-colors flex items-center gap-1.5"
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
              className="flex-1 px-3 py-2 bg-dark-bg border border-dark-border rounded-lg
                         text-gray-900 text-sm placeholder-gray-400 outline-none
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
      <div className="flex-1 overflow-y-auto p-5">
        {!showNewFolder && error ? (
          <div className="flex flex-col items-center justify-center h-full">
            <p className="text-red-400 text-sm mb-3">{error}</p>
            <button onClick={() => fetchFolders(false)} className="text-sm text-brand-primary hover:text-brand-hover transition-colors">
              נסו שוב
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Upload to full gallery — hero card */}
            <button
              onClick={() => {
                const def = folders.find((f) => f.is_default) || folders[0];
                if (def) onSelectFolder(def.id, 'כל הגלריה');
              }}
              className="w-full group relative overflow-hidden rounded-xl border border-brand-primary/20 bg-gradient-to-l from-brand-primary/5 via-dark-card to-dark-card
                         hover:border-brand-primary/40 hover:from-brand-primary/10 transition-all duration-300 text-right"
            >
              <div className="flex items-center gap-4 p-4">
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-brand-primary/20 to-brand-primary/5 flex items-center justify-center flex-shrink-0
                               group-hover:from-brand-primary/30 group-hover:to-brand-primary/10 transition-all duration-300">
                  <svg className="w-5 h-5 text-brand-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-gray-900 group-hover:text-brand-hover transition-colors">
                    העלאה לכל הגלריה
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {totalPhotos > 0 ? `${totalPhotos} תמונות בגלריה` : 'התחילו להעלות תמונות'}
                  </p>
                </div>
                <div className="w-8 h-8 rounded-lg bg-brand-primary/10 flex items-center justify-center flex-shrink-0
                               group-hover:bg-brand-primary/20 transition-all">
                  <svg className="w-4 h-4 text-brand-primary rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            </button>

            {/* Divider */}
            {folders.length > 1 && (
              <div className="flex items-center gap-3 py-2 px-1">
                <div className="flex-1 h-px bg-dark-border" />
                <span className="text-[11px] text-gray-600 font-medium">או בחרו תיקייה</span>
                <div className="flex-1 h-px bg-dark-border" />
              </div>
            )}

            {/* Individual folders (skip default if it's redundant with the hero card) */}
            {folders
              .filter((f) => folders.length > 1 ? !f.is_default : false)
              .map((folder) => (
              <button
                key={folder.id}
                onClick={() => onSelectFolder(folder.id, folder.name)}
                className="w-full group flex items-center gap-4 p-3.5 bg-dark-card border border-dark-border
                           rounded-xl hover:border-brand-primary/30 hover:bg-dark-hover transition-all duration-200 text-right"
              >
                <div className="w-9 h-9 rounded-lg bg-dark-bg flex items-center justify-center flex-shrink-0
                               group-hover:bg-brand-primary/10 transition-colors">
                  <svg className="w-4.5 h-4.5 text-gray-500 group-hover:text-brand-primary transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-medium text-gray-900 group-hover:text-brand-hover transition-colors truncate">
                    {folder.name}
                  </h3>
                  <p className="text-xs text-gray-600 mt-0.5">
                    {folder.photo_count > 0 ? `${folder.photo_count} תמונות` : 'ריקה'}
                  </p>
                </div>
                <svg className="w-4 h-4 text-gray-700 group-hover:text-brand-primary transition-colors flex-shrink-0 rotate-180"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
