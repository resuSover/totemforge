// © 2026 Totem Forge. All rights reserved.
// A simulated base for the prototype controls (?proto in the address): it answers like the real
// firmware, so the screens run exactly the same code as with real hardware.
import { replyLine } from '../core/protocol.js';

export function fakeBaseTransport(sim) {
  // sim: { platform, base, firmware, fast, fail, midiAllowed } — changed live by the prototype controls
  let lineFn = () => {}, goneFn = () => {}, refresh = null;
  const say = (l, ms = 40) => setTimeout(() => lineFn(l), ms);
  return {
    kind: 'fake',
    async permission() { return sim.platform === 'iphone' || sim.midiAllowed ? 'granted' : sim.fail === 'blocked' ? 'denied' : 'prompt'; },
    async open() {
      if (sim.fail === 'blocked') { sim.fail = 'none'; const e = new Error('blocked'); e.name = 'NotAllowedError'; throw e; }
      sim.midiAllowed = true;
      return sim.base;
    },
    send(bytes) {
      const text = bytes[2] === 0x01 ? replyLine([0xF0, 0x7D, 0x03, ...bytes.slice(3)]) : null;
      if (text === 'connect') return say('CONNECTED:2');
      if (text === 'version') return say(sim.firmware === '1.0' ? "ERROR: Unknown command: 'version'. Type 'help' for the command list." : 'VERSION:2.0.0');
      if (bytes[2] !== 0x02) return;
      clearTimeout(refresh);                       // a new image aborts the refresh in progress
      const fail = sim.fail; sim.fail = 'none';     // a simulated failure happens once
      if (fail === 'unplugged') return setTimeout(goneFn, 300);
      say('REFRESHING', 600);
      if (fail === 'display') return say('ERROR: Display disconnected!', 1000);
      if (fail === 'timeout') return;              // never answers
      refresh = setTimeout(() => lineFn('OK'), 600 + (sim.fast ? 3000 : 13000));
    },
    onLine(fn) { lineFn = fn; },
    onGone(fn) { goneFn = fn; }
  };
}
