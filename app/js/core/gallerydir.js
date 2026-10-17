// © 2026 Totem Forge. All rights reserved.
// A portraits folder: on a PC or Mac the folder the user chooses (platform/folder.js), in the iOS
// shell the app's own Documents/Portraits (platform/iosstore.js). Per portrait a picture
// (<id>.jpg|png|…, the master) and its settings (<id>.json); a marker file says the folder is a
// Totem Forge gallery. The picture is the portrait:
// - picture gone: the portrait goes (its .json stays, so it comes back with the picture, e.g. when a
//   cloud folder syncs late)
// - only the .json gone: written again
// - a picture without a .json (copied in by hand): a new portrait
// A dir is { list() → [{ name, size, lastModified? }], read(name) → Blob, write(name, blob), remove(name) }.
import { cleanRecord } from './tfc.js';

export const MARKER = 'totemforge-gallery.json';
const PICTURE = /\.(jpe?g|png|webp|gif|bmp)$/i;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };
const stem = name => name.replace(/\.[^.]+$/, '');
const json = o => new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' });

/** The picture's file name: the one it came with, or <id>.<jpg|png|…> */
export const pictureName = p => p.picture || `${p.id}.${EXT[p.blob?.type] || 'jpg'}`;
// The settings as stored, in a fixed shape (so two can be compared)
const settingsOf = p => ({ ...cleanRecord(p), picture: pictureName(p) });

export const isGallery = async dir => (await dir.list()).some(e => e.name === MARKER);
export const markGallery = dir => dir.write(MARKER, json({ app: 'Totem Forge', format: 1 }));

// One change at a time per folder: a deletion lists the folder and then removes files, so the same
// portrait saved again meanwhile (Undo, restoring right after deleting) would be deleted with it
const queues = new WeakMap();
function inTurn(dir, task) {
  const run = (queues.get(dir) || Promise.resolve()).catch(() => {}).then(task);
  queues.set(dir, run);
  return run;
}
async function write(dir, p, withPicture) {
  if (withPicture) await dir.write(pictureName(p), p.blob);
  await dir.write(`${p.id}.json`, json(settingsOf(p)));
}

/** Writes a portrait's settings, and its picture too when withPicture. */
export const writePortrait = (dir, p, withPicture) => inTurn(dir, () => write(dir, p, withPicture));

/** Removes the portraits' pictures and settings. */
export const removePortraits = (dir, ids) => inTurn(dir, async () => {
  const gone = new Set(ids);
  for (const { name } of await dir.list()) if (name !== MARKER && gone.has(stem(name))) await dir.remove(name);
});

/**
 * Reads the folder and compares it with the app's portraits (a Map of id → portrait).
 * added: [{ record, blob }] in the folder only; updated: [{ record, blob? }] changed in the folder
 * (blob only when the picture changed); removed: ids whose picture is gone (except those in `keep`,
 * changes not yet written); repaired: .json files written again; unreadable: pictures that couldn't
 * be read (a cloud file not downloaded yet). `defaults` fill in a picture copied in by hand.
 */
export const readGallery = (dir, known, options) => inTurn(dir, () => read(dir, known, options));
async function read(dir, known = new Map(), { keep = new Set(), defaults = {} } = {}) {
  const pictures = new Map(), settings = new Map();
  for (const e of await dir.list()) {
    if (e.name.startsWith('.') || e.name === MARKER) continue;
    if (PICTURE.test(e.name)) pictures.set(stem(e.name), e);
    else if (e.name.endsWith('.json')) settings.set(stem(e.name), e);
  }
  const out = { added: [], updated: [], removed: [], repaired: 0, unreadable: [] };
  for (const [id, pic] of pictures) {
    try {
      let saved = null;
      if (settings.has(id)) { try { saved = JSON.parse(await (await dir.read(settings.get(id).name)).text()); } catch { saved = null; } }
      const p = known.get(id);
      if (p) {
        if (!saved) { await write(dir, { ...p, picture: pic.name }, false); out.repaired++; continue; }
        const record = settingsOf({ ...saved, id, picture: pic.name });
        const blob = p.blob && pic.size != null && pic.size !== p.blob.size ? await dir.read(pic.name) : null;
        if (blob || JSON.stringify(record) !== JSON.stringify(settingsOf({ ...p, picture: p.picture || pic.name }))) out.updated.push({ record, blob });
      } else {
        const blob = await dir.read(pic.name);
        const record = settingsOf({ ...(saved || { ...defaults, createdAt: pic.lastModified || Date.now() }), id, picture: pic.name });
        if (!saved) { await dir.write(`${id}.json`, json(record)); out.repaired++; }
        out.added.push({ record, blob });
      }
    } catch { out.unreadable.push(pic.name); }
  }
  for (const id of known.keys()) if (!pictures.has(id) && !keep.has(id)) out.removed.push(id);
  return out;
}
