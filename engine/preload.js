const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  onConfig: (cb) => ipcRenderer.on('config', (_e, cfg) => cb(cfg)),
  onReducedMotion: (cb) => ipcRenderer.on('reduced-motion', (_e, v) => cb(v)),
  onResize: (cb) => ipcRenderer.on('resize', (_e, f) => cb(f)),
  onExternalState: (cb) => ipcRenderer.on('external-state', (_e, p) => cb(p)),
  onPresence: (cb) => ipcRenderer.on('presence', (_e, p) => cb(p)),
  onLedger: (cb) => ipcRenderer.on('ledger', (_e, d) => cb(d)),
  // 她要说一串话：告诉主进程这段别撤场
  speechBusy: (ms) => ipcRenderer.send('speech-busy', ms),
  // 戳她 / 拖她都算「他还在这儿」，用来推迟她退场的时间
  poke: () => ipcRenderer.send('pet-poke'),
  contextMenu: () => ipcRenderer.send('context-menu'),
  quit: () => ipcRenderer.send('quit'),
  openHome: () => ipcRenderer.send('open-home'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
});
