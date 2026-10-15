// © 2026 Totem Forge. All rights reserved.
// The gallery in the iOS shell: files in the app's Documents (Portraits/ in the portraits-folder
// format of core/gallerydir.js, App/settings.json), not WebView storage, which iOS may clear when
// the phone is very low on space; iCloud backups include them. The shell serves them at /__docs/
// and writes them through the files bridge (see WebShell.swift).
import { readGallery, writePortrait, removePortraits, isGallery, markGallery } from '../core/gallerydir.js';
import { iosFiles, base64 } from './files.js';

const CHUNK = 1 << 20;
const docPath = path => '/__docs/' + path.split('/').map(encodeURIComponent).join('/');

/** A folder in Documents as a dir for core/gallerydir.js */
function docsDir(folder) {
  return {
    async list() {                                       // fails rather than look empty (an empty gallery)
      const r = await fetch(docPath(folder) + '?list');
      if (!r.ok) throw new Error(`Couldn't list ${folder}`);
      return r.json();
    },
    async read(name) {
      const r = await fetch(docPath(`${folder}/${name}`));
      if (!r.ok) throw new Error(`${name} not found`);
      return r.blob();
    },
    async write(name, blob) {
      const native = iosFiles(), id = Math.random().toString(36).slice(2);
      await native.postMessage({ op: 'docBegin', id });
      for (let at = 0; at < blob.size; at += CHUNK) await native.postMessage({ op: 'docChunk', id, data: await base64(blob.slice(at, at + CHUNK)) });
      await native.postMessage({ op: 'docWrite', id, path: `${folder}/${name}` });
    },
    remove: name => iosFiles().postMessage({ op: 'docRemove', path: `${folder}/${name}` }),
  };
}

export async function openIosStore() {
  const portraits = docsDir('Portraits'), app = docsDir('App');
  if (!(await isGallery(portraits))) await markGallery(portraits);
  return {
    async loadAll() { return (await readGallery(portraits)).added; },
    save: (p, blob) => writePortrait(portraits, blob ? { ...p, blob } : p, !!blob),
    remove: ids => removePortraits(portraits, ids),
    async loadSettings() { try { return JSON.parse(await (await app.read('settings.json')).text()); } catch { return null; } },
    saveSettings: s => app.write('settings.json', new Blob([JSON.stringify(s)], { type: 'application/json' })),
  };
}
