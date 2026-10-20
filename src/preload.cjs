// Bridge between the control window and main. Kept tiny on purpose.
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (fn) => { const h = (_e, ...a) => fn(...a); ipcRenderer.on(ch, h); return () => ipcRenderer.off(ch, h); };

contextBridge.exposeInMainWorld('nc', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openStage: (opts) => ipcRenderer.invoke('stage:open', opts),
  reloadStage: () => ipcRenderer.invoke('stage:reload'),
  stageDevtools: () => ipcRenderer.invoke('stage:devtools'),
  focusStage: () => ipcRenderer.invoke('stage:focus'),
  closeStage: () => ipcRenderer.invoke('stage:close'),
  listSources: () => ipcRenderer.invoke('sources:list'),
  prepareCapture: (req) => ipcRenderer.invoke('capture:prepare', req),
  createFile: (ext) => ipcRenderer.invoke('file:create', ext),
  writeFile: (id, data, position) => ipcRenderer.invoke('file:write', id, data, position),
  closeFile: (id, opts) => ipcRenderer.invoke('file:close', id, opts),
  chooseDir: () => ipcRenderer.invoke('dir:choose'),
  openDir: () => ipcRenderer.invoke('dir:open'),
  showFile: (f) => ipcRenderer.invoke('file:show', f),
  playFile: (f) => ipcRenderer.invoke('file:play', f),
  smokeDone: (r) => ipcRenderer.invoke('app:smoke-done', r),
  onStageInfo: on('stage:info'),
  onStageError: on('stage:error'),
  onRecordToggle: on('record:toggle'),
});
