const api = window.launcher

const $ = (sel) => document.querySelector(sel)
const LOG_KEYS = ['backend', 'desktop', 'launcher']
const NOISE_RE = /Failed to send logs to Better Stack/
const ERR_PATTERN = /\b(error|exception|traceback|fatal|unhandled)\b|\bfailed\b(?!=0)/i
const ERR_RE = { test: (line) => !NOISE_RE.test(line) && ERR_PATTERN.test(line) }
const WARN_RE = /\bwarn(ing)?\b/i
const PR_OPTION = '__pr__'
const STATUS_LABEL = { off: 'Off', starting: 'Starting…', running: 'Running', stopping: 'Stopping…', error: 'Error' }

let ariaRoot = ''
let state = null
let flags = []
let logs = { backend: [], desktop: [], launcher: [] }
let errorCounts = { backend: 0, desktop: 0, launcher: 0 }
let activeLog = 'desktop'
let pendingTile = null

const shortWt = (wt) => (!wt ? '' : wt === ariaRoot ? 'aria-flow' : wt.split('/').pop())

// ---------------------------------------------------------------- worktrees

function renderWorktrees(list) {
  for (const service of ['backend', 'desktop']) {
    const select = $(`#${service}-worktree`)
    select.innerHTML = ''
    const selected = state?.settings[`${service}Worktree`]
    for (const wt of list) {
      const opt = document.createElement('option')
      opt.value = wt.path
      opt.textContent = wt.path === ariaRoot ? `${wt.branch}  ·  main checkout` : `${wt.branch}  ·  ${shortWt(wt.path)}`
      select.append(opt)
    }
    if (selected && !list.some((wt) => wt.path === selected)) {
      const opt = document.createElement('option')
      opt.value = selected
      opt.textContent = `${shortWt(selected)} · unavailable`
      select.append(opt)
    }
    if (service === 'desktop') select.append(new Option('Check out a GitHub PR…', PR_OPTION))
    select.value = selected ?? ''
    select.title = selected ?? ''
  }
}

for (const service of ['backend', 'desktop']) {
  $(`#${service}-worktree`).addEventListener('change', async (e) => {
    if (e.target.value === PR_OPTION) {
      e.target.value = state.settings.desktopWorktree
      return showPrForm(true)
    }
    setKnownFlags(await api.setWorktree(service, e.target.value))
    e.target.title = e.target.value
  })
}
$('#refresh-worktrees').addEventListener('click', async () => renderWorktrees(await api.worktrees()))
window.addEventListener('focus', async () => renderWorktrees(await api.worktrees()))

// ---------------------------------------------------------------- PR checkout

function showPrForm(show) {
  $('#desktop-worktree').hidden = show
  $('#pr-form').hidden = !show
  $('#pr-status').textContent = ''
  if (show) $('#pr-input').focus()
}

$('#pr-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = $('#pr-input')
  const status = $('#pr-status')
  if (!input.value.trim()) return
  input.disabled = true
  status.className = 'hint'
  status.textContent = 'Checking out… see Launcher logs'
  document.querySelector('#log-tabs [data-key="launcher"]').click()
  try {
    const wt = await api.checkoutPr(input.value)
    setKnownFlags(await api.setWorktree('desktop', wt))
    renderWorktrees(await api.worktrees())
    input.value = ''
    showPrForm(false)
  } catch (err) {
    status.className = 'hint err'
    status.textContent = status.title = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  } finally {
    input.disabled = false
  }
})
$('#pr-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.target.disabled) showPrForm(false)
})
$('#pr-input').addEventListener('blur', (e) => {
  if (!e.target.value.trim() && !e.target.disabled) showPrForm(false)
})

// ---------------------------------------------------------------- tiles

function tileView(tile) {
  const selected = state.settings[tile === 'backend' ? 'backendWorktree' : 'desktopWorktree']
  if (tile === 'backend') {
    const b = state.backend
    const on = b.status !== 'off'
    let where = on && b.worktree ? `${shortWt(b.worktree)}${b.port ? ` · :${b.port}` : ''}` : ''
    if (b.others.length) where += `${where ? ' · ' : ''}+${b.others.length} other running`
    return { status: b.status, where, other: on && b.worktree !== selected }
  }
  if (tile === 'prod') {
    const status = state.installed.status === 'off' && tile === pendingTile ? 'starting' : state.installed.status
    return { status, where: '', other: false }
  }
  const d = state.desktop
  if (d.tile !== tile) return { status: tile === pendingTile ? 'starting' : 'off', where: '', other: false }
  let where = tile === 'prod' ? '' : shortWt(d.worktree)
  if (tile === 'local-local' && d.backendWorktree) where += ` → ${shortWt(d.backendWorktree)}`
  if (d.external) where = `${where} · started outside launcher`
  return { status: d.status, where, other: tile !== 'prod' && d.status !== 'off' && (d.worktree !== selected || (tile === 'local-local' && !!d.backendWorktree && d.backendWorktree !== state.settings.backendWorktree)) }
}

function renderTiles() {
  for (const el of document.querySelectorAll('.tile')) {
    const { status, where, other } = tileView(el.dataset.tile)
    el.dataset.status = status
    el.dataset.other = String(other)
    el.querySelector('.pill').textContent = STATUS_LABEL[status] ?? status
    el.querySelector('.tile-where').textContent = where
    el.title = [el.dataset.hint, where, other ? 'Running with a different worktree selection' : ''].filter(Boolean).join(' · ')
  }
}

async function act(el, action) {
  const tile = el.dataset.tile
  const stopped = el.dataset.status === 'off' || el.dataset.status === 'error'
  if (stopped && action === 'click') pendingTile = tile
  renderTiles()
  try {
    await api.toggle(tile, action)
  } finally {
    pendingTile = null
    renderTiles()
  }
}

// Clicking a tile starts it, or stops it when running. Stop/Restart appear on hover while running.
for (const el of document.querySelectorAll('.tile')) {
  const actions = document.createElement('div')
  actions.className = 'tile-actions'
  for (const [action, label, icon] of [['restart', 'Restart', '↻'], ['stop', 'Stop', '■']]) {
    const b = document.createElement('button')
    b.dataset.action = action
    b.textContent = icon
    b.title = label
    b.setAttribute('aria-label', label)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      act(el, action)
    })
    actions.append(b)
  }
  el.append(actions)
  el.addEventListener('click', () => act(el, 'click'))
  el.addEventListener('keydown', (e) => {
    if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    act(el, 'click')
  })
}

// ---------------------------------------------------------------- backend args

let argsSaveTimer = null
function renderBackendCmd() {
  const args = $('#backend-args').value.trim()
  const cmd = `wispr-dev up${args ? ` ${args}` : ''}`
  $('.tile[data-tile="backend"]').dataset.hint = cmd
  if (state) renderTiles()
}
$('#backend-args').addEventListener('input', () => {
  renderBackendCmd()
  clearTimeout(argsSaveTimer)
  argsSaveTimer = setTimeout(() => api.setBackendArgs($('#backend-args').value.trim()), 300)
})

// ---------------------------------------------------------------- flags

function setKnownFlags(names) {
  const dl = $('#known-flags')
  dl.innerHTML = ''
  for (const n of names) {
    const opt = document.createElement('option')
    opt.value = n
    dl.append(opt)
  }
}

function saveFlags() {
  api.setFlags(flags)
  renderFlags()
}

function renderFlags() {
  const list = $('#flag-list')
  list.innerHTML = ''
  $('#flag-empty').style.display = flags.length ? 'none' : ''
  flags.forEach((f, i) => {
    const li = document.createElement('li')
    li.dataset.state = f.state

    const name = document.createElement('span')
    name.className = 'flag-name'
    name.textContent = f.name
    name.title = f.variant ? `${f.name}=${f.variant}` : f.name
    if (f.variant) {
      const v = document.createElement('span')
      v.className = 'variant'
      v.textContent = `=${f.variant}`
      name.append(v)
    }

    const seg = document.createElement('div')
    seg.className = 'seg'
    for (const [v, label] of [['on', f.variant ? 'Variant' : 'On'], ['off', 'Off'], ['posthog', 'PostHog']]) {
      const b = document.createElement('button')
      b.dataset.v = v
      b.textContent = label
      b.className = f.state === v ? 'on' : ''
      b.addEventListener('click', () => {
        f.state = v
        saveFlags()
      })
      seg.append(b)
    }

    const del = document.createElement('button')
    del.className = 'del'
    del.textContent = '✕'
    del.title = 'Remove'
    del.addEventListener('click', () => {
      flags.splice(i, 1)
      saveFlags()
    })

    li.append(name, seg, del)
    list.append(li)
  })
}

$('#flag-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const raw = $('#flag-input').value.trim()
  if (!raw) return
  const [name, ...rest] = raw.split('=')
  const variant = rest.join('=').trim()
  const isBool = /^(true|1|on|yes|enabled|false|0|off|no|disabled)$/i.test(variant)
  const entry = {
    name: name.trim(),
    variant: variant && !isBool ? variant : '',
    state: isBool && /^(false|0|off|no|disabled)$/i.test(variant) ? 'off' : 'on',
  }
  const existing = flags.findIndex((f) => f.name === entry.name)
  if (existing >= 0) flags[existing] = entry
  else flags.unshift(entry)
  $('#flag-input').value = ''
  saveFlags()
})

// ---------------------------------------------------------------- logs

function lineClass(line) {
  if (NOISE_RE.test(line)) return 'l dim'
  if (line.startsWith('▸')) return ERR_RE.test(line) ? 'l err' : 'l meta'
  if (ERR_RE.test(line)) return 'l err'
  if (WARN_RE.test(line)) return 'l warn'
  return 'l'
}

function lineVisible(line) {
  const filter = $('#log-filter').value.toLowerCase()
  if ($('#errors-only').checked && !ERR_RE.test(line)) return false
  return !filter || line.toLowerCase().includes(filter)
}

function makeLine(line) {
  const div = document.createElement('div')
  div.className = lineClass(line) + (lineVisible(line) ? '' : ' hidden')
  div.textContent = line || ' '
  return div
}

function renderLog() {
  const view = $('#log-view')
  const frag = document.createDocumentFragment()
  for (const line of logs[activeLog]) frag.append(makeLine(line))
  view.replaceChildren(frag)
  view.scrollTop = view.scrollHeight
  errorCounts[activeLog] = 0
  renderBadges()
}

function renderBadges() {
  document.querySelectorAll('#log-tabs button').forEach((b) => {
    const n = errorCounts[b.dataset.key]
    b.querySelector('.badge').textContent = n ? (n > 99 ? '99+' : String(n)) : ''
    b.classList.toggle('active', b.dataset.key === activeLog)
  })
}

function appendLines(key, lines) {
  logs[key].push(...lines)
  if (logs[key].length > 5000) logs[key].splice(0, logs[key].length - 5000)
  const logsOpen = !$('#logs').classList.contains('collapsed')
  if (key !== activeLog || !logsOpen) {
    errorCounts[key] += lines.filter((l) => ERR_RE.test(l)).length
    renderBadges()
    if (key !== activeLog) return
  }
  const view = $('#log-view')
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40
  const frag = document.createDocumentFragment()
  for (const line of lines) frag.append(makeLine(line))
  view.append(frag)
  while (view.childElementCount > 5000) view.firstChild.remove()
  if (atBottom) view.scrollTop = view.scrollHeight
}

document.querySelectorAll('#log-tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    activeLog = b.dataset.key
    setLogsOpen(true)
    renderLog()
  })
)
$('#log-filter').addEventListener('input', renderLog)
$('#errors-only').addEventListener('change', renderLog)
$('#log-clear').addEventListener('click', () => api.clearLog(activeLog))

function setLogsOpen(open) {
  $('#logs').classList.toggle('collapsed', !open)
  api.setLogsOpen(open)
  if (open) {
    errorCounts[activeLog] = 0
    renderBadges()
  }
}
$('#logs-toggle').addEventListener('click', () => setLogsOpen($('#logs').classList.contains('collapsed')))

// ---------------------------------------------------------------- wiring

api.onState((s) => {
  state = s
  renderTiles()
})
api.onLog(({ key, lines }) => appendLines(key, lines))
api.onLogCleared((key) => {
  logs[key] = []
  errorCounts[key] = 0
  if (key === activeLog) renderLog()
  else renderBadges()
})

;(async () => {
  const init = await api.init()
  ariaRoot = init.ariaRoot
  state = init.state
  logs = init.logs
  flags = state.settings.flags ?? []
  await renderWorktrees(init.worktrees)
  setKnownFlags(init.knownFlags)
  $('#backend-args').value = state.settings.backendArgs ?? ''
  renderBackendCmd()
  renderFlags()
  renderTiles()
  $('#logs').classList.toggle('collapsed', state.settings.logsOpen === false)
  renderLog()
})()
