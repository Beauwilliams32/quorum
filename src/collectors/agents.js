import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveProjectId } from './projects.js'

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions')

// Claude Code writes one file per running session here, with a real live
// `status` and `cwd`. That beats inferring activity from transcript mtimes:
// it distinguishes idle-but-alive from gone, which is what makes an avatar
// sit still in a room instead of vanishing between ticks.
function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function buildAgents(dir = SESSIONS_DIR) {
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return { agents: [], ts: Date.now() } }

  const agents = []
  for (const f of files) {
    let raw
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { continue }
    const pid = Number(raw?.pid)
    if (!pid || !raw?.sessionId) continue
    if (!alive(pid)) continue

    agents.push({
      pid,
      sessionId: raw.sessionId,
      name: raw.name || String(raw.sessionId).slice(0, 8),
      cwd: raw.cwd || null,
      projectId: resolveProjectId(raw.cwd),
      kind: raw.kind || 'interactive',
      entrypoint: raw.entrypoint || null,
      status: raw.status || null,
      version: raw.version || null,
      startedAt: raw.startedAt || null,
      statusUpdatedAt: raw.statusUpdatedAt || null,
      // Presence of a socket path is what makes browser chat possible at all;
      // desktop-launched sessions leave it null.
      chatCapable: !!raw.messagingSocketPath && fs.existsSync(raw.messagingSocketPath),
    })
  }

  agents.sort((a, b) => (b.statusUpdatedAt || 0) - (a.statusUpdatedAt || 0))
  return { agents, ts: Date.now() }
}

export function startAgents(state) {
  const tick = () => {
    try { state.update('agents', buildAgents()) } catch { /* never die */ }
  }
  tick()
  return setInterval(tick, 2000)
}
