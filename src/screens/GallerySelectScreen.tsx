import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabase';

interface Gallery {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  user_id?: string;
  photographer_id?: string;
  cover_photo_url?: string;
  cover_image?: string;
  status?: string;
  is_published?: boolean;
  photo_count?: number;
}

interface GalleryAllResponse {
  galleries: Gallery[];
  photosByGallery: Record<string, Array<{ id: string }>>;
  foldersByGallery: Record<string, unknown[]>;
}

interface GallerySelectScreenProps {
  token: string;
  userId: string;
  onSelectGallery: (galleryId: string, galleryName: string) => void;
  onLogout: () => void;
  email: string;
}

export default function GallerySelectScreen({
  token,
  userId,
  onSelectGallery,
  onLogout,
  email,
}: GallerySelectScreenProps) {
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [photoCounts, setPhotoCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const filteredGalleries = useMemo(() => {
    if (!search.trim()) return galleries;
    const q = search.trim().toLowerCase();
    return galleries.filter((g) => g.name.toLowerCase().includes(q));
  }, [galleries, search]);

  useEffect(() => {
    fetchGalleries();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchGalleries = async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError('');

    try {
      const apiBaseUrl = await window.electronAPI.config.getApiBaseUrl();
      const cacheBuster = Date.now();

      const [apiResult, supabaseResult] = await Promise.allSettled([
        fetch(`${apiBaseUrl}/api/gallery/all?_t=${cacheBuster}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
          },
        }).then(async (res) => {
          if (!res.ok) throw new Error(`API error: ${res.status}`);
          return res.json() as Promise<GalleryAllResponse>;
        }),
        supabase
          .from('galleries')
          .select('id, name, is_published, created_at, updated_at, user_id, cover_image, photo_count')
          .eq('user_id', userId)
          .order('created_at', { ascending: false }),
      ]);

      const apiData = apiResult.status === 'fulfilled' ? apiResult.value : null;
      const apiGalleries = apiData?.galleries || [];

      const sbGalleries: Gallery[] =
        supabaseResult.status === 'fulfilled' && !supabaseResult.value.error
          ? (supabaseResult.value.data || [])
          : [];

      const galleryMap = new Map<string, Gallery>();
      const sbMap = new Map<string, Gallery>();
      for (const g of sbGalleries) {
        sbMap.set(g.id, g);
      }
      for (const g of apiGalleries) {
        const sb = sbMap.get(g.id);
        if (sb?.cover_image && !g.cover_photo_url && !g.cover_image) {
          g.cover_image = sb.cover_image;
        }
        galleryMap.set(g.id, g);
      }
      for (const g of sbGalleries) {
        if (!galleryMap.has(g.id)) {
          galleryMap.set(g.id, g);
        }
      }
      const galleryList = Array.from(galleryMap.values()).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      setGalleries(galleryList);

      const counts: Record<string, number> = {};
      if (galleryList.length > 0) {
        const countPromises = galleryList.map(async (g) => {
          const { count, error: countError } = await supabase
            .from('gallery_photos')
            .select('*', { count: 'exact', head: true })
            .eq('gallery_id', g.id);
          if (!countError && count !== null) {
            counts[g.id] = count;
          } else {
            const fromApi = (apiData?.photosByGallery?.[g.id] || []).length;
            counts[g.id] = Math.max(g.photo_count || 0, fromApi);
          }
        });
        await Promise.all(countPromises);
      }
      setPhotoCounts(counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שגיאה בטעינת הגלריות');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-dark-bg">
      {/* Header */}
      <div className="px-6 py-4 border-b border-dark-border">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-bold text-gray-900">הגלריות שלי</h1>
            <p className="text-[11px] text-gray-600 mt-0.5">{email}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchGalleries(true)}
              disabled={refreshing}
              className="w-8 h-8 rounded-lg bg-dark-card border border-dark-border flex items-center justify-center
                         text-gray-500 hover:text-gray-900 hover:border-brand-primary/30 transition-all disabled:opacity-50"
              title="רענון"
            >
              <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={onLogout}
              className="w-8 h-8 rounded-lg bg-dark-card border border-dark-border flex items-center justify-center
                         text-gray-500 hover:text-red-500 hover:border-red-400/50 transition-all"
              title="התנתקות"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>

        {/* Search bar */}
        {!loading && galleries.length > 0 && (
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="חפשו גלריה..."
              className="w-full pr-4 pl-9 py-2.5 bg-dark-card border border-dark-border rounded-xl text-gray-900 text-sm
                         placeholder-gray-600 focus:outline-none focus:border-brand-primary/40 transition-all"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-scroll p-5 min-h-0">
        {loading ? (
          /* Skeleton loading */
          <div className="grid grid-cols-2 gap-3 animate-fade-in">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="p-3 bg-dark-card border border-dark-border rounded-xl">
                <div className="w-full aspect-video rounded-lg skeleton mb-3" />
                <div className="h-4 w-3/4 rounded skeleton mb-2" />
                <div className="h-3 w-1/3 rounded skeleton" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full animate-fade-in">
            <div className="w-14 h-14 rounded-2xl bg-red-500/10 flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <p className="text-red-400 text-sm mb-3">{error}</p>
            <button
              onClick={() => fetchGalleries(false)}
              className="text-sm text-brand-primary hover:text-brand-hover transition-colors"
            >
              נסו שוב
            </button>
          </div>
        ) : galleries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-dark-card border border-dark-border flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <p className="text-gray-500 text-sm mb-1">אין גלריות עדיין</p>
            <p className="text-gray-700 text-xs">צרו גלריה באתר ותחזרו לכאן</p>
          </div>
        ) : filteredGalleries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full animate-fade-in">
            <div className="w-14 h-14 rounded-2xl bg-dark-card border border-dark-border flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <p className="text-gray-500 text-sm">לא נמצאו גלריות עבור "{search}"</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {filteredGalleries.map((gallery, index) => (
              <button
                key={gallery.id}
                onClick={() => onSelectGallery(gallery.id, gallery.name)}
                className="group p-3 bg-dark-card border border-dark-border rounded-xl
                           hover:border-brand-primary/40 hover:bg-dark-hover
                           transition-all duration-200 text-right
                           hover:shadow-lg hover:shadow-brand-primary/5 hover:-translate-y-0.5
                           active:translate-y-0"
                style={{ animationDelay: `${index * 40}ms` }}
              >
                {/* Cover */}
                <div className="w-full rounded-lg bg-dark-bg mb-2.5 overflow-hidden relative">
                  {(gallery.cover_photo_url || gallery.cover_image) ? (
                    <img
                      src={(gallery.cover_photo_url || gallery.cover_image)!}
                      alt={gallery.name}
                      className="w-full object-contain max-h-36 transition-transform duration-500 group-hover:scale-105"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <svg className="w-7 h-7 text-gray-800" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
                          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                  )}
                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-brand-primary/0 group-hover:bg-brand-primary/5 transition-colors duration-300" />
                </div>

                {/* Info */}
                <div className="flex items-center gap-2 mb-0.5">
                  <h3 className="text-sm font-medium text-gray-900 group-hover:text-brand-hover transition-colors truncate flex-1">
                    {gallery.name}
                  </h3>
                  {gallery.is_published === false && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-400/80 whitespace-nowrap font-medium">
                      טיוטה
                    </span>
                  )}
                  {gallery.is_published === true && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400/80 whitespace-nowrap font-medium">
                      פורסמה
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-gray-600">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <span className="text-[11px]">
                    {photoCounts[gallery.id] ?? gallery.photo_count ?? 0} תמונות
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
