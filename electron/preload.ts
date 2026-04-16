import { contextBridge, ipcRenderer } from 'electron';

export interface UploadFileInfo {
  path: string;
  name: string;
  size: number;
  type: string;
}

export interface UploadSessionInfo {
  sessionId: string;
  galleryId: string;
  galleryName: string;
  folderId: string;
  folderName: string;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  totalSize: number;
  totalLoaded: number;
  percentage: number;
  speed: number;
  eta: number;
  status: 'uploading' | 'done' | 'error';
  errorMessage?: string;
}

export interface DeepLinkPayload {
  action: string;
  galleryId: string;
  galleryName: string;
  folderId: string;
  folderName: string;
}

export interface ElectronAPI {
  store: {
    getSession: () => Promise<{
      access_token: string;
      refresh_token: string;
      user_id: string;
      email: string;
    } | null>;
    setSession: (session: {
      access_token: string;
      refresh_token: string;
      user_id: string;
      email: string;
    } | null) => Promise<void>;
    clearSession: () => Promise<void>;
  };
  dialog: {
    openFiles: () => Promise<UploadFileInfo[]>;
    openFolder: () => Promise<UploadFileInfo[]>;
  };
  power: {
    preventSleep: () => Promise<number>;
    allowSleep: () => Promise<void>;
  };
  notification: {
    show: (title: string, body: string) => Promise<void>;
  };
  upload: {
    startSession: (
      sessionId: string,
      files: UploadFileInfo[],
      galleryId: string,
      galleryName: string,
      folderId: string,
      folderName: string,
      token: string
    ) => Promise<void>;
    cancelSession: (sessionId: string) => Promise<void>;
    dismissSession: (sessionId: string) => Promise<void>;
    getSessions: () => Promise<UploadSessionInfo[]>;
    hasActiveSessions: () => Promise<boolean>;
    onSessionUpdate: (callback: (session: UploadSessionInfo) => void) => () => void;
    onSessionComplete: (callback: (session: UploadSessionInfo) => void) => () => void;
    onAllSessionsComplete: (callback: () => void) => () => void;
  };
  config: {
    getApiBaseUrl: () => Promise<string>;
  };
  deepLink: {
    onDeepLink: (callback: (payload: DeepLinkPayload) => void) => () => void;
  };
  auth: {
    onTokenRefreshRequest: (callback: () => void) => () => void;
    sendFreshToken: (token: string) => void;
  };
  gallery: {
    checkDuplicates: (
      galleryId: string,
      folderId: string,
      fileNames: string[],
      token: string
    ) => Promise<{ file_name: string; id: string; size_bytes: number | null }[]>;
  };
}

const electronAPI: ElectronAPI = {
  store: {
    getSession: () => ipcRenderer.invoke('store:getSession'),
    setSession: (session) => ipcRenderer.invoke('store:setSession', session),
    clearSession: () => ipcRenderer.invoke('store:clearSession'),
  },
  dialog: {
    openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  },
  power: {
    preventSleep: () => ipcRenderer.invoke('power:preventSleep'),
    allowSleep: () => ipcRenderer.invoke('power:allowSleep'),
  },
  notification: {
    show: (title, body) => ipcRenderer.invoke('notification:show', title, body),
  },
  upload: {
    startSession: (sessionId, files, galleryId, galleryName, folderId, folderName, token) =>
      ipcRenderer.invoke(
        'upload:startSession',
        sessionId,
        files,
        galleryId,
        galleryName,
        folderId,
        folderName,
        token
      ),
    cancelSession: (sessionId) => ipcRenderer.invoke('upload:cancelSession', sessionId),
    dismissSession: (sessionId) => ipcRenderer.invoke('upload:dismissSession', sessionId),
    getSessions: () => ipcRenderer.invoke('upload:getSessions'),
    hasActiveSessions: () => ipcRenderer.invoke('upload:hasActiveSessions'),
    onSessionUpdate: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, session: UploadSessionInfo) =>
        callback(session);
      ipcRenderer.on('upload:sessionUpdate', handler);
      return () => ipcRenderer.removeListener('upload:sessionUpdate', handler);
    },
    onSessionComplete: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, session: UploadSessionInfo) =>
        callback(session);
      ipcRenderer.on('upload:sessionComplete', handler);
      return () => ipcRenderer.removeListener('upload:sessionComplete', handler);
    },
    onAllSessionsComplete: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('upload:allSessionsComplete', handler);
      return () => ipcRenderer.removeListener('upload:allSessionsComplete', handler);
    },
  },
  config: {
    getApiBaseUrl: () => ipcRenderer.invoke('config:getApiBaseUrl'),
  },
  deepLink: {
    onDeepLink: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: DeepLinkPayload) =>
        callback(payload);
      ipcRenderer.on('deep-link', handler);
      return () => ipcRenderer.removeListener('deep-link', handler);
    },
  },
  auth: {
    onTokenRefreshRequest: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('auth:refreshTokenRequest', handler);
      return () => ipcRenderer.removeListener('auth:refreshTokenRequest', handler);
    },
    sendFreshToken: (token: string) => {
      ipcRenderer.send('auth:freshToken', token);
    },
  },
  gallery: {
    checkDuplicates: (galleryId, folderId, fileNames, token) =>
      ipcRenderer.invoke('gallery:checkDuplicates', galleryId, folderId, fileNames, token),
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
