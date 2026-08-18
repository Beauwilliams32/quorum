import fs from 'node:fs'
import { DATA_DIR, dataDir, findFile } from './paths.js'

const DIR = DATA_DIR
const FILE = dataDir('presence.json')
const MAX = 40

function readPresence() {
  // Reads may still come from the pre-rename home; writes never do.
  const file = findFile('presence.json') || FILE
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data?.seats) ? data : { seats: [] }
  } catch {
    return { seats: [] }
  }
}

function writePresence(data) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2))
}

/**
 * Stamp a seat when Office / drawer spawns an agent into a project room.
 * Never stores secrets — projectId, agent, pty id, cwd, ts only.
 */
export function stampPresence({ projectId, agent, ptyId, cwd }) {
  if (!projectId && !cwd) return
  const data = readPresence()
  const seat = {
    projectId: projectId || null,
    agent: agent || 'shell',
    ptyId: ptyId || null,
    cwd: cwd || null,
    ts: Date.now(),
  }
  data.seats = [seat, ...data.seats.filter(s => !(s.ptyId && s.ptyId === ptyId))].slice(0, MAX)
  writePresence(data)
  return seat
}

export function loadPresence() {
  return readPresence()
}

export { FILE as PRESENCE_FILE }
