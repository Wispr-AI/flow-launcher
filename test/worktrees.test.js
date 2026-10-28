const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Exercise the real launcher without starting Electron, Docker, or a desktop app.
function launcher(saved = {}) {
  const handlers = {}
  let persisted
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return {
        app: { getPath: () => '/settings', on() {}, whenReady: () => ({ then() {} }) },
        ipcMain: { handle: (name, fn) => { handlers[name] = fn } },
        dialog: { showMessageBox: async (_win, opts) => { context.calls.push(['dialog', opts.buttons]); return { response: context.dialogResponse ?? 0 } } },
      }
      if (name === 'fs') return {
        ...fs,
        readFileSync: (file, ...args) => file === '/settings/settings.json' ? JSON.stringify(saved) : fs.readFileSync(file, ...args),
        mkdirSync() {},
        writeFileSync: (_file, data) => { persisted = JSON.parse(data) },
      }
      if (name === './authProfiles') return {}
      return require(name)
    },
    process: { env: {} }, __dirname: path.join(__dirname, '../src'),
    setTimeout, clearTimeout, setInterval, AbortSignal,
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8'), context)
  vm.runInContext(`
    loadSettings()
    globalThis.calls = []
    log = () => {}
    clearLog = () => {}
    poll = async () => {}
    swapLogin = async () => 'test login'
    startBackend = async (wt) => { calls.push(['backend', wt]); return true }
    backendEnv = async (wt) => {
      calls.push(['env', wt])
      return { BASE_WEB_URL: 'http://127.0.0.1:8100', LOCAL_WEBSOCKET_HOST: 'ws://127.0.0.1:8100/', SUPABASE_URL: 'http://127.0.0.1:9100' }
    }
    spawnShell = (command, options) => {
      calls.push(['spawn', command, options])
      return { exited: new Promise(() => {}) }
    }
    stopDesktop = async (tile) => {
      calls.push(['stop', tile])
      if (tile === 'prod') state.installed.status = 'off'
      else { ownDesktop = null; state.desktop.status = 'off' }
    }
    confirm = async () => { calls.push(['confirm']); return true }
  `, context)
  return {
    run: (code) => vm.runInContext(code, context), handlers,
    calls: () => JSON.parse(JSON.stringify(context.calls)),
    persisted: () => persisted,
  }
}

test('legacy selection migrates to both services and independent selections persist', () => {
  const app = launcher({ worktree: '/legacy', flags: [{ name: 'flag', state: 'on' }], backendArgs: '--skip-build' })
  assert.equal(app.run('settings.backendWorktree'), '/legacy')
  assert.equal(app.run('settings.desktopWorktree'), '/legacy')
  app.handlers['set-worktree'](null, 'backend', '/backend')
  app.handlers['set-worktree'](null, 'desktop', '/frontend')
  assert.deepEqual(app.persisted(), {
    backendWorktree: '/backend', desktopWorktree: '/frontend',
    flags: [{ name: 'flag', state: 'on' }], logsOpen: true, backendArgs: '--skip-build',
  })
  const reopened = launcher(app.persisted())
  assert.equal(reopened.run('settings.backendWorktree'), '/backend')
  assert.equal(reopened.run('settings.desktopWorktree'), '/frontend')
})

test('local desktop launches in frontend checkout with selected backend ports and auth', async () => {
  const app = launcher({ backendWorktree: '/backend', desktopWorktree: '/frontend', flags: [{ name: 'flag', state: 'on' }] })
  await app.run("toggle('local-local')")
  const calls = app.calls()
  assert.deepEqual(calls[0], ['env', '/backend'])
  assert.equal(calls[1][1], 'yarn start dev-backend')
  assert.equal(calls[1][2].cwd, '/frontend/desktop')
  assert.equal(calls[1][2].env.BASE_WEB_URL, 'http://127.0.0.1:8100')
  assert.equal(calls[1][2].env.LOCAL_WEBSOCKET_HOST, 'ws://127.0.0.1:8100/')
  assert.equal(calls[1][2].env.SUPABASE_URL, 'http://127.0.0.1:9100')
  assert.equal(calls[1][2].env.DEV_LOCAL_SIGNIN_EMAIL, 'dev@wispr.ai')
  assert.equal(calls[1][2].env.WISPR_FEATURE_FLAGS, 'flag')
  app.run(`lastScan.localDesktops = [{ worktree: '/frontend' }]; reconcileDesktop()`)
  assert.equal(app.run('state.desktop.backendWorktree'), '/backend')
  assert.equal(app.run('state.desktop.status'), 'running')
})

test('backend-only launch uses backend selection', async () => {
  const app = launcher({ backendWorktree: '/backend', desktopWorktree: '/frontend' })
  await app.run("toggle('backend')")
  assert.deepEqual(app.calls(), [['backend', '/backend']])
})

for (const [tile, command] of [['local-prod', 'yarn start'], ['local-staging', 'yarn start staging-backend']]) {
  test(`${tile} launches frontend without starting or reading local backend`, async () => {
    const app = launcher({ backendWorktree: '/backend', desktopWorktree: '/frontend' })
    await app.run(`toggle('${tile}')`)
    const calls = app.calls()
    assert.equal(calls.length, 1)
    assert.equal(calls[0][1], command)
    assert.equal(calls[0][2].cwd, '/frontend/desktop')
    assert.deepEqual(calls[0][2].env, {})
  })
}

const runLocal = (app, tile = 'local-local') =>
  app.run(`Object.assign(state.desktop, { tile: '${tile}', status: 'running', worktree: '/frontend', backendWorktree: '/old-backend' })`)

test('clicking a running tile stops it, even with a different worktree selected', async () => {
  const app = launcher({ backendWorktree: '/backend', desktopWorktree: '/other' })
  runLocal(app)
  await app.run("toggle('local-local')")
  assert.deepEqual(app.calls(), [['stop', 'local-local']])
})

test('restart stops and starts with the current selections, without asking', async () => {
  const app = launcher({ backendWorktree: '/backend', desktopWorktree: '/frontend' })
  runLocal(app)
  app.run("state.installed.status = 'running'")
  await app.run("toggle('local-local', 'restart')")
  assert.deepEqual(app.calls().slice(0, 2), [['stop', 'local-local'], ['env', '/backend']])
})

test('starting a second local build must quit the first', async () => {
  const app = launcher({ backendWorktree: '/backend', desktopWorktree: '/frontend' })
  runLocal(app, 'local-prod')
  await app.run("toggle('local-staging')")
  const calls = app.calls()
  assert.deepEqual(calls[0], ['dialog', ['Quit Local desktop → prod backend (frontend) and start', 'Cancel']])
  assert.deepEqual(calls[1], ['stop', 'local-prod'])
  assert.equal(calls[2][1], 'yarn start staging-backend')
})

for (const [response, expected] of [[0, [['stop', 'prod']]], [1, []]]) {
  test(`local build next to the installed app: option ${response}`, async () => {
    const app = launcher({ backendWorktree: '/backend', desktopWorktree: '/frontend' })
    app.run(`state.installed.status = 'running'; dialogResponse = ${response}`)
    await app.run("toggle('local-prod')")
    const calls = app.calls()
    assert.deepEqual(calls[0], ['dialog', ['Quit Wispr Flow (installed) and start', 'Start alongside', 'Cancel']])
    assert.deepEqual(calls.slice(1, -1), expected)
    assert.equal(calls.at(-1)[1], 'yarn start')
  })
}

test('installed app next to a local build can start alongside; cancel does nothing', async () => {
  const app = launcher({ backendWorktree: '/backend', desktopWorktree: '/frontend' })
  runLocal(app, 'local-prod')
  app.run('dialogResponse = 2')
  await app.run("toggle('prod')")
  assert.deepEqual(app.calls(), [['dialog', ['Quit Local desktop → prod backend (frontend) and start', 'Start alongside', 'Cancel']]])
})

test('second local build with the installed app running offers to keep the installed app', async () => {
  const app = launcher({ backendWorktree: '/backend', desktopWorktree: '/frontend' })
  runLocal(app, 'local-prod')
  app.run("state.installed.status = 'running'; dialogResponse = 1")
  await app.run("toggle('local-staging')")
  const calls = app.calls()
  assert.deepEqual(calls[0][1], [
    'Quit Local desktop → prod backend (frontend) and Wispr Flow (installed) and start',
    'Quit Local desktop → prod backend (frontend) only and start',
    'Cancel',
  ])
  assert.deepEqual(calls[1], ['stop', 'local-prod'])
  assert.equal(calls.length, 3)
})

test('Local → local and the installed app never run together', async () => {
  const app = launcher({ backendWorktree: '/backend', desktopWorktree: '/frontend' })
  app.run("state.installed.status = 'running'")
  await app.run("toggle('local-local')")
  assert.deepEqual(app.calls().slice(0, 2), [['dialog', ['Quit Wispr Flow (installed) and start', 'Cancel']], ['stop', 'prod']])

  const other = launcher({ backendWorktree: '/backend', desktopWorktree: '/frontend' })
  runLocal(other, 'local-local')
  await other.run("toggle('prod')")
  assert.deepEqual(other.calls().slice(0, 2), [['dialog', ['Quit Local desktop → local backend (frontend) and start', 'Cancel']], ['stop', 'local-local']])
})

test('Local → local never starts the backend, even when it is down', async () => {
  const app = launcher({ backendWorktree: '/backend', desktopWorktree: '/frontend' })
  await app.run("toggle('local-local')")
  const calls = app.calls()
  assert.ok(!calls.some(([kind]) => kind === 'backend'))
  assert.equal(calls.at(-1)[1], 'yarn start dev-backend')
})

test('PR link checks the branch out into its own worktree, or reuses one that has it', async () => {
  const app = launcher()
  app.run(`
    run = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: 'someone/pr-branch\\n' } }
    spawnShell = (command, options) => { calls.push(['spawn', command, options.cwd]); return { exited: Promise.resolve({ code: 0 }) } }
    listWorktrees = async () => worktrees
    worktrees = []
  `)
  const root = app.run('ARIA_ROOT')
  await assert.rejects(app.handlers['checkout-pr'](null, 'https://github.com/other/repo/pull/1'), /Expected a github.com/)
  assert.equal(await app.handlers['checkout-pr'](null, ' https://github.com/Wispr-AI/aria-flow/pull/999999/files '), `${root}/.worktrees/pr-999999`)
  assert.deepEqual(app.calls(), [
    ['gh', 'pr', 'view', '999999', '--json', 'headRefName', '-q', '.headRefName'],
    ['spawn', 'git worktree add --detach .worktrees/pr-999999 && cd .worktrees/pr-999999 && gh pr checkout 999999 && WORKTREESETUP_PROJECTS=desktop WORKTREESETUP_SKIP_FETCH=1 ./.worktreesetup', root],
  ])

  app.run(`calls.length = 0; worktrees = [{ path: '/mine', branch: 'someone/pr-branch' }]`)
  assert.equal(await app.handlers['checkout-pr'](null, 'https://github.com/Wispr-AI/aria-flow/pull/999999'), '/mine')
  assert.equal(app.calls().length, 1)
})
