/**
 * Sorts the files picked for a folder against what the gallery already has.
 *
 * - Same name in the target folder, same size  → identical copy (skip)
 * - Same name in the target folder, other size → edited version (can replace)
 * - Same name + size in another folder         → identical copy uploaded there
 * - Same name + size still uploading            → in progress
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
  /** Already in the target folder, same size */
  identical: PickedFile[];
  /** Same name in the target folder but a different file — `photoId` is the photo it replaces */
  edited: Array<{ file: PickedFile; photoId: string }>;
  /** Identical copies already in other folders, by folder id */
  inOtherFolders: Map<string, PickedFile[]>;
  /** Being uploaded right now, by folder name */
  uploading: Map<string, PickedFile[]>;
}

export function hasDuplicates(r: DuplicateReport): boolean {
  return r.identical.length + r.edited.length + r.inOtherFolders.size + r.uploading.size > 0;
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
    const busy = uploadingByKey.get(`${file.name}|${file.size}`);
    if (busy) {
      push(report.uploading, busy.folderName, file);
      continue;
    }

    const matches = byName.get(file.name) ?? [];
    const here = matches.filter((p) => p.folder_id === folderId);
    // Legacy rows without a size count as the same file
    if (here.some((p) => p.size_bytes === null || p.size_bytes === file.size)) {
      report.identical.push(file);
      continue;
    }
    const target = here.find((p) => !claimed.has(p.id));
    if (target) {
      claimed.add(target.id);
      report.edited.push({ file, photoId: target.id });
      continue;
    }

    const elsewhere = matches.find((p) => p.folder_id !== folderId && p.size_bytes === file.size);
    if (elsewhere) {
      push(report.inOtherFolders, elsewhere.folder_id ?? '', file);
      continue;
    }

    report.newFiles.push(file);
  }

  return report;
}
