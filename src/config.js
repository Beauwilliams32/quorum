// User configuration — `~/.quorum/config.json`.
//
// Quorum has to work on a machine that is not the author's, and the single
// biggest obstacle to that was a hardcoded project catalog: on anyone else's
// machine the floor rendered empty and the product looked broken inside thirty
// seconds. The fix is layered so that zero configuration still produces a
// working floor:
//
//   1. `projects` in config.json — explicit, wins over everything
//   2. auto-discovery under `roots` (default: ~/CLAUDE if present, else the
//      first plausible workspace dir, else the home directory itself)
//   3. catch-all rooms for each root and for $HOME, so a session whose cwd
//      matches nothing named still lands somewhere visible
//
// The file is read fresh on every catalog refresh (30s) rather than cached for
// the process lifetime, so editing it takes effect without a restart — the
// README tells users to "edit and watch the floor change", and that promise has
// to actually hold.
//
// Shape (all keys optional):
// {
//   "roots":    ["~/code", "~/work"],          // dirs to scan for projects
//   "projects": [{ "id": "api", "label": "Billing API", "path": "~/code/api" }],
//   "hidden":   ["some-discovered-id"]          // discovered rooms to suppress
// }

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findFile, DATA_DIR } from './paths.js'
import { validateRuntime } from './validate.js'

const HOME = os.homedir()

export const CONFIG_PATH = path.join(DATA_DIR, 'config.json')

const expand = p => path.resolve(String(p).replace(/^~(?=\/|$)/, HOME))

export function loadConfig() {
  const file = findFile('config.json')
  if (!file) return { roots: null, projects: [], hidden: [], runtimes: [], models: [], path: CONFIG_PATH, exists: false }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      roots: Array.isArray(raw.roots) && raw.roots.length ? raw.roots.map(expand) : null,
      projects: (Array.isArray(raw.projects) ? raw.projects : [])
        .filter(p => p && p.path)
        .map(p => ({
          id: slug(p.id || path.basename(String(p.path))),
          label: String(p.label || p.id || path.basename(String(p.path))).slice(0, 60),
          pathPrefix: expand(p.path),
        })),
      hidden: (Array.isArray(raw.hidden) ? raw.hidden : []).map(String),
      // Extra agent CLIs (gemini, aider, goose, …) — validated because the
      // command string ends up executed; a bad entry is dropped, not fatal.
      runtimes: (Array.isArray(raw.runtimes) ? raw.runtimes : [])
        .map(r => validateRuntime(r))
        .filter(v => v.ok)
        .map(v => v.value)
        .slice(0, 12),
      // Extra roundtable models beyond sonnet/opus/haiku — any name the
      // `claude` CLI accepts (full model ids included).
      models: (Array.isArray(raw.models) ? raw.models : [])
        .filter(m => typeof m === 'string' && m.trim())
        .map(m => m.trim().slice(0, 80))
        .slice(0, 20),
      path: file,
      exists: true,
    }
  } catch {
    // A malformed config must not blank the floor — fall back to discovery and
    // surface the problem through configInfo() rather than dying silently.
    return { roots: null, projects: [], hidden: [], runtimes: [], models: [], path: file, exists: true, malformed: true }
  }
}

/**
 * The launchable runtime set: built-ins plus the config's own agents. Built-in
 * ids can't be overridden — a config that silently rebound `claude` to another
 * binary would be indistinguishable from the real thing in the UI.
 */
export const BUILTIN_RUNTIMES = [
  { id: 'claude', label: 'claude', command: 'claude', builtin: true },
  { id: 'codex', label: 'codex', command: 'codex', builtin: true },
  { id: 'hermes', label: 'hermes', command: 'hermes', builtin: true },
  { id: 'shell', label: 'zsh', command: null, builtin: true },
]

export function loadRuntimes() {
  const cfg = loadConfig()
  const taken = new Set(BUILTIN_RUNTIMES.map(r => r.id))
  const extra = (cfg.runtimes || []).filter(r => !taken.has(r.id))
  return [...BUILTIN_RUNTIMES, ...extra]
}

/** Roundtable model choices: the standard trio plus anything from config. */
export const BUILTIN_MODELS = ['sonnet', 'opus', 'haiku']

export function loadModels() {
  const cfg = loadConfig()
  return [...new Set([...BUILTIN_MODELS, ...(cfg.models || [])])]
}

/**
 * Default scan roots when the config names none. ~/CLAUDE is this machine's
 * layout; the generic candidates cover the common conventions elsewhere. The
 * home directory is the last resort so a brand-new install still shows rooms.
 */
export function defaultRoots() {
  const candidates = [
    path.join(HOME, 'CLAUDE'),
    path.join(HOME, 'code'),
    path.join(HOME, 'dev'),
    path.join(HOME, 'src'),
    path.join(HOME, 'projects'),
    path.join(HOME, 'Projects'),
    path.join(HOME, 'workspace'),
  ]
  const found = candidates.filter(isDir)
  return found.length ? found : [HOME]
}

/**
 * A directory is a project when it carries any recognisable project marker.
 * The marker list is deliberately broad — a project with none of these is rare,
 * and a false positive only costs an extra idle room on the floor.
 */
const MARKERS = ['.git', 'package.json', 'CLAUDE.md', 'wrangler.toml', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'Makefile', '.claude']
const SKIP = new Set(['node_modules', 'archive', 'dist', 'build', 'tmp', 'Library', 'Applications', 'Desktop', 'Downloads', 'Documents', 'Movies', 'Music', 'Pictures', 'Public'])

export function discoverProjects(roots) {
  const out = []
  for (const root of roots) {
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue
      const full = path.join(root, e.name)
      if (!MARKERS.some(m => exists(path.join(full, m)))) continue
      out.push({ id: slug(e.name), label: titleize(e.name), pathPrefix: full, discovered: true })
    }
  }
  return out
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'
}

function titleize(name) {
  return String(name).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 60)
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
function exists(p) {
  try { fs.accessSync(p); return true } catch { return false }
}
