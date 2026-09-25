import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Resolving "is this CLI installed?" used to be
// `execFileSync('zsh', ['-lc', 'command -v …'])` — a full login shell, once
// per runtime, on every catalog build, and a catalog is built on every
// WebSocket handshake, every roundtable start and every command preview. On
// this machine that measured 11 login shells and ~71ms per build; the 800ms
// timeout it carried is what a heavy profile (nvm, conda, oh-my-zsh) costs.
//
// The reason it shelled out at all is real: a CLI installed through a profile
// that edits PATH is invisible to a server whose PATH came from launchd. So
// the login PATH is still read from a login shell — exactly once per process
// — and every lookup after that is a stat against the union of that PATH, the
// process PATH, and the usual install prefixes.

const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.bun', 'bin'),
  path.join(os.homedir(), 'bin'),
]

const DEFAULT_TTL_MS = 60_000

let loginPathCache = null
const resolved = new Map()

/**
 * The PATH a login shell would give us, read once. A failure here is not
 * fatal: the process PATH and the standard prefixes still resolve almost
 * everything, and the lookup simply sees one fewer directory.
 */
export function loginPath() {
  if (loginPathCache !== null) return loginPathCache
  loginPathCache = ''
  if (process.platform === 'win32') return loginPathCache
  const shell = process.env.SHELL && path.basename(process.env.SHELL) ? process.env.SHELL : '/bin/sh'
  try {
    loginPathCache = String(execFileSync(shell, ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })).trim()
  } catch { /* a non-interactive or missing login shell leaves PATH as-is */ }
  return loginPathCache
}

function searchDirs(env) {
  const dirs = [
    ...String(env.PATH || '').split(path.delimiter),
    ...loginPath().split(path.delimiter),
    ...EXTRA_PATHS,
  ]
  return [...new Set(dirs.map(dir => dir.trim()).filter(Boolean))]
}

function lookup(command, env) {
  if (path.isAbsolute(command)) {
    try { return fs.statSync(command).isFile() ? command : null } catch { return null }
  }
  if (!/^[\w.@+-]+$/.test(command)) return null
  for (const dir of searchDirs(env)) {
    const candidate = path.join(dir, command)
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111))) return candidate
    } catch { /* next candidate */ }
  }
  return null
}

/**
 * Absolute path of `command`, or null. Memoised for `ttl` so a burst of
 * catalog builds — a handshake, a preview and a roundtable start in the same
 * second — pays for one resolution, while a CLI installed while the cockpit
 * is running still appears within a minute.
 */
export function resolveCommand(command, { env = process.env, ttl = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!command) return null
  const key = String(command)
  const hit = resolved.get(key)
  if (hit && now - hit.at < ttl) return hit.path
  const found = lookup(key, env)
  resolved.set(key, { path: found, at: now })
  return found
}

export function hasCommand(command, options = {}) {
  return Boolean(resolveCommand(command, options))
}

/** Forget every memoised lookup — and, optionally, the captured login PATH. */
export function invalidateCommandCache({ loginPath: alsoLoginPath = false } = {}) {
  resolved.clear()
  if (alsoLoginPath) loginPathCache = null
}

/** Test seam: how many commands are currently memoised. */
export function commandCacheSize() { return resolved.size }
