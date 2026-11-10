// AAC sound for every MP4 this app writes. X, Instagram, iMessage and most editors refuse Opus in
// an MP4, and Electron on Linux has no AAC encoder of its own, so one is bundled (FFmpeg's AAC-LC
// encoder as WASM, from @mediabunny/aac-encoder) and used wherever the platform lacks a native one.
import { canEncodeAudio } from '../../node_modules/mediabunny/dist/bundles/mediabunny.mjs';
import { registerAacEncoder } from '../../node_modules/@mediabunny/aac-encoder/dist/bundles/mediabunny-aac-encoder.mjs';

let ready = null;

/** Resolves to true when AAC can be encoded (natively, or with the bundled encoder). */
export function ensureAac() {
  ready ??= (async () => {
    try {
      if (await canEncodeAudio('aac')) return true;
      registerAacEncoder();
      return await canEncodeAudio('aac');
    } catch (e) {
      console.warn('AAC encoder unavailable:', e);
      return false;
    }
  })();
  return ready;
}
