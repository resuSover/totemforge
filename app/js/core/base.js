// © 2026 Totem Forge. All rights reserved.
// The summon flow over a MIDI transport: handshake and version check once per connection,
// then image → REFRESHING → OK. Errors come back as BaseError codes the screens explain.
import { textMessage, imageMessage, isOlder, MIN_FIRMWARE } from './protocol.js';

export class BaseError extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}
// Codes: no-base, blocked (MIDI permission denied), no-answer, old-firmware, unplugged,
// display (can't reach the totem's screen), failed (any other ERROR reply), replaced (a newer summon took over)

export class Base {
  /** transport: { open(): Promise<boolean>, send(bytes), onLine(fn), onGone(fn) } */
  constructor(transport) {
    this.t = transport;
    this.ready = false;            // handshake and version check done on this connection
    this.version = null;
    this.waiters = new Set();
    this.run = 0;                  // id of the latest summon
    transport.onLine(line => this.waiters.forEach(w => w.line(line)));
    transport.onGone(() => {
      this.ready = false;
      this.waiters.forEach(w => w.fail(new BaseError('unplugged')));
    });
  }

  /** Resolves with the first line that `match` accepts, or rejects after `ms`. */
  waitFor(match, ms, code = 'no-answer') {
    return new Promise((resolve, reject) => {
      const w = {
        line: l => { if (match(l)) { done(); resolve(l); } },
        fail: e => { done(); reject(e); }
      };
      const timer = setTimeout(() => w.fail(new BaseError(code)), ms);
      const done = () => { clearTimeout(timer); this.waiters.delete(w); };
      this.waiters.add(w);
    });
  }

  async connect() {
    if (this.ready) return;
    let found;
    try { found = await this.t.open(); }
    catch (e) { throw new BaseError(e && (e.name === 'SecurityError' || e.name === 'NotAllowedError') ? 'blocked' : 'no-base', e && e.message); }
    if (!found) throw new BaseError('no-base');
    this.t.send(textMessage('connect'));
    await this.waitFor(l => l.startsWith('CONNECTED:'), 2500);
    this.t.send(textMessage('version'));
    const v = await this.waitFor(l => l.startsWith('VERSION:') || l.startsWith("ERROR: Unknown command: 'version'"), 2000);
    this.version = v.startsWith('VERSION:') ? v.slice(8) : 'older than 2.0.0';
    if (isOlder(this.version, MIN_FIRMWARE)) throw new BaseError('old-firmware', this.version);
    this.ready = true;
  }

  /** Sends one packed image (4050 bytes). onStage('sending' | 'refreshing') reports progress. */
  async summon(image, onStage) {
    const run = ++this.run;
    // An earlier summon still waiting gives way: the base aborts its refresh for the new image
    this.waiters.forEach(w => w.fail(new BaseError('replaced')));
    await this.connect();
    if (run !== this.run) throw new BaseError('replaced');
    onStage('sending');
    this.t.send(imageMessage(image));
    await this.waitFor(l => l === 'REFRESHING' || l.startsWith('ERROR') || l.startsWith('BUSY'), 5000)
      .then(l => { if (l !== 'REFRESHING') throw replyError(l); });
    onStage('refreshing');
    const end = await this.waitFor(l => l === 'OK' || l.startsWith('ERROR'), 30000);
    if (end !== 'OK') throw replyError(end);
  }
}

function replyError(line) {
  if (/Display (disconnected|connection timeout)/.test(line)) return new BaseError('display', line);
  return new BaseError('failed', line);
}
