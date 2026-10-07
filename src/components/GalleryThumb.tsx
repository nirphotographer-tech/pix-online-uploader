import { useEffect, useRef, useState } from 'react';
import { getThumbnail, peekThumbnail } from '../lib/thumbnails';

interface GalleryThumbProps {
  url?: string;
  alt: string;
}

const placeholderIcon = (
  <svg className="w-5 h-5 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

/** 56px cover tile. Loads a worker-made thumbnail once the row nears the visible area. */
export default function GalleryThumb({ url, alt }: GalleryThumbProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null | undefined>(() => (url ? peekThumbnail(url) : null));

  useEffect(() => {
    if (!url) {
      setSrc(null);
      return;
    }
    const known = peekThumbnail(url);
    if (known !== undefined) {
      setSrc(known);
      return;
    }
    setSrc(undefined);
    const el = ref.current;
    if (!el) return;

    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        getThumbnail(url).then((thumb) => {
          if (!cancelled) setSrc(thumb);
        });
      },
      // Start a few rows ahead of the scroll position
      { root: el.closest('[data-scroll-root]'), rootMargin: '400px 0px' }
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [url]);

  return (
    <div ref={ref} className="w-14 h-14 flex-shrink-0 bg-[#111] overflow-hidden flex items-center justify-center">
      {src ? (
        <img src={src} alt={alt} draggable={false} className="w-full h-full object-cover animate-fade-in" />
      ) : src === null ? (
        placeholderIcon
      ) : null}
    </div>
  );
}
