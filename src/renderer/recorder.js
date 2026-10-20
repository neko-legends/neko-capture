// Recording: MediaStream (tab capture of the stage, or an app window) → WebCodecs encoders → MP4 on disk.
import {
  Output, Mp4OutputFormat, StreamTarget, MediaStreamVideoTrackSource, MediaStreamAudioTrackSource,
  getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
  QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH,
} from '../../node_modules/mediabunny/dist/bundles/mediabunny.mjs';

const QUALITY = { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, veryhigh: QUALITY_VERY_HIGH };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

async function frameSize(_stream, track) {
  const v = document.createElement('video');
  v.muted = true;
  v.srcObject = new MediaStream([track]);
  try {
    await Promise.race([
      new Promise((r) => (v.onresize = () => v.videoWidth && r())),
      v.play().then(() => new Promise((r) => { const f = () => (v.videoWidth ? r() : requestAnimationFrame(f)); f(); })),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  } catch { /* fall through to settings */ }
  const s = track.getSettings();
  const out = { width: v.videoWidth || s.width || 1280, height: v.videoHeight || s.height || 720 };
  v.srcObject = null;
  return out;
}

export class Recorder {
  /** @param {{onStop?: (result: {file?: string, size?: number, error?: string}) => void}} hooks */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.state = 'idle'; // idle | starting | recording | stopping
    this.bytes = 0;
  }

  /**
   * @param {{kind: 'stage'|'window', sourceId?: string, fps: number, quality: string, audio?: boolean}} opts
   * @returns {Promise<{stream: MediaStream, file: string, video: string, audio: string|null, width: number, height: number}>}
   */
  async start(opts) {
    if (this.state !== 'idle') throw new Error('Already recording');
    this.state = 'starting';
    this.bytes = 0;
    try {
      const prep = await window.nc.prepareCapture({ kind: opts.kind, sourceId: opts.sourceId, audio: opts.audio });
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: opts.fps, max: opts.fps } },
        audio: prep.audio,
      });
      const vTrack = this.stream.getVideoTracks()[0];
      const aTrack = this.stream.getAudioTracks()[0] ?? null;
      if (!vTrack) throw new Error('No video from the capture source');
      vTrack.contentHint = 'motion';

      // getSettings() can report the screen size before the first frame; the first real frame is the truth.
      const { width, height } = await frameSize(this.stream, vTrack);
      const quality = QUALITY[opts.quality] ?? QUALITY_HIGH;
      const vCodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: even(width), height: even(height), quality });
      if (!vCodec) throw new Error('No usable video encoder on this machine');
      const aCodec = aTrack ? await getFirstEncodableAudioCodec(['aac', 'opus']) : null;

      this.file = await window.nc.createFile('mp4');
      const fileId = this.file.id;
      const writable = new WritableStream({
        write: async (chunk) => { await window.nc.writeFile(fileId, chunk.data, chunk.position); this.bytes = Math.max(this.bytes, chunk.position + chunk.data.byteLength); },
      });

      this.output = new Output({ format: new Mp4OutputFormat(), target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }) });
      const videoConfig = {
        codec: vCodec, quality, keyFrameInterval: 2, latencyMode: 'quality',
        // A captured window can be resized mid-recording: keep the first size and letterbox.
        sizeChangeBehavior: 'contain',
      };
      if (width % 2 || height % 2) videoConfig.transform = { width: even(width), height: even(height) };
      this.videoSource = new MediaStreamVideoTrackSource(vTrack, videoConfig, { frameRate: opts.fps });
      this.output.addVideoTrack(this.videoSource, { frameRate: opts.fps });
      if (aTrack && aCodec) {
        this.audioSource = new MediaStreamAudioTrackSource(aTrack, { codec: aCodec, quality: QUALITY_HIGH });
        this.output.addAudioTrack(this.audioSource);
      }

      // Closing the captured window (or the stage) ends the track → stop and keep what we have.
      vTrack.addEventListener('ended', () => { if (this.state === 'recording') this.stop(); });
      const fail = (e) => { if (this.state === 'recording') this.stop(String(e?.message ?? e)); };
      this.videoSource.errorPromise.catch(fail);
      this.audioSource?.errorPromise.catch(fail);

      await this.output.start();
      this.startedAt = performance.now();
      this.state = 'recording';
      return { stream: this.stream, file: this.file.file, video: vCodec, audio: aTrack && aCodec ? aCodec : null, width: even(width), height: even(height) };
    } catch (e) {
      await this.#cleanup(true);
      throw e;
    }
  }

  get elapsed() { return this.state === 'recording' ? (performance.now() - this.startedAt) / 1000 : 0; }

  async stop(error) {
    if (this.state !== 'recording') return;
    this.state = 'stopping';
    let result;
    try {
      await this.output.finalize();
      const closed = await window.nc.closeFile(this.file.id);
      result = { ...closed, error };
    } catch (e) {
      result = { file: this.file?.file, error: String(e?.message ?? e) };
    }
    await this.#cleanup(false);
    this.hooks.onStop?.(result);
    return result;
  }

  async #cleanup(discardFile) {
    this.stream?.getTracks().forEach((t) => t.stop());
    if (discardFile) {
      try { await this.output?.cancel(); } catch { /* not started */ }
      if (this.file) { try { await window.nc.closeFile(this.file.id, { discard: true }); } catch { /* already closed */ } }
    }
    this.stream = this.output = this.videoSource = this.audioSource = this.file = null;
    this.state = 'idle';
  }
}
