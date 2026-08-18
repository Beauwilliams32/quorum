import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadConfig, defaultRoots, discoverProjects, slug, CONFIG_PATH } from '../config.js'

const HOME = os.homedir()
const CLAUDE_ROOT = path.join(HOME, 'CLAUDE')

/**
 * Named rooms for this machine's own workspace layout. These predate the
 * config system and stay because the folder names alone don't produce the
 * right labels ('nil-platform' is Trident NIL) or the right nesting
 * (apps/mac beats trident-tools by prefix length). On any other machine every
 * one of these fails the existence check in buildCatalog and vanishes,
 * leaving discovery in charge — they are defaults, not requirements.
 */
const LEGACY_CATALOG = [
  { id: 'portal', label: 'Williams Media Portal', pathPrefix: path.join(CLAUDE_ROOT, 'williams-media-portal') },
  { id: 'nil', label: 'Trident NIL', pathPrefix: path.join(CLAUDE_ROOT, 'nil-platform') },
  { id: 'ops', label: 'Trident Ops', pathPrefix: path.join(CLAUDE_ROOT, 'localops-ai-saas') },
  { id: 'trident-tools-mac', label: 'Trident Tools Mac', pathPrefix: path.join(CLAUDE_ROOT, 'trident-tools', 'apps', 'mac') },
  { id: 'trident-tools', label: 'Trident Tools', pathPrefix: path.join(CLAUDE_ROOT, 'trident-tools') },
  { id: 'playbook', label: 'Trident Playbook', pathPrefix: path.join(CLAUDE_ROOT, 'trident-playbook') },
  { id: 'social', label: 'Trident Social', pathPrefix: path.join(CLAUDE_ROOT, 'trident-social') },
  { id: 'portfolio', label: 'Beau Portfolio', pathPrefix: path.join(CLAUDE_ROOT, 'beau-portfolio') },
  { id: 'filippa', label: 'Filippa Dressage', pathPrefix: path.join(CLAUDE_ROOT, 'filippa-dressage') },
  { id: 'uao', label: 'Quorum', pathPrefix: path.join(CLAUDE_ROOT, 'unified-ai-operator') },
  { id: 'memory-bridge', label: 'Agent Memory Bridge', pathPrefix: path.join(CLAUDE_ROOT, 'agent-memory-bridge') },
  { id: 'trader', label: 'Trader Bot', pathPrefix: path.join(CLAUDE_ROOT, 'Projects', 'Trader') },
]

/**
 * Build the live catalog. Precedence, first match by path wins:
 * config.projects → legacy named rooms → auto-discovered → catch-alls.
 *
 * Catch-alls are deliberately last and deliberately short. Longest-prefix wins
 * in resolveProjectId, so a real project always beats them; without them,
 * worktrees and home-dir sessions resolve to null and get dropped from the
 * floor entirely — which is most of the live agents.
 */
export function buildCatalog() {
  const cfg = loadConfig()
  const roots = cfg.roots || defaultRoots()
  const hidden = new Set(cfg.hidden)

  const out = []
  const seenPath = new Set()
  const seenId = new Set()

  const add = entry => {
    const key = path.resolve(entry.pathPrefix)
    if (seenPath.has(key) || hidden.has(entry.id)) return
    let id = entry.id
    // Two different folders can slug identically ('api' under two roots) —
    // suffix rather than drop, or one of them silently loses its room.
    while (seenId.has(id)) id = id + '2'
    seenPath.add(key)
    seenId.add(id)
    out.push({ ...entry, id })
  }

  for (const p of cfg.projects) add(p)
  for (const p of LEGACY_CATALOG) if (existsDir(p.pathPrefix)) add(p)
  for (const p of discoverProjects(roots)) add(p)

  for (const root of roots) {
    if (path.resolve(root) === path.resolve(HOME)) continue
    add({ id: slug(path.basename(root)) + '-root', label: `Workspace (${path.basename(root)})`, pathPrefix: root, catchAll: true })
  }
  add({ id: 'home', label: 'Home / Machine', pathPrefix: HOME, catchAll: true })

  lastConfig = { ...cfg, roots, discovered: out.filter(p => p.discovered).length, total: out.length }
  return out
}

function existsDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

let lastConfig = null

/** What the UI shows about where the catalog came from — see the setup card. */
export function configInfo() {
  if (!lastConfig) buildCatalog()
  return {
    path: lastConfig.path || CONFIG_PATH,
    exists: !!lastConfig.exists,
    malformed: !!lastConfig.malformed,
    roots: lastConfig.roots,
    discovered: lastConfig.discovered,
    total: lastConfig.total,
  }
}

/**
 * The live catalog. Mutated in place on refresh rather than reassigned so
 * that resolveProjectId's default parameter — captured once at module load —
 * always sees the current contents.
 */
export const PROJECT_CATALOG = buildCatalog()

export function refreshCatalog() {
  const next = buildCatalog()
  PROJECT_CATALOG.length = 0
  PROJECT_CATALOG.push(...next)
  return PROJECT_CATALOG
}

/** Normalize path for prefix checks (resolve + strip trailing slash). */
export function normalizeCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return null
  try {
    return path.resolve(cwd.replace(/^~(?=\/|$)/, HOME))
  } catch {
    return null
  }
}

/**
 * Map a working directory to a catalog project id.
 * Prefers the longest matching pathPrefix so apps/mac wins over trident-tools.
 */
export function resolveProjectId(cwd, catalog = PROJECT_CATALOG) {
  const resolved = normalizeCwd(cwd)
  if (!resolved) return null
  let best = null
  let bestLen = -1
  for (const p of catalog) {
    const prefix = path.resolve(p.pathPrefix)
    if (resolved === prefix || resolved.startsWith(prefix + path.sep)) {
      if (prefix.length > bestLen) {
        best = p.id
        bestLen = prefix.length
      }
    }
  }
  return best
}

export function projectById(id, catalog = PROJECT_CATALOG) {
  return catalog.find(p => p.id === id) || null
}

/** Only list rooms whose path exists on disk (or always-show core set). */
function roomExists(p) {
  try {
    return fs.existsSync(p.pathPrefix)
  } catch {
    return false
  }
}

/**
 * Build Office payload: team desks + project rooms with seated sessions.
 */
export function buildOffice(stateData, catalog = PROJECT_CATALOG) {
  const sessions = stateData.sessions?.cards || []
  const groups = stateData.processes?.groups || {}
  const services = stateData.services || {}

  const team = [
    { id: 'claude', label: 'Claude', alive: (groups.claude || 0) > 0, count: groups.claude || 0 },
    { id: 'codex', label: 'Codex', alive: (groups.codex || 0) > 0, count: groups.codex || 0 },
    { id: 'hermes', label: 'Hermes', alive: !!(services.hermes?.up || (groups.hermes || 0) > 0), count: groups.hermes || 0 },
    { id: 'comfy', label: 'Comfy', alive: !!(services.comfy?.up || (groups.comfy || 0) > 0), count: groups.comfy || 0 },
  ]

  const byProject = new Map()
  for (const c of sessions) {
    const pid = c.projectId || resolveProjectId(c.cwd, catalog)
    if (!pid) continue
    if (!byProject.has(pid)) byProject.set(pid, [])
    byProject.get(pid).push(c)
  }

  const rooms = catalog.filter(roomExists).map(p => {
    const seated = (byProject.get(p.id) || []).slice().sort((a, b) => b.mtimeMs - a.mtimeMs)
    const active = seated.filter(s => s.active)
    const agents = [...new Set(seated.map(s => s.agent))]
    return {
      id: p.id,
      label: p.label,
      cwd: p.pathPrefix,
      exists: true,
      active: active.length > 0,
      sessionCount: seated.length,
      agents,
      summary: (active[0] || seated[0])?.summary || null,
      topSessionFile: (active[0] || seated[0])?.file || null,
      topSessionAgent: (active[0] || seated[0])?.agent || null,
    }
  })

  return {
    team,
    rooms,
    catalog: catalog.map(p => ({ id: p.id, label: p.label, cwd: p.pathPrefix, exists: roomExists(p) })),
    ts: Date.now(),
  }
}

export function startProjects(state) {
  const tick = () => {
    try {
      // Ensure session cards carry projectId even if sessions collector raced.
      const cards = state.data.sessions?.cards
      if (cards) {
        for (const c of cards) {
          if (!c.projectId) c.projectId = resolveProjectId(c.cwd)
        }
      }
      state.update('projects', { ...buildOffice(state.data), config: configInfo() })
    } catch { /* collector must never die */ }
  }
  tick()
  setInterval(tick, 2000)
  // Config edits and newly-cloned repos appear without a restart. 30s, not the
  // 2s office tick: a full directory scan per render tick would be wasted disk
  // churn for something that changes a few times a day at most.
  setInterval(() => { try { refreshCatalog() } catch { /* keep old catalog */ } }, 30_000)
}
