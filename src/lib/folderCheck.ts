import { supabase } from './supabase';

export type FolderCheck =
  | { state: 'ok'; name: string }
  /** The folder was deleted on the website */
  | { state: 'folder-deleted' }
  | { state: 'gallery-deleted' }
  /** The gallery has no folder rows yet (the site's default folder isn't saved) — the upload creates it */
  | { state: 'not-created-yet' }
  /** Couldn't tell (offline etc.) — carry on, the upload itself will find out */
  | { state: 'unknown' };

/** null = couldn't tell */
export async function galleryExists(galleryId: string): Promise<boolean | null> {
  const { data, error } = await supabase.from('galleries').select('id').eq('id', galleryId).maybeSingle();
  if (error) return null;
  return !!data;
}

export async function checkFolder(galleryId: string, folderId: string): Promise<FolderCheck> {
  try {
    const { data: folder, error } = await supabase
      .from('gallery_folders')
      .select('id, name')
      .eq('id', folderId)
      .maybeSingle();
    if (error) return { state: 'unknown' };
    if (folder) return { state: 'ok', name: folder.name };

    const { data: others, error: othersError } = await supabase
      .from('gallery_folders')
      .select('id')
      .eq('gallery_id', galleryId)
      .limit(1);
    if (othersError) return { state: 'unknown' };
    // The site never deletes a gallery's last folder, so other folders = this one was deleted
    if (others && others.length > 0) return { state: 'folder-deleted' };

    const exists = await galleryExists(galleryId);
    if (exists === null) return { state: 'unknown' };
    return exists ? { state: 'not-created-yet' } : { state: 'gallery-deleted' };
  } catch {
    return { state: 'unknown' };
  }
}
