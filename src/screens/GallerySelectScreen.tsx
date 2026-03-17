import { useState, useEffect } from 'react';

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
      const response = await fetch(`${apiBaseUrl}/api/gallery/all`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        throw new Error(`שגיאה בטעינת הגלריות: ${response.status}`);
      }

      const data: GalleryAllResponse = await response.json();
      console.log('[GallerySelect] userId:', userId);
      console.log('[GallerySelect] galleries count:', data.galleries?.length);
      console.log('[GallerySelect] galleries:', JSON.stringify(data.galleries?.map(g => ({
        id: g.id, name: g.name, is_published: g.is_published, user_id: g.user_id, photographer_id: g.photographer_id,
      })), null, 2));
      setGalleries(data.galleries || []);
      setPhotoCounts(
        Object.fromEntries(
          Object.entries(data.photosByGallery || {}).map(([gid, photos]) => [gid, photos.length])
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שגיאה בטעינת הגלריות');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-dark-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-dark-border pt-8">
        <div>
          <h1 className="text-lg font-semibold text-white">הגלריות שלי</h1>
          <p className="text-xs text-gray-500 mt-0.5">{email}</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => fetchGalleries(true)}
            disabled={refreshing}
            className="text-gray-500 hover:text-white transition-colors disabled:opacity-50"
            title="רענון גלריות"
          >
            <svg className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            onClick={onLogout}
            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            התנתקות
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <svg className="animate-spin w-8 h-8 text-brand-primary mx-auto mb-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="text-gray-500 text-sm">טוען גלריות...</p>
            </div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="text-center">
              <p className="text-red-400 text-sm mb-3">{error}</p>
              <button
                onClick={() => fetchGalleries(false)}
                className="text-sm text-brand-primary hover:text-brand-hover transition-colors"
              >
                נסו שוב
              </button>
            </div>
          </div>
        ) : galleries.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-gray-500 text-sm">אין גלריות עדיין</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {galleries.map((gallery) => (
              <button
                key={gallery.id}
                onClick={() => onSelectGallery(gallery.id, gallery.name)}
                className="group p-4 bg-dark-card border border-dark-border rounded-xl
                           hover:border-brand-primary/50 hover:bg-dark-hover
                           transition-all text-right"
              >
                {/* Cover */}
                <div className="w-full aspect-video rounded-lg bg-dark-bg mb-3 overflow-hidden">
                  {(gallery.cover_photo_url || gallery.cover_image) ? (
                    <img
                      src={gallery.cover_photo_url || gallery.cover_image}
                      alt={gallery.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <svg className="w-8 h-8 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm font-medium text-white group-hover:text-brand-hover transition-colors truncate flex-1">
                    {gallery.name}
                  </h3>
                  {gallery.is_published === false && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 whitespace-nowrap">
                      טיוטה
                    </span>
                  )}
                  {gallery.is_published === true && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 whitespace-nowrap">
                      פורסמה
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {gallery.photo_count ?? photoCounts[gallery.id] ?? 0} תמונות
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
