import ThumbWorker from './thumbWorker?worker&inline';

// Thumbnails for gallery covers, made in a worker (see thumbWorker.ts).
// Results are kept in memory for this run and in IndexedDB across runs —
// cover URLs are timestamped uploads, so a URL's image never changes.

const THUMB_SIZE = 112; // 2x the 56px tile, sharp on high-DPI screens
const MAX_PARALLEL = 6; // downloads in flight; the worker decodes 2 at a time

const DB_NAME = 'pix-thumbs';
const STORE = 'thumbs';

const ready = new Map<string, string | null>(); // url → object URL (null = failed)
const pending = new Map<string, Promise<string | null>>();

let worker: Worker | null = null;
let nextId = 0;
const callbacks = new Map<number, (result: { blob?: Blob; error?: string }) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new ThumbWorker();
    worker.onmessage = (e: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
      const cb = callbacks.get(e.data.id);
      callbacks.delete(e.data.id);
      cb?.(e.data);
    };
  }
  return worker;
}

// Simple FIFO limiter so a long gallery list doesn't download dozens at once
let active = 0;
const queue: Array<() => void> = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => queue.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

function renderInWorker(url: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    callbacks.set(id, ({ blob, error }) => (blob ? resolve(blob) : reject(new Error(error))));
    getWorker().postMessage({ id, url, size: THUMB_SIZE });
  });
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function readCached(url: string): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE).objectStore(STORE).get(url);
      req.onsuccess = () => resolve(req.result instanceof Blob ? req.result : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeCached(url: string, blob: Blob): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, url);
  } catch {
    // cache is best-effort
  }
}

/** Already-made thumbnail for this cover, without waiting. */
export function peekThumbnail(url: string): string | null | undefined {
  return ready.get(url);
}

/** Small square thumbnail (object URL) for a cover image, or null if it can't be loaded. */
export function getThumbnail(url: string): Promise<string | null> {
  if (ready.has(url)) return Promise.resolve(ready.get(url)!);
  let p = pending.get(url);
  if (!p) {
    p = (async () => {
      try {
        let blob = await readCached(url);
        if (!blob) {
          blob = await limited(() => renderInWorker(url));
          void writeCached(url, blob);
        }
        const objectUrl = URL.createObjectURL(blob);
        ready.set(url, objectUrl);
        return objectUrl;
      } catch {
        ready.set(url, null);
        return null;
      } finally {
        pending.delete(url);
      }
    })();
    pending.set(url, p);
  }
  return p;
}
