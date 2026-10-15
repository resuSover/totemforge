// © 2026 Totem Forge. All rights reserved.
// Gallery storage. IndexedDB in browsers, on Android and (for now) inside the iOS shell.
// For the App Store build the iOS shell gets a file-based version of this same interface,
// because iOS may clear web storage when the phone runs very low on space.
//
// Stored per portrait: its settings (record) and its master picture (Blob), kept separately so
// settings changes don't rewrite the picture.

const DB = 'totemforge', VERSION = 1;
const FIELDS = ['id', 'tags', 'collection', 'rot', 'crop', 'fill', 'adjust', 'overlay', 'createdAt', 'lastUsed', 'picture'];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('portraits', { keyPath: 'id' });
      db.createObjectStore('masters');
      db.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export async function openStore() {
  const db = await openDb();
  try { await navigator.storage?.persist?.(); } catch {}   // ask the browser not to clear it under storage pressure
  return {
    /** All portraits: [{ record, blob }] */
    async loadAll() {
      const tx = db.transaction(['portraits', 'masters']);
      const records = await request(tx.objectStore('portraits').getAll());
      const masters = tx.objectStore('masters');
      return Promise.all(records.map(async record => ({ record, blob: await request(masters.get(record.id)) })));
    },
    /** Saves a portrait's settings, and its master picture when `blob` is given. */
    async save(portrait, blob) {
      const record = Object.fromEntries(FIELDS.map(k => [k, structuredClone(portrait[k] ?? null)]));
      const tx = db.transaction(['portraits', 'masters'], 'readwrite');
      tx.objectStore('portraits').put(record);
      if (blob) tx.objectStore('masters').put(blob, portrait.id);
      return done(tx);
    },
    async remove(ids) {
      const tx = db.transaction(['portraits', 'masters'], 'readwrite');
      for (const id of ids) { tx.objectStore('portraits').delete(id); tx.objectStore('masters').delete(id); }
      return done(tx);
    },
    async loadSettings() { return this.loadValue('app'); },
    saveSettings(s) { return this.saveValue('app', s); },
    /** Other values kept with the gallery (the portraits folder's handle, changes waiting for it) */
    async loadValue(key) { return (await request(db.transaction('settings').objectStore('settings').get(key))) ?? null; },
    async saveValue(key, value) {
      const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put(value, key); return done(tx);
    }
  };
}
