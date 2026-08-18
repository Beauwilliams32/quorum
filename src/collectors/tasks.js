import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveProjectId } from './projects.js'

const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks')
const STATUS_ORDER = { in_progress: 0, pending: 1, completed: 2 }

// Cache parsed task files by path; re-read only when mtime/size changes.
const cache = new Map()

function readTask(file, st) {
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.task
  let task = null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && typeof raw.subject === 'string') {
      task = {
        id: String(raw.id ?? path.basename(file, '.json')),
        subject: raw.subject,
        description: typeof raw.description === 'string' ? raw.description : '',
        activeForm: typeof raw.activeForm === 'string' ? raw.activeForm : '',
        status: STATUS_ORDER[raw.status] !== undefined ? raw.status : 'pending',
        blockedBy: Array.isArray(raw.blockedBy) ? raw.blockedBy.map(String) : [],
        blocks: Array.isArray(raw.blocks) ? raw.blocks.map(String) : [],
      }
    }
  } catch { /* a half-written file just skips this tick */ }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, task })
  return task
}

// sessionId -> { projectId, agent, cwd, active }
// Two sources: transcript cards (48h window, includes finished sessions) and the
// live session registry. The registry wins on conflict — it carries a real
// status rather than one inferred from file mtime.
function sessionIndex(stateData) {
  const idx = new Map()
  for (const c of stateData?.sessions?.cards || []) {
    idx.set(c.id, {
      projectId: c.projectId || resolveProjectId(c.cwd),
      agent: c.agent,
      cwd: c.cwd,
      active: !!c.active,
    })
  }
  for (const a of stateData?.agents?.agents || []) {
    idx.set(a.sessionId, {
      projectId: a.projectId,
      agent: 'claude',
      cwd: a.cwd,
      active: a.status === 'busy',
    })
  }
  return idx
}

export function buildTasks(stateData, dir = TASKS_DIR) {
  const idx = sessionIndex(stateData)
  const tasks = []
  let sessionDirs = []
  try { sessionDirs = fs.readdirSync(dir) } catch { return empty() }

  for (const sessionId of sessionDirs) {
    const sdir = path.join(dir, sessionId)
    let files = []
    try {
      if (!fs.statSync(sdir).isDirectory()) continue
      files = fs.readdirSync(sdir).filter((f) => f.endsWith('.json'))
    } catch { continue }

    const meta = idx.get(sessionId) || null
    for (const f of files) {
      const file = path.join(sdir, f)
      let st
      try { st = fs.statSync(file) } catch { continue }
      const task = readTask(file, st)
      if (!task) continue
      tasks.push({
        ...task,
        sessionId,
        projectId: meta?.projectId ?? null,
        agent: meta?.agent ?? null,
        live: !!meta,
        sessionActive: !!meta?.active,
        mtimeMs: st.mtimeMs,
      })
    }
  }

  tasks.sort((a, b) => {
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    if (s !== 0) return s
    return b.mtimeMs - a.mtimeMs
  })

  const counts = { pending: 0, in_progress: 0, completed: 0 }
  const byProject = {}
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] || 0) + 1
    const key = t.projectId || '_unassigned'
    if (!byProject[key]) byProject[key] = { pending: 0, in_progress: 0, completed: 0 }
    byProject[key][t.status] = (byProject[key][t.status] || 0) + 1
  }

  // The board only shows open work plus recently-finished items; completed tasks
  // from months of sessions would otherwise bury everything actionable.
  const open = tasks.filter((t) => t.status !== 'completed')
  const recentDone = tasks.filter((t) => t.status === 'completed').slice(0, 15)

  return { tasks: [...open, ...recentDone].slice(0, 200), counts, byProject, ts: Date.now() }
}

function empty() {
  return { tasks: [], counts: { pending: 0, in_progress: 0, completed: 0 }, byProject: {}, ts: Date.now() }
}

export function startTasks(state) {
  const tick = () => {
    try { state.update('tasks', buildTasks(state.data)) } catch { /* never die */ }
  }
  tick()
  return setInterval(tick, 3000)
}
