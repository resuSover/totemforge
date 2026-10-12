// © 2026 Totem Forge. All rights reserved.
// Saving files: the Save dialog in desktop Chrome/Edge, the share sheet in the iOS shell
// (window.webkit.messageHandlers.files), a download everywhere else.

export const iosFiles = () => window.webkit?.messageHandlers?.files;
export const hasSaveDialog = () => !iosFiles() && typeof window.showSaveFilePicker === 'function';

/** Asks where to save; resolves to a file handle, or null when cancelled. Call it straight from a tap. */
export async function pickSaveFile(name) {
  try {
    return await window.showSaveFilePicker({ suggestedName: name,
      types: [{ description: 'Totem Forge file', accept: { 'application/octet-stream': ['.tfc'] } }] });
  } catch (e) {
    if (e && e.name === 'AbortError') return null;
    throw e;
  }
}

export async function writeHandle(handle, blob) {
  const out = await handle.createWritable();
  await out.write(blob);
  await out.close();
}

/** Downloads the file (Android, other browsers). */
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));   // keeps the .tfc name
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

/** iOS shell: hands the file to the share sheet (Save to Files, AirDrop, …); resolves true when shared. */
export async function shareOnIos(blob, name) {
  const native = iosFiles(), CHUNK = 1 << 20;
  await native.postMessage({ op: 'begin' });
  for (let at = 0; at < blob.size; at += CHUNK) {
    await native.postMessage({ op: 'chunk', data: await base64(blob.slice(at, at + CHUNK)) });
  }
  return !!(await native.postMessage({ op: 'share', name }));
}

const base64 = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result.slice(r.result.indexOf(',') + 1));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
