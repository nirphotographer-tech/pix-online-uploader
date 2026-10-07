/// <reference lib="webworker" />
// Downloads a gallery cover and shrinks it to a small square thumbnail.
// Covers are the full-size originals (often 4-5 MB, 24 MP); decoding them on
// the UI thread while scrolling made the gallery list stutter, so all of it
// happens here and only a few-KB thumbnail goes back.

interface ThumbRequest {
  id: number;
  url: string;
  size: number;
}

// The website keeps a lighter .webp copy next to most JPEG originals
function webpSibling(url: string): string | null {
  const m = url.match(/^(.*)\.(jpe?g|png)$/i);
  return m ? `${m[1]}.webp` : null;
}

async function fetchImage(url: string): Promise<Blob> {
  const webp = webpSibling(url);
  if (webp) {
    try {
      const res = await fetch(webp);
      if (res.ok) return await res.blob();
    } catch {
      // fall back to the original
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

// A full-size decode briefly takes ~100 MB, so only a couple run at once
const MAX_DECODES = 2;
let decoding = 0;
const waiting: Array<() => void> = [];

async function makeThumb(url: string, size: number): Promise<Blob> {
  const image = await fetchImage(url);
  if (decoding >= MAX_DECODES) await new Promise<void>((resolve) => waiting.push(resolve));
  decoding++;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(image);
    // Center crop to a square, like object-fit: cover
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  } finally {
    bitmap?.close();
    decoding--;
    waiting.shift()?.();
  }
}

self.onmessage = async (e: MessageEvent<ThumbRequest>) => {
  const { id, url, size } = e.data;
  try {
    const blob = await makeThumb(url, size);
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
