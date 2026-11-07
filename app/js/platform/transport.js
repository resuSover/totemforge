// © 2026 Totem Forge. All rights reserved.
// MIDI transports: Web MIDI in Chrome/Edge (desktop and Android), the native bridge in the iOS shell.
// Each one: { kind, permission(), open(), send(bytes), onLine(fn), onGone(fn) }
import { replyLine } from '../core/protocol.js';

// The base's MIDI port: "TotemForge_Base" on macOS; on Windows "PicoMIDI" (its MIDI interface) up to firmware 2.0.1
const isBase = port => /totemforge|picomidi/i.test(`${port.name} ${port.manufacturer}`);

export function webMidiTransport() {
  let access = null, input = null, output = null, lineFn = () => {}, goneFn = () => {};
  return {
    kind: 'webmidi',
    async permission() {             // 'granted' | 'prompt' | 'denied'
      try { return (await navigator.permissions.query({ name: 'midi', sysex: true })).state; } catch { return 'prompt'; }
    },
    async open() {
      access = access || await navigator.requestMIDIAccess({ sysex: true });
      if (input && input.state === 'connected' && output && output.state === 'connected') return true;
      input = [...access.inputs.values()].find(isBase);
      output = [...access.outputs.values()].find(isBase);
      if (!input || !output) return false;
      input.onmidimessage = e => { const l = replyLine(e.data); if (l) lineFn(l); };
      access.onstatechange = e => {
        if ((e.port === input || e.port === output) && e.port.state === 'disconnected') { input = output = null; goneFn(); }
      };
      return true;
    },
    send(bytes) { output.send(bytes); },
    onLine(fn) { lineFn = fn; },
    onGone(fn) { goneFn = fn; }
  };
}

// The iOS shell exposes window.webkit.messageHandlers.midi (CoreMIDI) and calls
// window.totemBridge.line(text) / .gone() when the base answers or disappears.
export function iosTransport() {
  const native = window.webkit.messageHandlers.midi;
  let lineFn = () => {}, goneFn = () => {};
  window.totemBridge = { line: l => lineFn(l), gone: () => goneFn() };
  return {
    kind: 'ios',
    async permission() { return 'granted'; },
    async open() { return !!(await native.postMessage({ op: 'open' })); },
    send(bytes) { native.postMessage({ op: 'send', bytes: Array.from(bytes) }); },
    onLine(fn) { lineFn = fn; },
    onGone(fn) { goneFn = fn; }
  };
}

export function pickTransport() {
  if (window.webkit?.messageHandlers?.midi) return iosTransport();
  if (navigator.requestMIDIAccess) return webMidiTransport();
  return null;
}
