// neko-capture: main process.
// Two capture modes:
//   stage  — a real browser window showing a URL at an exact pixel size. You interact with it directly
//            (real keyboard focus, real <select> popups), and it is recorded via tab capture, so window
//            frames, overlapping windows or the window being half off-screen never end up in the video.
//   window — any app window (or a whole screen) via the OS capture API; on Wayland the desktop portal picker.
// Recording itself happens in the control window (WebCodecs + Mediabunny → MP4); main only hands it the
// stream source and writes the bytes to disk.

import { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, shell, dialog, globalShortcut, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes('--smoke');
const STAGE_TITLE = 'neko-capture stage';
const HOTKEY = 'CommandOrControl+Alt+R';

// ---------- Chromium switches (must be set before ready) ----------
const features = [];
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto'); // native Wayland on Hyprland/Omarchy
  features.push('WebRTCPipeWireCapturer', 'GlobalShortcutsPortal');
}
if (features.length) app.commandLine.appendSwitch('enable-features', features.join(','));
// A game in the stage must keep running at full speed while you look at the control window,
// and a covered window must keep painting (Windows pauses occluded windows otherwise).
// Tab capture must not re-render the stage at the monitor's scaling (we want exactly W×H).
app.commandLine.appendSwitch('disable-features', 'WebContentsCaptureHiDPI');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// nc-media://file/?f=<path> lets the clip editor's <video> play a recording (with seeking) without
// opening up file:// access. Only files this session recorded or exported are served.
protocol.registerSchemesAsPrivileged([{ scheme: 'nc-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

// ---------- settings ----------
const DEFAULTS = {
  url: 'https://nekolegends.com/res/projects/purplePlanet/',
  width: 1920,
  height: 1080,
  borderless: false,
  fps: 60,
  quality: 'high',
  outDir: '',
  mode: 'stage',
};
const SMOKE_DIR = () => path.join(app.getPath('temp'), 'neko-capture-smoke');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { ...DEFAULTS };
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch { /* first run */ }
  // Earlier self-test runs saved their temporary folder as the "Save to" folder: undo that.
  if (settings.outDir && path.resolve(settings.outDir) === SMOKE_DIR()) settings.outDir = '';
  if (!settings.outDir) settings.outDir = path.join(app.getPath('videos'), 'neko-capture');
}
function saveSettings() {
  if (SMOKE) return; // the self-test uses its own folder and size: never write those into the real settings
  try { fs.mkdirSync(path.dirname(settingsPath()), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); } catch (e) { console.error('settings save failed', e); }
}

// ---------- windows ----------
let control = null;
let stage = null;
let stageOpts = null;
const send = (ch, ...a) => { if (control && !control.isDestroyed()) control.webContents.send(ch, ...a); };

// Tiling Wayland compositors (Hyprland on Omarchy, Sway, niri, river) draw no title bar, so there is nothing to
// grab. There the control window is frameless and its header is the drag handle (-webkit-app-region in
// control.css only works in a frameless window). Desktops with real title bars keep theirs.
const NO_TITLEBAR_WM = process.platform === 'linux'
  && (!!process.env.HYPRLAND_INSTANCE_SIGNATURE || /hyprland|sway|niri|river/i.test(process.env.XDG_CURRENT_DESKTOP ?? ''));

function createControl() {
  control = new BrowserWindow({
    width: 460, height: 820, minWidth: 400, minHeight: 560, frame: !NO_TITLEBAR_WM,
    title: 'neko-capture', backgroundColor: '#17141c', autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), backgroundThrottling: false },
  });
  control.removeMenu();
  control.loadFile(path.join(here, 'renderer', 'control.html'));
  control.on('closed', () => { control = null; if (stage && !stage.isDestroyed()) stage.close(); });
}

/** Make the page inside the stage exactly width×height *device* pixels with devicePixelRatio 1,
 *  whatever the monitor's scaling is: window content = size/scale DIPs, page zoom = 1/scale. */
function stageScale() {
  const b = stage && !stage.isDestroyed() ? stage.getBounds() : null;
  const d = b ? screen.getDisplayMatching(b) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return d.scaleFactor || 1;
}
function applyStageSize() {
  if (!stage || stage.isDestroyed() || !stageOpts) return;
  const s = stageScale();
  stage.setContentSize(Math.round(stageOpts.width / s), Math.round(stageOpts.height / s));
  stage.webContents.setZoomFactor(1 / s);
}

async function reportStage() {
  if (!stage || stage.isDestroyed() || stage.webContents.isLoading()) return;
  try {
    const [w, h, dpr] = await stage.webContents.executeJavaScript('[innerWidth, innerHeight, devicePixelRatio]', true);
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    send('stage:info', { open: true, url: stage.webContents.getURL(), width: pw, height: ph, wanted: [stageOpts.width, stageOpts.height],
      ok: Math.abs(pw - stageOpts.width) <= 1 && Math.abs(ph - stageOpts.height) <= 1 });
  } catch { /* page navigating */ }
}

function openStage(opts) {
  const recreate = !stage || stage.isDestroyed() || (stageOpts && stageOpts.borderless !== opts.borderless);
  stageOpts = { ...opts };
  if (recreate) {
    if (stage && !stage.isDestroyed()) stage.destroy();
    const s = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor || 1;
    stage = new BrowserWindow({
      width: Math.round(opts.width / s), height: Math.round(opts.height / s), useContentSize: true,
      frame: !opts.borderless, resizable: false, maximizable: false, fullscreenable: false,
      title: STAGE_TITLE, backgroundColor: '#000000', show: false, autoHideMenuBar: true,
      enableLargerThanScreen: true,
      webPreferences: { partition: 'persist:stage', backgroundThrottling: false, zoomFactor: 1 / s },
    });
    stage.removeMenu();
    stage.on('page-title-updated', (e) => e.preventDefault()); // fixed title → window-manager rules keep matching
    stage.webContents.setVisualZoomLevelLimits(1, 1);
    stage.webContents.setWindowOpenHandler(({ url }) => { stage.loadURL(url); return { action: 'deny' }; });
    const wc = stage.webContents;
    wc.on('zoom-changed', () => applyStageSize());
    wc.on('did-navigate', () => applyStageSize());
    wc.on('did-navigate-in-page', () => reportStage());
    wc.on('did-finish-load', () => { applyStageSize(); setTimeout(reportStage, 150); });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => { if (isMain && code !== -3) send('stage:error', `${desc} (${url})`); });
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F5') { wc.reload(); e.preventDefault(); }
      else if (input.key === 'F12') { wc.toggleDevTools(); e.preventDefault(); }
    });
    stage.on('resize', () => setTimeout(reportStage, 50));
    stage.on('moved', () => applyStageSize()); // dragged to a monitor with different scaling
    stage.on('closed', () => { stage = null; send('stage:info', { open: false }); });
    stage.once('ready-to-show', () => stage.show());
  }
  applyStageSize();
  stage.loadURL(opts.url).catch(() => { /* reported via did-fail-load */ });
  if (!recreate) stage.show();
}

// ---------- capture plumbing ----------
let pendingCapture = null; // set right before the control window calls getDisplayMedia

function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const p = pendingCapture;
    pendingCapture = null;
    // The stage lives in its own session, so only the control window can reach this handler.
    if (!p) return callback({});
    if (p.kind === 'stage') {
      if (!stage || stage.isDestroyed()) return callback({});
      const frame = stage.webContents.mainFrame;
      return callback(p.audio ? { video: frame, audio: frame } : { video: frame });
    }
    const streams = { video: p.source };
    if (p.audio) streams.audio = 'loopback';
    callback(streams);
  });
}

let sourceCache = new Map();
async function listSources() {
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
  sourceCache = new Map(sources.map((s) => [s.id, s]));
  const own = control ? control.getMediaSourceId() : '';
  return sources.filter((s) => s.id !== own).map((s) => ({
    id: s.id, name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window',
    thumb: s.thumbnail?.isEmpty() ? '' : s.thumbnail.toDataURL(),
    icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
  }));
}

// ---------- files ----------
const files = new Map();
let fileSeq = 0;
const known = new Set(); // finished recordings/clips the renderer may read back
const readers = new Map(); // file -> Promise<FileHandle> for the clip editor's reads
function reader(file) {
  if (!known.has(file)) throw new Error('Not a recording from this session.');
  if (!readers.has(file)) readers.set(file, fs.promises.open(file, 'r'));
  return readers.get(file);
}

function setupMediaProtocol() {
  protocol.handle('nc-media', async (req) => {
    const file = new URL(req.url).searchParams.get('f') ?? '';
    if (!known.has(file)) return new Response('not found', { status: 404 });
    let size;
    try { size = (await fs.promises.stat(file)).size; } catch { return new Response('gone', { status: 404 }); }
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
    if (!m || (!m[1] && !m[2]) || size === 0) {
      return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
    }
    let start, end;
    if (m[1]) { start = +m[1]; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; }
    else { start = Math.max(0, size - +m[2]); end = size - 1; } // suffix range: last N bytes
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
    });
  });
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// ---------- IPC ----------
function setupIpc() {
  ipcMain.handle('settings:get', () => ({ ...settings, platform: process.platform, wayland: process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY, hotkey: HOTKEY, hotkeyVia: hotkeyVia, stageTitle: STAGE_TITLE }));
  ipcMain.handle('settings:set', (_e, patch) => { Object.assign(settings, patch); saveSettings(); return settings; });

  ipcMain.handle('stage:open', (_e, opts) => openStage(opts));
  ipcMain.handle('stage:reload', () => stage?.webContents.reload());
  ipcMain.handle('stage:devtools', () => stage?.webContents.toggleDevTools());
  ipcMain.handle('stage:focus', () => stage?.focus());
  ipcMain.handle('stage:close', () => stage?.close());

  ipcMain.handle('sources:list', () => listSources());

  ipcMain.handle('capture:prepare', (_e, req) => {
    if (req.kind === 'stage') {
      if (!stage || stage.isDestroyed()) throw new Error('Open the stage first.');
      const audio = req.audio !== false; // false: the retry after the page's sound could not be captured
      pendingCapture = { kind: 'stage', audio };
      return { audio, name: stage.webContents.getURL() };
    }
    const source = sourceCache.get(req.sourceId);
    if (!source) throw new Error('That window is gone — pick it again.');
    // Windows can loop back system audio; other platforms get video only for window capture.
    const audio = process.platform === 'win32' && req.audio !== false;
    pendingCapture = { kind: 'window', source, audio };
    return { audio, name: source.name };
  });

  ipcMain.handle('file:create', async (_e, ext, opts = {}) => {
    // A clip goes next to the recording it came from: "<recording> clip.mp4", "<recording> clip (2).mp4", …
    const like = opts.like && known.has(opts.like) ? opts.like : null;
    const dir = like ? path.dirname(like) : settings.outDir;
    const base = like ? `${path.parse(like).name} clip` : `neko-capture ${stamp()}`;
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, `${base}.${ext}`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} (${i}).${ext}`);
    const fh = await fs.promises.open(file, 'w');
    const id = ++fileSeq;
    files.set(id, { fh, file });
    return { id, file };
  });
  ipcMain.handle('file:write', async (_e, id, data, position) => {
    const f = files.get(id);
    if (!f) throw new Error('file closed');
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await f.fh.write(buf, 0, buf.length, position);
  });
  ipcMain.handle('file:close', async (_e, id, { discard = false } = {}) => {
    const f = files.get(id);
    if (!f) return null;
    files.delete(id);
    await f.fh.close();
    if (discard) { fs.rmSync(f.file, { force: true }); return null; }
    known.add(f.file);
    return { file: f.file, size: fs.statSync(f.file).size };
  });
  ipcMain.handle('file:size', async (_e, file) => (await (await reader(file)).stat()).size);
  ipcMain.handle('file:read', async (_e, file, start, end) => {
    const fh = await reader(file);
    const buf = Buffer.alloc(Math.max(0, end - start));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
  });
  ipcMain.handle('file:release', async (_e, file) => {
    const p = readers.get(file);
    readers.delete(file);
    if (p) await (await p).close().catch(() => {});
  });

  // Delete a recording or clip made in this session: to the trash where the desktop has one, else for good.
  ipcMain.handle('file:delete', async (_e, file) => {
    if (!known.has(file)) throw new Error('Not a recording from this session.');
    const p = readers.get(file);
    readers.delete(file);
    if (p) await (await p).close().catch(() => {});
    let trashed = true;
    try { await shell.trashItem(file); } catch { trashed = false; await fs.promises.rm(file, { force: true }); }
    known.delete(file);
    return { trashed };
  });

  ipcMain.handle('dir:choose', async () => {
    const r = await dialog.showOpenDialog(control, { defaultPath: settings.outDir, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return settings.outDir;
    settings.outDir = r.filePaths[0]; saveSettings();
    return settings.outDir;
  });
  ipcMain.handle('dir:open', () => { fs.mkdirSync(settings.outDir, { recursive: true }); return shell.openPath(settings.outDir); });
  ipcMain.handle('file:show', (_e, file) => shell.showItemInFolder(file));
  ipcMain.handle('file:play', (_e, file) => shell.openPath(file));
  ipcMain.handle('app:smoke-done', async (_e, result) => {
    console.log('SMOKE_RESULT ' + JSON.stringify(result));
    try { fs.writeFileSync(path.join(settings.outDir, 'control.png'), (await control.webContents.capturePage()).toPNG()); } catch { /* optional */ }
    setTimeout(() => app.quit(), 200);
  });
}

// ---------- smoke test: open a test page, record 3 s, print the file ----------
async function runSmoke() {
  console.log('SMOKE_PID ' + process.pid);
  // --url=<address> records that page instead of the built-in test page.
  const testUrl = process.argv.find((x) => x.startsWith('--url='))?.slice(6) || 'file://' + path.join(here, '..', 'test', 'smoke.html');
  settings.outDir = SMOKE_DIR();
  await new Promise((r) => control.webContents.once('did-finish-load', r));
  // --size=WxH and --borderless let the self-test try other stage shapes (npm run smoke -- --size=1080x1920).
  const m = /^--size=(\d+)x(\d+)$/.exec(process.argv.find((x) => x.startsWith('--size=')) ?? '');
  openStage({ url: testUrl, width: m ? +m[1] : 1280, height: m ? +m[2] : 720, borderless: process.argv.includes('--borderless') });
  await new Promise((r) => stage.webContents.once('did-finish-load', r));
  if (process.argv.includes('--click')) { // pages that only start their sound after a click
    await new Promise((r) => setTimeout(r, 2500));
    const [x, y] = [Math.round(stageOpts.width / 2), Math.round(stageOpts.height / 2)];
    stage.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    stage.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 1500));
  }
  await new Promise((r) => setTimeout(r, 500));
  control.webContents.executeJavaScript(`window.__smoke(${JSON.stringify(process.argv.includes('--window') ? 'window' : 'stage')})`).catch((e) => { console.log('SMOKE_RESULT ' + JSON.stringify({ error: String(e) })); app.quit(); });
  setTimeout(() => { console.log('SMOKE_RESULT {"error":"timeout"}'); app.quit(); }, 30000);
}

// ---------- global hotkey ----------
// Windows/X11: Electron's globalShortcut. Hyprland (Omarchy): the desktop portal refuses shortcuts from an app
// without an installed app id and would still need a hand-written bind, so the key is bound in Hyprland for as
// long as the app runs (removed on quit) and signals this process. Anywhere else, bind a key in your window
// manager to `neko-capture --toggle-record`.
let hotkeyVia = ''; // 'electron' | 'hyprland' | ''
let hyprBound = null; // how the key was bound: 'lua' | 'keyword'
const HYPR_KEYS = 'CTRL + ALT + R';
const toggleRecord = () => send('record:toggle');
const hyprctl = (...args) => new Promise((resolve) => {
  execFile('hyprctl', args, { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
});

async function bindHyprlandHotkey() {
  const binds = await hyprctl('binds', '-j');
  if (binds === null) return false;
  try { // leave an existing Ctrl+Alt+R binding alone (modmask: ctrl 4 + alt 8)
    if (JSON.parse(binds).some((b) => b.modmask === 12 && String(b.key).toLowerCase() === 'r')) return false;
  } catch { return false; }
  // Signal only this very process: the start time guards against the pid being reused after a crash.
  let started = '';
  try { started = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').pop().split(' ')[19]; } catch { return false; }
  const cmd = `sh -c '[ "$(sed "s/.*) //" /proc/${process.pid}/stat | cut -d" " -f20)" = "${started}" ] && kill -USR2 ${process.pid}'`;
  process.on('SIGUSR2', toggleRecord);
  const has = async () => { try { return JSON.parse(await hyprctl('binds', '-j') ?? '[]').some((b) => b.modmask === 12 && String(b.key).toLowerCase() === 'r'); } catch { return false; } };
  await hyprctl('eval', `hl.bind(${JSON.stringify(HYPR_KEYS)}, hl.dsp.exec_cmd(${JSON.stringify(cmd)}))`); // Lua config (Hyprland 0.5x+)
  if (await has()) { hyprBound = 'lua'; return true; }
  await hyprctl('keyword', 'bind', `CTRL ALT, R, exec, ${cmd}`); // classic hyprland.conf syntax
  if (await has()) { hyprBound = 'keyword'; return true; }
  return false;
}
function unbindHyprlandHotkey() {
  if (hyprBound === 'lua') execFile('hyprctl', ['eval', `hl.unbind(${JSON.stringify(HYPR_KEYS)})`], () => {});
  else if (hyprBound === 'keyword') execFile('hyprctl', ['keyword', 'unbind', 'CTRL ALT, R'], () => {});
  hyprBound = null;
}

async function setupHotkey() {
  if (process.platform === 'linux' && process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    if (await bindHyprlandHotkey()) { hotkeyVia = 'hyprland'; return; }
  }
  try { if (globalShortcut.register(HOTKEY, toggleRecord)) hotkeyVia = 'electron'; } catch { /* hotkey unavailable */ }
}

// One running copy. Starting it again brings the control window forward; `--toggle-record` starts/stops the
// recording in the running copy (for a window-manager key binding).
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--toggle-record')) return toggleRecord();
    if (control && !control.isDestroyed()) { if (control.isMinimized()) control.restore(); control.focus(); }
  });
  app.whenReady().then(async () => {
    loadSettings();
    if (!SMOKE || process.argv.includes('--hotkey')) await setupHotkey();
    setupIpc();
    setupDisplayMedia();
    setupMediaProtocol();
    createControl();
    if (SMOKE) runSmoke();
  });
}
app.on('will-quit', () => { globalShortcut.unregisterAll(); unbindHyprlandHotkey(); });
app.on('window-all-closed', () => app.quit());
