import { supabase } from './supabase';

/**
 * Realtime link with the website's gallery editor, one Supabase broadcast
 * channel per gallery (`uploader-progress:${galleryId}`).
 *
 * - 'upload-progress' (we send): the editor's progress bar.
 * - 'folders-changed' (both ways): folders were added / renamed / reordered /
 *   deleted. The receiver re-reads the folders from the DB. Arriving events are
 *   re-dispatched as a window event, see onFoldersChanged().
 */

const PROGRESS_EVENT = 'upload-progress';
const FOLDERS_CHANGED_EVENT = 'folders-changed';
const WINDOW_EVENT = 'pix:gallery-folders-changed';

interface ChannelEntry {
  channel: ReturnType<typeof supabase.channel>;
  ready: boolean;
  /** Latest unsent payload per event, sent once the channel is subscribed */
  pending: Map<string, unknown>;
}

const channels = new Map<string, ChannelEntry>();

function getChannel(galleryId: string): ChannelEntry {
  const existing = channels.get(galleryId);
  if (existing) return existing;

  const channel = supabase.channel(`uploader-progress:${galleryId}`);
  const entry: ChannelEntry = { channel, ready: false, pending: new Map() };
  channels.set(galleryId, entry);

  channel.on('broadcast', { event: FOLDERS_CHANGED_EVENT }, () => {
    window.dispatchEvent(new CustomEvent(WINDOW_EVENT, { detail: { galleryId } }));
  });

  channel.subscribe((status) => {
    entry.ready = status === 'SUBSCRIBED';
    if (!entry.ready) return;
    entry.pending.forEach((payload, event) => {
      channel.send({ type: 'broadcast', event, payload });
    });
    entry.pending.clear();
  });

  return entry;
}

function send(galleryId: string, event: string, payload: unknown): void {
  const entry = getChannel(galleryId);
  if (entry.ready) {
    entry.channel.send({ type: 'broadcast', event, payload });
  } else {
    entry.pending.set(event, payload);
  }
}

export function sendUploadProgress(galleryId: string, payload: unknown): void {
  send(galleryId, PROGRESS_EVENT, payload);
}

/** Tell an open gallery editor that this gallery's folders changed */
export function notifyFoldersChanged(galleryId: string): void {
  send(galleryId, FOLDERS_CHANGED_EVENT, { galleryId, source: 'uploader', at: Date.now() });
}

/**
 * Run `callback` when the website changed this gallery's folders.
 * Subscribes to the gallery's channel if needed. Returns an unsubscribe function.
 */
export function onFoldersChanged(galleryId: string, callback: () => void): () => void {
  getChannel(galleryId);
  const handler = (e: Event) => {
    if ((e as CustomEvent<{ galleryId: string }>).detail?.galleryId === galleryId) callback();
  };
  window.addEventListener(WINDOW_EVENT, handler);
  return () => window.removeEventListener(WINDOW_EVENT, handler);
}

export function removeAllGalleryChannels(): void {
  channels.forEach(({ channel }) => supabase.removeChannel(channel));
  channels.clear();
}
