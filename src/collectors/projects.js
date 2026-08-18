import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()
const CLAUDE_ROOT = path.join(HOME, 'CLAUDE')

/**
 * Fixed project catalog for the Office floor.
 * Longer pathPrefix wins when resolving cwd (see resolveProjectId).
 */
export const PROJECT_CATALOG = [
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
  // Catch-alls, deliberately last and deliberately short. Longest-prefix wins,
  // so a real project always beats these. Without them, superproject worktrees
  // (~/CLAUDE/.claude/worktrees/*) and home-dir sessions resolve to null and
  // get dropped from the floor entirely — which is most of the live agents.
  { id: 'workspace', label: 'Workspace (superproject)', pathPrefix: CLAUDE_ROOT },
  { id: 'home', label: 'Home / Machine', pathPrefix: HOME },
]

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
      state.update('projects', buildOffice(state.data))
    } catch { /* collector must never die */ }
  }
  tick()
  setInterval(tick, 2000)
}
