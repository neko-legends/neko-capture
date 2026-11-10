// Clip editor: pick a start and an end on a recording, export just that part as a new MP4.
// Preview plays through the nc-media:// protocol (served by main, with byte ranges); the export
// reads the source through IPC and uses Mediabunny's Conversion with a trim range. Media is copied
// without re-encoding where key frames allow, and only re-encoded where needed for an exact cut.
import {
  Input, Output, Conversion, CustomSource, ALL_FORMATS, Mp4OutputFormat, StreamTarget,
} from '../../node_modules/mediabunny/dist/bundles/mediabunny.mjs';

import { ensureAac } from './aac.js';

const $ = (id) => document.getElementById(id);
const nc = window.nc;
const GAP = 0.1; // shortest clip, seconds
const sec = (s) => `${s.toFixed(2)} s`;
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const baseName = (f) => f.split(/[\\/]/).pop();
export const mediaUrl = (file) => `nc-media://file/?f=${encodeURIComponent(file)}`;

export class ClipEditor {
  /** @param {{onExported?: (r: {file: string, size: number}) => void}} hooks */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.rec = null;
    this.duration = 0;
    this.exporting = null; // the running Conversion
    this.v = $('ed-video');
    this.s = $('ed-start');
    this.e = $('ed-end');

    this.s.addEventListener('input', () => this.#slide(this.s));
    this.e.addEventListener('input', () => this.#slide(this.e));
    for (const el of [this.s, this.e]) {
      el.addEventListener('pointerdown', () => this.#raise(el));
      el.addEventListener('focus', () => this.#raise(el));
      el.addEventListener('change', () => this.#hideBubble());
      el.addEventListener('pointerup', () => this.#hideBubble());
      el.addEventListener('blur', () => this.#hideBubble());
    }
    this.v.addEventListener('timeupdate', () => this.#drawHead());
    this.v.addEventListener('click', () => this.#togglePlay());
    this.v.addEventListener('pause', () => ($('ed-play').textContent = '▶ Play clip'));
    this.v.addEventListener('play', () => ($('ed-play').textContent = '❚❚ Pause'));
    $('ed-play').onclick = () => this.#togglePlay();
    $('ed-export').onclick = () => (this.exporting ? this.#cancelExport() : this.#export());
    $('ed-close').onclick = () => this.close();
  }

  get start() { return +this.s.value; }
  get end() { return +this.e.value; }

  async open(rec) {
    if (this.exporting) { this.#status('Wait for the export to finish (or cancel it) first.', 'warn'); return; }
    this.close();
    this.rec = rec;
    $('editor').hidden = false;
    $('ed-name').textContent = baseName(rec.file);
    $('ed-name').title = rec.file;
    this.#status('Loading…');
    $('ed-export').disabled = $('ed-play').disabled = true;
    this.v.src = mediaUrl(rec.file);
    try {
      await new Promise((ok, fail) => {
        this.v.onloadedmetadata = ok;
        this.v.onerror = () => fail(new Error(this.v.error?.message || 'the video could not be loaded'));
      });
      let d = this.v.duration;
      if (!Number.isFinite(d) || d <= 0) d = await this.#probeDuration(rec.file);
      if (this.rec !== rec) return; // another recording was opened meanwhile
      this.duration = d;
    } catch (err) {
      if (this.rec === rec) this.#status(`Couldn’t open: ${err.message}`, 'err');
      return;
    }
    for (const el of [this.s, this.e]) { el.max = String(this.duration); el.step = '0.01'; }
    this.s.value = '0';
    this.e.value = String(this.duration);
    this.#raise(this.e);
    this.#draw();
    this.#status('Drag the two handles to choose where the clip starts and ends.');
    $('ed-export').disabled = $('ed-play').disabled = false;
    $('editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  close() {
    if (this.exporting) return;
    cancelAnimationFrame(this.raf);
    this.v.pause();
    this.v.removeAttribute('src');
    this.v.load();
    if (this.rec) nc.releaseFile(this.rec.file).catch(() => {});
    this.rec = null;
    $('editor').hidden = true;
  }

  pause() { this.v.pause(); }

  // ---------- slider ----------
  #slide(el) {
    if (el === this.s && this.start > this.end - GAP) this.s.value = String(Math.max(0, this.end - GAP));
    if (el === this.e && this.end < this.start + GAP) this.e.value = String(Math.min(this.duration, this.start + GAP));
    this.v.pause();
    this.v.currentTime = +el.value; // show the frame under the handle
    this.#draw();
    this.#showBubble(el);
  }
  #raise(el) { this.s.classList.toggle('top', el === this.s); this.e.classList.toggle('top', el === this.e); }
  #pct(t) { return this.duration ? Math.min(1, Math.max(0, t / this.duration)) : 0; }
  #draw() {
    const a = this.#pct(this.start), b = this.#pct(this.end);
    const sel = $('ed-sel');
    sel.style.left = `${a * 100}%`;
    sel.style.width = `${(b - a) * 100}%`;
    $('ed-start-t').textContent = sec(this.start);
    $('ed-end-t').textContent = sec(this.end);
    $('ed-len-t').textContent = `${sec(this.end - this.start)} of ${sec(this.duration)}`;
    this.#drawHead();
  }
  #drawHead() { $('ed-head').style.left = `${this.#pct(this.v.currentTime) * 100}%`; }
  #showBubble(el) {
    const b = $('ed-bubble');
    b.hidden = false;
    b.textContent = `${el === this.s ? 'Start' : 'End'} ${sec(+el.value)}`;
    b.style.left = `calc(8px + (100% - 16px) * ${this.#pct(+el.value)})`;
  }
  #hideBubble() { $('ed-bubble').hidden = true; }

  // ---------- preview ----------
  #togglePlay() {
    if (!this.rec || !this.duration) return;
    if (!this.v.paused) { this.v.pause(); return; }
    if (this.v.currentTime < this.start || this.v.currentTime >= this.end - 0.03) this.v.currentTime = this.start;
    this.v.play().catch(() => {});
    const watch = () => {
      if (this.v.paused) return;
      if (this.v.currentTime >= this.end) { this.v.pause(); this.v.currentTime = this.end; }
      this.#drawHead();
      this.raf = requestAnimationFrame(watch);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(watch);
  }

  // ---------- export ----------
  #input(file) {
    return new Input({
      formats: ALL_FORMATS,
      source: new CustomSource({
        getSize: () => nc.fileSize(file),
        read: (start, end) => nc.readFile(file, start, end),
        prefetchProfile: 'fileSystem',
        maxCacheSize: 32 * 1024 * 1024,
      }),
    });
  }
  async #probeDuration(file) {
    const input = this.#input(file);
    try { return await input.computeDuration(); } finally { input.dispose?.(); }
  }

  async #export() {
    const rec = this.rec;
    if (!rec || !this.duration) return;
    this.v.pause();
    const start = this.start, end = this.end;
    const whole = start <= 0.005 && end >= this.duration - 0.005;
    if (whole) { this.#status('Move a handle first — right now the clip is the whole recording.', 'warn'); return; }

    let out = null;
    let input = null;
    $('ed-export').textContent = 'Cancel';
    $('ed-export').classList.remove('primary');
    for (const el of [this.s, this.e, $('ed-play'), $('ed-close')]) el.disabled = true;
    this.#status(`Exporting ${sec(end - start)}…`);
    try {
      input = this.#input(rec.file);
      out = await nc.createFile('mp4', { like: rec.file });
      const fileId = out.id;
      const writable = new WritableStream({ write: (chunk) => nc.writeFile(fileId, chunk.data, chunk.position) });
      const output = new Output({ format: new Mp4OutputFormat(), target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }) });
      // Sound always leaves as AAC: a clip of an older recording (Opus) becomes postable on X.
      // AAC sources are still copied without re-encoding.
      const aac = await ensureAac();
      const conv = await Conversion.init({ input, output, trim: { start, end }, showWarnings: false, ...(aac ? { audio: { codec: 'aac' } } : {}) });
      if (!conv.isValid) throw new Error(conv.discardedTracks.map((t) => t.reason).join(', ') || 'nothing to export');
      this.exporting = conv;
      conv.onProgress = (p) => this.#status(`Exporting ${sec(end - start)}… ${Math.round(p * 100)}%`);
      await conv.execute();
      const closed = await nc.closeFile(fileId);
      out = null;
      this.#status(`Saved ${baseName(closed.file)} (${fmtSize(closed.size)}).`, 'ok');
      this.hooks.onExported?.({ ...closed, clip: true });
    } catch (err) {
      const cancelled = this.cancelled;
      this.#status(cancelled ? 'Export cancelled.' : `Export failed: ${err?.message ?? err}`, cancelled ? '' : 'err');
      if (out) await nc.closeFile(out.id, { discard: true }).catch(() => {});
    } finally {
      input?.dispose?.();
      nc.releaseFile(rec.file).catch(() => {});
      this.exporting = null;
      this.cancelled = false;
      $('ed-export').textContent = 'Export clip';
      $('ed-export').classList.add('primary');
      for (const el of [this.s, this.e, $('ed-play'), $('ed-close')]) el.disabled = false;
    }
  }
  async #cancelExport() {
    if (!this.exporting) return;
    this.cancelled = true;
    try { await this.exporting.cancel(); } catch { /* already done */ }
  }

  #status(text, kind = '') {
    const st = $('ed-status');
    st.className = `status ${kind || 'muted'}`;
    st.textContent = text;
  }
}
