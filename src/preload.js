const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('launcher', {
  init: () => ipcRenderer.invoke('init'),
  worktrees: () => ipcRenderer.invoke('worktrees'),
  toggle: (tile) => ipcRenderer.invoke('toggle', tile),
  setWorktree: (wt) => ipcRenderer.invoke('set-worktree', wt),
  setFlags: (flags) => ipcRenderer.invoke('set-flags', flags),
  setBackendArgs: (args) => ipcRenderer.invoke('set-backend-args', args),
  setLogsOpen: (open) => ipcRenderer.invoke('set-logs-open', open),
  clearLog: (key) => ipcRenderer.invoke('clear-log', key),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onLog: (fn) => ipcRenderer.on('log', (_e, payload) => fn(payload)),
  onLogCleared: (fn) => ipcRenderer.on('log-cleared', (_e, key) => fn(key)),
})
