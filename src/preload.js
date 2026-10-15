const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('launcher', {
  init: () => ipcRenderer.invoke('init'),
  worktrees: () => ipcRenderer.invoke('worktrees'),
  toggle: (tile, action) => ipcRenderer.invoke('toggle', tile, action),
  setWorktree: (service, wt) => ipcRenderer.invoke('set-worktree', service, wt),
  setFlags: (flags) => ipcRenderer.invoke('set-flags', flags),
  setBackendArgs: (args) => ipcRenderer.invoke('set-backend-args', args),
  setLogsOpen: (open) => ipcRenderer.invoke('set-logs-open', open),
  clearLog: (key) => ipcRenderer.invoke('clear-log', key),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onLog: (fn) => ipcRenderer.on('log', (_e, payload) => fn(payload)),
  onLogCleared: (fn) => ipcRenderer.on('log-cleared', (_e, key) => fn(key)),
})
