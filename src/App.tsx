import { useState, useEffect, useCallback, useRef } from 'react';
import LoginScreen from './screens/LoginScreen';
import GallerySelectScreen from './screens/GallerySelectScreen';
import FolderSelectScreen, { type FolderItem } from './screens/FolderSelectScreen';
import UploadScreen from './screens/UploadScreen';
import { supabase } from './lib/supabase';
import type { UploadSessionInfo } from '../electron/preload';

const APP_VERSION = '2.5.2';

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
  const [cachedFolders, setCachedFolders] = useState<FolderItem[]>([]);
  // pendingSessions/resumingSession removed — auto-resume handles this silently
  const pendingDeepLinkRef = useRef<any>(null);
  const [screenTransition, setScreenTransition] = useState(false);

  // Screen transition helper
  const navigateTo = useCallback((nextScreen: Screen) => {
    setScreenTransition(true);
    setTimeout(() => {
      setScreen(nextScreen);
      setScreenTransition(false);
    }, 150);
  }, []);

  // Auto-resume pending (interrupted) sessions when user is authenticated — no prompt
  const autoResumeAllRef = useRef(false);
  const autoResumeAll = useCallback(async (token: string) => {
    if (!window.electronAPI) return;
    if (typeof window.electronAPI.upload.getPendingSessions !== 'function') return;
    try {
      const sessions = await window.electronAPI.upload.getPendingSessions();
      if (!sessions || sessions.length === 0) return;
      console.log(`[Resume] Auto-resuming ${sessions.length} interrupted session(s)`);
      for (const s of sessions) {
        try {
          const result = await window.electronAPI.upload.resumePendingSession(s.sessionId, token);
          if (!result.resumed) {
            await window.electronAPI.upload.dismissPendingSession(s.sessionId);
            console.log(`[Resume] Session ${s.sessionId} discarded: ${result.reason}`);
          } else {
            console.log(`[Resume] Session ${s.sessionId} resumed with ${result.remainingCount} files`);
          }
        } catch (err) {
          console.error('[Resume] Error resuming session:', err);
        }
      }
    } catch (err) {
      console.error('[Resume] getPendingSessions error:', err);
    }
  }, []);

  useEffect(() => {
    if (!auth) return;
    autoResumeAllRef.current = false;
    // Slight delay to let the upload manager initialise
    const t = setTimeout(() => autoResumeAll(auth.token), 1500);
    return () => clearTimeout(t);
  }, [auth, autoResumeAll]);

  // Auto-resume when network comes back online (only if user hasn't manually stopped)
  useEffect(() => {
    if (!auth) return;
    const handleOnline = () => {
      console.log('[Network] Back online — auto-resuming pending sessions');
      autoResumeAll(auth.token);
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [auth, autoResumeAll]);

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
          const { data, error } = await supabase.auth.setSession({
            access_token: saved.access_token,
            refresh_token: saved.refresh_token,
          });

          if (error || !data.session) {
            await window.electronAPI.store.clearSession();
            setLoading(false);
            return;
          }

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

  // Listen to upload session events + broadcast to Supabase Realtime
  useEffect(() => {
    if (!window.electronAPI) return;

    const channels = new Map<string, ReturnType<typeof supabase.channel>>();
    const channelReady = new Map<string, boolean>();
    const pendingMessages = new Map<string, any>();
    const lastBroadcast = new Map<string, number>();

    const getOrCreateChannel = (galleryId: string) => {
      if (channels.has(galleryId)) return channels.get(galleryId)!;
      
      const channel = supabase.channel(`uploader-progress:${galleryId}`);
      channels.set(galleryId, channel);
      
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channelReady.set(galleryId, true);
          const pending = pendingMessages.get(galleryId);
          if (pending) {
            channel.send({ type: 'broadcast', event: 'upload-progress', payload: pending });
            pendingMessages.delete(galleryId);
          }
        }
      });
      
      return channel;
    };

    const lastCompletedFiles = new Map<string, number>();

    const broadcastProgress = (session: UploadSessionInfo) => {
      const now = Date.now();
      const last = lastBroadcast.get(session.sessionId) || 0;
      const isFinal = session.status === 'done' || session.status === 'error';
      const prevCompleted = lastCompletedFiles.get(session.sessionId) || 0;
      const fileJustCompleted = session.completedFiles > prevCompleted;
      if (!isFinal && !fileJustCompleted && now - last < 1000) return;
      lastBroadcast.set(session.sessionId, now);
      lastCompletedFiles.set(session.sessionId, session.completedFiles);

      const payload = {
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
        errorMessage: session.errorMessage,
      };

      const channel = getOrCreateChannel(session.galleryId);
      if (channelReady.get(session.galleryId)) {
        channel.send({ type: 'broadcast', event: 'upload-progress', payload });
      } else {
        pendingMessages.set(session.galleryId, payload);
      }
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
      channels.forEach((channel) => supabase.removeChannel(channel));
    };
  }, []);

  // Deep link handler
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubscribe = window.electronAPI.deepLink.onDeepLink((payload) => {
      if (payload.action === 'upload' && payload.galleryId) {
        if (auth) {
          applyDeepLink(payload);
        } else {
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

  // Proactive token refresh — every 50 minutes
  useEffect(() => {
    if (!auth) return;

    const REFRESH_INTERVAL = 50 * 60 * 1000;

    const refreshToken = async () => {
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (error || !data.session) {
          console.error('Token refresh failed:', error?.message);
          return;
        }
        const fresh = data.session;
        setAuth({
          token: fresh.access_token,
          userId: fresh.user.id,
          email: fresh.user.email || auth.email,
        });
        await window.electronAPI.store.setSession({
          access_token: fresh.access_token,
          refresh_token: fresh.refresh_token,
          user_id: fresh.user.id,
          email: fresh.user.email || auth.email,
        });
        console.log('[Auth] Token refreshed proactively');
      } catch (err) {
        console.error('[Auth] Token refresh error:', err);
      }
    };

    const interval = setInterval(refreshToken, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [auth]);

  // Reactive token refresh (after 401 from upload queue)
  useEffect(() => {
    if (!window.electronAPI) return;
    
    const handler = async () => {
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (error || !data.session) {
          console.error('[Auth] Reactive token refresh failed:', error?.message);
          return;
        }
        const fresh = data.session;
        setAuth({
          token: fresh.access_token,
          userId: fresh.user.id,
          email: fresh.user.email || auth?.email || '',
        });
        await window.electronAPI.store.setSession({
          access_token: fresh.access_token,
          refresh_token: fresh.refresh_token,
          user_id: fresh.user.id,
          email: fresh.user.email || auth?.email || '',
        });
        window.electronAPI.auth.sendFreshToken(fresh.access_token);
        console.log('[Auth] Token refreshed reactively (after 401)');
      } catch (err) {
        console.error('[Auth] Reactive token refresh error:', err);
        window.electronAPI.auth.sendFreshToken('');
      }
    };

    const unsub = window.electronAPI.auth.onTokenRefreshRequest(handler);
    return unsub;
  }, [auth]);

  const applyDeepLink = useCallback((payload: any) => {
    setGallery({ id: payload.galleryId, name: payload.galleryName || 'גלריה' });

    if (payload.folderId) {
      const rawFolderId = String(payload.folderId || '').trim();
      const normalizedFolderId = rawFolderId && rawFolderId.includes('-folder-')
        ? rawFolderId
        : `${payload.galleryId}-folder-${rawFolderId}`;

      setFolder({ id: normalizedFolderId, name: payload.folderName || 'תיקייה' });
      setScreen('upload');
    } else {
      setFolder(null);
      setScreen('folders');
    }
  }, []);


  const handleLogin = useCallback((token: string, userId: string, email: string) => {
    setAuth({ token, userId, email });
    navigateTo('galleries');
  }, [navigateTo]);

  const handleSelectGallery = useCallback((galleryId: string, galleryName: string) => {
    setGallery({ id: galleryId, name: galleryName });
    setFolder(null);
    navigateTo('folders');
  }, [navigateTo]);

  const handleSelectFolder = useCallback((folderId: string, folderName: string) => {
    setFolder({ id: folderId, name: folderName });
    navigateTo('upload');
  }, [navigateTo]);

  const handleBackToFolders = useCallback(() => {
    setFolder(null);
    setFolderKey((k) => k + 1);
    navigateTo('folders');
  }, [navigateTo]);

  const handleUploadStarted = useCallback(() => {
    setFolder(null);
    setFolderKey((k) => k + 1);
    navigateTo('folders');
  }, [navigateTo]);

  const handleLogout = useCallback(async () => {
    await window.electronAPI.store.clearSession();
    setAuth(null);
    setGallery(null);
    setFolder(null);
    navigateTo('login');
  }, [navigateTo]);

  const handleBackToGalleries = useCallback(() => {
    setGallery(null);
    setFolder(null);
    setCachedFolders([]);
    setGalleryKey((k) => k + 1);
    navigateTo('galleries');
  }, [navigateTo]);


  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-dark-bg gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-primary to-brand-hover flex items-center justify-center shadow-lg shadow-brand-primary/20">
          <svg className="animate-spin w-5 h-5 text-white" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
        <p className="text-xs text-gray-600">טוען...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      {/* macOS traffic light drag region */}
      <div className="h-9 flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />


      {/* Pending sessions are auto-resumed silently on load/reconnect */}

      {/* Main content area with transition */}
      <div
        className={`flex-1 h-full overflow-visible transition-opacity duration-150 ${
          screenTransition ? 'opacity-0' : 'opacity-100'
        }`}
      >
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
            uploadSessions={uploadSessions}
            initialFolders={cachedFolders.length > 0 ? cachedFolders : undefined}
            onFoldersLoaded={setCachedFolders}
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



      {/* Version number */}
      <div className="fixed bottom-2 left-2 text-[10px] text-black/30 select-none pointer-events-none">
        v{APP_VERSION}
      </div>
    </div>
  );
}
