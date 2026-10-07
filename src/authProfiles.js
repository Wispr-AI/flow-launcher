// Keeps separate Wispr Flow logins for the prod and local backends.
//
// The installed app and every dev build share one electron-store file,
// ~/Library/Application Support/Wispr Flow/session.json. Signing the local desktop in against the
// local backend makes the app drop the other provider's session, so a local run wipes the real
// login. Before each desktop launch we split the file by owner, save each half to its own
// profile (0600, in the launcher's own userData), and write back only the half the next launch
// needs.
//
// Ownership is by key: Supabase stores its session under `sb-<first label of the host>-…`, so the
// local GoTrue (127.0.0.1 / localhost) keys are local; everything else (prod Supabase, WorkOS,
// device-code state) is prod. `authProviderId` is per-profile and `__internal__` (electron-store
// metadata) is kept in both.

const fs = require('fs')
const os = require('os')
const path = require('path')

const SESSION_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'Wispr Flow', 'session.json')
const LOCAL_KEY = /^sb-(127|localhost)-/
const SHARED_KEYS = ['__internal__']

const profileForTile = (tile) => (tile === 'local-local' ? 'local' : 'prod')

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.flow-launcher.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, '\t'), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Splits a session file into its local- and prod-owned halves. */
function split(session) {
  const local = {}
  const prod = {}
  const shared = {}
  for (const [k, v] of Object.entries(session)) {
    if (SHARED_KEYS.includes(k)) shared[k] = v
    else if (k === 'authProviderId') continue
    else if (LOCAL_KEY.test(k)) local[k] = v
    else prod[k] = v
  }
  const hasProdLogin = Object.keys(prod).some((k) => k === 'workosSession' || k.startsWith('sb-'))
  return { local, prod, shared, hasLocalLogin: Object.keys(local).length > 0, hasProdLogin }
}

/**
 * Makes session.json hold only `target`'s login ('local' | 'prod'), first saving whatever logins
 * it currently holds into `profilesDir`. Must only run while no Wispr Flow app is running.
 * Returns a short description for the log.
 */
function switchTo(target, profilesDir, sessionFile = SESSION_FILE) {
  const session = readJson(sessionFile)
  if (session === null && fs.existsSync(sessionFile)) return 'session.json is not valid JSON, left untouched'

  // One-time safety copy of whatever was there before the launcher first touched it.
  const backup = path.join(profilesDir, 'session.original.json')
  if (session && !fs.existsSync(backup)) writeJson(backup, session)

  const files = { local: path.join(profilesDir, 'local.json'), prod: path.join(profilesDir, 'prod.json') }
  const saved = { local: readJson(files.local), prod: readJson(files.prod) }
  const { local, prod, shared, hasLocalLogin, hasProdLogin } = split(session ?? {})

  // authProviderId belongs to the local half only when the local login is the sole one present
  // (the local backend never uses WorkOS).
  const provider = session?.authProviderId
  const providerIsLocal = provider === 'supabase' && hasLocalLogin && !hasProdLogin

  // If the profile that was last active no longer has a login, the user signed out on purpose:
  // forget it rather than bring it back.
  const activeFile = path.join(profilesDir, 'active')
  const lastActive = fs.existsSync(activeFile) ? fs.readFileSync(activeFile, 'utf8').trim() : null
  const stillSignedIn = { local: hasLocalLogin, prod: hasProdLogin }
  if (lastActive in stillSignedIn && !stillSignedIn[lastActive] && saved[lastActive]) {
    saved[lastActive] = null
    fs.rmSync(files[lastActive], { force: true })
  }

  if (hasLocalLogin) saved.local = { ...shared, ...local, authProviderId: 'supabase' }
  if (hasProdLogin) {
    const prodProvider = provider && !providerIsLocal
      ? provider
      : (saved.prod?.authProviderId ?? ('workosSession' in prod ? 'workos' : 'supabase'))
    saved.prod = { ...shared, ...prod, authProviderId: prodProvider }
  } else if (Object.keys(prod).length && saved.prod) {
    // Non-login prod state (e.g. device-code progress): fold it into the saved profile.
    saved.prod = { ...saved.prod, ...prod }
  }

  if (saved.local) writeJson(files.local, saved.local)
  if (saved.prod) writeJson(files.prod, saved.prod)
  writeJson(sessionFile, saved[target] ?? { ...shared })
  fs.writeFileSync(activeFile, target)

  if (saved[target]) return `Restored the ${target} login`
  return target === 'local'
    ? 'No saved local login yet; the app will sign in as dev@wispr.ai'
    : 'No saved prod login yet; sign in once and it will be kept from now on'
}

module.exports = { switchTo, profileForTile, split, SESSION_FILE }
