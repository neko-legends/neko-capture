// neko-capture: main process.
// Two capture modes:
//   stage  — a real browser window showing a URL at an exact pixel size. You interact with it directly
//            (real keyboard focus, real <select> popups), and it is recorded via tab capture, so window
//            frames, overlapping windows or the window being half off-screen never end up in the video.
//   window — any app window (or a whole screen) via the OS capture API; on Wayland the desktop portal picker.
// Recording itself happens in the control window (WebCodecs + Mediabunny → MP4); main only hands it the
// stream source and writes the bytes to disk.

import { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, shell, dialog, globalShortcut } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (SMOKE) app.commandLine.appendSwitch('no-sandbox');

// ---------- settings ----------
const DEFAULTS = {
  url: 'http://localhost:5173/games/voxel-derby/',
  width: 1920,
  height: 1080,
  borderless: false,
  fps: 60,
  quality: 'high',
  outDir: '',
  mode: 'stage',
};
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { ...DEFAULTS };
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch { /* first run */ }
  if (!settings.outDir) settings.outDir = path.join(app.getPath('videos'), 'neko-capture');
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsPath()), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); } catch (e) { console.error('settings save failed', e); }
}

// ---------- windows ----------
let control = null;
let stage = null;
let stageOpts = null;
const send = (ch, ...a) => { if (control && !control.isDestroyed()) control.webContents.send(ch, ...a); };

function createControl() {
  control = new BrowserWindow({
    width: 460, height: 820, minWidth: 400, minHeight: 560,
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
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// ---------- IPC ----------
function setupIpc() {
  ipcMain.handle('settings:get', () => ({ ...settings, platform: process.platform, wayland: process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY, hotkey: HOTKEY, stageTitle: STAGE_TITLE }));
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
      pendingCapture = { kind: 'stage', audio: true };
      return { audio: true, name: stage.webContents.getURL() };
    }
    const source = sourceCache.get(req.sourceId);
    if (!source) throw new Error('That window is gone — pick it again.');
    // Windows can loop back system audio; other platforms get video only for window capture.
    const audio = process.platform === 'win32' && req.audio !== false;
    pendingCapture = { kind: 'window', source, audio };
    return { audio, name: source.name };
  });

  ipcMain.handle('file:create', async (_e, ext) => {
    fs.mkdirSync(settings.outDir, { recursive: true });
    let file = path.join(settings.outDir, `neko-capture ${stamp()}.${ext}`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(settings.outDir, `neko-capture ${stamp()} (${i}).${ext}`);
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
    return { file: f.file, size: fs.statSync(f.file).size };
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
  const testUrl = 'file://' + path.join(here, '..', 'test', 'smoke.html');
  settings.outDir = path.join(app.getPath('temp'), 'neko-capture-smoke');
  await new Promise((r) => control.webContents.once('did-finish-load', r));
  openStage({ url: testUrl, width: 1280, height: 720, borderless: false });
  await new Promise((r) => stage.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 500));
  control.webContents.executeJavaScript(`window.__smoke(${JSON.stringify(process.argv.includes('--window') ? 'window' : 'stage')})`).catch((e) => { console.log('SMOKE_RESULT ' + JSON.stringify({ error: String(e) })); app.quit(); });
  setTimeout(() => { console.log('SMOKE_RESULT {"error":"timeout"}'); app.quit(); }, 30000);
}

app.whenReady().then(() => {
  loadSettings();
  setupIpc();
  setupDisplayMedia();
  createControl();
  try { globalShortcut.register(HOTKEY, () => send('record:toggle')); } catch { /* hotkey unavailable (some Wayland setups) */ }
  if (SMOKE) runSmoke();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
