const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const { spawn, execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ARIA_ROOT = path.join(os.homedir(), 'projects', 'aria-flow')
const PROD_APP = '/Applications/Wispr Flow.app'
const PROD_BUNDLE_ID = 'com.electron.wispr-flow'
const PROD_LOG = path.join(os.homedir(), 'Library', 'Logs', 'Wispr Flow', 'main.log')
// Seeded local GoTrue user — production tokens 401 against a local backend (see desktop/AGENTS.md).
const DEV_SIGNIN_ENV = {
  DEV_LOCAL_SIGNIN_EMAIL: 'dev@wispr.ai',
  DEV_LOCAL_SIGNIN_PASSWORD: 'local-dev-not-a-secret',
}
const MAX_LOG_LINES = 5000
const BACKEND_HEALTH_TIMEOUT_MS = 180_000

const DESKTOP_TILES = ['local-prod', 'local-local', 'prod']
const TILE_LABELS = {
  backend: 'Local backend',
  'local-prod': 'Local desktop → prod backend',
  'local-local': 'Local desktop → local backend',
  prod: 'Wispr Flow (installed)',
}

let win = null

// ---------------------------------------------------------------- settings

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
let settings = { worktree: ARIA_ROOT, flags: [], logsOpen: true }

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }
  } catch {}
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}

/** Builds WISPR_FEATURE_FLAGS: on → `name` / `name=variant`, off → `name=false`, posthog → omitted. */
function featureFlagEnv() {
  const entries = settings.flags
    .filter((f) => f.state !== 'posthog')
    .map((f) => (f.state === 'off' ? `${f.name}=false` : f.variant ? `${f.name}=${f.variant}` : f.name))
  return entries.length ? { WISPR_FEATURE_FLAGS: entries.join(',') } : {}
}

// ---------------------------------------------------------------- logs

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g
const logs = { backend: [], desktop: [], launcher: [] }
const pending = { backend: [], desktop: [], launcher: [] }
const partial = {}
let flushTimer = null

function log(key, text) {
  const buf = (partial[key] ?? '') + String(text).replace(ANSI, '').replace(/\r(?!\n)/g, '\n')
  const lines = buf.split(/\r?\n/)
  partial[key] = lines.pop()
  if (!lines.length) return
  logs[key].push(...lines)
  if (logs[key].length > MAX_LOG_LINES) logs[key].splice(0, logs[key].length - MAX_LOG_LINES)
  pending[key].push(...lines)
  flushTimer ??= setTimeout(flushLogs, 80)
}

const note = (key, msg) => log(key, `▸ ${msg}\n`)

function flushLogs() {
  flushTimer = null
  for (const key of Object.keys(pending)) {
    if (pending[key].length && win && !win.isDestroyed()) win.webContents.send('log', { key, lines: pending[key] })
    pending[key] = []
  }
}

function clearLog(key) {
  logs[key] = []
  pending[key] = []
  win?.webContents.send('log-cleared', key)
}

// ---------------------------------------------------------------- process helpers

/** GUI apps get a bare PATH; borrow the login shell's so docker/python/git resolve. */
function adoptLoginShellPath() {
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-lic', 'echo "__PATH__$PATH"'], { timeout: 15000 }, (_err, stdout = '') => {
      const line = stdout.split('\n').find((l) => l.startsWith('__PATH__'))
      if (line) process.env.PATH = line.slice('__PATH__'.length)
      resolve()
    })
  })
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, timeout: 30000, ...opts }, (err, stdout = '', stderr = '') => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
    })
  })
}

/**
 * Runs a command in a hidden interactive login zsh (so nvm picks up the worktree's .nvmrc),
 * in its own process group so stopping it takes the whole tree down.
 */
function spawnShell(command, { cwd, env = {}, logKey }) {
  note(logKey, `$ ${command}   (in ${cwd})`)
  const child = spawn('/bin/zsh', ['-lic', command], {
    cwd,
    env: { ...process.env, ...env, FORCE_COLOR: '0' },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => log(logKey, d))
  child.stderr.on('data', (d) => log(logKey, d))
  child.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return child
}

function killGroup(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(fn, timeoutMs, intervalMs = 300) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(intervalMs)
  }
  return false
}

// ---------------------------------------------------------------- discovery

async function listWorktrees() {
  const { stdout } = await run('git', ['-C', ARIA_ROOT, 'worktree', 'list', '--porcelain'])
  const out = []
  let cur = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) out.push((cur = { path: line.slice(9), branch: '(detached)' }))
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace('refs/heads/', '')
  }
  return out.filter((w) => fs.existsSync(path.join(w.path, 'scripts', 'wispr-dev')))
}

function knownFlags(worktree) {
  try {
    const src = fs.readFileSync(path.join(worktree, 'desktop/src/common/featureFlagTypes.ts'), 'utf8')
    const start = src.indexOf('export enum FeatureFlag {')
    const body = src.slice(start, src.indexOf('\n}', start))
    return [...body.matchAll(/=\s*'([^']+)'/g)].map((m) => m[1]).sort()
  } catch {
    return []
  }
}

const ELECTRON_RE = /^\s*(\d+)\s+(.+?)\/desktop\/node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron(?:\s(.*))?$/

/** Scans `ps` for the installed app and for dev Electron instances launched from any aria-flow checkout. */
async function scanProcesses() {
  const { stdout } = await run('ps', ['-axww', '-o', 'pid=,command='])
  const prodPids = []
  const localDesktops = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!m) continue
    const [, pid, cmd] = m
    if (cmd.startsWith(`${PROD_APP}/`)) prodPids.push(Number(pid))
    const e = line.match(ELECTRON_RE)
    if (e && e[2].startsWith(ARIA_ROOT)) {
      localDesktops.push({ pid: Number(e[1]), worktree: e[2], devBackend: /\bdev-backend\b/.test(e[3] ?? '') })
    }
  }
  return { prodPids, localDesktops }
}

/** Running local backends, from `wispr-dev status` (the source of truth for slots). */
async function scanBackends() {
  const { stdout } = await run('python3', [path.join(ARIA_ROOT, 'scripts', 'wispr-dev'), 'status'], { cwd: ARIA_ROOT })
  const out = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*\d+\s+(\S+)\s+:(\d+)\s+(running.*?|stopped|\S+)\s{2,}(\/.+)$/)
    if (m && m[3].startsWith('running')) out.push({ instance: m[1], port: Number(m[2]), worktree: m[4].trim() })
  }
  return out
}

async function backendEnv(worktree) {
  const { stdout, code, stderr } = await run('python3', ['scripts/wispr-dev', 'env', 'dev'], { cwd: worktree })
  if (code !== 0) throw new Error(`wispr-dev env failed: ${stderr}`)
  const env = {}
  for (const m of stdout.matchAll(/^export ([A-Z0-9_]+)=(?:"(.*)"|(.*))$/gm)) env[m[1]] = m[2] ?? m[3]
  return env
}

// ---------------------------------------------------------------- state

const state = {
  backend: { status: 'off', worktree: null, port: null, external: false, others: [] },
  desktop: { tile: null, status: 'off', worktree: null, external: false },
}
let busy = { backend: false, desktop: false }
let ownDesktop = null // { child, tile, worktree }
let ownBackendUp = null // child running `wispr-dev up`
let backendTail = null // { child, worktree }
let prodTail = null
let lastScan = { prodPids: [], localDesktops: [], backends: [] }

function pushState() {
  if (!win || win.isDestroyed()) return
  win.webContents.send('state', { ...state, settings })
}

function setBackend(patch) {
  Object.assign(state.backend, patch)
  pushState()
}

function setDesktop(patch) {
  Object.assign(state.desktop, patch)
  pushState()
}

let polling = false
async function poll() {
  if (polling) return
  polling = true
  try {
    const [procs, backends] = await Promise.all([scanProcesses(), scanBackends()])
    lastScan = { ...procs, backends }
    reconcileBackend()
    reconcileDesktop()
  } finally {
    polling = false
  }
}

function reconcileBackend() {
  const { backends } = lastScan
  if (!busy.backend) {
    const preferred = backends.find((b) => b.worktree === state.backend.worktree) ?? backends[0]
    if (preferred) {
      setBackend({ status: 'running', worktree: preferred.worktree, port: preferred.port, external: false })
    } else {
      setBackend({ status: 'off', port: null })
    }
  }
  setBackend({ others: backends.filter((b) => b.worktree !== state.backend.worktree).map((b) => b.worktree) })

  // Keep a `docker compose logs -f` tail attached to whichever backend is running.
  const running = backends.find((b) => b.worktree === state.backend.worktree)
  if (running && state.backend.status === 'running' && backendTail?.worktree !== running.worktree) {
    stopBackendTail()
    const child = spawnShell(`docker compose -p wispr-${running.instance} logs -f --tail 200 --no-color`, {
      cwd: running.worktree,
      logKey: 'backend',
    })
    backendTail = { child, worktree: running.worktree }
    child.exited.then(() => {
      if (backendTail?.child === child) backendTail = null
    })
  } else if (!running && backendTail && !busy.backend) {
    stopBackendTail()
  }
}

function stopBackendTail() {
  if (backendTail) killGroup(backendTail.child)
  backendTail = null
}

function reconcileDesktop() {
  const { prodPids, localDesktops } = lastScan
  if (prodPids.length && !prodTail) startProdTail()
  if (!prodPids.length && prodTail) stopProdTail()
  if (busy.desktop) return

  if (ownDesktop) {
    const electron = localDesktops.find((d) => d.worktree === ownDesktop.worktree)
    setDesktop({ tile: ownDesktop.tile, worktree: ownDesktop.worktree, status: electron ? 'running' : 'starting', external: false })
    return
  }
  const local = localDesktops[0]
  if (local) {
    setDesktop({ tile: local.devBackend ? 'local-local' : 'local-prod', worktree: local.worktree, status: 'running', external: true })
  } else if (prodPids.length) {
    setDesktop({ tile: 'prod', worktree: null, status: 'running', external: false })
  } else {
    setDesktop({ tile: null, worktree: null, status: 'off', external: false })
  }
}

function startProdTail() {
  if (!fs.existsSync(PROD_LOG)) return
  prodTail = spawn('tail', ['-n', '50', '-F', PROD_LOG], { detached: true })
  note('desktop', `Tailing ${PROD_LOG}`)
  prodTail.stdout.on('data', (d) => log('desktop', d))
}

function stopProdTail() {
  if (prodTail) killGroup(prodTail)
  prodTail = null
}

// ---------------------------------------------------------------- confirm

async function confirm(message, detail, okLabel) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [okLabel, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message,
    detail,
  })
  return response === 0
}

const shortWt = (wt) => (wt === ARIA_ROOT ? 'aria-flow (main checkout)' : path.basename(wt))

// ---------------------------------------------------------------- backend actions

async function startBackend(worktree) {
  await poll()
  const others = lastScan.backends.filter((b) => b.worktree !== worktree)
  if (lastScan.backends.some((b) => b.worktree === worktree)) {
    setBackend({ worktree })
    await poll()
    return true
  }
  if (others.length) {
    const ok = await confirm(
      'Another local backend is running',
      `${others.map((b) => shortWt(b.worktree)).join(', ')} will be stopped before starting ${shortWt(worktree)}.`,
      'Stop it and continue'
    )
    if (!ok) return false
    for (const b of others) await stopBackend(b.worktree)
  }

  busy.backend = true
  stopBackendTail()
  clearLog('backend')
  setBackend({ status: 'starting', worktree, external: false })
  try {
    ownBackendUp = spawnShell('python3 scripts/wispr-dev up', { cwd: worktree, logKey: 'backend' })
    const { code } = await ownBackendUp.exited
    ownBackendUp = null
    if (code !== 0) throw new Error(`wispr-dev up exited with ${code}`)

    const { WISPR_BACKEND_PORT: port } = await backendEnv(worktree)
    note('backend', `Waiting for http://127.0.0.1:${port} to answer…`)
    const healthy = await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
        return true
      } catch {
        return false
      }
    }, BACKEND_HEALTH_TIMEOUT_MS, 1500)
    if (!healthy) throw new Error(`backend did not answer on :${port} within ${BACKEND_HEALTH_TIMEOUT_MS / 1000}s`)
    note('backend', `Backend is up on :${port}`)
    busy.backend = false
    await poll()
    return true
  } catch (err) {
    note('backend', `ERROR: ${err.message}`)
    busy.backend = false
    setBackend({ status: 'error' })
    return false
  }
}

async function stopBackend(worktree = state.backend.worktree) {
  if (!worktree) return
  busy.backend = true
  if (ownBackendUp) killGroup(ownBackendUp)
  if (worktree === state.backend.worktree) {
    stopBackendTail()
    setBackend({ status: 'stopping' })
  }
  const child = spawnShell('python3 scripts/wispr-dev down', { cwd: worktree, logKey: 'backend' })
  await child.exited
  busy.backend = false
  await poll()
}

// ---------------------------------------------------------------- desktop actions

async function stopDesktop() {
  const { tile, worktree, external } = state.desktop
  busy.desktop = true
  setDesktop({ status: 'stopping' })
  try {
    if (tile === 'prod') {
      note('desktop', 'Quitting installed Wispr Flow…')
      await run('osascript', ['-e', `tell application id "${PROD_BUNDLE_ID}" to quit`], { timeout: 8000 })
      const gone = await waitFor(async () => !(await scanProcesses()).prodPids.length, 8000)
      if (!gone) {
        note('desktop', 'Did not quit in time — terminating')
        await killPids(() => scanProcesses().then((p) => p.prodPids))
      }
    } else {
      note('desktop', `Stopping local desktop (${shortWt(worktree)})…`)
      const pidsFor = async () => {
        const { stdout } = await run('ps', ['-axww', '-o', 'pid=,command='])
        const desktopDir = `${worktree}/desktop/`
        return stdout
          .split('\n')
          .map((l) => l.match(/^\s*(\d+)\s+(.*)$/))
          .filter((m) => m && (m[2].startsWith(`${desktopDir}node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`) || m[2].startsWith(`${desktopDir}swift-helper-app-dist/`)))
          .map((m) => Number(m[1]))
      }
      if (ownDesktop && !external) killGroup(ownDesktop.child)
      await killPids(pidsFor)
      if (ownDesktop) {
        const exited = await Promise.race([ownDesktop.child.exited.then(() => true), sleep(5000).then(() => false)])
        if (!exited) killGroup(ownDesktop.child, 'SIGKILL')
      }
      ownDesktop = null
    }
  } finally {
    busy.desktop = false
    await poll()
  }
}

/** SIGTERM, wait, then SIGKILL whatever is left. */
async function killPids(getPids) {
  for (const pid of await getPids()) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  const gone = await waitFor(async () => !(await getPids()).length, 6000, 400)
  if (!gone) {
    for (const pid of await getPids()) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
}

async function startDesktop(tile, worktree) {
  if (tile === 'prod') {
    busy.desktop = true
    setDesktop({ tile, status: 'starting', worktree: null, external: false })
    note('desktop', 'Opening installed Wispr Flow')
    await run('open', ['-a', PROD_APP])
    await waitFor(async () => (await scanProcesses()).prodPids.length > 0, 15000)
    busy.desktop = false
    await poll()
    return
  }

  const useLocalBackend = tile === 'local-local'
  let env = {}
  if (useLocalBackend) {
    busy.desktop = true
    setDesktop({ tile, worktree, status: 'starting', external: false, waitingForBackend: true })
    const ok = await startBackend(worktree)
    busy.desktop = false
    setDesktop({ waitingForBackend: false })
    if (!ok) {
      await poll()
      note('desktop', 'Not starting desktop: local backend failed to start (see Backend logs)')
      return
    }
    env = { ...(await backendEnv(worktree)), ...DEV_SIGNIN_ENV }
  }
  env = { ...env, ...featureFlagEnv() }

  clearLog('desktop')
  if (env.WISPR_FEATURE_FLAGS) note('desktop', `Feature flag overrides: ${env.WISPR_FEATURE_FLAGS}`)
  const child = spawnShell(`yarn start${useLocalBackend ? ' dev-backend' : ''}`, {
    cwd: path.join(worktree, 'desktop'),
    env,
    logKey: 'desktop',
  })
  ownDesktop = { child, tile, worktree }
  setDesktop({ tile, worktree, status: 'starting', external: false })
  child.exited.then(({ code, signal }) => {
    note('desktop', `Local desktop exited (${signal ?? `code ${code}`})`)
    if (ownDesktop?.child === child) ownDesktop = null
    poll()
  })
}

// ---------------------------------------------------------------- toggle

let toggling = false
async function toggle(tile) {
  if (toggling) return
  toggling = true
  try {
    await poll()
    const worktree = settings.worktree
    if (tile === 'backend') {
      if (['running', 'starting'].includes(state.backend.status) && state.backend.worktree === worktree) await stopBackend()
      else await startBackend(worktree)
      return
    }

    const d = state.desktop
    const active = d.status !== 'off'
    const sameTile = d.tile === tile && (tile === 'prod' || d.worktree === worktree)
    if (active && sameTile) {
      await stopDesktop()
      return
    }
    if (active) {
      const current = d.tile === 'prod' ? TILE_LABELS.prod : `${TILE_LABELS[d.tile]} (${shortWt(d.worktree)})`
      const ok = await confirm(
        `${current} is running`,
        `It will be quit before starting ${TILE_LABELS[tile]}${tile === 'prod' ? '' : ` (${shortWt(worktree)})`}.`,
        'Quit it and continue'
      )
      if (!ok) return
      await stopDesktop()
    }
    await startDesktop(tile, worktree)
  } catch (err) {
    note('launcher', `ERROR: ${err.stack ?? err}`)
  } finally {
    toggling = false
    pushState()
  }
}

// ---------------------------------------------------------------- app

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: 'Flow Launcher',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#111214',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // Dev aid: FLOW_LAUNCHER_SNAPSHOT=/path.png captures the window a few seconds after launch.
  if (process.env.FLOW_LAUNCHER_SNAPSHOT) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(process.env.FLOW_LAUNCHER_SNAPSHOT, img.toPNG())
    }, Number(process.env.FLOW_LAUNCHER_SNAPSHOT_DELAY ?? 6000))
  }
}

ipcMain.handle('init', async () => ({
  state: { ...state, settings },
  logs,
  worktrees: await listWorktrees(),
  knownFlags: knownFlags(settings.worktree),
  ariaRoot: ARIA_ROOT,
}))
ipcMain.handle('worktrees', () => listWorktrees())
ipcMain.handle('toggle', (_e, tile) => toggle(tile))
ipcMain.handle('set-worktree', (_e, wt) => {
  settings.worktree = wt
  saveSettings()
  pushState()
  return knownFlags(wt)
})
ipcMain.handle('set-flags', (_e, flags) => {
  settings.flags = flags
  saveSettings()
  pushState()
})
ipcMain.handle('set-logs-open', (_e, open) => {
  settings.logsOpen = open
  saveSettings()
})
ipcMain.handle('clear-log', (_e, key) => clearLog(key))
ipcMain.handle('reveal', (_e, p) => shell.openPath(p))

let quitting = false
app.on('before-quit', async (e) => {
  stopBackendTail()
  stopProdTail()
  if (ownDesktop && !quitting) {
    e.preventDefault()
    quitting = true
    await stopDesktop().catch(() => {})
    app.quit()
  }
})
app.on('window-all-closed', () => app.quit())

app.whenReady().then(async () => {
  app.setName('Flow Launcher')
  loadSettings()
  if (!fs.existsSync(settings.worktree)) settings.worktree = ARIA_ROOT
  await adoptLoginShellPath()
  createWindow()
  note('launcher', `PATH resolved; aria-flow at ${ARIA_ROOT}`)
  poll()
  setInterval(poll, 3000)
})
