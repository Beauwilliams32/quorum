// Durable state for Quorum HQ, under ~/.quorum/hq (or QUORUM_HQ_DIR).
//
//   hq.json          the company, agents, goals, tickets, channels, approvals,
//                    wakeups and spend attribution — rewritten atomically
//   messages.jsonl   every channel message ever posted, append-only, signed
//   activity.jsonl   every mutation, append-only, hash-chained
//   archive/*.jsonl  records trimmed out of hq.json by retention (never deleted)
//   keys/*.pem       one Ed25519 key per identity (see identity.js)
//
// The two logs are the record; hq.json is the working set. A crash mid-append
// costs at most the torn last line, which is skipped on load and reported by
// verify() rather than silently absorbed.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { canonical, sha256, verifySignature } from './identity.js'

const WINDOW_PER_CHANNEL = 500
const ACTIVITY_WINDOW = 200
const WAKEUP_RETENTION = 200
const SPEND_RETENTION_MS = 400 * 24 * 60 * 60 * 1000
const GENESIS = '0'.repeat(64)

export const MESSAGE_SIGNED_FIELDS = ['id', 'channelId', 'threadId', 'author', 'text', 'card', 'mentions', 'at']

/** The part of a message its author signs. Anything outside it (presentation, `sig`) is not covered. */
export function signedPart(message) {
  const out = {}
  for (const key of MESSAGE_SIGNED_FIELDS) out[key] = message[key] === undefined ? null : message[key]
  return out
}

// Keyed collections are null-prototype objects: an id such as "__proto__"
// can then only ever be an own key, never a path to Object.prototype.
const MAPS = ['agents', 'goals', 'tickets', 'channels', 'approvals', 'identities', 'roundtables', 'routines']
const dict = (source = {}) => Object.assign(Object.create(null), source && typeof source === 'object' ? source : {})

function emptyState() {
  return {
    version: 1,
    company: null,
    agents: dict(),
    goals: dict(),
    tickets: dict(),
    channels: dict(),
    approvals: dict(),
    wakeups: [],
    spend: [],
    identities: dict(),
    roundtables: dict(),
    routines: dict(),
    counters: { ticket: 0, goal: 0, approval: 0, routine: 0, message: 0 },
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

function readLines(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return { records: [], torn: 0 } }
  const records = []
  let torn = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch { torn += 1 }
  }
  return { records, torn }
}

export class HqStore {
  constructor({ dir }) {
    this.dir = path.resolve(dir)
    this.file = path.join(this.dir, 'hq.json')
    this.messagesFile = path.join(this.dir, 'messages.jsonl')
    this.activityFile = path.join(this.dir, 'activity.jsonl')
    this.data = emptyState()
    this.window = new Map()
    this.activity = []
    this.lastActivity = { seq: 0, hash: GENESIS }
    this.torn = { messages: 0, activity: 0 }
    // Unreadable state found at load, kept aside rather than overwritten.
    this.corrupt = null
    this.recovered = []
    this.load()
  }

  load() {
    let saved = null
    let text = null
    try { text = fs.readFileSync(this.file, 'utf8') } catch { /* first run, or moved aside earlier */ }
    if (text === null) {
      // No hq.json, but an earlier start kept an unreadable one aside: that
      // is still the last company this directory held. The guard stands until
      // a founding with `force` writes a new hq.json (or the kept file is
      // repaired and put back), however many restarts come in between.
      const kept = this.#keptCorrupt()
      if (kept) this.corrupt = { file: kept, kept: true, error: 'it could not be read when Quorum started earlier', earlier: true }
    } else {
      try { saved = JSON.parse(text) } catch (error) {
        // An hq.json that cannot be parsed is the company's working set. Starting
        // empty and letting `init` write over it would be a silent delete, so it
        // is moved aside and `init` refuses until someone decides what to do.
        const aside = path.join(this.dir, `hq.json.corrupt-${stamp()}`)
        let kept = false
        try { fs.renameSync(this.file, aside); kept = true } catch { /* still at hq.json; init refuses to write over it */ }
        this.corrupt = { file: kept ? aside : this.file, kept, error: String(error.message || error).slice(0, 200) }
      }
    }
    this.data = emptyState()
    if (saved && typeof saved === 'object') {
      this.data = { ...emptyState(), ...saved, counters: { ...emptyState().counters, ...(saved.counters || {}) } }
      for (const key of MAPS) this.data[key] = dict(saved[key])
      if (!Array.isArray(this.data.wakeups)) this.data.wakeups = []
      if (!Array.isArray(this.data.spend)) this.data.spend = []
    }

    this.#recoverTail(this.messagesFile)
    this.#recoverTail(this.activityFile)

    const messages = readLines(this.messagesFile)
    this.torn.messages = messages.torn
    this.window = new Map()
    for (const message of messages.records) this.#remember(message)

    const activity = readLines(this.activityFile)
    this.torn.activity = activity.torn
    this.activity = activity.records.slice(-ACTIVITY_WINDOW)
    const last = activity.records[activity.records.length - 1]
    if (last && Number.isInteger(last.seq) && typeof last.hash === 'string') this.lastActivity = { seq: last.seq, hash: last.hash }

    // Ids are never reused. The logs outlive hq.json, so the counters are at
    // least as high as any id the logs have ever named.
    const highest = { ticket: 0, goal: 0, approval: 0, routine: 0 }
    const note = value => {
      const match = String(value || '').match(/^([TGAR])-(\d{1,6})$/)
      if (!match) return
      const kind = { T: 'ticket', G: 'goal', A: 'approval', R: 'routine' }[match[1]]
      highest[kind] = Math.max(highest[kind], Number(match[2]))
    }
    for (const entry of activity.records) note(entry.target)
    for (const message of messages.records) note(message.threadId)
    for (const kind of Object.keys(highest)) this.data.counters[kind] = Math.max(Number(this.data.counters[kind]) || 0, highest[kind])
  }

  /** The newest `hq.json.corrupt-*` kept in this directory, if any. */
  #keptCorrupt() {
    try {
      const name = fs.readdirSync(this.dir).filter(item => item.startsWith('hq.json.corrupt-')).sort().at(-1)
      return name ? path.join(this.dir, name) : null
    } catch { return null }
  }

  /**
   * Move both logs into archive/<label>/ and start them afresh. Used when a
   * new company is founded over one that could not be read: the old history
   * is kept whole, and still verifies with the same keys, but it is not the
   * new company's.
   */
  archiveLogs(label) {
    const dir = path.join(this.dir, 'archive', label)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const moved = []
    for (const file of [this.messagesFile, this.activityFile]) {
      try { fs.renameSync(file, path.join(dir, path.basename(file))); moved.push(path.basename(file)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    this.window = new Map()
    this.activity = []
    this.lastActivity = { seq: 0, hash: GENESIS }
    this.torn = { messages: 0, activity: 0 }
    return { dir, moved }
  }

  /**
   * A crash mid-append leaves a last line with no newline. The next append
   * would glue a new record onto it, losing that record and breaking the
   * chain for good. The torn fragment is moved to archive/ and the log is cut
   * back to its last complete line — nothing is thrown away.
   */
  #recoverTail(file) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { return }
    if (!text || text.endsWith('\n')) return
    const cut = text.lastIndexOf('\n') + 1
    const fragment = text.slice(cut)
    const dir = path.join(this.dir, 'archive')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const kept = path.join(dir, `${path.basename(file)}.torn-${stamp()}`)
    fs.writeFileSync(kept, fragment, { mode: 0o600 })
    fs.truncateSync(file, Buffer.byteLength(text.slice(0, cut)))
    this.recovered.push({ file: path.basename(file), bytes: Buffer.byteLength(fragment), keptAt: kept })
  }

  #ensureDir() { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }) }

  save() {
    this.#ensureDir()
    this.#retain()
    const temp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(this.data) + '\n', { mode: 0o600 })
    fs.renameSync(temp, this.file)
  }

  /** Move records past their retention into archive/<kind>.jsonl. Nothing is dropped. */
  #retain() {
    const done = this.data.wakeups.filter(item => !['queued', 'processing'].includes(item.status))
    if (done.length > WAKEUP_RETENTION) {
      const archived = new Set(done.slice(0, done.length - WAKEUP_RETENTION).map(item => item.id))
      this.#archive('wakeups', this.data.wakeups.filter(item => archived.has(item.id)))
      this.data.wakeups = this.data.wakeups.filter(item => !archived.has(item.id))
    }
    const cutoff = Date.now() - SPEND_RETENTION_MS
    const old = this.data.spend.filter(entry => Number(entry.at) < cutoff)
    if (old.length) {
      this.#archive('spend', old)
      this.data.spend = this.data.spend.filter(entry => Number(entry.at) >= cutoff)
    }
  }

  /** Move records out of hq.json's working set into archive/<kind>.jsonl. Nothing is dropped. */
  archiveRecords(kind, records) { this.#archive(kind, records) }

  #archive(kind, records) {
    if (!records.length) return
    const dir = path.join(this.dir, 'archive')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.appendFileSync(path.join(dir, `${kind}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 })
  }

  #remember(message) {
    const channelId = String(message?.channelId || '')
    if (!channelId) return
    const list = this.window.get(channelId) || []
    list.push(message)
    if (list.length > WINDOW_PER_CHANNEL) list.splice(0, list.length - WINDOW_PER_CHANNEL)
    this.window.set(channelId, list)
  }

  /** Append one already-signed message. */
  appendMessage(message) {
    this.#ensureDir()
    fs.appendFileSync(this.messagesFile, JSON.stringify(message) + '\n', { mode: 0o600 })
    this.#remember(message)
    return message
  }

  /** Messages in a channel's in-memory window, oldest first. Older history stays in messages.jsonl. */
  messages(channelId, { limit = 100, threadId = undefined, before = null } = {}) {
    let list = this.window.get(String(channelId)) || []
    if (threadId !== undefined) list = list.filter(message => (message.threadId || null) === (threadId || null))
    if (before) {
      const at = list.findIndex(message => message.id === before)
      if (at >= 0) list = list.slice(0, at)
    }
    const bounded = Math.max(1, Math.min(Number(limit) || 100, WINDOW_PER_CHANNEL))
    return list.slice(-bounded)
  }

  /** Every message about one ticket, whichever channel carried it. */
  thread(ticketId, limit = 200) {
    const out = []
    for (const list of this.window.values()) for (const message of list) if (message.threadId === ticketId) out.push(message)
    return out.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-limit)
  }

  /**
   * Messages matching a parsed search, from the whole of messages.jsonl — not
   * only the in-memory window — newest last. The file is read line by line
   * and only the newest `limit` matches are kept, so a long history costs
   * time, never unbounded memory. `match(message)` decides; see Hq#search.
   */
  async search(match, { limit = 50 } = {}) {
    const found = []
    let scanned = 0
    let input
    try { input = fs.createReadStream(this.messagesFile, { encoding: 'utf8' }) } catch { return { messages: [], scanned } }
    const lines = readline.createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (!line.trim()) continue
        scanned += 1
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (!match(message)) continue
        found.push(message)
        if (found.length > limit) found.shift()
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return { messages: found, scanned }
  }

  channelStats(channelId) {
    const list = this.window.get(String(channelId)) || []
    return { count: list.length, lastAt: list.length ? list[list.length - 1].at : null }
  }

  /** Append one activity entry to the hash chain and return it. */
  appendActivity({ actor, action, target = null, detail = '' }) {
    this.#ensureDir()
    const entry = {
      seq: this.lastActivity.seq + 1,
      at: new Date().toISOString(),
      actor: actor ? { kind: String(actor.kind || 'board'), id: String(actor.id || 'board') } : { kind: 'system', id: 'system' },
      action: String(action || '').slice(0, 80),
      target: target === null ? null : String(target).slice(0, 120),
      detail: String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      prev: this.lastActivity.hash,
    }
    entry.hash = sha256(entry.prev + canonical({ ...entry, hash: undefined }))
    fs.appendFileSync(this.activityFile, JSON.stringify(entry) + '\n', { mode: 0o600 })
    this.lastActivity = { seq: entry.seq, hash: entry.hash }
    this.activity.push(entry)
    if (this.activity.length > ACTIVITY_WINDOW) this.activity.shift()
    return entry
  }

  recentActivity(limit = 40) { return this.activity.slice(-Math.max(1, Math.min(Number(limit) || 40, ACTIVITY_WINDOW))) }

  /**
   * Re-read both logs from disk and check them: every message against its
   * author's public key, every activity entry against the chain. Reports the
   * first break rather than stopping at "not ok".
   */
  verify() {
    const identities = this.data.identities || {}
    const messages = readLines(this.messagesFile)
    const failed = []
    let verified = 0
    for (const message of messages.records) {
      const author = message?.author || {}
      const identity = author.kind === 'agent' ? `agent:${author.id}` : author.kind
      if (verifySignature(identities[identity], signedPart(message), message.sig)) verified += 1
      else failed.push(message.id || '(no id)')
    }
    const activity = readLines(this.activityFile)
    let prev = GENESIS
    let brokenAt = null
    for (const entry of activity.records) {
      const expected = sha256(prev + canonical({ ...entry, hash: undefined }))
      if (entry.prev !== prev || entry.hash !== expected) { brokenAt = entry.seq ?? '(no seq)'; break }
      prev = entry.hash
    }
    return {
      ok: failed.length === 0 && brokenAt === null && messages.torn === 0 && activity.torn === 0,
      messages: { total: messages.records.length, verified, failed: failed.slice(0, 50), torn: messages.torn },
      activity: { total: activity.records.length, brokenAt, torn: activity.torn, head: prev },
      // Torn tails recovered at load (kept in archive/), and an unreadable
      // hq.json kept aside — reported so a recovery is never invisible.
      recovered: this.recovered.map(item => ({ ...item })),
      corrupt: this.corrupt ? { ...this.corrupt } : null,
      checkedAt: new Date().toISOString(),
    }
  }
}
