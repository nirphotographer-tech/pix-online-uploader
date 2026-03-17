import { useState, useEffect, useCallback, useRef } from 'react';
import LoginScreen from './screens/LoginScreen';
import GallerySelectScreen from './screens/GallerySelectScreen';
import FolderSelectScreen from './screens/FolderSelectScreen';
import UploadScreen from './screens/UploadScreen';
import UploadStatusBar from './components/UploadStatusBar';
import { supabase } from './lib/supabase';
import type { UploadSessionInfo } from '../electron/preload';

const APP_VERSION = '1.3.0';

type Screen = 'login' | 'galleries' | 'folders' | 'upload';

interface AuthState {
  token: string;
  userId: string;
  email: string;
}

interface GalleryState {
  id: string;
  name: string;
}

interface FolderState {
  id: string;
  name: string;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('login');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [gallery, setGallery] = useState<GalleryState | null>(null);
  const [folder, setFolder] = useState<FolderState | null>(null);
  const [loading, setLoading] = useState(true);
  const [galleryKey, setGalleryKey] = useState(0);
  const [folderKey, setFolderKey] = useState(0);
  const [uploadSessions, setUploadSessions] = useState<UploadSessionInfo[]>([]);
  const pendingDeepLinkRef = useRef<any>(null);

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

  // Listen to upload session events (persistent across all screens)
  // Also broadcast progress to Supabase Realtime so the web app can show it
  useEffect(() => {
    if (!window.electronAPI) return;

    // Throttle broadcast: max once every 2 seconds per session
    const lastBroadcast = new Map<string, number>();

    const broadcastProgress = (session: UploadSessionInfo) => {
      const now = Date.now();
      const last = lastBroadcast.get(session.sessionId) || 0;
      const isFinal = session.status === 'done' || session.status === 'error';
      if (!isFinal && now - last < 2000) return; // throttle
      lastBroadcast.set(session.sessionId, now);

      const channel = supabase.channel(`uploader-progress:${session.galleryId}`);
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channel.send({
            type: 'broadcast',
            event: 'upload-progress',
            payload: {
              sessionId: session.sessionId,
              galleryId: session.galleryId,
              folderId: session.folderId,
              folderName: session.folderName,
              totalFiles: session.totalFiles,
              completedFiles: session.completedFiles,
              failedFiles: session.failedFiles,
              percentage: session.percentage,
              speed: session.speed,
              eta: session.eta,
              status: session.status,
            },
          });
          // Unsubscribe after sending to avoid channel buildup
          setTimeout(() => supabase.removeChannel(channel), 500);
        }
      });
    };

    const unsubUpdate = window.electronAPI.upload.onSessionUpdate((session) => {
      setUploadSessions((prev) => {
        const idx = prev.findIndex((s) => s.sessionId === session.sessionId);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = session;
          return updated;
        }
        return [...prev, session];
      });
      broadcastProgress(session);
    });

    const unsubComplete = window.electronAPI.upload.onSessionComplete((session) => {
      setUploadSessions((prev) => {
        const idx = prev.findIndex((s) => s.sessionId === session.sessionId);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = session;
          return updated;
        }
        return [...prev, session];
      });
      broadcastProgress(session);
    });

    return () => {
      unsubUpdate();
      unsubComplete();
    };
  }, []);


  // Deep link handler — also queues pending link if auth isn't ready yet
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubscribe = window.electronAPI.deepLink.onDeepLink((payload) => {
      if (payload.action === 'upload' && payload.galleryId) {
        if (auth) {
          applyDeepLink(payload);
        } else {
          // Auth not ready yet (session restoring) — save for later
          pendingDeepLinkRef.current = payload;
        }
      }
    });

    return unsubscribe;
  }, [auth]);

  // Process pending deep link once auth becomes available
  useEffect(() => {
    if (auth && pendingDeepLinkRef.current) {
      const payload = pendingDeepLinkRef.current;
      pendingDeepLinkRef.current = null;
      applyDeepLink(payload);
    }
  }, [auth]);

  const applyDeepLink = useCallback((payload: any) => {
    setGallery({ id: payload.galleryId, name: payload.galleryName || 'גלריה' });

    if (payload.folderId) {
      setFolder({ id: payload.folderId, name: payload.folderName || 'תיקייה' });
      setScreen('upload');
    } else {
      setFolder(null);
      setScreen('folders');
    }
  }, []);

  const handleLogin = useCallback((token: string, userId: string, email: string) => {
    setAuth({ token, userId, email });
    setScreen('galleries');
  }, []);

  const handleSelectGallery = useCallback((galleryId: string, galleryName: string) => {
    setGallery({ id: galleryId, name: galleryName });
    setFolder(null);
    setScreen('folders');
  }, []);

  const handleSelectFolder = useCallback((folderId: string, folderName: string) => {
    setFolder({ id: folderId, name: folderName });
    setScreen('upload');
  }, []);

  const handleBackToFolders = useCallback(() => {
    setFolder(null);
    setFolderKey((k) => k + 1);
    setScreen('folders');
  }, []);

  const handleUploadStarted = useCallback(() => {
    // After upload starts, navigate back to folders so user can upload more
    setFolder(null);
    setFolderKey((k) => k + 1);
    setScreen('folders');
  }, []);

  const handleLogout = useCallback(async () => {
    await window.electronAPI.store.clearSession();
    setAuth(null);
    setGallery(null);
    setFolder(null);
    setScreen('login');
  }, []);

  const handleBackToGalleries = useCallback(() => {
    setGallery(null);
    setFolder(null);
    setGalleryKey((k) => k + 1);
    setScreen('galleries');
  }, []);

  const handleCancelSession = useCallback((sessionId: string) => {
    window.electronAPI.upload.cancelSession(sessionId);
    setUploadSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
  }, []);

  const handleDismissSession = useCallback((sessionId: string) => {
    window.electronAPI.upload.dismissSession(sessionId);
    setUploadSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
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
    <div className="flex flex-col h-screen">
      {/* Main content area */}
      <div className="flex-1 overflow-hidden">
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
        {screen === 'folders' && auth && gallery && (
          <FolderSelectScreen
            key={folderKey}
            galleryId={gallery.id}
            galleryName={gallery.name}
            token={auth.token}
            userId={auth.userId}
            onSelectFolder={handleSelectFolder}
            onBack={handleBackToGalleries}
          />
        )}
        {screen === 'upload' && auth && gallery && folder && (
          <UploadScreen
            galleryId={gallery.id}
            galleryName={gallery.name}
            folderId={folder.id}
            folderName={folder.name}
            token={auth.token}
            onBack={handleBackToFolders}
            onUploadStarted={handleUploadStarted}
          />
        )}
      </div>

      {/* Persistent upload status bar — visible on all screens when uploads are active */}
      {screen !== 'login' && uploadSessions.length > 0 && (
        <UploadStatusBar
          sessions={uploadSessions}
          onCancel={handleCancelSession}
          onDismiss={handleDismissSession}
        />
      )}

      {/* Version number */}
      <div className="fixed bottom-2 left-2 text-[10px] text-white/20 select-none pointer-events-none">
        v{APP_VERSION}
      </div>
    </div>
  );
}
