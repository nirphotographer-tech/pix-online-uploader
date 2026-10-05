/**
 * Sorts the files picked for a folder against what the gallery already has.
 *
 * - Same name in the target folder, same size  → identical copy
 * - Same name in the target folder, other size → edited version
 * - Same name + size in another folder         → identical copy uploaded there
 * - Same name + size still uploading            → in progress
 *
 * "Replace" puts the new file in the place of every one of these — the
 * existing photo keeps its id, folder and position. Same rules as the website
 * (pix-online/src/lib/upload-duplicates.ts).
 *
 * A name alone in another folder is not a duplicate: two cameras (or a second
 * shooter) easily produce the same DSC_0001.jpg for different photos.
 */

export interface PickedFile {
  path: string;
  name: string;
  size: number;
  type: string;
}

export interface ExistingPhoto {
  id: string;
  file_name: string;
  size_bytes: number | null;
  folder_id: string | null;
}

export interface UploadingFile {
  name: string;
  size: number;
  folderId: string;
  folderName: string;
}

export interface DuplicateReport {
  newFiles: PickedFile[];
  /** Already in the target folder, same size — `photoId` is the photo it would replace */
  identical: Array<{ file: PickedFile; photoId: string }>;
  /** Same name in the target folder but a different file */
  edited: Array<{ file: PickedFile; photoId: string }>;
  /** Identical copies already in other folders, by folder id */
  inOtherFolders: Map<string, Array<{ file: PickedFile; photoId: string }>>;
  /** Being uploaded right now, by folder name — `photoId` = the same photo already in the gallery, if any */
  uploading: Map<string, Array<{ file: PickedFile; photoId: string | null }>>;
}

export function hasDuplicates(r: DuplicateReport): boolean {
  return r.identical.length + r.edited.length + r.inOtherFolders.size + r.uploading.size > 0;
}

/** Existing photos that "Replace" overwrites (files still uploading are resolved later) */
export function replaceTargets(r: DuplicateReport): Array<{ file: PickedFile; photoId: string }> {
  return [...r.identical, ...r.edited, ...Array.from(r.inOtherFolders.values()).flat()];
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function classifyFiles(
  files: PickedFile[],
  folderId: string,
  existing: ExistingPhoto[],
  uploading: UploadingFile[],
): DuplicateReport {
  const report: DuplicateReport = {
    newFiles: [],
    identical: [],
    edited: [],
    inOtherFolders: new Map(),
    uploading: new Map(),
  };

  const byName = new Map<string, ExistingPhoto[]>();
  for (const p of existing) push(byName, p.file_name, p);
  const uploadingByKey = new Map<string, UploadingFile>();
  for (const u of uploading) uploadingByKey.set(`${u.name}|${u.size}`, u);
  // A photo is replaced by one file at most (a folder scan can hold two DSC_0001.jpg)
  const claimed = new Set<string>();

  for (const file of files) {
    const matches = (byName.get(file.name) ?? []).filter((p) => !claimed.has(p.id));
    const here = matches.filter((p) => p.folder_id === folderId);
    // Legacy rows without a size count as the same file
    const same = here.find((p) => p.size_bytes === null || p.size_bytes === file.size);
    const edited = same ? undefined : here[0];
    const elsewhere = same || edited ? undefined : matches.find((p) => p.folder_id !== folderId && p.size_bytes === file.size);
    const match = same ?? edited ?? elsewhere;
    if (match) claimed.add(match.id);

    // Still uploading: remember the gallery copy too — if the upload is
    // stopped before saving, "replace" takes that photo's place instead
    const busy = uploadingByKey.get(`${file.name}|${file.size}`);
    if (busy) {
      push(report.uploading, busy.folderName, { file, photoId: match?.id ?? null });
      continue;
    }

    if (same) report.identical.push({ file, photoId: same.id });
    else if (edited) report.edited.push({ file, photoId: edited.id });
    else if (elsewhere) push(report.inOtherFolders, elsewhere.folder_id ?? '', { file, photoId: elsewhere.id });
    else report.newFiles.push(file);
  }

  return report;
}
