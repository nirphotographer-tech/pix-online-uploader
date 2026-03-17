import { useState, useEffect, useCallback } from 'react';
import LoginScreen from './screens/LoginScreen';
import GallerySelectScreen from './screens/GallerySelectScreen';
import UploadScreen from './screens/UploadScreen';
import { supabase } from './lib/supabase';

type Screen = 'login' | 'galleries' | 'upload';

interface AuthState {
  token: string;
  userId: string;
  email: string;
}

interface GalleryState {
  id: string;
  name: string;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('login');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [gallery, setGallery] = useState<GalleryState | null>(null);
  const [loading, setLoading] = useState(true);
  const [galleryKey, setGalleryKey] = useState(0);

  // Restore session on mount
  useEffect(() => {
    const restoreSession = async () => {
      try {
        if (!window.electronAPI) {
          setLoading(false);
          return;
        }
        const saved = await window.electronAPI.store.getSession();
        if (saved) {
          // Refresh the token via Supabase to ensure it's valid
          const { data, error } = await supabase.auth.setSession({
            access_token: saved.access_token,
            refresh_token: saved.refresh_token,
          });

          if (error || !data.session) {
            // Token expired and can't be refreshed — force re-login
            await window.electronAPI.store.clearSession();
            setLoading(false);
            return;
          }

          // Save the refreshed tokens
          const freshToken = data.session.access_token;
          const freshRefresh = data.session.refresh_token;
          await window.electronAPI.store.setSession({
            access_token: freshToken,
            refresh_token: freshRefresh,
            user_id: data.session.user.id,
            email: data.session.user.email || saved.email,
          });

          setAuth({
            token: freshToken,
            userId: data.session.user.id,
            email: data.session.user.email || saved.email,
          });
          setScreen('galleries');
        }
      } catch {
        // No saved session, stay on login
      } finally {
        setLoading(false);
      }
    };

    restoreSession();
  }, []);

  // Deep link handler
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubscribe = window.electronAPI.deepLink.onDeepLink((payload) => {
      if (payload.action === 'upload' && payload.galleryId && auth) {
        setGallery({ id: payload.galleryId, name: payload.galleryName || 'גלריה' });
        setScreen('upload');
      }
    });

    return unsubscribe;
  }, [auth]);

  const handleLogin = useCallback((token: string, userId: string, email: string) => {
    setAuth({ token, userId, email });
    setScreen('galleries');
  }, []);

  const handleSelectGallery = useCallback((galleryId: string, galleryName: string) => {
    setGallery({ id: galleryId, name: galleryName });
    setScreen('upload');
  }, []);

  const handleLogout = useCallback(async () => {
    await window.electronAPI.store.clearSession();
    setAuth(null);
    setGallery(null);
    setScreen('login');
  }, []);

  const handleBackToGalleries = useCallback(() => {
    setGallery(null);
    setGalleryKey((k) => k + 1);
    setScreen('galleries');
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-dark-bg">
        <svg className="animate-spin w-8 h-8 text-brand-primary" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  return (
    <>
      {screen === 'login' && <LoginScreen onLogin={handleLogin} />}
      {screen === 'galleries' && auth && (
        <GallerySelectScreen
          key={galleryKey}
          token={auth.token}
          userId={auth.userId}
          onSelectGallery={handleSelectGallery}
          onLogout={handleLogout}
          email={auth.email}
        />
      )}
      {screen === 'upload' && auth && gallery && (
        <UploadScreen
          galleryId={gallery.id}
          galleryName={gallery.name}
          token={auth.token}
          onBack={handleBackToGalleries}
        />
      )}
    </>
  );
}
