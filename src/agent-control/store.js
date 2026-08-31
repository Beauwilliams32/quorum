import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_DIR = path.join(os.homedir(), '.quorum', 'agent-control')
const LEGACY_DIR = path.join(os.homedir(), '.agent-control')
const SECRET_KEY = /(token|secret|password|credential|api[-_]?key|authorization|prompt|transcript|payload)/i
const SECRET_VALUE = /(bearer\s+|sk-[a-z0-9]|ghp_[a-z0-9]|xox[baprs]-|AIza[a-z0-9])/i

export function redact(value, depth = 0) {
  if (depth > 5) return '[redacted-depth]'
  if (typeof value === 'string') return SECRET_VALUE.test(value) ? '[redacted]' : value.replace(/\s+/g, ' ').slice(0, 500)
  if (Array.isArray(value)) return value.slice(0, 40).map(item => redact(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redact(item, depth + 1)]))
  }
  return value
}

export class AgentControlStore {
  constructor(dir = process.env.AGENT_CONTROL_STATE_DIR || DEFAULT_DIR) {
    this.dir = path.resolve(dir)
    this.file = path.join(this.dir, 'state.json')
    this.state = this.#read()
  }

  #read() {
    try {
      const current = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const value = current
      return { runs: {}, claims: {}, actions: {}, checkpoints: {}, events: [], ...value }
    } catch {
      // Existing installs used ~/.agent-control. Read it only when the new
      // location has no state; never move or delete the legacy evidence.
      try {
        const legacy = JSON.parse(fs.readFileSync(path.join(LEGACY_DIR, 'state.json'), 'utf8'))
        return { runs: {}, claims: {}, actions: {}, checkpoints: {}, events: [], ...legacy }
      } catch { return { runs: {}, claims: {}, actions: {}, checkpoints: {}, events: [] } }
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(redact(this.state), null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(temp, this.file)
  }

  append(kind, record) {
    if (!this.state[kind]) this.state[kind] = {}
    this.state[kind][record.id] = redact(record)
    this.state.events.push(redact({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, runId: record.runId, ts: Date.now(), status: record.status }))
    if (this.state.events.length > 500) this.state.events.splice(0, this.state.events.length - 500)
    this.save()
    return this.state[kind][record.id]
  }

  list(kind) { return Object.values(this.state[kind] || {}).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))) }
  get(kind, id) { return this.state[kind]?.[id] || null }
  delete(kind, id) { if (this.state[kind]?.[id]) { delete this.state[kind][id]; this.save() } }
}
