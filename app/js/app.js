// © 2026 Totem Forge. All rights reserved. See https://totemforge.nl/terms.html
//
// Totem Forge app: the screens. Imaging, protocol, summon flow and storage live in core/,
// the MIDI transports in platform/. Add ?proto to the address for the prototype controls
// (a simulated base that answers like the real firmware).
import { W, H, INK_NAMES, SHOW, FILE_INKS, FRAME, DITHER, ditherStep, render, paint, paintPreview } from './core/imaging.js';
import { packImage } from './core/protocol.js';
import { Base } from './core/base.js';
import { openStore } from './core/store.js';
import { openIosStore } from './platform/iosstore.js';
import { readTfc, writeTfc } from './core/tfc.js';
import { pickTransport } from './platform/transport.js';
import { fakeBaseTransport } from './platform/fakebase.js';
import { iosFiles, hasSaveDialog, pickSaveFile, writeHandle, download, shareOnIos } from './platform/files.js';
import { installRoute, chromeLink } from './platform/install.js';
import { readGallery, writePortrait, removePortraits } from './core/gallerydir.js';
import { folderSupported, handleDir, permission, folderExists, chooseFolder } from './platform/folder.js';

const $ = id => document.getElementById(id);
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- platform, base and storage ----------
const PROTO = new URLSearchParams(location.search).has('proto');
const realPlatform = window.webkit?.messageHandlers?.midi ? 'iphone' : /Android/i.test(navigator.userAgent) ? 'android' : 'desktop';
const sim = { platform: realPlatform, base: true, firmware: '2.0', fast: false, fail: 'none', midiAllowed: false };
const transport = PROTO ? fakeBaseTransport(sim) : pickTransport();
const base = transport ? new Base(transport) : null;
const platform = () => PROTO ? sim.platform : realPlatform;
const device = () => platform() === 'desktop' ? 'computer' : platform() === 'iphone' ? 'iPhone' : 'phone';

const memoryStore = { async loadAll() { return []; }, async save() {}, async remove() {}, async loadSettings() { return null; }, async saveSettings() {} };
let store = memoryStore;
// Backup reminder: sinceBackup counts portraits added since the last full backup; the banner shows
// once it reaches remindAt (backupEvery, pushed further by "Later"); backupEvery 0 is never
const settings = { sort: 'newest', midiExplained: false, backupEvery: 5, sinceBackup: 0, remindAt: 0, lastBackup: 0, installLater: 0 };
// While saves are under way, leaving the page asks first (closing it then would lose them)
let saving = 0;
const persist = (p, withPicture = false) => {
  saving++;
  return Promise.all([store.save(p, withPicture ? p.blob : undefined).catch(storageFailed), folderSave(p, withPicture)])
    .finally(() => saving--);
};
const removeStored = ids => { store.remove(ids).catch(storageFailed); folderRemove(ids); };
window.addEventListener('beforeunload', e => { if (saving) { e.preventDefault(); e.returnValue = ''; } });
const saveSettings = () => store.saveSettings(settings).catch(storageFailed);
function storageFailed() { toast("Couldn't save. Is the device out of storage?"); }

// ---------- portraits ----------
// { id, tags, collection, img (master, decoded), blob (master file), rot, crop, fill, adjust, overlay, createdAt, lastUsed, thumb }
let portraits = [];
const label = p => (p.overlay && p.overlay.text.trim() ? p.overlay.text.trim().replace(/\s*\n\s*/g, ' ') : p.tags[0]) || 'Portrait';
const clone = p => ({ ...p, tags: [...p.tags], crop: { ...p.crop }, adjust: { ...p.adjust }, overlay: p.overlay ? { ...p.overlay } : null });
function updateThumb(p) { const c = document.createElement('canvas'); c.width = W; c.height = H; paintPreview(c, render(p).idx); p.thumb = c.toDataURL(); }
const newId = () => crypto.randomUUID ? crypto.randomUUID() : 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2);
function renderPng(p) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; paint(c, render(p).idx, FILE_INKS);   // the old app's colours
  return new Promise(r => c.toBlob(r, 'image/png'));
}
const loadFreePack = async () => readTfc(await (await fetch('data/classic-fantasy.tfc')).blob());

// ---------- navigation ----------
const wide = () => matchMedia('(min-width: 900px)').matches;
let currentScreen = 'gallery';
function show(id) {
  currentScreen = id;
  const panes = ['portrait', 'editor', 'settings', 'placeholder'];
  if (wide()) {
    $('gallery').hidden = false;
    panes.forEach(s => $(s).hidden = s !== (id === 'gallery' ? 'placeholder' : id));
  } else {
    $('gallery').hidden = id !== 'gallery';
    panes.forEach(s => $(s).hidden = s !== id);
  }
  if (id === 'gallery') current = null;
  renderGallery();
  syncHistory();
}
window.addEventListener('resize', () => { show(currentScreen); if (currentScreen === 'editor') placeBezel(); });

// Back (Android's button or gesture, the browser's arrow) walks the page history, so the history
// follows how deep the app is: the gallery 0, a portrait or Settings 1, the editor of a portrait 2,
// and an open sheet or selecting one more. A step in pushes an entry, Back pops it and the app
// steps back to match, and going back in the app itself pops entries with history.go.
// Chrome's Back skips an entry when the page pushed the next one without a tap in between (it
// stops pages from trapping Back), so entries are pushed only after a tap, never on Back: a step
// in without a tap (a long press, the finger still down) waits for the next one.
const entry = () => ({ level: history.state?.level || 0, index: history.state?.index || 0 });
const levels = [];          // level of each entry of the app's history, by index
let tapped = false, waiting = false, going = false, syncQueued = false;
function depth() {
  let d = currentScreen === 'gallery' ? 0 : currentScreen === 'editor' && !isNew && current ? 2 : 1;
  if (selecting) d++;
  if (!$('sheet').hidden) d++;
  return d;
}
function syncHistory() {
  // after the current step, so closing a sheet and opening a screen in one tap is one change
  if (syncQueued) return;
  syncQueued = true;
  setTimeout(() => {
    syncQueued = false; waiting = false;
    if (going) return;      // history.go's popstate syncs again
    const want = depth(), { level, index } = entry();
    levels[index] = level;
    if (want > level) {
      if (!tapped) { waiting = true; return; }
      tapped = false;
      history.pushState({ level: want, index: index + 1 }, '');
      levels[index + 1] = want; levels.length = index + 2;
    } else if (want < level && index === 0) {
      history.replaceState({ level: want, index }, '');    // never back out of the app
    } else if (want < level) {
      // back to the nearest entry that isn't deeper; if it's less deep, the popstate pushes again
      let to = index - 1;
      while (to > 0 && (levels[to] || 0) > want) to--;
      going = true; history.go(to - index);
    }
  });
}
// What counts as a tap for Chrome (a user activation)
const tap = () => { tapped = true; if (waiting) syncHistory(); };
window.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse') tap(); }, true);
window.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') tap(); }, true);
window.addEventListener('keydown', e => { if (e.key !== 'Escape') tap(); }, true);
function stepBack() {
  if (!$('sheet').hidden) $('scrim').onclick();
  else if (selecting) $('selCancel').onclick();
  else if (currentScreen === 'editor') $('eCancel').onclick();
  else if (currentScreen !== 'gallery') show('gallery');
}
window.addEventListener('popstate', () => {
  if (going) going = false;
  // usually one step; more when an entry waited for a tap that never came
  else for (let i = 0; i < 4 && depth() > entry().level; i++) stepBack();
  syncHistory();
});

// ---------- gallery ----------
const filter = { q: '', mode: 'all', untagged: false };
let selecting = false, current = null; const selected = new Set();

function allTags() {
  const n = new Map();
  portraits.forEach(p => p.tags.forEach(t => n.set(t, (n.get(t) || 0) + 1)));
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
}
// Each search word must match the start of a word in a tag or in the text; several words match
// all of them, or any of them ("or" between words switches to any)
const terms = () => filter.q.toLowerCase().split(/\s+/).filter(w => w && w !== 'or' && w !== 'and');
// Tags as written and split at spaces (so symbol tags like "?" count), plus words split at punctuation
const words = p => {
  const text = [...p.tags, p.overlay ? p.overlay.text : ''].join(' ').toLowerCase();
  return [...p.tags, ...text.split(/\s+/), ...text.split(/[^\p{L}\p{N}]+/u)].filter(Boolean);
};
const sorted = list => [...list].sort((a, b) =>
  settings.sort === 'recent' ? (b.lastUsed - a.lastUsed) || (b.createdAt - a.createdAt) : b.createdAt - a.createdAt);
function visible() {
  const t = terms();
  return sorted(portraits.filter(p => {
    if (filter.untagged && p.tags.length) return false;
    if (!t.length) return true;
    const ws = words(p), hit = term => ws.some(w => w.startsWith(term));
    return filter.mode === 'any' ? t.some(hit) : t.every(hit);
  }));
}
// "Did you mean": the closest known word, at most 2 letters off, for search words that match nothing
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function didYouMean() {
  const vocab = [...new Set(portraits.flatMap(words))];
  let changed = false;
  const fixed = terms().map(t => {
    if (t.length < 3 || vocab.some(w => w.startsWith(t))) return t;
    let best = null, bd = 3;
    vocab.forEach(w => { const d = distance(t, w); if (d < bd) { bd = d; best = w; } });
    if (best) { changed = true; return best; }
    return t;
  });
  return changed ? fixed.join(filter.mode === 'any' ? ' or ' : ' ') : null;
}
function setQuery(q) { filter.q = q; $('search').value = q; filter.mode = /(^|\s)or(\s|$)/i.test(q) ? 'any' : 'all'; renderGallery(); }

function renderSearchUI() {
  const t = terms(), active = t.length || filter.untagged;
  $('searchClear').hidden = !filter.q;
  const line = $('qline'); line.hidden = !active; line.innerHTML = '';
  if (!active) return;
  const n = visible().length;
  const count = document.createElement('span'); count.className = 'count';
  count.textContent = `${n} portrait${n === 1 ? '' : 's'}`; line.appendChild(count);
  if (filter.untagged) {
    const pill = document.createElement('span'); pill.className = 'pill'; pill.textContent = 'Without tags';
    const x = document.createElement('button'); x.textContent = '✕'; x.setAttribute('aria-label', 'Show tagged portraits too');
    x.onclick = () => { filter.untagged = false; renderGallery(); };
    pill.appendChild(x); line.appendChild(pill);
  }
  if (t.length > 1) {
    const m = document.createElement('span');
    m.innerHTML = `Matching <strong>${filter.mode}</strong>: ${t.map(escapeHtml).join(', ')}`;
    const flip = document.createElement('button'); flip.className = 'linkish';
    flip.textContent = filter.mode === 'all' ? 'Match any instead' : 'Match all instead';
    flip.onclick = () => { filter.mode = filter.mode === 'all' ? 'any' : 'all'; renderGallery(); };
    line.append(m, flip);
  }
}
// Suggestions under the field: tags matching the word being typed, plus "Without tags"
function renderSugs() {
  const box = $('sugs'), partial = filter.q.endsWith(' ') ? '' : (filter.q.toLowerCase().split(/\s+/).pop() || '');
  const used = terms();
  const counts = new Map(); portraits.forEach(p => p.tags.forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
  const tags = [...counts.entries()]
    .filter(([t]) => (!partial || t.split(' ').some(w => w.startsWith(partial))) && !used.includes(t))
    .sort((a, b) => b[1] - a[1]).slice(0, 12);
  box.innerHTML = '';
  const untagged = portraits.filter(p => !p.tags.length).length;
  if (untagged && !filter.untagged && !partial) {
    const b = document.createElement('button'); b.className = 'chip sug sug-none';
    b.innerHTML = `Without tags<span class="n">${untagged}</span>`;
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => { filter.untagged = true; renderGallery(); renderSugs(); };
    box.appendChild(b);
  }
  tags.forEach(([t, c]) => {
    const b = document.createElement('button'); b.className = 'chip sug';
    b.innerHTML = `${escapeHtml(t)}<span class="n">${c}</span>`;
    b.onmousedown = e => e.preventDefault();          // keep the keyboard open
    b.onclick = () => {
      const parts = filter.q.split(/\s+/).filter(Boolean);
      if (partial) parts.pop();
      filter.q = [...parts, t].join(' ') + ' '; $('search').value = filter.q;
      renderGallery(); renderSugs(); $('search').focus();
    };
    box.appendChild(b);
  });
  box.hidden = !box.children.length || document.activeElement !== $('search');
}

function renderGallery() {
  renderSearchUI(); renderBanner();
  const grid = $('grid'); grid.innerHTML = '';
  $('galleryScroll').classList.toggle('selecting', selecting);
  $('empty').hidden = portraits.length > 0;
  const list = visible();
  list.forEach(p => {
    const b = document.createElement('button'); b.className = 'card' + (current && current.id === p.id && wide() ? ' open' : '');
    b.setAttribute('aria-checked', selected.has(p.id));
    b.setAttribute('aria-label', label(p));
    b.innerHTML = `<img class="thumb" alt="" src="${p.thumb}"><span class="tick"></span>`;
    longPress(b, () => { if (!selecting) { selecting = true; selected.add(p.id); syncSelect(); } });
    b.onclick = () => {
      if (b.dataset.longpressed) { delete b.dataset.longpressed; return; }
      if (selecting) { selected.has(p.id) ? selected.delete(p.id) : selected.add(p.id); if (!selected.size) selecting = false; syncSelect(); }
      else openPortrait(p);
    };
    grid.appendChild(b);
  });
  const nores = $('nores');
  nores.hidden = !(portraits.length && !list.length);
  if (!nores.hidden) {
    const fix = didYouMean();
    nores.innerHTML = `<span>Nothing matches <strong>${escapeHtml(filter.q.trim() || 'this search')}</strong>${filter.untagged ? ' among portraits without tags' : ''}.</span>`;
    if (fix) {
      const p = document.createElement('span'); p.innerHTML = 'Did you mean ';
      const a = document.createElement('button'); a.className = 'linkish'; a.textContent = fix; a.onclick = () => setQuery(fix);
      p.append(a, '?'); nores.appendChild(p);
    }
    const c = document.createElement('button'); c.className = 'secondary'; c.style.width = 'auto'; c.textContent = 'Clear search';
    c.onclick = () => { filter.untagged = false; setQuery(''); };
    nores.appendChild(c);
  }
}
function syncSelect() {
  $('galleryBar').hidden = selecting; $('selectBar').hidden = !selecting; $('selbar').hidden = !selecting;
  $('fab').hidden = selecting; $('protoBtn').hidden = selecting || !PROTO;
  $('selCount').textContent = `${selected.size} selected`;
  renderGallery();
  syncHistory();
}
function longPress(el, fn) {
  let t = null;
  el.addEventListener('pointerdown', () => { t = setTimeout(() => { el.dataset.longpressed = '1'; fn(); }, 450); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(e => el.addEventListener(e, () => clearTimeout(t)));
  el.addEventListener('contextmenu', e => e.preventDefault());
}
$('search').oninput = e => {
  filter.q = e.target.value;
  if (/(^|\s)or(\s|$)/i.test(filter.q)) filter.mode = 'any';
  else if (terms().length < 2) filter.mode = 'all';
  renderGallery(); renderSugs();
};
$('search').onfocus = renderSugs;
$('search').onblur = () => setTimeout(() => $('sugs').hidden = true, 120);
$('search').onkeydown = e => { if (e.key === 'Enter') $('search').blur(); };
$('searchClear').onclick = () => { setQuery(''); renderSugs(); $('search').focus(); };
$('selCancel').onclick = () => { selecting = false; selected.clear(); syncSelect(); };
$('selAll').onclick = () => { visible().forEach(p => selected.add(p.id)); syncSelect(); };
$('selDelete').onclick = () => {
  const removed = portraits.filter(p => selected.has(p.id));
  portraits = portraits.filter(p => !selected.has(p.id));
  removeStored(removed.map(p => p.id));
  selecting = false; selected.clear(); syncSelect();
  toast(`Deleted ${removed.length} portrait${removed.length > 1 ? 's' : ''}`, () => {
    portraits = [...removed, ...portraits]; removed.forEach(p => persist(p, true)); renderGallery();
  });
};
$('selExport').onclick = () => {
  const list = portraits.filter(p => selected.has(p.id));
  selecting = false; selected.clear(); syncSelect();
  exportPortraits(list, list.length === portraits.length);
};
$('selTag').onclick = () => manageTags();

// Tags of the selected portraits: remove one from all of them, or add one to all of them
function manageTags() {
  const sel = portraits.filter(p => selected.has(p.id)), n = sel.length;
  const counts = new Map();
  sel.forEach(p => p.tags.forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
  openSheet(`<h3>Tags of ${n} portrait${n > 1 ? 's' : ''}</h3>
    <div class="tagrow" id="mtList"></div>
    <input class="search" id="mtNew" placeholder="Add a tag to all of them" aria-label="Add a tag" style="margin-top:12px">
    <div class="tagrow" id="mtSug" style="margin-top:8px"></div>
    <div class="actions"><button class="primary" id="mtDone">Done</button></div>`, s => {
    const list = s.querySelector('#mtList'), input = s.querySelector('#mtNew'), sug = s.querySelector('#mtSug');
    const draw = () => {
      list.innerHTML = counts.size ? '' : '<span class="hint">No tags yet</span>';
      [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, c]) => {
        const el = document.createElement('span'); el.className = 'tag';
        el.textContent = c === n ? t : `${t} · ${c} of ${n}`;
        const x = document.createElement('button'); x.textContent = '×'; x.setAttribute('aria-label', `Remove ${t} from all`);
        x.onclick = () => { sel.forEach(p => { p.tags = p.tags.filter(v => v !== t); persist(p); }); counts.delete(t); draw(); };
        el.appendChild(x); list.appendChild(el);
      });
      sug.innerHTML = '';
      allTags().filter(t => counts.get(t) !== n && t.includes(input.value.trim().toLowerCase())).slice(0, 12).forEach(t => {
        const b = document.createElement('button'); b.className = 'chip'; b.textContent = '+ ' + t; b.onclick = () => add(t); sug.appendChild(b);
      });
    };
    const add = t => { sel.forEach(p => { if (!p.tags.includes(t)) { p.tags.push(t); persist(p); } }); counts.set(t, n); input.value = ''; draw(); };
    input.oninput = draw;
    input.onkeydown = e => { const v = input.value.trim().toLowerCase(); if (e.key === 'Enter' && v) add(v); };
    s.querySelector('#mtDone').onclick = () => { closeSheet(); renderGallery(); };
    draw();
  });
}

// ---------- sheets and toast ----------
function openSheet(html, bind) { $('sheet').innerHTML = html; $('sheet').hidden = false; $('scrim').hidden = false; bind && bind($('sheet')); syncHistory(); }
function closeSheet() { $('sheet').hidden = true; $('scrim').hidden = true; syncHistory(); }
$('scrim').onclick = closeSheet;
let toastTimer = null;
function toast(text, action, actionLabel = 'Undo') {
  $('toastText').textContent = text; $('toast').hidden = false;
  $('toastAction').textContent = actionLabel;
  $('toastAction').hidden = !action; $('toastAction').onclick = () => { $('toast').hidden = true; action(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500);
}

$('fab').onclick = () => openSheet(`
    <h3>Add</h3>
    <a class="item" href="https://totemforge.nl/" target="_blank" rel="noopener"><span class="ico">⬢</span><span>More totems<small>Get them on Etsy</small></span></a>
    <a class="item" href="https://totemforge.nl/" target="_blank" rel="noopener"><span class="ico">✦</span><span>More art<small>Art packs and ideas for your own images</small></span></a>
    <button class="item" data-a="pack"><span class="ico">📦</span><span>Art pack or backup<small>From a .tfc file</small></span></button>
    <button class="item" data-a="photo"><span class="ico">🖼</span><span>Photo or image<small>From your photos or files</small></span></button>`,
  s => s.querySelectorAll('button.item').forEach(b => b.onclick = () => {
    closeSheet();
    if (iosFiles()) return b.dataset.a === 'photo' ? pickIosPhoto() : pickIosPack();
    $(b.dataset.a === 'photo' ? 'filePick' : 'packPick').click();
  }));

$('menuBtn').onclick = () => openSheet(`
    <button class="item" data-a="select"><span class="ico">☑</span><span>Select portraits</span></button>
    <button class="item" data-a="settings"><span class="ico">⚙</span><span>Settings<small>Order, backup, firmware, about</small></span></button>
    <button class="item" data-a="help"><span class="ico">?</span><span>Help & feedback<small>Quick start, Discord, email</small></span></button>
    ${installRoute(navigator.userAgent, runsInstalled()) && !installedApp ? `<button class="item" data-a="install"><span class="ico">⤓</span><span>Install app<small>On this phone, from Chrome</small></span></button>` : ''}`,
  s => s.querySelectorAll('button.item').forEach(b => b.onclick = () => {
    closeSheet();
    if (b.dataset.a === 'select') { selecting = true; syncSelect(); }
    else if (b.dataset.a === 'help') helpSheet();
    else if (b.dataset.a === 'install') { settings.installLater = 0; saveSettings(); renderInstall(); $('galleryScroll').scrollTop = 0; }
    else { renderSettings(); show('settings'); }
  }));

// ---------- installing on Android ----------
// A card at the top of the gallery: in Chrome an Install button (Chrome's own dialog), or where to
// find Install in Chrome's menu until Chrome offers it; in other browsers a link that opens the page
// in Chrome. "Not now" hides it for two weeks; the menu brings it back.
const runsInstalled = () => matchMedia('(display-mode: standalone)').matches || platform() === 'iphone';
const INSTALL_WHY = 'It opens full screen like any app, keeps your gallery safer, and other apps can share photos straight to it.';
let installPrompt = null, installedApp = false;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; renderInstall(); });
window.addEventListener('appinstalled', () => { installPrompt = null; installedApp = true; renderInstall(); });
// Chrome tells an open page when the app is already installed (manifest: related_applications)
navigator.getInstalledRelatedApps?.().then(apps => { if (apps.length) { installedApp = true; renderInstall(); } }).catch(() => {});
function renderInstall() {
  const card = $('installCard'), route = installRoute(navigator.userAgent, runsInstalled());
  card.hidden = !route || Date.now() - settings.installLater < 14 * 864e5;
  if (card.hidden) return;
  const later = '<button class="secondary" id="instLater">Not now</button>';
  if (installedApp) card.innerHTML = `<p><strong>Totem Forge is installed on this phone.</strong> Open it from your home screen or app list.</p>
    <div class="actions"><button class="secondary" id="instLater">OK</button></div>`;
  else if (route === 'chrome') card.innerHTML = `<p><strong>Install Totem Forge from Chrome.</strong> ${INSTALL_WHY}</p>
    <p>This browser can't install it: open this page in Chrome and tap <strong>Install</strong> there.</p>
    <div class="actions"><a class="primary wide" id="instChrome" href="${escapeHtml(chromeLink(location.href))}">Open in Chrome</a>
      <button class="secondary" id="instCopy">Copy link</button>${later}</div>`;
  else if (installPrompt) card.innerHTML = `<p><strong>Install Totem Forge on this phone.</strong> ${INSTALL_WHY}</p>
    <div class="actions"><button class="primary" id="instGo">Install</button>${later}</div>`;
  else card.innerHTML = `<p><strong>Install Totem Forge on this phone.</strong> ${INSTALL_WHY}</p>
    <p>In Chrome's menu <strong>⋮</strong> (top right), tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.
      Opened from another app, like Discord? Tap <strong>⋮</strong> → <strong>Open in Chrome</strong> first.</p>
    <div class="actions">${later}</div>`;
  card.querySelector('#instLater').onclick = () => { settings.installLater = Date.now(); saveSettings(); renderInstall(); };
  const go = card.querySelector('#instGo');
  if (go) go.onclick = async () => {
    const asked = installPrompt; installPrompt = null;
    await asked.prompt();
    // Installed: appinstalled follows. Declined: Chrome's dialog can't be shown again, so the menu way
    if ((await asked.userChoice).outcome !== 'accepted') renderInstall();
  };
  const copy = card.querySelector('#instCopy');
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText(location.origin + location.pathname); toast('Link copied: paste it into Chrome.'); }
    catch { toast(`Open ${location.host}${location.pathname} in Chrome.`); }
  };
}

// ---------- portraits folder (PC/Mac) ----------
// Chrome and Edge on a computer save the portraits as files in a folder the user chooses, so clearing
// the browser's data can't lose them. It's asked for before the first own portrait is saved (the free
// pack needs none). The browser keeps a working copy; the folder is the master: on start (and on
// Check the folder) the gallery follows it (core/gallerydir.js has the format and the rules).
// state: off (phones, the iOS shell, other browsers), none (not chosen yet), ready, ask (the browser
// wants an OK again, e.g. after a restart), lost (moved, renamed or deleted). Changes that can't be
// written yet wait (kept with the gallery) and are written once the folder is back.
const folder = { handle: null, dir: null, name: '', state: 'off', waiting: { save: [], remove: [] } };
const saveWaiting = () => store.saveValue?.('folderWaiting', folder.waiting).catch(() => {});
async function folderStart() {
  if (platform() !== 'desktop' || iosFiles() || !folderSupported() || !store.loadValue) return;
  folder.state = 'none';
  folder.waiting = (await store.loadValue('folderWaiting')) || { save: [], remove: [] };
  const handle = await store.loadValue('folder');
  if (handle) { setFolder(handle); await checkFolderState(false); }
  renderFolder();
}
function setFolder(handle) { folder.handle = handle; folder.dir = handleDir(handle); folder.name = handle.name; }
// Brings the folder state up to date; when ready, writes what waited and follows the folder
async function checkFolderState(ask) {
  if (!folder.handle) return null;
  let result = null;
  try {
    if (await permission(folder.handle, ask) !== 'granted') folder.state = 'ask';
    else if (!(await folderExists(folder.handle))) folder.state = 'lost';
    else { folder.state = 'ready'; await writeWaiting(); result = await followFolder(); }
  } catch { folder.state = 'lost'; }
  renderFolder();
  return result;
}
function waitFor(kind, ids) {
  const other = kind === 'save' ? 'remove' : 'save';
  folder.waiting[other] = folder.waiting[other].filter(id => !ids.includes(id));
  folder.waiting[kind] = [...new Set([...folder.waiting[kind], ...ids])];
  saveWaiting(); renderFolder();
}
async function folderSave(p, withPicture) {
  if (folder.state === 'off' || folder.state === 'none') return;
  if (folder.state !== 'ready') return waitFor('save', [p.id]);
  try { await writePortrait(folder.dir, p, withPicture); }
  catch { waitFor('save', [p.id]); checkFolderState(false); }
}
async function folderRemove(ids) {
  if (folder.state === 'off' || folder.state === 'none') return;
  if (folder.state !== 'ready') return waitFor('remove', ids);
  try { await removePortraits(folder.dir, ids); }
  catch { waitFor('remove', ids); checkFolderState(false); }
}
async function writeWaiting() {
  const { save, remove } = folder.waiting;
  if (!save.length && !remove.length) return;
  if (remove.length) await removePortraits(folder.dir, remove);
  for (const id of save) { const p = portraits.find(x => x.id === id); if (p) await writePortrait(folder.dir, p, true); }
  folder.waiting = { save: [], remove: [] }; saveWaiting();
}
// The folder is the master: the gallery (and the browser's copy) follow it
async function followFolder() {
  const r = await readGallery(folder.dir, new Map(portraits.map(p => [p.id, p])),
    { keep: new Set(folder.waiting.save), defaults: { adjust: { brightness: 0, dither: DITHER.normal } } });
  for (const { record, blob } of r.added) {
    try { const p = { ...record, blob, img: await createImageBitmap(blob), thumb: null }; updateThumb(p); portraits.push(p); store.save(p, blob).catch(storageFailed); }
    catch { r.unreadable.push(record.picture); }
  }
  for (const { record, blob } of r.updated) {
    const i = portraits.findIndex(p => p.id === record.id);
    if (i < 0) continue;
    const p = { ...portraits[i], ...record };
    if (blob) { try { p.blob = blob; p.img = await createImageBitmap(blob); } catch { continue; } }
    updateThumb(p); portraits[i] = p;
    if (current && current.id === p.id) current = p;
    store.save(p, blob || undefined).catch(storageFailed);
  }
  if (r.removed.length) {
    const gone = new Set(r.removed);
    portraits = portraits.filter(p => !gone.has(p.id));
    store.remove(r.removed).catch(storageFailed);
    if (current && gone.has(current.id) && currentScreen === 'portrait') show('gallery');
  }
  if (r.added.length || r.updated.length || r.removed.length) {
    renderGallery();
    if (currentScreen === 'portrait' && current) openPortrait(current);
  }
  return r;
}
// A newly chosen folder: what waited and the gallery's portraits it doesn't have go in, then the
// folder's own come in
async function useFolder(handle) {
  setFolder(handle); folder.state = 'ready';
  await store.saveValue('folder', handle);
  await writeWaiting();
  const there = new Set((await folder.dir.list()).map(e => e.name.replace(/\.[^.]+$/, '')));
  for (const p of portraits) if (!there.has(p.id)) await writePortrait(folder.dir, p, true);
  const r = await followFolder();
  renderFolder();
  if (currentScreen === 'settings') renderSettings();
  return r;
}
// Choose (or change, or find again) the folder; restoring: only one that already has portraits
async function pickFolder(restoring) {
  try {
    const handle = await chooseFolder(restoring);
    if (!handle) return false;
    const r = await useFolder(handle);
    toast(restoring || r.added.length ? `${plural(r.added.length, 'portrait')} brought in from “${handle.name}”` : `Portraits are saved in “${handle.name}”`);
    return true;
  } catch (e) { toast(e.message || "Couldn't use that folder."); return false; }
}
async function checkFolder() {
  const r = await checkFolderState(true);
  if (!r) return toast(folder.state === 'ask' ? 'The browser didn’t allow access to the folder.' : 'Your portraits folder wasn’t found.');
  const changes = [r.added.length && `${r.added.length} added`, r.updated.length && `${r.updated.length} changed`,
    r.removed.length && `${r.removed.length} removed`, r.unreadable.length && `${r.unreadable.length} couldn't be read`].filter(Boolean);
  toast(changes.length ? `From the folder: ${changes.join(', ')}` : 'The gallery matches the folder');
}
// Before the first own portrait is saved (folder.state 'none'): choose the folder; resolves false
// when cancelled. Callers check the state first, so a chosen folder adds no wait
function requireFolder() {
  if (folder.state !== 'none') return Promise.resolve(true);
  return new Promise(resolve => {
    const cancel = () => { closeSheet(); $('scrim').onclick = closeSheet; toast('Not saved: portraits are kept in a folder you choose.'); resolve(false); };
    openSheet(`<h3>Choose where portraits are saved</h3>
      <p>Your portraits are kept as files in a folder on this computer, so they stay safe even if the browser's data is cleared.</p>
      <p class="hint">Make a new folder, for example “Totem Forge” in Documents, OneDrive, iCloud Drive or Dropbox, and choose it. The browser won't allow Documents itself.</p>
      <div class="actions"><button class="secondary" id="rfCancel">Cancel</button><button class="primary" id="rfGo">Choose a folder</button></div>`, s => {
      s.querySelector('#rfCancel').onclick = cancel;
      s.querySelector('#rfGo').onclick = async () => {
        let handle;
        try { handle = await chooseFolder(false); } catch (e) { return toast(e.message); }
        if (!handle) return;
        closeSheet(); $('scrim').onclick = closeSheet;
        await useFolder(handle);
        resolve(true);
      };
    });
    $('scrim').onclick = cancel;
  });
}
function renderFolder() {
  const bar = $('folderBanner'), waiting = folder.waiting.save.length + folder.waiting.remove.length;
  const more = waiting ? ` ${plural(waiting, 'change')} ${waiting === 1 ? 'is' : 'are'} waiting to be saved.` : '';
  bar.hidden = !['ask', 'lost'].includes(folder.state) || selecting;
  if (!bar.hidden) {
    bar.innerHTML = folder.state === 'ask'
      ? `<p><strong>Reconnect your portraits folder.</strong> The browser needs your OK again to save to “${escapeHtml(folder.name)}”.${more}</p>
         <div class="actions"><button class="primary" id="fbGo">Allow access</button></div>`
      : `<p><strong>Your portraits folder wasn't found.</strong> “${escapeHtml(folder.name)}” may have been moved, renamed or deleted.${more}</p>
         <div class="actions"><button class="primary" id="fbGo">Choose it again</button></div>`;
    $('fbGo').onclick = folder.state === 'ask' ? checkFolder : () => pickFolder(false);
  }
  $('restoreFolder').hidden = !(folder.state === 'none' && !portraits.length);
}
$('restoreFolder').onclick = () => pickFolder(true);

// ---------- help and feedback ----------
const DISCORD = 'https://discord.gg/fgyvRsuTGd', EMAIL = 'info@totemforge.nl';
// "iPhone · iOS 18.2" from the iOS shell; in a browser the system and browser from its user agent
function deviceInfo() {
  if (window.totemShell?.device) return window.totemShell.device;
  const ua = navigator.userAgent;
  const system = (ua.match(/Android [\d.]+/) || [/Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'unknown system'])[0];
  const browser = (ua.match(/Edg\/\d+/) || ua.match(/Chrome\/\d+/) || ua.match(/Firefox\/\d+/) || ua.match(/Version\/[\d.]+(?= .*Safari)/) || ['browser'])[0]
    .replace(/^Edg\//, 'Edge ').replace(/^Chrome\//, 'Chrome ').replace(/^Firefox\//, 'Firefox ').replace(/^Version\//, 'Safari ');
  return `${system} · ${browser}`;
}
// The email starts with a line about the app, device and base, so a problem can be answered at once;
// people see it before sending (nothing is sent by the app itself)
function helpSheet() {
  const about = `Totem Forge ${window.totemShell?.version || 'web app'} · ${deviceInfo()} · base firmware ${base?.version || 'not known yet'}`;
  const mail = `mailto:${EMAIL}?subject=${encodeURIComponent('Totem Forge feedback')}&body=${encodeURIComponent(`\n\n\n--\n${about}`)}`;
  openSheet(`<h3>Help & feedback</h3>
    <a class="item" href="https://totemforge.nl/start.html" target="_blank" rel="noopener"><span class="ico">📖</span><span>Quick start and FAQ<small>Setting up and using your totems</small></span></a>
    <a class="item" href="${DISCORD}" target="_blank" rel="noopener"><span class="ico">💬</span><span>Discord<small>Questions, ideas and other players</small></span></a>
    <a class="item" href="${escapeHtml(mail)}"><span class="ico">✉</span><span>Email us<small>${EMAIL}</small></span></a>`);
}

// ---------- art packs and backups (.tfc) ----------
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
$('packPick').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };

async function importFile(file) {
  let pack;
  try { pack = await readTfc(file); } catch { return toast("That file isn't a Totem Forge art pack or backup."); }
  if (!pack.items.length) return toast('That file has no portraits.');
  const names = new Set(pack.items.map(i => i.record.collection));
  const title = names.size === 1 && pack.items[0].record.collection || file.name.replace(/\.(tfc|zip)$/gi, '');
  previewImport(pack.items, title);
}
// What the file adds, and what to do with portraits already in the gallery
function previewImport(items, title) {
  const have = new Set(portraits.map(p => p.id));
  const dup = items.filter(i => have.has(i.record.id)).length, fresh = items.length - dup;
  openSheet(`<h3>${escapeHtml(title)}</h3>
    <p><strong>${plural(items.length, 'portrait')}:</strong> ${fresh} new${dup ? `, ${dup} already in your gallery` : ''}.</p>
    ${dup ? `<label class="radio"><input type="radio" name="dup" value="skip" checked><span>Keep mine<small>Skip the ${dup} you already have</small></span></label>
    <label class="radio"><input type="radio" name="dup" value="replace"><span>Replace mine<small>Use the file's version, including text and tags</small></span></label>` : ''}
    <div class="actions"><button class="secondary" id="ipCancel">Cancel</button>
      <button class="primary" id="ipGo">Import</button></div>`, s => {
    s.querySelector('#ipCancel').onclick = closeSheet;
    s.querySelector('#ipGo').onclick = async () => {
      const replace = s.querySelector('input[name="dup"]:checked')?.value === 'replace';
      if (folder.state === 'none' && !(await requireFolder())) return;
      closeSheet();
      const added = await addItems(items, id => !have.has(id) || replace);
      toast(!added ? 'Nothing new to add' : replace && dup ? `Added ${fresh} and replaced ${dup}` : `Added ${plural(added, 'portrait')}`);
    };
  });
}
// New portraits go to the top of the gallery, in the file's order
async function addItems(items, take) {
  const now = Date.now(), list = [], saves = [];
  for (const [i, { record, blob }] of items.entries()) {
    if (!take(record.id)) continue;
    let img;
    try { img = await createImageBitmap(blob); } catch { continue; }
    const p = { ...record, blob, img, createdAt: now - i, thumb: null };
    updateThumb(p); list.push(p); saves.push(persist(p, true));
  }
  const ids = new Set(list.map(p => p.id));
  portraits = [...list, ...portraits.filter(p => !ids.has(p.id))];
  setQuery(''); $('galleryScroll').scrollTop = 0; show('gallery');
  await Promise.all(saves);           // the message that follows means they're all saved
  return list.length;
}
$('addFreePack').onclick = async () => {
  $('addFreePack').disabled = true;
  try { const n = await addItems((await loadFreePack()).items, () => true); toast(`Added ${n} portraits from Classic Fantasy`); }
  catch { toast("Couldn't load the free pack."); }
  $('addFreePack').disabled = false;
};

// Export: totem_backup_2026-10-12_5_portraits.tfc, or totem_<text or tag>.tfc for one portrait.
// backup: it holds the whole gallery, so it resets the backup reminder.
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const exportName = list => list.length === 1
  ? `totem_${label(list[0]).replace(/[^\p{L}\p{N}-]+/gu, '_').replace(/^_|_$/g, '') || 'portrait'}.tfc`
  : `totem_backup_${localDate()}_${list.length}_portraits.tfc`;
async function exportPortraits(list, backup = false) {
  if (!list.length) return;
  const name = exportName(list), build = () => writeTfc(sorted(list), renderPng);
  let saved = null;
  try {
    if (iosFiles()) {
      toast('Preparing the file…');
      if (await shareOnIos(await build(), name)) saved = name;
      $('toast').hidden = true;
    } else if (hasSaveDialog()) {
      const handle = await pickSaveFile(name);     // first, while the tap still counts as one
      if (handle) { toast('Saving…'); await writeHandle(handle, await build()); saved = handle.name; }
    } else {
      saved = await nameSheet(name, await build(), list.length);
    }
  } catch { return toast("Couldn't save the file. Is the device out of storage?"); }
  if (!saved) return;
  if (backup) { Object.assign(settings, { lastBackup: Date.now(), sinceBackup: 0, remindAt: 0 }); saveSettings(); renderBanner(); }
  toast(`Saved ${saved}${hasSaveDialog() || iosFiles() ? '' : ' to Downloads'}`);
  if (currentScreen === 'settings') renderSettings();
}
// Downloads can't be renamed afterwards, so the name is chosen first
function nameSheet(name, blob, count) {
  return new Promise(resolve => {
    const done = file => { closeSheet(); $('scrim').onclick = closeSheet; if (file) download(blob, file); resolve(file); };
    openSheet(`<h3>Save ${plural(count, 'portrait')}</h3>
      <label class="field"><span>File name</span><input class="search" id="nsName" autocomplete="off" spellcheck="false"></label>
      <div class="actions"><button class="secondary" id="nsCancel">Cancel</button><button class="primary" id="nsSave">Save</button></div>`, s => {
      const input = s.querySelector('#nsName'); input.value = name;
      s.querySelector('#nsCancel').onclick = () => done(null);
      s.querySelector('#nsSave').onclick = () =>
        done((input.value.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\.tfc$/i, '') || name.replace(/\.tfc$/, '')) + '.tfc');
    });
    $('scrim').onclick = () => done(null);
  });
}

// Backup reminder
function countNew() { settings.sinceBackup++; saveSettings(); }
function renderBanner() {
  const due = settings.backupEvery > 0 && portraits.length > 0 && settings.sinceBackup >= (settings.remindAt || settings.backupEvery);
  $('backupBanner').hidden = !due || selecting;
  if (due) $('backupText').textContent = `You've added ${plural(settings.sinceBackup, 'portrait')} since ${settings.lastBackup ? 'your last backup' : 'you started'}.${folder.state === 'ready' ? '' : ' Your gallery is only on this device.'}`;
  renderFolder();
}
$('backupNow').onclick = () => exportPortraits(portraits, true);
$('backupLater').onclick = () => { settings.remindAt = settings.sinceBackup + (settings.backupEvery || 5); saveSettings(); renderBanner(); };

// ---------- prototype controls (?proto) ----------
const failNames = { none: 'Works', unplugged: 'Base unplugged while sending', display: "Totem's screen not reached",
                    timeout: 'Base stops answering', blocked: 'MIDI access blocked' };
$('protoBtn').hidden = !PROTO;
$('protoBtn').onclick = () => openSheet(`
    <h3>Prototype controls</h3>
    <p>Simulate the base and the device. Not part of the app.</p>
    <div class="row"><span>Device</span><div class="seg" id="pcPlat">
      <button data-v="android">Android</button><button data-v="iphone">iPhone</button><button data-v="desktop">PC or Mac</button></div></div>
    <label class="row"><span>Base plugged in</span><input type="checkbox" id="pcBase" ${sim.base ? 'checked' : ''}></label>
    <label class="row"><span>Base has old firmware (1.0)</span><input type="checkbox" id="pcOld" ${sim.firmware === '1.0' ? 'checked' : ''}></label>
    <label class="row"><span>Next summon</span><select id="pcFail">${Object.entries(failNames).map(([k, v]) =>
      `<option value="${k}" ${sim.fail === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="row"><span>Fast refresh (3 s instead of 13 s)</span><input type="checkbox" id="pcFast" ${sim.fast ? 'checked' : ''}></label>
    <div class="actions"><button class="secondary" id="pcEmpty">Empty gallery</button></div>`,
  s => {
    const plat = s.querySelector('#pcPlat');
    const syncPlat = () => plat.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === sim.platform));
    plat.querySelectorAll('button').forEach(b => b.onclick = () => { sim.platform = b.dataset.v; syncPlat(); renderSettings(); });
    syncPlat();
    s.querySelector('#pcBase').onchange = e => { sim.base = e.target.checked; base.ready = false; renderSettings(); };
    s.querySelector('#pcOld').onchange = e => { sim.firmware = e.target.checked ? '1.0' : '2.0'; base.ready = false; renderSettings(); };
    s.querySelector('#pcFail').onchange = e => sim.fail = e.target.value;
    s.querySelector('#pcFast').onchange = e => sim.fast = e.target.checked;
    s.querySelector('#pcEmpty').onclick = () => { removeStored(portraits.map(p => p.id)); portraits = []; closeSheet(); show('gallery'); };
  });

// ---------- portrait ----------
function openPortrait(p) {
  current = p; show('portrait');
  $('pTitle').textContent = label(p);
  paintPreview($('pCanvas'), render(p).idx);
  $('pMeta').textContent = p.collection || '';
  if (!summon.run || summon.for !== p.id) $('notice').hidden = true;
  syncSummon(); renderTags();
}
function renderTags() {
  const row = $('pTags'); row.innerHTML = '';
  current.tags.forEach(t => {
    const s = document.createElement('span'); s.className = 'tag'; s.textContent = t;
    const x = document.createElement('button'); x.textContent = '×'; x.setAttribute('aria-label', `Remove tag ${t}`);
    x.onclick = () => { current.tags = current.tags.filter(v => v !== t); persist(current); renderTags(); };
    s.appendChild(x); row.appendChild(s);
  });
  const add = document.createElement('button'); add.className = 'tag-add'; add.textContent = '+ Tag';
  add.onclick = () => tagSheet(t => { if (!current.tags.includes(t)) { current.tags.push(t); persist(current); } renderTags(); }, current.tags);
  row.appendChild(add);
}
function tagSheet(onPick, exclude = []) {
  const tags = allTags().filter(t => !exclude.includes(t));
  openSheet(`<h3>Add tag</h3>
    <input class="search" id="tagNew" placeholder="New or existing tag" aria-label="Tag">
    <div class="tagrow" id="tagSug" style="margin-top:10px"></div>`, s => {
    const input = s.querySelector('#tagNew'), sug = s.querySelector('#tagSug');
    const draw = () => {
      sug.innerHTML = '';
      tags.filter(t => t.includes(input.value.trim().toLowerCase())).slice(0, 18).forEach(t => {
        const b = document.createElement('button'); b.className = 'chip'; b.textContent = t;
        b.onclick = () => { closeSheet(); onPick(t); }; sug.appendChild(b);
      });
    };
    input.oninput = draw; draw();
    input.onkeydown = e => { const v = input.value.trim().toLowerCase(); if (e.key === 'Enter' && v) { closeSheet(); onPick(v); } };
    setTimeout(() => input.focus(), 50);
  });
}
$('pBack').onclick = () => show('gallery');
// Duplicate with the next number in the text: "Orc 1" → "Orc 2", "Orc" → "Orc 2"
const nextText = t => !t.trim() ? '' : /\d+(?!.*\d)/s.test(t) ? t.replace(/(\d+)(?!.*\d)/s, n => +n + 1) : t.trimEnd() + ' 2';
$('pMenu').onclick = () => {
  const txt = current.overlay ? current.overlay.text : '';
  openSheet(`
    <button class="item" data-a="dup"><span class="ico">⧉</span><span>Duplicate${txt.trim() ? `<small>The copy says “${escapeHtml(nextText(txt).replace(/\n/g, ' '))}”</small>` : ''}</span></button>
    <button class="item" data-a="export"><span class="ico">⬆</span><span>Export<small>Share as a .tfc file</small></span></button>
    <button class="item" data-a="delete" style="color:var(--danger)"><span class="ico">🗑</span><span>Delete</span></button>`,
  s => s.querySelectorAll('.item').forEach(b => b.onclick = async () => {
    closeSheet();
    if (b.dataset.a === 'export') return exportPortraits([current], portraits.length === 1);
    if (b.dataset.a === 'dup') {
      if (folder.state === 'none' && !(await requireFolder())) return;
      const copy = clone(current); copy.id = newId(); copy.createdAt = Date.now(); copy.lastUsed = 0;
      if (copy.overlay) copy.overlay.text = nextText(copy.overlay.text);
      updateThumb(copy); portraits.push(copy); persist(copy, true); countNew(); return openPortrait(copy);
    }
    const p = current, i = portraits.indexOf(p);
    portraits.splice(i, 1); removeStored([p.id]); show('gallery');
    toast('Deleted the portrait', () => { portraits.splice(i, 0, p); persist(p, true); renderGallery(); });
  }));
};
$('pEdit').onclick = () => openEditor(current, false);

// ---------- summon ----------
// summon.run counts summons; summon.for is the portrait being summoned; summon.stage 'sending' | 'refreshing'
const REFRESH_MS = () => PROTO && sim.fast ? 3000 : 13000;
let ticker = null;
function syncSummon() {
  const mine = current && summon.run && summon.for === current.id;
  $('progress').hidden = !mine;
  $('summon').textContent = mine ? 'Summoning…' : 'Summon';
  $('summon').disabled = !!mine;
}
function tick() {
  if (!current || current.id !== summon.for) return;
  const t = performance.now() - summon.since;
  const refreshing = summon.stage === 'refreshing';
  const pct = refreshing ? 10 + Math.min(87, t / REFRESH_MS() * 90) : Math.min(10, t / 600 * 10);
  $('progFill').style.width = pct + '%';
  $('progText').textContent = refreshing ? 'Refreshing the totem…' : 'Sending…';
  $('progTime').textContent = refreshing ? `${Math.max(1, Math.ceil((REFRESH_MS() - t) / 1000))} s` : '';
}
function notice(html, retry, error = true) {
  const n = $('notice'); n.className = 'notice' + (error ? ' error' : ''); n.innerHTML = `<span>${html}</span>`; n.hidden = false;
  if (retry) { const b = document.createElement('button'); b.className = 'primary'; b.textContent = 'Try again'; b.onclick = summon; n.appendChild(b); }
  return n;
}
const errors = {
  'no-base': () => `<strong>No base found.</strong> Plug the base into this ${device()}, then try again.`,
  blocked: () => '<strong>The browser blocked access to the base.</strong> Allow MIDI devices for this site in the browser settings (the icon left of the address), then try again.',
  'no-answer': () => '<strong>The base stopped answering.</strong> Unplug it, plug it back in, and try again.',
  unplugged: () => '<strong>The base was unplugged while sending.</strong> Plug it back in and try again.',
  display: () => "<strong>The base can't reach the totem's screen.</strong> Check that the totem sits firmly on the base, then try again.",
  failed: e => `<strong>Something went wrong.</strong> The base said: ${escapeHtml(e.message)}. Try again.`
};
async function summon() {
  const p = current;
  $('notice').hidden = true;
  if (!base) return notice(`<strong>This browser can't talk to the base.</strong> Use Chrome or Edge, or the Totem Forge app.`);
  if (platform() !== 'iphone') {
    const perm = await transport.permission();
    if (perm === 'denied') return notice(errors.blocked(), true);
    if (perm === 'prompt' && !settings.midiExplained) return midiSheet();
  }
  const run = summon.run = (summon.run || 0) + 1;
  summon.for = p.id; summon.stage = 'sending'; summon.since = performance.now();
  syncSummon(); clearInterval(ticker); ticker = setInterval(tick, 100); tick();
  try {
    await base.summon(packImage(render(p).idx), stage => { summon.stage = stage; summon.since = performance.now(); });
    // Done: the totem shows it and the base's red LED goes out, so the app says nothing
    p.lastUsed = Date.now(); persist(p);
  } catch (e) {
    if (e.code === 'replaced' || run !== summon.run) return;
    if (e.code === 'old-firmware') { finish(run); return firmwareSheet(); }
    const here = current && current.id === p.id && !$('portrait').hidden;
    finish(run);
    if (!here) return toast('Summon failed. Open the portrait to try again.');
    const n = notice((errors[e.code] || errors.failed)(e), true);
    if (e.code === 'no-base') {                    // a base on old firmware has no MIDI, so it looks absent
      const more = document.createElement('span'); more.className = 'hint';
      more.innerHTML = 'Plugged in? Its firmware may need a one-time update. ';
      const how = document.createElement('button'); how.className = 'linkish'; how.textContent = 'How to update'; how.onclick = firmwareSheet;
      more.appendChild(how); n.insertBefore(more, n.lastChild);
    }
    return;
  }
  finish(run);
}
function finish(run) {
  if (run !== summon.run) return;
  summon.run = 0; summon.for = null; clearInterval(ticker); syncSummon();
}
$('summon').onclick = summon;
function midiSheet() {
  openSheet(`<h3>Allow access to the base</h3>
    <p>Your browser will now ask to let Totem Forge use <strong>MIDI devices</strong>. That's how the app talks to the base, so choose <strong>Allow</strong>. You're asked only once.</p>
    <div class="actions"><button class="secondary" id="mdCancel">Not now</button><button class="primary" id="mdGo">Continue</button></div>`, s => {
    s.querySelector('#mdCancel').onclick = closeSheet;
    s.querySelector('#mdGo').onclick = () => { closeSheet(); settings.midiExplained = true; saveSettings(); summon(); };
  });
}
function firmwareSheet() {
  if (platform() === 'desktop') {
    openSheet(`<h3>One-time update for your base</h3>
      <p>Your base needs a one-minute firmware update before it can show images.</p>
      <p class="hint">The update works in Google Chrome on a PC or Mac.</p>
      <div class="actions"><button class="secondary" id="fwLater">Later</button>
        <a class="primary" style="text-align:center;text-decoration:none" href="https://totemforge.nl/updater/" target="_blank" rel="noopener">Open the update page</a></div>`,
      s => s.querySelector('#fwLater').onclick = closeSheet);
  } else {
    openSheet(`<h3>One-time update for your base</h3>
      <p>Your base needs a one-minute firmware update. Do it once on a PC or Mac: open <strong>totemforge.nl/updater</strong> in Google Chrome.</p>
      <div class="actions"><button class="primary" id="fwOk">Got it</button></div>`, s => s.querySelector('#fwOk').onclick = closeSheet);
  }
}

// ---------- settings ----------
function renderSettings() {
  const body = $('settingsBody');
  const fw = base && base.version ? base.version : 'Summon once to see it';
  body.innerHTML = `
    <div class="group"><h3>Gallery</h3>
      <div class="rows"><div class="srow"><span class="k">Order</span>
        <div class="seg" id="setSort"><button data-v="newest">Newest first</button><button data-v="recent">Recently used</button></div></div></div></div>
    <div class="group"><h3>Backup</h3>
      <div class="rows">
        <div class="srow"><span class="k">Last backup</span><span class="v">${settings.lastBackup ? new Date(settings.lastBackup).toLocaleDateString() : 'Never'}</span></div>
        <div class="srow"><span class="k">Remind me after</span>
          <div class="seg" id="setRemind"><button data-v="5">5 new</button><button data-v="10">10 new</button><button data-v="25">25 new</button><button data-v="0">Never</button></div></div></div>
      <p class="hint">${folder.state === 'ready' ? '' : 'Your gallery is stored only on this device. '}A backup is a .tfc file with all your portraits: keep it somewhere safe, or open it on another device to move your gallery.</p>
      <div class="btnrow"><button class="secondary" id="setBackup" ${portraits.length ? '' : 'disabled'}>Back up now</button>
        <button class="secondary" id="setRestore">Restore a backup</button></div></div>
    ${folder.state !== 'off' ? `<div class="group"><h3>Portraits folder</h3>
      <div class="rows"><div class="srow"><span class="k">Folder</span><span class="v">${folder.handle ? escapeHtml(folder.name)
        + ({ ask: ' (needs your OK)', lost: ' (not found)' }[folder.state] || '') : 'Not chosen yet'}</span></div></div>
      <p class="hint">Your portraits are saved as files in this folder, so they stay safe even if the browser's data is cleared. In OneDrive, iCloud Drive or Dropbox they're also kept online.</p>
      <div class="btnrow"><button class="secondary" id="setFolder">${folder.handle ? 'Change folder' : 'Choose a folder'}</button>
        ${folder.handle ? '<button class="secondary" id="setFolderCheck">Check the folder</button>' : ''}</div></div>` : ''}
    ${platform() === 'desktop' ? `<div class="group"><h3>Base firmware</h3>
      <div class="rows"><div class="srow"><span class="k">Firmware</span><span class="v">${escapeHtml(fw)}</span></div></div>
      <a class="secondary" style="text-align:center;text-decoration:none" href="https://totemforge.nl/updater/" target="_blank" rel="noopener">Update firmware</a>
      <p class="hint">The update works in Google Chrome.</p></div>` : ''}
    <div class="group"><h3>About</h3>
      <div class="rows">
        <div class="srow"><span class="k">App version</span><span class="v">${escapeHtml(window.totemShell?.version || 'Web app')}</span></div>
        <div class="srow"><span class="k">Base firmware</span><span class="v">${escapeHtml(fw)}</span></div>
        <button class="srow" id="setHelp"><span class="k">Help & feedback</span><span class="v">Quick start, Discord, email ›</span></button>
        <div class="srow"><a href="https://totemforge.nl/terms.html" target="_blank" rel="noopener">Terms of use</a><a href="https://totemforge.nl/privacy.html" target="_blank" rel="noopener">Privacy policy</a><a href="https://totemforge.nl/" target="_blank" rel="noopener">totemforge.nl</a></div>
      </div>
      <p class="hint">© 2026 Totem Forge. All rights reserved.</p></div>`;
  body.querySelectorAll('#setRemind button').forEach(b => {
    b.setAttribute('aria-pressed', settings.backupEvery === +b.dataset.v);
    b.onclick = () => { settings.backupEvery = +b.dataset.v; settings.remindAt = 0; saveSettings(); renderSettings(); renderBanner(); };
  });
  $('setBackup').onclick = () => exportPortraits(portraits, true);
  if ($('setFolder')) $('setFolder').onclick = () => pickFolder(false);
  if ($('setFolderCheck')) $('setFolderCheck').onclick = checkFolder;
  $('setRestore').onclick = () => iosFiles() ? pickIosPack() : $('packPick').click();
  $('setHelp').onclick = helpSheet;
  body.querySelectorAll('#setSort button').forEach(b => {
    b.setAttribute('aria-pressed', settings.sort === b.dataset.v);
    b.onclick = () => { settings.sort = b.dataset.v; saveSettings(); renderSettings(); renderGallery(); };
  });
}
$('sBack').onclick = () => show('gallery');

// ---------- editor ----------
let draft = null, isNew = false;
function openEditor(p, fresh) {
  draft = clone(p); isNew = fresh;
  if (!draft.overlay) draft.overlay = { text: '', bar: 'black', textColour: 'yellow', position: 'bottom', push: 0 };
  $('eTitle').textContent = fresh ? 'New portrait' : 'Edit portrait';
  $('zoom').value = Math.round(draft.crop.zoom * 100);
  $('bright').value = draft.adjust.brightness; syncDither();
  $('ovText').value = draft.overlay.text; $('push').value = draft.overlay.push;
  selectTab('Adjust'); show('editor'); syncEditor();
  requestAnimationFrame(placeBezel);
}
function syncEditor() {
  const { idx, gap } = render(draft);
  paint($('eCanvas'), idx);
  $('fillmode').hidden = !gap;
  $('fillExtend').setAttribute('aria-pressed', draft.fill === 'extend');
  $('fillColour').setAttribute('aria-pressed', draft.fill === 'colour');
  $('zoomOut').textContent = `${Math.round(draft.crop.zoom * 100)} %`;
  $('brightOut').textContent = draft.adjust.brightness;
  $('pushOut').textContent = `${draft.overlay.push} %`;
  $('posTop').setAttribute('aria-pressed', draft.overlay.position === 'top');
  $('posBottom').setAttribute('aria-pressed', draft.overlay.position === 'bottom');
  swatches('swBar', 'bar'); swatches('swText', 'textColour');
  requestAnimationFrame(placeBezel);
}
function swatches(id, key) {
  const box = $(id); box.innerHTML = '';
  INK_NAMES.forEach((name, i) => {
    const b = document.createElement('button'); b.className = 'swatch'; b.setAttribute('aria-label', name);
    b.style.background = `rgb(${SHOW[i].join(',')})`;
    b.setAttribute('aria-pressed', draft.overlay[key] === name);
    b.onclick = () => { draft.overlay[key] = name; syncEditor(); };
    box.appendChild(b);
  });
}
function placeBezel() {   // what the totem's frame leaves visible (FRAME)
  const c = $('eCanvas'); if (!c.clientWidth) return;
  const k = c.clientWidth / W, r = c.getBoundingClientRect(), s = $('stage').getBoundingClientRect();
  Object.assign($('bezel').style, { left: (r.left - s.left + FRAME.side * k) + 'px', top: (r.top - s.top + FRAME.end * k) + 'px',
    width: (r.width - 2 * FRAME.side * k) + 'px', height: (r.height - 2 * FRAME.end * k) + 'px' });
}
function selectTab(name) {
  ['Adjust', 'Crop', 'Text'].forEach(t => { $('tab' + t).setAttribute('aria-selected', t === name); $('panel' + t).hidden = t !== name; });
}
['Adjust', 'Crop', 'Text'].forEach(t => $('tab' + t).onclick = () => selectTab(t));
$('fillExtend').onclick = () => { draft.fill = 'extend'; syncEditor(); };
$('fillColour').onclick = () => { draft.fill = 'colour'; syncEditor(); };
$('zoom').oninput = e => { draft.crop.zoom = e.target.value / 100; syncEditor(); };
$('rotate').onclick = () => { draft.rot = ((draft.rot || 0) + 90) % 360; draft.crop.x = draft.crop.y = 0; syncEditor(); };
$('cropReset').onclick = () => { draft.crop = { zoom: 1, x: 0, y: 0 }; draft.rot = 0; $('zoom').value = 100; syncEditor(); };
$('bright').oninput = e => { draft.adjust.brightness = +e.target.value; syncEditor(); };
// No highlighted step: the portrait's numbers match none of them (an older or newer app's steps)
const syncDither = () => $('dither').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === ditherStep(draft.adjust.dither)));
$('dither').querySelectorAll('button').forEach(b => b.onclick = () => { draft.adjust.dither = DITHER[b.dataset.v]; syncDither(); syncEditor(); });
$('ovText').oninput = e => { draft.overlay.text = e.target.value; syncEditor(); };
$('push').oninput = e => { draft.overlay.push = +e.target.value; syncEditor(); };
$('posTop').onclick = () => { draft.overlay.position = 'top'; syncEditor(); };
$('posBottom').onclick = () => { draft.overlay.position = 'bottom'; syncEditor(); };

// drag to move, pinch or wheel to zoom
const pts = new Map(); let pinch = null;
const canvasEl = $('eCanvas');
canvasEl.addEventListener('pointerdown', e => { canvasEl.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); });
canvasEl.addEventListener('pointermove', e => {
  if (!pts.has(e.pointerId)) return;
  const prev = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
  const k = W / canvasEl.clientWidth;
  if (pts.size === 1) { draft.crop.x += (e.clientX - prev[0]) * k; draft.crop.y += (e.clientY - prev[1]) * k; syncEditor(); }
  else if (pts.size === 2) {
    const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinch) zoomBy(d / pinch);
    pinch = d;
  }
});
const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
['pointerup', 'pointercancel'].forEach(ev => canvasEl.addEventListener(ev, up));
canvasEl.addEventListener('wheel', e => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.08 : 1 / 1.08); }, { passive: false });
function zoomBy(f) { draft.crop.zoom = Math.max(.4, Math.min(4, draft.crop.zoom * f)); $('zoom').value = Math.round(draft.crop.zoom * 100); syncEditor(); }

$('eCancel').onclick = () => { isNew || !current ? show('gallery') : openPortrait(current); };
$('eSave').onclick = async () => {
  if (isNew && folder.state === 'none' && !(await requireFolder())) return;
  if (!draft.overlay.text.trim()) draft.overlay.text = '';
  updateThumb(draft);
  if (isNew) { draft.createdAt = Date.now(); portraits.push(draft); persist(draft, true); countNew(); }
  else { portraits[portraits.findIndex(p => p.id === draft.id)] = draft; persist(draft); }
  openPortrait(draft);
};

// import: photo → editor (dither on for photos); the whole picture is kept, downscaled to ≤ 1600 px,
// and stored as JPG or PNG so backups open everywhere (HEIC, WebP, … become JPG)
async function openImage(f) {
  let bmp;
  try { bmp = await createImageBitmap(f); } catch { return toast('Could not read that image. Try a JPG or PNG.'); }
  const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const keep = s === 1 && f.size <= 3e6 && /^image\/(jpeg|png)$/.test(f.type);
  const blob = keep ? f : await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  openEditor({ id: newId(), tags: [], collection: null, img: c, blob, rot: 0, crop: { zoom: 1, x: 0, y: 0 },
               fill: 'colour', adjust: { brightness: 0, dither: DITHER.normal }, overlay: null, createdAt: 0, lastUsed: 0, thumb: null }, true);
}
$('filePick').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openImage(f); };
// iPhone: the shell opens Photos or Files itself. One tap on a photo picks it (no menu first, no Add
// button), and Files offers .tfc and .zip files (the browser's picker can't always tell .tfc apart)
async function pickIos(op, open, failed) {
  try {
    const got = await iosFiles().postMessage({ op });
    if (!got) return;                                          // cancelled
    const b = await (await fetch(got.url)).blob();
    open(new File([b], got.name, { type: b.type }));
  } catch { toast(failed); }
}
const pickIosPhoto = () => pickIos('pickPhoto', openImage, "Couldn't open that photo.");
const pickIosPack = () => pickIos('pickPack', importFile, "Couldn't open that file.");

// Files from outside the app (dropped on the window, "Open in" on iPhone, shared on Android):
// an image opens in the editor, a .tfc file in the import preview
const isPack = f => /\.(tfc|zip)$/i.test(f.name) || /zip/.test(f.type);
function receiveFile(f) {
  if (currentScreen === 'editor') return toast('Save or cancel this portrait first, then add the next one.');
  closeSheet();
  if (f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(f.name)) return openImage(f);
  // Android may share a .tfc file without its name's ending: anything typeless is tried as one
  if (isPack(f) || !f.type || f.type === 'application/octet-stream') return importFile(f);
  toast('Add an image, or a Totem Forge .tfc file.');
}

// Android "Share to Totem Forge": the service worker keeps the shared file and opens ?shared=1
async function takeShared() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const box = await caches.open('totemforge-shared'), res = await box.match('shared-file');
    if (!res) return;
    await box.delete('shared-file');
    const blob = await res.blob();
    receiveFile(new File([blob], decodeURIComponent(res.headers.get('X-File-Name') || 'shared'), { type: blob.type }));
    if (+res.headers.get('X-Count') > 1) setTimeout(() => toast('One file at a time: added the first one.'), 50);
  } catch { toast("Couldn't open the shared file."); }
}

// drag and drop (PC/Mac): an overlay while files are dragged over the window
let dragDepth = 0;
const draggingFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!draggingFiles(e)) return; e.preventDefault(); dragDepth++; $('dropZone').hidden = false; });
window.addEventListener('dragover', e => { if (draggingFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', () => { if (dragDepth && !--dragDepth) $('dropZone').hidden = true; });
window.addEventListener('drop', e => {
  if (!draggingFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('dropZone').hidden = true;
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  receiveFile(files[0]);
  if (files.length > 1) setTimeout(() => toast('One file at a time: added the first one.'), 50);
});

// ---------- start ----------
(async () => {
  try { store = iosFiles() ? await openIosStore() : await openStore(); }   // the iOS shell keeps the gallery in files
  catch { toast("This browser can't keep your gallery; it will be gone when you close the app."); }
  // Ask to keep the gallery even when the device runs low on space (Chrome grants it to installed apps)
  navigator.storage?.persist?.().catch(() => {});
  try {
    Object.assign(settings, await store.loadSettings() || {});
    const rows = await store.loadAll();
    portraits = (await Promise.all(rows.map(async ({ record, blob }) => {
      try { return { ...record, blob, img: await createImageBitmap(blob), thumb: null }; } catch { return null; }
    }))).filter(Boolean);
    portraits.forEach(updateThumb);
  } catch { toast("Couldn't load your gallery."); }
  show('gallery');
  renderInstall();
  folderStart().catch(() => {});
  // Offline use and installing (not in the iOS shell, which has the files built in)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  takeShared();
  // iPhone "Open in Totem Forge": the shell hands over files once the gallery is ready
  if (iosFiles()) {
    window.totemBridge = Object.assign(window.totemBridge || {}, {
      incoming: async ({ url, name }) => {
        try { const b = await (await fetch(url)).blob(); receiveFile(new File([b], name, { type: b.type })); }
        catch { toast("Couldn't open that file."); }
      }
    });
    iosFiles().postMessage({ op: 'ready' });
  }
})();
