/**
 * Face scan service for pix-online-uploader (Electron renderer).
 * Runs after gallery upload completes — pre-populates the face-data cache
 * so visitors see ready-to-click face circles without waiting for a scan.
 *
 * Results are saved directly to Supabase (anon key; RLS allows public write).
 */
import { supabase } from './supabase';

// ── Config (mirrors pix-online FACE_RECOGNITION_CONFIG) ─────────────────────
const CFG = {
  UNIQUE_FACE_THRESHOLD:    0.63,
  CLUSTER_MERGE_THRESHOLD:  0.60,
  PROFILE_MERGE_THRESHOLD:  0.55,
  MAX_YAW_FRONTAL:          30,
  MIN_EYE_DISTANCE_RATIO:   0.22,
  MAX_FACES_PER_IMAGE:      100,
  MIN_FACE_SCORE:           0.60,
  MIN_FACE_SHARPNESS:       70,
  MATCH_MARGIN_THRESHOLD:   0.06,
};

// ── Human.js (loaded from CDN into Electron Chromium renderer) ───────────────
const HUMAN_ESM_URL   = 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/dist/human.esm.js';
const HUMAN_MODEL_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/human/models/';

type HumanInstance = {
  detect: (input: HTMLCanvasElement, config?: object) => Promise<any>;
  match: {
    similarity: (a: Float32Array | number[], b: Float32Array | number[]) => number;
  };
};

let _human: HumanInstance | null = null;

async function getHuman(): Promise<HumanInstance> {
  if (_human) return _human;
  const mod = await import(/* @vite-ignore */ HUMAN_ESM_URL);
  const Human = mod.default;
  _human = new Human({
    modelBasePath: HUMAN_MODEL_CDN,
    async: true,
    face: {
      enabled: true,
      detector: {
        maxDetected: CFG.MAX_FACES_PER_IMAGE,
        rotation: true,
        return: true,
        minConfidence: 0.1,
        minSize: 64,
        iouThreshold: 0.01,
      },
      mesh:        { enabled: true },
      description: { enabled: true, minConfidence: 0.1 },
      emotion:     { enabled: false },
      iris:        { enabled: false },
      antispoof:   { enabled: false },
      liveness:    { enabled: false },
    },
    body:    { enabled: false },
    hand:    { enabled: false },
    object:  { enabled: false },
    gesture: { enabled: false },
  }) as HumanInstance;
  return _human;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function centroid(descs: Float32Array[]): Float32Array {
  const len = descs[0].length;
  const sum = new Float32Array(len);
  for (const d of descs) for (let i = 0; i < len; i++) sum[i] += d[i];
  for (let i = 0; i < len; i++) sum[i] /= descs.length;
  return sum;
}

function sampled(descs: Float32Array[], max = 4): Float32Array[] {
  if (descs.length <= max) return descs;
  const out: Float32Array[] = [];
  const step = (descs.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(descs[Math.round(i * step)]);
  return out;
}

function laplacianVariance(imgData: ImageData): number {
  const { data, width, height } = imgData;
  if (width < 3 || height < 3) return 0;
  const gray = new Float32Array(width * height);
  for (let p = 0, d = 0; p < gray.length; p++, d += 4)
    gray[p] = 0.299 * data[d] + 0.587 * data[d + 1] + 0.114 * data[d + 2];
  let sum = 0, sumSq = 0, count = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      const lap = 4 * gray[idx] - gray[idx - 1] - gray[idx + 1] - gray[idx - width] - gray[idx + width];
      sum += lap; sumSq += lap * lap; count++;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

// ── Public API ───────────────────────────────────────────────────────────────
export interface ScanPhoto {
  id: string;
  url: string;
}

/**
 * Scan all photos in a gallery for faces and save results to Supabase.
 * Runs silently in the Electron renderer process after upload completes.
 */
export async function runGalleryFaceScan(
  shareId: string,
  photos: ScanPhoto[],
  options?: { force?: boolean }
): Promise<void> {
  if (!shareId || photos.length === 0) return;

  // Check if cache already exists (skip unless force)
  if (!options?.force) {
    const { data } = await supabase
      .from('gallery_face_data')
      .select('share_id')
      .eq('share_id', shareId)
      .maybeSingle();
    if (data) {
      console.log(`[face-scan] ✅ Cache exists for ${shareId.substring(0, 8)}, skipping`);
      return;
    }
  }

  console.log(`[face-scan] 🔍 Starting scan of ${photos.length} photos for gallery ${shareId.substring(0, 8)}`);
  const human = await getHuman();
  console.log(`[face-scan] ✅ Human.js loaded`);

  type FaceCandidate = {
    faceIndex: number; photoId: string; photoUrl: string;
    score: number; sharpness: number;
    box: { x: number; y: number; width: number; height: number };
    descriptor: Float32Array;
    yaw?: number; pitch?: number; eyeDistanceRatio?: number;
  };

  const allFaces: FaceCandidate[] = [];
  const faceDataRows: Array<{ photoId: string; descriptors: number[][]; faceCount: number }> = [];

  for (let pi = 0; pi < photos.length; pi++) {
    const photo = photos[pi];

    // Load image
    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 12_000);
      img.onload = () => { clearTimeout(t); resolve(); };
      img.onerror = () => { clearTimeout(t); resolve(); };
      img.src = photo.url;
    });
    if (!img.complete || !img.naturalWidth) continue;

    // Draw to canvas
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.drawImage(img, 0, 0);

    const result = await human.detect(canvas);
    const faces = result?.face ?? [];
    if (!faces.length) continue;

    const imgW = canvas.width, imgH = canvas.height;
    const acceptedDescriptors: Float32Array[] = [];

    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      const embedding: number[] | undefined = f.embedding;
      if (!embedding) continue;
      const descriptor = new Float32Array(embedding);

      const [bx, by, bw, bh] = f.boxRaw as [number, number, number, number];
      const box = { x: bx * imgW, y: by * imgH, width: bw * imgW, height: bh * imgH };
      if (Math.min(box.width, box.height) < 72) continue;

      const score = f.score ?? (f.boxScore ?? 0);
      if (score < CFG.MIN_FACE_SCORE) continue;

      // Crop face thumbnail
      const side = Math.max(box.width, box.height) * 1.15;
      const half = side / 2;
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const cropX = Math.max(0, Math.min(imgW - side, cx - half));
      const cropY = Math.max(0, Math.min(imgH - side, cy - half));
      const cropW = Math.min(side, imgW), cropH = Math.min(side, imgH);

      const fc = document.createElement('canvas');
      fc.width = fc.height = 160;
      const fctx = fc.getContext('2d')!;
      fctx.fillStyle = '#f3f4f6';
      fctx.fillRect(0, 0, 160, 160);
      fctx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, 160, 160);

      const sharpness = laplacianVariance(fctx.getImageData(0, 0, 160, 160));
      if (sharpness < CFG.MIN_FACE_SHARPNESS) continue;

      const yaw   = f.rotation?.angle?.yaw   !== undefined ? Math.abs(f.rotation.angle.yaw!)   : undefined;
      const pitch = f.rotation?.angle?.pitch !== undefined ? Math.abs(f.rotation.angle.pitch!) : undefined;

      let eyeDistanceRatio: number | undefined;
      const le = f.annotations?.leftEye?.[0], re = f.annotations?.rightEye?.[0];
      if (le && re) eyeDistanceRatio = Math.sqrt((re.x - le.x) ** 2 + (re.y - le.y) ** 2) / box.width;

      acceptedDescriptors.push(descriptor);
      allFaces.push({
        faceIndex: fi,
        photoId: photo.id,
        photoUrl: fc.toDataURL('image/jpeg', 0.9),
        score, sharpness, box, descriptor, yaw, pitch, eyeDistanceRatio,
      });
    }

    if (acceptedDescriptors.length > 0) {
      faceDataRows.push({
        photoId: photo.id,
        descriptors: acceptedDescriptors.map((d) => Array.from(d)),
        faceCount: acceptedDescriptors.length,
      });
    }

    // Yield every 5 photos so Electron stays responsive
    if (pi % 5 === 4) await new Promise<void>((r) => setTimeout(r, 0));
  }

  // ── Cluster faces ─────────────────────────────────────────────────────────
  const frontalScore = (f: FaceCandidate) => {
    const poseDeduct = ((f.yaw ?? 0) + (f.pitch ?? 0)) / 180;
    const sharpBoost  = Math.min(0.3, (f.sharpness ?? 0) / 300);
    return f.score + sharpBoost - poseDeduct;
  };
  const sorted = [...allFaces].sort((a, b) => frontalScore(b) - frontalScore(a));

  const clusters: Array<{
    face: FaceCandidate; descriptors: Float32Array[];
    centroid: Float32Array; photoIds: Set<string>;
  }> = [];

  for (const face of sorted) {
    const yaw = face.yaw ?? 0;
    const eyeD = face.eyeDistanceRatio;
    const passesEye = !eyeD || eyeD >= CFG.MIN_EYE_DISTANCE_RATIO;
    const frontal = yaw <= CFG.MAX_YAW_FRONTAL && passesEye;
    const thresh = frontal ? CFG.UNIQUE_FACE_THRESHOLD : CFG.PROFILE_MERGE_THRESHOLD;

    let bestIdx = -1, bestSim = 0, secondSim = 0;
    for (let ci = 0; ci < clusters.length; ci++) {
      const cSim = cosineSimilarity(face.descriptor, clusters[ci].centroid);
      let eSim = cSim;
      for (const d of sampled(clusters[ci].descriptors)) {
        const s = cosineSimilarity(face.descriptor, d);
        if (s > eSim) eSim = s;
      }
      const sim = Math.max(cSim, eSim);
      if (sim > bestSim) { secondSim = bestSim; bestSim = sim; bestIdx = ci; }
      else if (sim > secondSim) secondSim = sim;
    }

    const canAttach = bestIdx >= 0 && bestSim >= thresh &&
      (bestSim - secondSim) >= Math.max(0.025, CFG.MATCH_MARGIN_THRESHOLD * 0.5);

    if (canAttach) {
      clusters[bestIdx].descriptors.push(face.descriptor);
      clusters[bestIdx].centroid = centroid(clusters[bestIdx].descriptors);
      clusters[bestIdx].photoIds.add(face.photoId);
    } else if (frontal) {
      clusters.push({ face, descriptors: [face.descriptor], centroid: face.descriptor, photoIds: new Set([face.photoId]) });
    }
  }

  // Secondary merge pass
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < clusters.length && !merged; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const cSim = cosineSimilarity(clusters[i].centroid, clusters[j].centroid);
        let eSim = cSim;
        for (const a of sampled(clusters[i].descriptors, 3))
          for (const b of sampled(clusters[j].descriptors, 3)) {
            const s = cosineSimilarity(a, b); if (s > eSim) eSim = s;
          }
        const si = clusters[i].photoIds.size, sj = clusters[j].photoIds.size;
        const oneSideSmall = si <= 3 || sj <= 3;
        const canMerge = oneSideSmall && Math.max(si, sj) <= 6 &&
          cSim >= CFG.CLUSTER_MERGE_THRESHOLD - 0.02 && eSim >= CFG.CLUSTER_MERGE_THRESHOLD + 0.02;
        if (canMerge) {
          clusters[i].descriptors.push(...clusters[j].descriptors);
          clusters[i].centroid = centroid(clusters[i].descriptors);
          clusters[j].photoIds.forEach((id) => clusters[i].photoIds.add(id));
          if (frontalScore(clusters[j].face) > frontalScore(clusters[i].face))
            clusters[i].face = clusters[j].face;
          clusters.splice(j, 1); merged = true; break;
        }
      }
    }
  }

  clusters.sort((a, b) => b.photoIds.size - a.photoIds.size);
  const uniqueFaces = clusters
    .filter((c) => (c.face.sharpness ?? 0) >= CFG.MIN_FACE_SHARPNESS + 10 && (c.face.score ?? 0) >= CFG.MIN_FACE_SCORE + 0.05)
    .map((c) => ({ ...c.face, photoCount: c.photoIds.size, descriptor: Array.from(c.face.descriptor) }));

  console.log(`[face-scan] 📸 ${uniqueFaces.length} unique faces, ${faceDataRows.length} photos with faces`);

  // ── Save directly to Supabase ─────────────────────────────────────────────
  const { error } = await supabase
    .from('gallery_face_data')
    .upsert(
      {
        share_id: shareId,
        face_data: faceDataRows,
        detected_faces: uniqueFaces,
        photo_count: faceDataRows.length,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'share_id' }
    );

  if (error) {
    console.error('[face-scan] ❌ Supabase upsert error:', error);
  } else {
    console.log(`[face-scan] ✅ Face data saved for gallery ${shareId.substring(0, 8)}`);
  }
}
