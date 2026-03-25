import { useState, useEffect, useCallback, useRef } from 'react';
import LoginScreen from './screens/LoginScreen';
import GallerySelectScreen from './screens/GallerySelectScreen';
import FolderSelectScreen from './screens/FolderSelectScreen';
import UploadScreen from './screens/UploadScreen';
import UploadStatusBar from './components/UploadStatusBar';
import { supabase } from './lib/supabase';
import type { UploadSessionInfo, PendingSession } from '../electron/preload';

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
  const [pendingSessions, setPendingSessions] = useState<PendingSession[]>([]);
  const pendingDeepLinkRef = useRef<any>(null);
  const [screenTransition, setScreenTransition] = useState(false);
  const [toastNotifications, setToastNotifications] = useState<Array<{
    id: string;
    folderName: string;
    galleryName: string;
    count: number;
  }>>([]);

  // Screen transition helper
  const navigateTo = useCallback((nextScreen: Screen) => {
    setScreenTransition(true);
    setTimeout(() => {
      setScreen(nextScreen);
      setScreenTransition(false);
    }, 150);
  }, []);

  // Restore session on mount
  useEffect(() => {
    const restoreSession = async () => {
      try {
        if (!window.electronAPI) {
          setLoading(false);
          return;
        }
        const saved = await window.electronAPI.store.getSession();
        if (!saved) {
          setLoading(false);
          return;
        }

        // Retry up to 3 times in case of network/timeout errors on cold start
        let lastError: unknown = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const { data, error } = await supabase.auth.setSession({
              access_token: saved.access_token,
              refresh_token: saved.refresh_token,
            });

            if (error) {
              // Auth error (token revoked / invalid) — don't retry, clear session
              console.warn('[Auth] Session restore failed (auth error):', error.message);
              await window.electronAPI.store.clearSession();
              setLoading(false);
              return;
            }

            if (!data.session) {
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
            setLoading(false);
            return; // success
          } catch (err) {
            lastError = err;
            console.warn(`[Auth] Session restore attempt ${attempt}/3 failed:`, err);
            if (attempt < 3) {
              // Wait before retrying (1s, then 2s)
              await new Promise((r) => setTimeout(r, attempt * 1000));
            }
          }
        }

        // All retries exhausted — network issue, but keep the saved session
        // so next launch can try again. Don't clear it.
        console.error('[Auth] Session restore failed after 3 attempts, will retry next launch:', lastError);
      } finally {
        setLoading(false);
      }
    };

    restoreSession();
  }, []);

  // Listen to upload session events + broadcast to Supabase Realtime
  useEffect(() => {
    if (!window.electronAPI) return;

    // Load any sessions that were interrupted by a previous app quit
    window.electronAPI.pendingUploads.getSessions().then((sessions) => {
      if (sessions.length > 0) {
        setPendingSessions(sessions);
      }
    }).catch(() => {/* ignore */});

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

      // Toast notification on successful completion
      if (session.status === 'done' && session.failedFiles === 0) {
        const toastId = session.sessionId;
        setToastNotifications((prev) => [
          ...prev.filter((t) => t.id !== toastId),
          {
            id: toastId,
            folderName: session.folderName || 'תיקייה',
            galleryName: session.galleryName || 'גלריה',
            count: session.completedFiles,
          },
        ]);
      }
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
      setFolder({ id: payload.folderId, name: payload.folderName || 'תיקייה' });
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
    await window.electronAPI.pendingUploads.clearAll();
    setPendingSessions([]);
    setAuth(null);
    setGallery(null);
    setFolder(null);
    setToastNotifications([]);
    navigateTo('login');
  }, [navigateTo]);

  const handleBackToGalleries = useCallback(() => {
    setGallery(null);
    setFolder(null);
    setGalleryKey((k) => k + 1);
    navigateTo('galleries');
  }, [navigateTo]);

  const handleCancelSession = useCallback((sessionId: string) => {
    window.electronAPI.upload.cancelSession(sessionId);
    setUploadSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
  }, []);

  const handleDismissSession = useCallback((sessionId: string) => {
    window.electronAPI.upload.dismissSession(sessionId);
    setUploadSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
  }, []);

  // Resume a session that was interrupted when the app quit
  const handleResumePendingSession = useCallback(async (pending: PendingSession) => {
    if (!auth) return;

    // Filter out files that already completed
    const remainingFiles = pending.files.filter(
      (f) => !pending.completedFileNames.includes(f.name)
    );
    if (remainingFiles.length === 0) {
      await window.electronAPI.pendingUploads.dismissSession(pending.sessionId);
      setPendingSessions((prev) => prev.filter((s) => s.sessionId !== pending.sessionId));
      return;
    }

    // Refresh the auth token before resuming
    let token = auth.token;
    try {
      const { data } = await supabase.auth.refreshSession();
      if (data.session) token = data.session.access_token;
    } catch { /* use existing token */ }

    // Start upload with remaining files (reuse same sessionId so persistence tracks it)
    await window.electronAPI.upload.startSession(
      pending.sessionId,
      remainingFiles,
      pending.galleryId,
      pending.galleryName,
      pending.folderId,
      pending.folderName,
      token
    );

    // Remove from pending banner
    setPendingSessions((prev) => prev.filter((s) => s.sessionId !== pending.sessionId));
  }, [auth]);

  const handleDismissPendingSession = useCallback(async (sessionId: string) => {
    await window.electronAPI.pendingUploads.dismissSession(sessionId);
    setPendingSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
  }, []);

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
      {/* Resume upload banner — shown after app restart if uploads were interrupted */}
      {screen !== 'login' && pendingSessions.length > 0 && (
        <div className="fixed top-14 left-3 right-3 z-50 flex flex-col gap-2">
          {pendingSessions.map((pending) => {
            const remaining = pending.files.length - pending.completedFileNames.length;
            return (
              <div
                key={pending.sessionId}
                className="flex items-center gap-3 bg-[#1a1a2e] border border-[#7c5ff6] rounded-xl px-4 py-3 shadow-xl"
              >
                <span className="text-lg flex-shrink-0">📤</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white leading-tight truncate">
                    {pending.galleryName}
                    {pending.folderName ? ` / ${pending.folderName}` : ''}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    נשארו {remaining} תמונות להעלאה
                  </p>
                </div>
                <button
                  onClick={() => handleResumePendingSession(pending)}
                  className="flex-shrink-0 bg-brand-primary hover:bg-brand-hover text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                >
                  המשך
                </button>
                <button
                  onClick={() => handleDismissPendingSession(pending.sessionId)}
                  className="flex-shrink-0 text-gray-500 hover:text-gray-300 transition-colors"
                  title="בטל"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M18 6L6 18M6 6l12 12"/>
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Toast notifications */}
      {toastNotifications.length > 0 && (
        <div className="fixed top-14 right-3 z-50 flex flex-col gap-2 pointer-events-none">
          {toastNotifications.map((toast) => (
            <div
              key={toast.id}
              className="pointer-events-auto flex items-start gap-3 bg-white border border-gray-200 rounded-xl shadow-lg px-4 py-3 min-w-[240px] max-w-[300px] animate-slide-in"
            >
              <span className="text-xl mt-0.5">✅</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900 leading-tight">העלאה הושלמה!</p>
                <p className="text-xs text-gray-500 mt-0.5 leading-snug">
                  {toast.count} תמונות הועלו לתיקייה <span className="font-medium text-gray-700">{toast.folderName}</span>
                </p>
              </div>
              <button
                onClick={() => setToastNotifications((prev) => prev.filter((t) => t.id !== toast.id))}
                className="text-gray-400 hover:text-gray-600 transition-colors mt-0.5 flex-shrink-0"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

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

      {/* Persistent upload status bar */}
      {screen !== 'login' && uploadSessions.length > 0 && (
        <UploadStatusBar
          sessions={uploadSessions}
          onCancel={handleCancelSession}
          onDismiss={handleDismissSession}
        />
      )}

      {/* Version number */}
      <div className="fixed bottom-2 left-2 text-[10px] text-black/30 select-none pointer-events-none">
        v{APP_VERSION}
      </div>
    </div>
  );
}
