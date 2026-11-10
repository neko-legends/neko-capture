import { Recorder } from './recorder.js';
import { ClipEditor } from './editor.js';

const $ = (id) => document.getElementById(id);
const nc = window.nc;
const cfg = await nc.getSettings();

const PRESETS = [['1080p', 1920, 1080], ['720p', 1280, 720], ['1440p', 2560, 1440], ['4K', 3840, 2160], ['Vertical', 1080, 1920], ['Square', 1080, 1080], ['Square', 1024, 1024]];
let mode = cfg.mode;
let picked = null; // {id, name}
let stageOpen = false;
let stageSize = null; // the size the open stage was asked for

// ---------- init fields ----------
$('url').value = cfg.url;
$('w').value = cfg.width;
$('h').value = cfg.height;
$('borderless').checked = cfg.borderless;
$('fps').value = String(cfg.fps);
$('quality').value = cfg.quality;
$('outdir').textContent = cfg.outDir;
$('outdir').title = cfg.outDir;
$('hotkey').textContent = cfg.hotkey.replace('CommandOrControl', cfg.platform === 'darwin' ? 'Cmd' : 'Ctrl');
if (!cfg.hotkeyVia) { // no global hotkey here: say how to get one instead of advertising a dead key
  $('hotkey').hidden = true;
  $('rec').title = 'To start/stop from anywhere, bind a key in your window manager to: neko-capture --toggle-record';
}
if (cfg.platform !== 'win32') $('sysaudio-wrap').hidden = true;
if (cfg.wayland) $('pick').textContent = 'Choose window (system picker)…';
if (cfg.wayland) { // the picker is the desktop's, and on Omarchy it opens on whole screens
  $('picked').textContent = 'The system picker opens. To record one window, click its “Windows” tab first: the “Outputs” tab records a whole screen.';
}

const save = (patch) => nc.setSettings(patch);
const size = () => ({ width: Math.max(64, Math.round(+$('w').value / 2) * 2 || 1920), height: Math.max(64, Math.round(+$('h').value / 2) * 2 || 1080) });

// ---------- tabs ----------
function setMode(m) {
  mode = m;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  $('panel-stage').hidden = m !== 'stage';
  $('panel-window').hidden = m !== 'window';
  save({ mode: m });
  updateRecButton();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---------- stage ----------
function renderPresets() {
  const { width, height } = size();
  $('presets').replaceChildren(...PRESETS.map(([name, w, h]) => {
    const b = document.createElement('button');
    b.textContent = `${name} ${w}×${h}`;
    b.className = w === width && h === height ? 'on' : '';
    b.onclick = () => { $('w').value = w; $('h').value = h; onSizeChange(); };
    return b;
  }));
}
function onSizeChange() {
  renderPresets();
  save(size());
  if (stageOpen) openStage();
}
$('w').addEventListener('change', onSizeChange);
$('h').addEventListener('change', onSizeChange);
$('borderless').addEventListener('change', () => { save({ borderless: $('borderless').checked }); if (stageOpen) openStage(); });

function normUrl(u) {
  u = u.trim();
  if (!u) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return (/^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/.test(u) ? 'http://' : 'https://') + u;
}
function openStage() {
  const url = normUrl($('url').value);
  if (!url) { $('url').focus(); return; }
  $('url').value = url;
  save({ url, ...size(), borderless: $('borderless').checked });
  nc.openStage({ url, ...size(), borderless: $('borderless').checked });
}
$('open').onclick = openStage;
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') openStage(); });
$('reload').onclick = () => nc.reloadStage();
$('devtools').onclick = () => nc.stageDevtools();
$('focus').onclick = () => nc.focusStage();

nc.onStageInfo((info) => {
  stageOpen = info.open;
  stageSize = info.open && info.wanted ? { width: info.wanted[0], height: info.wanted[1] } : null;
  for (const id of ['reload', 'devtools', 'focus']) $(id).disabled = !info.open;
  const st = $('stage-status');
  if (!info.open) { st.className = 'status muted'; st.textContent = 'Stage not open.'; $('wm-tip').hidden = true; }
  else if (info.ok) { st.className = 'status ok'; st.textContent = `Stage page is ${info.width}×${info.height}. Click into it to play.`; $('wm-tip').hidden = true; }
  else {
    st.className = 'status warn';
    st.textContent = `Stage page is ${info.width}×${info.height}, not ${info.wanted[0]}×${info.wanted[1]}. The recording will be letterboxed.`;
    const tip = $('wm-tip');
    tip.hidden = false;
    if (cfg.platform === 'linux') {
      tip.innerHTML = 'Your window manager resized the stage. On Hyprland, let it float — add to <b>~/.config/hypr/hyprland.conf</b> (syntax for older Hyprland: <i>windowrulev2 = float, title:…</i>):';
      const code = document.createElement('code');
      code.textContent = `windowrule = float on, match:title ^(${cfg.stageTitle})$`;
      tip.append(code);
    } else {
      tip.textContent = 'The stage didn’t fit on your screen. Try “borderless”, a smaller size, or lower Windows display scaling.';
    }
  }
  updateRecButton();
});
nc.onStageError((msg) => { const st = $('stage-status'); st.className = 'status err'; st.textContent = `Couldn’t load: ${msg}`; });

// ---------- window picker ----------
$('pick').onclick = async () => {
  $('pick').disabled = true;
  try {
    const list = await nc.listSources();
    if (list.length === 1 && cfg.platform === 'linux') { choose(list[0]); $('sources').replaceChildren(); return; }
    $('sources').replaceChildren(...list.map((s) => {
      const b = document.createElement('button');
      if (picked?.id === s.id) b.className = 'on';
      const img = document.createElement('img'); img.className = 'thumb'; img.src = s.thumb || ''; img.alt = '';
      const name = document.createElement('div'); name.className = 'name'; name.title = s.name;
      if (s.icon) { const ic = document.createElement('img'); ic.src = s.icon; ic.alt = ''; name.append(ic); }
      name.append(s.kind === 'screen' ? `🖥 ${s.name}` : s.name);
      b.append(img, name);
      b.onclick = () => { choose(s); document.querySelectorAll('.sources button').forEach((x) => x.classList.toggle('on', x === b)); };
      return b;
    }));
    if (!list.length) $('picked').textContent = 'No windows found (picker cancelled?).';
  } catch (e) {
    $('picked').textContent = `Couldn’t list windows: ${e.message}`;
  } finally { $('pick').disabled = false; }
};
function choose(s) {
  picked = { id: s.id, name: s.name };
  $('picked').className = 'status ok';
  $('picked').textContent = s.name;
  updateRecButton();
}

// ---------- output ----------
$('fps').onchange = () => save({ fps: +$('fps').value });
$('quality').onchange = () => save({ quality: $('quality').value });
$('choose-dir').onclick = async () => { const d = await nc.chooseDir(); $('outdir').textContent = d; $('outdir').title = d; };
$('open-dir').onclick = () => nc.openDir();

// ---------- recording ----------
const recent = [];
const rec = new Recorder({ onStop: (r) => finished(r) });
const editor = new ClipEditor({ onExported: (r) => { recent.unshift(r); renderRecent(); } });
let tick = null;

const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);

function canRecord() { return mode === 'stage' ? stageOpen : !!picked; }
function updateRecButton() {
  const on = rec.state === 'recording';
  $('rec').classList.toggle('on', on);
  $('rec').disabled = rec.state === 'starting' || rec.state === 'stopping' || (!on && !canRecord());
  $('rec-label').textContent = on ? `Stop  ${fmtTime(rec.elapsed)} · ${fmtSize(rec.bytes)}` : rec.state === 'stopping' ? 'Saving…' : 'Record';
  $('pill').textContent = on ? 'REC' : rec.state === 'idle' ? 'idle' : rec.state;
  $('pill').classList.toggle('rec', on);
  document.querySelectorAll('.tabs button').forEach((b) => (b.disabled = rec.state !== 'idle'));
  if (!on && rec.state === 'idle' && !canRecord() && !$('rec-info').dataset.keep) {
    $('rec-info').textContent = mode === 'stage' ? 'Open a URL to record it.' : 'Choose a window to record it.';
  }
}

async function startRecording() {
  if (rec.state !== 'idle' || !canRecord()) return;
  delete $('rec-info').dataset.keep;
  editor.pause();
  $('rec-info').className = 'status muted';
  $('rec-info').textContent = 'Starting…';
  const p = rec.start({ kind: mode, sourceId: picked?.id, size: mode === 'stage' ? (stageSize ?? size()) : null, fps: +$('fps').value, quality: $('quality').value, audio: $('sysaudio').checked });
  updateRecButton();
  try {
    const r = await p;
    const scaled = r.captured.width !== r.width || r.captured.height !== r.height ? ` (scaled from ${r.captured.width}×${r.captured.height})` : '';
    $('rec-info').textContent = `${r.width}×${r.height}${scaled} @ ${$('fps').value} fps · ${r.video.toUpperCase()}${r.audio ? ` + ${r.audio.toUpperCase()}` : r.audioError ? ` · no sound (${r.audioError})` : ' · no sound'}`;
    if (r.audioError) $('rec-info').className = 'status warn';
    const v = $('preview');
    // While a page is being recorded Chromium stops playing its sound on the speakers (it goes to the
    // recording instead), so the preview plays it. A window recording's sound is already audible: keep that muted.
    v.muted = !(mode === 'stage' && r.audio);
    v.srcObject = r.stream; v.hidden = false; v.play().catch(() => {});
    tick = setInterval(updateRecButton, 250);
    if (mode === 'stage') nc.focusStage(); // straight back to the game
  } catch (e) {
    $('rec-info').className = 'status err';
    $('rec-info').dataset.keep = '1';
    $('rec-info').textContent = `Couldn’t start: ${e.message}`;
  }
  updateRecButton();
}
async function stopRecording() { if (rec.state === 'recording') { const p = rec.stop(); updateRecButton(); await p; } }
function finished(r) {
  clearInterval(tick);
  const v = $('preview'); v.srcObject = null; v.hidden = true;
  $('rec-info').dataset.keep = '1';
  if (r.file && r.size) {
    $('rec-info').className = r.error ? 'status warn' : 'status ok';
    $('rec-info').textContent = `${r.error ? `Stopped (${r.error}). ` : ''}Saved ${fmtSize(r.size)}.`;
    recent.unshift(r);
    renderRecent();
    if (!SMOKE_RUN) editor.open(r); // straight into trimming
  } else {
    $('rec-info').className = 'status err';
    $('rec-info').textContent = `Recording failed: ${r.error ?? 'unknown error'}`;
  }
  updateRecButton();
  window.__lastResult = r;
}
function renderRecent() {
  $('recent').replaceChildren(...recent.slice(0, 8).map((r) => {
    const li = document.createElement('li');
    const n = document.createElement('span'); n.className = 'n'; n.textContent = r.file.split(/[\\/]/).pop(); n.title = r.file;
    const sz = document.createElement('span'); sz.className = 'muted'; sz.textContent = fmtSize(r.size);
    const play = document.createElement('button'); play.textContent = 'Play'; play.onclick = () => nc.playFile(r.file);
    const show = document.createElement('button'); show.textContent = 'Show'; show.onclick = () => nc.showFile(r.file);
    const edit = document.createElement('button'); edit.textContent = 'Edit'; edit.title = 'Trim and export a clip'; edit.onclick = () => editor.open(r);
    const del = document.createElement('button'); del.textContent = 'Delete'; del.className = 'danger'; del.title = 'Delete this recording (moves it to the trash)';
    del.onclick = async () => {
      del.disabled = true;
      if (editor.rec?.file === r.file) editor.close(); // lets go of the file first
      try {
        const { trashed } = await nc.deleteFile(r.file);
        recent.splice(recent.indexOf(r), 1);
        renderRecent();
        $('rec-info').className = 'status muted'; $('rec-info').dataset.keep = '1';
        $('rec-info').textContent = trashed ? 'Moved to the trash.' : 'Deleted.';
      } catch (e) {
        del.disabled = false;
        $('rec-info').className = 'status err'; $('rec-info').dataset.keep = '1';
        $('rec-info').textContent = `Couldn’t delete: ${e.message}`;
      }
    };
    li.append(n, sz, play, show, edit, del);
    return li;
  }));
}
$('rec').onclick = () => (rec.state === 'recording' ? stopRecording() : startRecording());
nc.onRecordToggle(() => (rec.state === 'recording' ? stopRecording() : startRecording()));
window.addEventListener('beforeunload', () => { if (rec.state === 'recording') rec.stop(); });

// ---------- smoke test hook (npm run smoke) ----------
let SMOKE_RUN = false;
window.__smoke = async (kind = 'stage', repeat = false) => {
  SMOKE_RUN = true;
  if (kind === 'window') {
    const list = await nc.listSources();
    const s = list.find((x) => x.name === cfg.stageTitle) ?? list.find((x) => x.kind === 'screen');
    if (!s) return nc.smokeDone({ error: 'no source: ' + list.map((x) => x.name).join(', ') });
    choose(s);
  }
  setMode(kind);
  await startRecording();
  if (rec.state !== 'recording') return nc.smokeDone({ error: $('rec-info').textContent });
  const info = $('rec-info').textContent;
  await new Promise((r) => setTimeout(r, 3000));
  await stopRecording();
  if (repeat) { // a second recording in the same session
    const first = window.__lastResult;
    await new Promise((r) => setTimeout(r, 1500));
    await startRecording();
    if (rec.state !== 'recording') return nc.smokeDone({ ...first, second: { error: $('rec-info').textContent } });
    await new Promise((r) => setTimeout(r, 3000));
    await stopRecording();
    return nc.smokeDone({ ...first, info, second: window.__lastResult });
  }
  nc.smokeDone({ ...window.__lastResult, info });
};

renderPresets();
setMode(mode);
