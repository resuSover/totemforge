// © 2026 Totem Forge. All rights reserved.
// .tfc files: art packs and backups. A zip with manifest.json and pictures.
//
// Version 1 (the old Android app, the first packs): images/<id>.png are the finished 88 x 184
// pictures; the manifest's "images" list has tags and text-overlay settings.
// Version 2 (this app): sources/<id>.<jpg|png> are the masters (whole originals) and the manifest's
// "portraits" list has the full settings. It also keeps images/<id>.png and a version 1 style
// "images" list, so the old Android app can still import these files.
import { readZip, writeZip } from './zip.js';

const INKS = ['black', 'white', 'yellow', 'red'];
const ink = (v, fallback) => INKS.includes(v) ? v : fallback;
const titleCase = s => s.replace(/\b\p{L}/gu, c => c.toUpperCase());

/** Reads a .tfc file: { version, name, items: [{ record, blob }] } */
export async function readTfc(file) {
  const files = await readZip(file);
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new Error('This file is not a Totem Forge pack or backup.');
  const m = JSON.parse(new TextDecoder().decode(manifestBytes));
  const version = m.format_version || 1;
  const items = [];
  if (version >= 2 && Array.isArray(m.portraits)) {
    for (const p of m.portraits) {
      const bytes = files.get(p.source);
      if (!bytes) continue;
      items.push({ record: fromV2(p), blob: new Blob([bytes], { type: p.source.endsWith('.png') ? 'image/png' : 'image/jpeg' }) });
    }
  } else {
    for (const p of m.images || []) {
      const bytes = files.get(`images/${p.id}.png`);
      if (!bytes) continue;
      items.push({ record: fromV1(p), blob: new Blob([bytes], { type: 'image/png' }) });
    }
  }
  return { version, name: m.name || null, items };
}

// { strength, threshold }, kept within range; anything else is no dither
const NO_DITHER = { strength: 0, threshold: 24 };
const dither = d => d && typeof d === 'object'
  ? { strength: Math.min(1, Math.max(0, +d.strength || 0)), threshold: Math.min(255, Math.max(0, +d.threshold || 0)) } : { ...NO_DITHER };
function fromV2(p) {
  return {
    id: String(p.id), tags: (p.tags || []).map(String), collection: p.collection || null,
    rot: p.rot || 0, crop: { zoom: 1, x: 0, y: 0, ...p.crop }, fill: p.fill === 'extend' ? 'extend' : 'colour',
    adjust: { brightness: 0, ...p.adjust, dither: dither(p.adjust?.dither) },
    overlay: p.overlay ? { text: String(p.overlay.text || ''), bar: ink(p.overlay.bar, 'black'), textColour: ink(p.overlay.textColour, 'yellow'),
                           position: p.overlay.position === 'top' ? 'top' : 'bottom', push: +p.overlay.push || 0 } : null,
    createdAt: p.createdAt || Date.now(), lastUsed: p.lastUsed || 0
  };
}

// Version 1: the PNG is already in the four inks, so it becomes the master with a full crop and
// no dither; a "pack: X" tag becomes the collection
function fromV1(p) {
  const tags = String(p.tag || '').split(',').map(t => t.trim()).filter(Boolean);
  const pack = tags.find(t => t.startsWith('pack:'));
  const text = String(p.overlayText || '');
  return {
    id: String(p.id), tags: tags.filter(t => !t.startsWith('pack:') && t !== 'other'),
    collection: pack ? titleCase(pack.slice(5).trim()) : null,
    rot: 0, crop: { zoom: 1, x: 0, y: 0 }, fill: 'colour', adjust: { brightness: 0, dither: { ...NO_DITHER } },
    overlay: p.overlayEnabled && text.trim() ? {
      text, bar: ink(p.overlayBgColor, 'black'), textColour: ink(p.overlayTextColor, 'yellow'),
      position: p.overlayPosition === 'top' ? 'top' : 'bottom', push: +p.overlayPush || 0
    } : null,
    createdAt: +p.timestamp || Date.now(), lastUsed: 0
  };
}

/** Writes portraits as a version 2 .tfc Blob. renderPng(portrait) → Promise<Blob> of the finished picture. */
export async function writeTfc(portraits, renderPng) {
  const entries = [], list = [], v1 = [];
  const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
  for (const p of portraits) {
    const ext = p.blob.type === 'image/png' ? 'png' : 'jpg';
    const source = `sources/${p.id}.${ext}`;
    entries.push({ name: source, data: await bytes(p.blob) });
    entries.push({ name: `images/${p.id}.png`, data: await bytes(await renderPng(p)) });
    list.push({ id: p.id, tags: p.tags, collection: p.collection, rot: p.rot || 0, crop: p.crop, fill: p.fill,
                adjust: p.adjust, overlay: p.overlay && p.overlay.text.trim() ? p.overlay : null,
                createdAt: p.createdAt, lastUsed: p.lastUsed || 0, source });
    const ov = p.overlay && p.overlay.text.trim() ? p.overlay : null;
    v1.push({ id: p.id, timestamp: p.createdAt,
              tag: [...p.tags, ...(p.collection ? [`pack: ${p.collection.toLowerCase()}`] : [])].join(','),
              overlayEnabled: !!ov, overlayMode: 'text', overlayText: ov ? ov.text : '',
              overlayBgColor: ov ? ov.bar : 'black', overlayTextColor: ov ? ov.textColour : 'yellow',
              overlayPosition: ov ? ov.position : 'bottom', overlayPush: ov ? ov.push : 0,
              flipMode: 'none', overlayStyle: 'overlay', advancedExpanded: false, originalUri: '' });
  }
  const manifest = { format_version: 2, db_version: 6, app: 'Totem Forge', exported_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
                     portraits: list, images: v1 };
  entries.unshift({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  return writeZip(entries);
}
