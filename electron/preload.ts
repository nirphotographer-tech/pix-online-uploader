import { contextBridge, ipcRenderer } from 'electron';

export interface UploadFileInfo {
  path: string;
  name: string;
  size: number;
  type: string;
}

export interface UploadProgress {
  fileId: string;
  fileName: string;
  loaded: number;
  total: number;
  percentage: number;
  speed: number;
  totalLoaded: number;
  totalSize: number;
  totalPercentage: number;
  eta: number;
}

export interface UploadFileResult {
  fileId: string;
  success: boolean;
  error?: string;
}

export interface UploadStats {
  total: number;
  success: number;
  failed: number;
  totalTime: number;
}

export interface DeepLinkPayload {
  action: string;
  galleryId: string;
  galleryName: string;
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
    openFiles: () => Promise<string[]>;
    openFolder: () => Promise<string[]>;
  };
  power: {
    preventSleep: () => Promise<number>;
    allowSleep: () => Promise<void>;
  };
  notification: {
    show: (title: string, body: string) => Promise<void>;
  };
  upload: {
    start: (files: UploadFileInfo[], galleryId: string, token: string) => Promise<void>;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    cancel: () => Promise<void>;
    onProgress: (callback: (progress: UploadProgress) => void) => () => void;
    onFileComplete: (callback: (result: UploadFileResult) => void) => () => void;
    onAllComplete: (callback: (stats: UploadStats) => void) => () => void;
  };
  config: {
    getApiBaseUrl: () => Promise<string>;
  };
  deepLink: {
    onDeepLink: (callback: (payload: DeepLinkPayload) => void) => () => void;
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
    start: (files, galleryId, token) =>
      ipcRenderer.invoke('upload:start', files, galleryId, token),
    pause: () => ipcRenderer.invoke('upload:pause'),
    resume: () => ipcRenderer.invoke('upload:resume'),
    cancel: () => ipcRenderer.invoke('upload:cancel'),
    onProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: UploadProgress) =>
        callback(progress);
      ipcRenderer.on('upload:progress', handler);
      return () => ipcRenderer.removeListener('upload:progress', handler);
    },
    onFileComplete: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, result: UploadFileResult) =>
        callback(result);
      ipcRenderer.on('upload:fileComplete', handler);
      return () => ipcRenderer.removeListener('upload:fileComplete', handler);
    },
    onAllComplete: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, stats: UploadStats) =>
        callback(stats);
      ipcRenderer.on('upload:allComplete', handler);
      return () => ipcRenderer.removeListener('upload:allComplete', handler);
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
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
