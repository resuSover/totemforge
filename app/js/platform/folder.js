// © 2026 Totem Forge. All rights reserved.
// The portraits folder on a PC or Mac (Chrome, Edge: the File System Access API). The user chooses it
// once; the browser keeps a working copy of the gallery and the folder is the master
// (core/gallerydir.js has the format and the rules).
import { MARKER, markGallery } from '../core/gallerydir.js';

const SUBFOLDER = 'Totem Forge';
export const folderSupported = () => typeof window.showDirectoryPicker === 'function';

/** A directory handle as a dir for core/gallerydir.js */
export function handleDir(h) {
  return {
    async list() {
      const out = [];
      for await (const [name, e] of h.entries()) {
        // Chrome saves through a temporary name.crswap file next to it, which can vanish meanwhile
        if (e.kind !== 'file' || name.endsWith('.crswap')) continue;
        let f;
        try { f = await e.getFile(); } catch { continue; }       // gone since it was listed
        out.push({ name, size: f.size, lastModified: f.lastModified });
      }
      return out;
    },
    read: async name => (await h.getFileHandle(name)).getFile(),
    async write(name, blob) {
      const out = await (await h.getFileHandle(name, { create: true })).createWritable();
      await out.write(blob);
      await out.close();
    },
    remove: name => h.removeEntry(name).catch(() => {}),
  };
}

/** 'granted', or what the browser says ('prompt' after a restart, 'denied'); ask only from a tap. */
export async function permission(h, ask = false) {
  if (!h.queryPermission) return 'granted';
  const opts = { mode: 'readwrite' };
  let state = await h.queryPermission(opts);
  if (state !== 'granted' && ask) state = await h.requestPermission(opts);
  return state;
}
// false only when the marker isn't there; other errors (no permission) are thrown
const hasMarker = async h => {
  try { await h.getFileHandle(MARKER); return true; }
  catch (e) { if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return false; throw e; }
};

/** Still there (moved, renamed or deleted folders aren't)? */
export const folderExists = h => hasMarker(h);

// The gallery for a chosen folder: itself if it's a gallery or empty, the gallery inside it if it
// has one; else, when creating, a Totem Forge folder inside it (so other files aren't mixed in)
async function galleryIn(place, create) {
  if (await hasMarker(place)) return place;
  try { const sub = await place.getDirectoryHandle(SUBFOLDER); if (await hasMarker(sub)) return sub; } catch {}
  if (!create) return null;
  for await (const [name] of place.entries()) {
    if (!name.startsWith('.')) return place.getDirectoryHandle(SUBFOLDER, { create: true });
  }
  return place;
}

/**
 * Asks for the folder (call it straight from a tap). restoring: only a folder that already holds a
 * gallery. Resolves to the gallery's handle, or null when cancelled; throws with a message to show.
 */
export async function chooseFolder(restoring = false) {
  let place;
  try { place = await window.showDirectoryPicker({ id: 'totemforge-portraits', mode: 'readwrite', startIn: 'documents' }); }
  catch (e) {
    if (e.name === 'AbortError') return null;
    throw new Error(`That folder can't be used. Make a new folder, for example “${SUBFOLDER}” in Documents, and choose it.`);
  }
  if (await permission(place, true) !== 'granted') throw new Error('Saving in that folder wasn’t allowed.');
  const dir = await galleryIn(place, !restoring);
  if (!dir) throw new Error(`No portraits found in “${place.name}”. Choose your portraits folder.`);
  if (!(await hasMarker(dir))) await markGallery(handleDir(dir));
  return dir;
}
