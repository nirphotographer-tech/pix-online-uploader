import { memo, useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '../lib/supabase';
import GalleryThumb from '../components/GalleryThumb';

interface Gallery {
  id: string;
  name: string;
  share_id?: string;
  created_at: string;
  updated_at: string;
  event_date?: string;
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
  onSelectGallery: (galleryId: string, galleryName: string, shareId?: string) => void;
  onLogout: () => void;
  email: string;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function GallerySelectScreen({
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

  // Galleries created, renamed or deleted on the website while this window was
  // in the background show up when it regains focus. Only the galleries table
  // is read (cheap) — the full load with photo counts stays on the refresh button.
  const lastFocusSyncRef = useRef(0);
  useEffect(() => {
    const syncGalleryList = async () => {
      if (Date.now() - lastFocusSyncRef.current < 10_000) return;
      lastFocusSyncRef.current = Date.now();
      const { data, error: syncError } = await supabase
        .from('galleries')
        .select('id, name, share_id, is_published, created_at, updated_at, user_id, cover_image, photo_count, event_date')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (syncError || !data) return;
      setGalleries((prev) => {
        const prevById = new Map(prev.map((g) => [g.id, g]));
        return (data as Gallery[]).map((g) => {
          const old = prevById.get(g.id);
          // Keep what the full load enriched (cover / event date from the API)
          return old
            ? { ...old, ...g, cover_image: g.cover_image || old.cover_image, event_date: g.event_date || old.event_date }
            : g;
        });
      });
      setPhotoCounts((prev) => {
        const next = { ...prev };
        for (const g of data as Gallery[]) {
          if (next[g.id] === undefined) next[g.id] = g.photo_count || 0;
        }
        return next;
      });
    };
    window.addEventListener('focus', syncGalleryList);
    return () => window.removeEventListener('focus', syncGalleryList);
  }, [userId]);

  const fetchGalleries = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
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
          .select('id, name, share_id, is_published, created_at, updated_at, user_id, cover_image, photo_count, event_date')
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
      for (const g of sbGalleries) sbMap.set(g.id, g);

      // Only show galleries that exist in Supabase (source of truth after delete)
      // API result is used only to enrich data (cover, event_date), not to add galleries
      for (const g of sbGalleries) {
        const api = apiGalleries.find((a) => a.id === g.id);
        if (api?.cover_photo_url) g.cover_image = g.cover_image || api.cover_photo_url;
        if (api?.event_date && !g.event_date) g.event_date = api.event_date;
        galleryMap.set(g.id, g);
      }
      void sbMap; // suppress unused warning

      const galleryList = Array.from(galleryMap.values()).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      setGalleries(galleryList);

      const counts: Record<string, number> = {};
      if (galleryList.length > 0) {
        await Promise.all(
          galleryList.map(async (g) => {
            const { count, error: countError } = await supabase
              .from('gallery_photos')
              .select('*', { count: 'exact', head: true })
              .eq('gallery_id', g.id);
            if (!countError && count !== null) counts[g.id] = count;
            else counts[g.id] = Math.max(g.photo_count || 0, (apiData?.photosByGallery?.[g.id] || []).length);
          })
        );
      }
      setPhotoCounts(counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load galleries');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-dark-bg">

      {/* ── TOP BAR ─────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between px-5 py-4 border-b border-dark-border">
        <div className="min-w-0">
          <h1 className="text-base font-bold text-gray-900 leading-tight">My galleries</h1>
          <p className="text-[11px] text-gray-500 mt-0.5 truncate">{email}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-3">
          {/* Refresh */}
          <button
            onClick={() => fetchGalleries(true)}
            disabled={refreshing}
            title="Refresh"
            className="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-gray-900 border border-dark-border hover:border-gray-400 bg-dark-card transition-colors disabled:opacity-40"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          {/* Logout */}
          <button
            onClick={onLogout}
            title="Sign out"
            className="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-red-400 border border-dark-border hover:border-red-500/40 bg-dark-card transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── SEARCH ──────────────────────────────────────────── */}
      {!loading && galleries.length > 0 && (
        <div className="flex-shrink-0 px-4 py-3 border-b border-dark-border">
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search galleries..."
              className="w-full px-4 py-2 bg-dark-card border border-dark-border text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:border-brand-primary/50 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── CONTENT AREA ────────────────────────────────────── */}
      <div data-scroll-root className="flex-1 overflow-y-auto min-h-0">

        {/* Loading skeletons */}
        {loading && (
          <div className="divide-y divide-dark-border">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                {/* thumbnail placeholder */}
                <div className="w-12 h-12 flex-shrink-0 bg-dark-card animate-pulse" />
                {/* text lines */}
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="h-3.5 w-3/5 bg-dark-card animate-pulse" />
                  <div className="h-3 w-2/5 bg-dark-card animate-pulse" />
                </div>
                {/* count placeholder */}
                <div className="flex-shrink-0 text-left space-y-1">
                  <div className="h-5 w-8 bg-dark-card animate-pulse mx-auto" />
                  <div className="h-2.5 w-12 bg-dark-card animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center h-full gap-4 px-8 text-center">
            <div className="w-12 h-12 bg-red-500/10 flex items-center justify-center">
              <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <p className="text-red-400 text-sm">{error}</p>
            <button onClick={() => fetchGalleries(false)} className="text-xs text-brand-primary hover:text-brand-hover transition-colors border border-brand-primary/30 px-4 py-1.5">
              Try again
            </button>
          </div>
        )}

        {/* Empty state — no galleries */}
        {!loading && !error && galleries.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-8 text-center">
            <div className="w-14 h-14 bg-dark-card border border-dark-border flex items-center justify-center">
              <svg className="w-7 h-7 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <p className="text-gray-900 text-sm font-medium mb-1">No galleries yet</p>
              <p className="text-gray-600 text-xs">Create a gallery on the website, then come back here</p>
            </div>
          </div>
        )}

        {/* Empty search results */}
        {!loading && !error && galleries.length > 0 && filteredGalleries.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-8 text-center">
            <svg className="w-8 h-8 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <p className="text-gray-500 text-sm">No gallery named <span className="text-gray-900">“{search}”</span></p>
          </div>
        )}

        {/* ── GALLERY LIST ──────────────────────────────────── */}
        {!loading && !error && filteredGalleries.length > 0 && (
          <div className="flex flex-col gap-2 p-2">
            {filteredGalleries.map((gallery) => {
              const photoCount = photoCounts[gallery.id] ?? gallery.photo_count ?? 0;
              const displayDate = formatDate(gallery.event_date || gallery.created_at);
              const coverUrl = gallery.cover_photo_url || gallery.cover_image;

              return (
                <button
                  key={gallery.id}
                  onClick={() => onSelectGallery(gallery.id, gallery.name, gallery.share_id)}
                  className="group w-full flex items-center justify-between px-4 py-3 bg-dark-card hover:bg-dark-hover transition-colors duration-100 border-l-2 border-transparent hover:border-brand-primary"
                >
                  {/* ── Thumbnail + Info (grouped together) ── */}
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {/* Thumbnail */}
                    <GalleryThumb url={coverUrl} alt={gallery.name} />

                    {/* Name + Date — directly next to thumbnail */}
                    <div className="min-w-0 text-left">
                      <div className="flex items-center gap-1.5">
                        <h3 className="text-[14px] font-semibold text-gray-900 group-hover:text-brand-hover transition-colors truncate leading-tight">
                          {gallery.name}
                        </h3>
                      </div>
                      {displayDate && (
                        <p className="mt-0.5 text-[11px] text-gray-500 flex items-center gap-1">
                          <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          <span>{displayDate}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  {/* ── Photo Count + Chevron ── */}
                  <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                    <div className="flex flex-col items-center min-w-[36px]">
                      <span className="text-[18px] font-bold text-gray-900 leading-none tabular-nums">
                        {photoCount}
                      </span>
                      <span className="text-[10px] text-gray-600 mt-0.5">{photoCount === 1 ? 'photo' : 'photos'}</span>
                      {gallery.is_published === false && (
                        <span className="mt-1 text-[9px] px-1.5 py-0.5 bg-amber-500/15 text-amber-500 font-medium leading-none rounded-sm">Draft</span>
                      )}
                      {gallery.is_published === true && (
                        <span className="mt-1 text-[9px] px-1.5 py-0.5 bg-emerald-500/15 text-emerald-500 font-medium leading-none rounded-sm">Published</span>
                      )}
                    </div>
                    <svg className="w-4 h-4 text-gray-700 group-hover:text-brand-primary transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Bottom padding */}
        <div className="h-4" />
      </div>

      {/* ── FOOTER — gallery count ───────────────────────────── */}
      {!loading && !error && galleries.length > 0 && (
        <div className="flex-shrink-0 px-5 py-2 border-t border-dark-border text-left">
          <span className="text-[11px] text-gray-700">
            {filteredGalleries.length === galleries.length
              ? `${galleries.length} ${galleries.length === 1 ? 'gallery' : 'galleries'}`
              : `${filteredGalleries.length} of ${galleries.length} galleries`}
          </span>
        </div>
      )}
    </div>
  );
}

// Upload progress re-renders App many times a second; the list only needs to
// re-render when its own props change.
export default memo(GallerySelectScreen);
