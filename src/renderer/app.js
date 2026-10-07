const api = window.launcher

const $ = (sel) => document.querySelector(sel)
const LOG_KEYS = ['backend', 'desktop', 'launcher']
const NOISE_RE = /Failed to send logs to Better Stack/
const ERR_PATTERN = /\b(error|exception|traceback|fatal|unhandled)\b|\bfailed\b(?!=0)/i
const ERR_RE = { test: (line) => !NOISE_RE.test(line) && ERR_PATTERN.test(line) }
const WARN_RE = /\bwarn(ing)?\b/i
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

async function renderWorktrees(list) {
  const select = $('#worktree')
  select.innerHTML = ''
  for (const wt of list) {
    const opt = document.createElement('option')
    opt.value = wt.path
    opt.textContent = wt.path === ariaRoot ? `${wt.branch}  ·  main checkout` : `${wt.branch}  ·  ${shortWt(wt.path)}`
    select.append(opt)
  }
  if (state) select.value = state.settings.worktree
}

$('#worktree').addEventListener('change', async (e) => {
  setKnownFlags(await api.setWorktree(e.target.value))
})
$('#refresh-worktrees').addEventListener('click', async () => renderWorktrees(await api.worktrees()))
window.addEventListener('focus', async () => renderWorktrees(await api.worktrees()))

// ---------------------------------------------------------------- tiles

function tileView(tile) {
  const selected = state.settings.worktree
  if (tile === 'backend') {
    const b = state.backend
    const on = b.status !== 'off'
    let where = on && b.worktree ? `${shortWt(b.worktree)}${b.port ? ` · :${b.port}` : ''}` : ''
    if (b.others.length) where += `${where ? ' · ' : ''}+${b.others.length} other running`
    return { status: b.status, where, other: on && b.worktree !== selected }
  }
  const d = state.desktop
  if (d.tile !== tile) return { status: tile === pendingTile ? 'starting' : 'off', where: '', other: false }
  let where = tile === 'prod' ? '' : shortWt(d.worktree)
  if (d.waitingForBackend) where = `${where} · waiting for backend`
  if (d.external) where = `${where} · started outside launcher`
  return { status: d.status, where, other: tile !== 'prod' && d.status !== 'off' && d.worktree !== selected }
}

function renderTiles() {
  for (const el of document.querySelectorAll('.tile')) {
    const { status, where, other } = tileView(el.dataset.tile)
    el.dataset.status = status
    el.dataset.other = String(other)
    el.querySelector('.pill').textContent = STATUS_LABEL[status] ?? status
    el.querySelector('.tile-where').textContent = where
    el.title = other ? 'Running from a different worktree than the one selected' : el.dataset.hint ?? ''
  }
}

document.querySelectorAll('.tile').forEach((el) =>
  el.addEventListener('click', async () => {
    const tile = el.dataset.tile
    if (el.dataset.status === 'off' || el.dataset.status === 'error') pendingTile = tile
    renderTiles()
    try {
      await api.toggle(tile)
    } finally {
      pendingTile = null
      renderTiles()
    }
  })
)

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
  renderFlags()
  renderTiles()
  $('#logs').classList.toggle('collapsed', state.settings.logsOpen === false)
  renderLog()
})()
