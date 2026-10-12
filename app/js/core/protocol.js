// © 2026 Totem Forge. All rights reserved.
// Talking to the base, firmware 2.0.0 or later: SysEx messages with manufacturer ID 0x7D.
// Reference: docs/phone-app-protocol.md in the firmware repo (RP2040-Zero-MiniToo).

export const MIN_FIRMWARE = '2.0.0';
const MFR = 0x7D, TEXT = 0x01, IMAGE = 0x02, REPLY = 0x03;

// Firmware 2-bit codes for the inks in our index order black, white, yellow, red
const CODES = [3, 0, 1, 2];
const W = 88, H = 184, PIXEL_BYTES = W * H / 4;

export const textMessage = cmd => [0xF0, MFR, TEXT, ...Array.from(cmd, c => c.charCodeAt(0) & 0x7F), 0xF7];
export const imageMessage = image => [0xF0, MFR, IMAGE, ...pack7(image), 0xF7];

/** The reply line in a complete SysEx message from the base, or null for anything else. */
export function replyLine(data) {
  if (data.length < 4 || data[0] !== 0xF0 || data[1] !== MFR || data[2] !== REPLY) return null;
  const end = data[data.length - 1] === 0xF7 ? data.length - 1 : data.length;
  return String.fromCharCode(...data.slice(3, end)).trim();
}

/** 4048 pixel bytes (4 pixels per byte, first pixel in the top bits) + big-endian CRC16. */
export function packImage(index) {
  const out = new Uint8Array(PIXEL_BYTES + 2);
  for (let i = 0; i < W * H; i++) out[i >> 2] |= CODES[index[i]] << (6 - 2 * (i & 3));
  const crc = crc16(out.subarray(0, PIXEL_BYTES));
  out[PIXEL_BYTES] = crc >> 8;
  out[PIXEL_BYTES + 1] = crc & 0xFF;
  return out;
}

/** SysEx data bytes are 7-bit: per group of up to 7 bytes, one byte of their top bits
 *  (bit i = bit 7 of byte i), then the bytes with bit 7 cleared. */
export function pack7(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i += 7) {
    const n = Math.min(7, raw.length - i);
    let msbs = 0;
    for (let j = 0; j < n; j++) msbs |= (raw[i + j] >> 7) << j;
    out.push(msbs);
    for (let j = 0; j < n; j++) out.push(raw[i + j] & 0x7F);
  }
  return out;
}

/** CRC-CCITT, poly 0x1021, init 0xFFFF, as in the firmware. */
export function crc16(data) {
  let crc = 0xFFFF;
  for (const b of data) {
    crc ^= b << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

/** True if version a ("2.0.0", "2.0.0-3-gabc") is older than b. Anything unparseable counts as older. */
export function isOlder(a, b) {
  const parse = v => (/^(\d+)\.(\d+)\.(\d+)/.exec(v || '') || []).slice(1).map(Number);
  const x = parse(a), y = parse(b);
  if (y.length < 3) return false;
  if (x.length < 3) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
