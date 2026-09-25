import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_DIR = path.join(os.homedir(), '.quorum', 'agent-control')
const LEGACY_DIR = path.join(os.homedir(), '.agent-control')
// The journal is the durable record, so the snapshot exists only to bound how
// much of it has to be replayed at startup. It is therefore written after the
// store goes quiet, or as soon as the journal has outgrown this much — never
// once per streamed provider event.
const SAVE_DELAY_MS = 1_000
const SNAPSHOT_JOURNAL_BYTES = 1 << 20
const SECRET_KEY = /(token|secret|password|credential|api[-_]?key|prompt|transcript|payload)/i
const AUTHORIZATION_SECRET_KEY = /authorization/i
// A key prefix only counts where a token starts. Unanchored, `sk-[a-z0-9]`
// matched inside ordinary words and inside Quorum's own ids, and a match
// replaces the whole string: `task-1` (the default mission task id), a
// `…/desk-app` worktree, and every id minted in a millisecond whose base36
// form ends in "sk" (1 in 1296, e.g. `verification-mudnh4sk-3fa1b2c4`) all
// became '[redacted]'. Records are keyed by id, so same-millisecond
// verifications then overwrote one another under that one key, and an
// authorization minted that way could no longer be found.
const SECRET_VALUE = /bearer\s+|(?<![a-z0-9])(?:sk-|ghp_|xox[baprs]-|AIza)[a-z0-9]/i

// Retention. `redact(this.state)` on every save used to bound these
// collections as a side effect of `Object.entries(...).slice(0, 80)` — which
// is also how it silently deleted the user's evidence past 80 records.
// Dropping that re-redaction fixed the data loss and left nothing bounding the
// store at all, so retention is now explicit: a cap per collection, the
// oldest-admitted records moved to an append-only archive beside the state
// file, and a running count of what was moved kept in the state itself. The
// hot file stops growing; nothing is deleted.
export const RETENTION = {
  runs: 400, claims: 400, actions: 1_000, checkpoints: 1_000,
  executionPlans: 400, evidence: 2_000, verifications: 2_000,
  learning: 500, spend: 1_000, runtimeEvents: 2_000,
}

// A run or claim that is still doing something is never archived, however old
// it is: retention is about history, not about live work.
const LIVE_RUN = new Set(['active', 'stale', 'recovery-pending'])
const isLive = (kind, record) => (kind === 'runs' && LIVE_RUN.has(record?.status)) || (kind === 'claims' && record?.status === 'active')

export function redact(value, depth = 0) {
  if (depth > 5) return '[redacted-depth]'
  if (typeof value === 'string') return SECRET_VALUE.test(value) ? '[redacted]' : value.replace(/\s+/g, ' ').slice(0, 500)
  if (Array.isArray(value)) return value.slice(0, 40).map(item => redact(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => {
      const secretKey = SECRET_KEY.test(key) || AUTHORIZATION_SECRET_KEY.test(key) && !/^authorizationIds?$/i.test(key)
      return [key, secretKey ? '[redacted]' : redact(item, depth + 1)]
    }))
  }
  return value
}

/**
 * Apply journal ops to a state object, skipping anything `absorbed` already
 * records as folded in, and updating it as it goes. Returns the highest
 * sequence seen. Shared by startup replay and by the pre-snapshot absorb.
 */
function applyOps(state, lines, absorbed) {
  let highest = Number(state.journalSeq || 0)
  for (const line of lines) {
    if (!line.trim()) continue
    let op
    try { op = JSON.parse(line) } catch { continue }   // a torn tail costs its own line
    // Sequence numbers are per writer: two processes deal them from the same
    // snapshot, so a single counter cannot order a shared journal. Each
    // writer's own high-water mark is tracked separately, and a line with no
    // writer id (written before this scheme) falls back to the snapshot's.
    const writer = String(op.w || '')
    if (!(Number(op.s) > (absorbed.get(writer) ?? -1))) continue
    absorbed.set(writer, Number(op.s) || 0)
    if (op.k && op.r?.id) {
      if (!state[op.k]) state[op.k] = {}
      state[op.k][op.r.id] = op.r
    }
    if (Array.isArray(op.del) && op.k && state[op.k]) for (const id of op.del) delete state[op.k][id]
    if (op.e) {
      if (!Array.isArray(state.events)) state.events = []
      state.events.push(op.e)
      if (state.events.length > 500) state.events.splice(0, state.events.length - 500)
    }
    if (op.m) { if (!state.markers) state.markers = {}; state.markers[op.m.key] = op.m.value }
    // Retention counters live in the state, so a crash before the next
    // snapshot must not lose the record of what was archived — otherwise
    // "400 runs" reads as "all the runs there have ever been".
    if (op.ret?.k) { if (!state.retention) state.retention = {}; state.retention[op.ret.k] = op.ret.v }
    highest = Math.max(highest, Number(op.s) || 0)
    state.journalSeq = Number(op.s)
  }
  return highest
}

export class AgentControlStore {
  constructor(dir = process.env.AGENT_CONTROL_STATE_DIR || DEFAULT_DIR, { retention = RETENTION, saveDelayMs = SAVE_DELAY_MS } = {}) {
    this.dir = path.resolve(dir)
    this.file = path.join(this.dir, 'state.json')
    this.journal = path.join(this.dir, 'journal.jsonl')
    // Where a compaction rotates the journal to before folding it in. The
    // rename is atomic, so the live journal is never the file being drained.
    this.compacting = path.join(this.dir, 'journal.compacting')
    this.lock = path.join(this.dir, 'compaction.lock')
    // Every line this store appends is stamped with `writerId`, and `absorbed`
    // holds the highest sequence folded in per writer — so a second process
    // journalling into the same file is ordered correctly rather than being
    // skipped or replayed twice. `dirty` starts false, which is what makes a
    // read-only open inert.
    this.writerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    this.absorbed = new Map()
    this.journalOwnBytes = 0
    // The inode `journalFd` addresses. A compaction rotates the journal by
    // rename, so this is how an append notices it is writing into a file that
    // has been retired — see `#rewriteIfRotated`.
    this.journalIno = 0
    this.lockHeld = false
    this.dirty = false
    // Overridable so a test can exercise retention at a cap it can reach in a
    // second rather than at the shipped one.
    this.retention = retention
    this.saveDelayMs = saveDelayMs
    this.saveTimer = null
    this.state = this.#read()
    this.seq = Number(this.state.journalSeq || 0)
    if (!AgentControlStore.exitHooked) {
      AgentControlStore.exitHooked = true
      // Flush what this process appended; a store it only READ writes nothing.
      // Quorum ships bin/agent, which opens the same directory on every
      // invocation while the cockpit is running — `agent doctor` used to
      // rewrite state.json from its own stale copy and truncate the journal,
      // destroying whatever the server had journalled since the CLI started.
      process.on('exit', () => {
        for (const store of AgentControlStore.open) {
          try { store.flush() } catch { /* exiting anyway */ }
          try { store.releaseCompactionLock() } catch { /* exiting anyway */ }
        }
      })
    }
    AgentControlStore.open.add(this)
  }

  #read() {
    try {
      const current = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const value = current
      return this.#replayJournal({ runs: {}, claims: {}, actions: {}, checkpoints: {}, events: [], markers: {}, ...value })
    } catch {
      // Existing installs used ~/.agent-control. Read it only when the new
      // location has no state; never move or delete the legacy evidence.
      // Only the default location migrates: an explicitly chosen directory
      // (a test scratch dir, a second instance) must not silently inherit
      // another install's runs, which made every scratch store start with
      // the author's real records in it.
      if (this.dir !== DEFAULT_DIR) return this.#replayJournal({ runs: {}, claims: {}, actions: {}, checkpoints: {}, events: [], markers: {} })
      try {
        const legacy = JSON.parse(fs.readFileSync(path.join(LEGACY_DIR, 'state.json'), 'utf8'))
        return this.#replayJournal({ runs: {}, claims: {}, actions: {}, checkpoints: {}, events: [], markers: {}, ...legacy })
      } catch { return this.#replayJournal({ runs: {}, claims: {}, actions: {}, checkpoints: {}, events: [], markers: {} }) }
    }
  }

  /**
   * Re-apply whatever the journal holds beyond the last snapshot.
   *
   * The snapshot records the sequence number it was written at, so a crash
   * between `rename` and the journal truncation replays nothing twice — which
   * matters for `events`, an array rather than a keyed bucket.
   *
   * `journalKnownBytes` is the other half of that: it is how much of the
   * journal is already folded into `this.state`, and it is what makes
   * truncation safe when a second process is appending to the same file.
   */
  #replayJournal(state) {
    this.absorbed = new Map(Object.entries(state.journalWriters || {}).map(([writer, seq]) => [writer, Number(seq) || 0]))
    if (!this.absorbed.has('')) this.absorbed.set('', Number(state.journalSeq || 0))
    // A compaction that died between rotating the journal aside and removing
    // it leaves `journal.compacting` behind, holding records *older* than
    // whatever the live journal has collected since. Fold it in first:
    // sequence numbers are a per-writer high-water mark, so replaying the
    // newer file first would make the older one look already-absorbed and
    // drop it.
    try { applyOps(state, fs.readFileSync(this.compacting, 'utf8').split('\n'), this.absorbed) } catch { /* the usual case: no rotation in flight */ }
    let raw
    try { raw = fs.readFileSync(this.journal, 'utf8') } catch { this.journalOwnBytes = 0; return state }
    // Everything in the file is folded in by the time this returns, so the
    // whole of it counts as ours for the purposes of the fast path below.
    this.journalOwnBytes = Buffer.byteLength(raw)
    applyOps(state, raw.split('\n'), this.absorbed)
    return state
  }

  /** Fold one journal file into `this.state`. Returns its byte length. */
  #absorbFile(file) {
    let raw
    try { raw = fs.readFileSync(file, 'utf8') } catch { return 0 }
    const highest = applyOps(this.state, raw.split('\n'), this.absorbed)
    this.seq = Math.max(Number(this.seq || 0), highest)
    return Buffer.byteLength(raw)
  }

  /**
   * Rotate the journal aside and fold every line it holds into `this.state`.
   *
   * This replaces "read the journal, then truncate it if its size still
   * matches what we wrote". That check could only ever narrow the window
   * between deciding to truncate and truncating: a line another process
   * appended in between was destroyed *after* its `append()` had returned.
   *
   * `rename` closes the window instead of narrowing it. It is atomic, so
   * there is no instant at which the journal is half-drained, and the file
   * being drained is by construction not the one new appends resolve to. What
   * a concurrent writer can still do is append through an fd it opened before
   * the rename — `#rewriteIfRotated` is the other half, and it puts that line
   * back into the live journal before its `append()` returns.
   */
  #compactJournal() {
    // A previous compaction died between the rotation and the removal. Fold
    // its file in before the rename below replaces it, or those records go
    // with it.
    if (fs.existsSync(this.compacting)) {
      this.#absorbFile(this.compacting)
      try { fs.unlinkSync(this.compacting) } catch { /* another holder got there first */ }
    }
    const ownBytes = Number(this.journalOwnBytes || 0)
    try { fs.renameSync(this.journal, this.compacting) } catch { return }   // nothing journalled yet
    // Every fd in this process now points at the rotated file. Ours is
    // re-opened immediately, which also re-creates `journal.jsonl` empty;
    // siblings re-open lazily on their next append.
    this.#invalidateJournalFds()
    let size = -1
    try { size = fs.statSync(this.compacting).size } catch { /* fall through and read it */ }
    // Fast path: the rotated file is byte for byte what this store wrote, so
    // every line in it is already in `this.state` and there is no read to pay
    // for — the same saving the old size check bought, without betting
    // durability on it.
    if (size !== ownBytes) this.#absorbFile(this.compacting)
  }

  /**
   * Point this process's journal fds at the file `journal.jsonl` now names.
   *
   * The successor is created here, while the rotated file still holds its
   * inode — so the live journal can never inherit the inode number of a
   * journal that was rotated away, which is what lets `#rewriteIfRotated`
   * decide with one `stat` and a remembered inode instead of two.
   */
  #invalidateJournalFds() {
    for (const store of AgentControlStore.open) {
      if (store.journal !== this.journal || store.journalFd == null) continue
      try { fs.closeSync(store.journalFd) } catch { /* already gone */ }
      store.journalFd = null
      store.journalIno = 0
      store.journalOwnBytes = 0
    }
    try { this.#openJournal() } catch { this.journalFd = null; this.journalIno = 0 }
    this.journalOwnBytes = 0
  }

  /** Open the journal for appending and remember which inode that is. */
  #openJournal() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.journalFd = fs.openSync(this.journal, 'a', 0o600)
    try { this.journalIno = fs.fstatSync(this.journalFd).ino } catch { this.journalIno = 0 }
  }

  /**
   * After a write, make sure the line landed in the journal that is live now.
   *
   * A compaction renames the journal aside and later removes it, so an fd
   * opened before that rename addresses a file nobody will read again. When
   * that has happened the line is written a second time, into the current
   * journal, before `append()` returns — replay skips the duplicate because
   * sequence numbers are per writer and `absorbed` records the high-water
   * mark.
   *
   * The cost is one `stat` per append, and only for a store that does not
   * hold the compaction lock. The lock holder is the only process that
   * rotates and it does so synchronously, so it cannot be rotated out from
   * under itself — the cockpit's hot append path, which holds the lock from
   * its first snapshot until it exits, pays nothing at all.
   */
  #rewriteIfRotated(line) {
    if (this.lockHeld || this.journalFd == null) return
    let live = null
    try { live = fs.statSync(this.journal) } catch { /* rotated away and not re-created yet */ }
    // A rotation always creates the successor before removing the file it
    // rotated aside (see `#invalidateJournalFds`), so the live journal never
    // carries a retired journal's inode number and this comparison cannot be
    // fooled by the kernel recycling one.
    if (live && live.ino === this.journalIno) return
    try { fs.closeSync(this.journalFd) } catch { /* already gone */ }
    this.journalFd = null
    this.journalIno = 0
    this.journalOwnBytes = 0
    try {
      this.#openJournal()
      const written = fs.writeSync(this.journalFd, line)
      this.journalBytes = Number(this.journalBytes || 0) + written
      this.journalOwnBytes = written
    } catch { /* a journal that cannot be written still leaves the snapshot */ }
  }

  /**
   * Take the state directory's compaction lock.
   *
   * Only the holder writes `state.json` or truncates the journal. A second
   * process still journals its own appends — those are durable the moment
   * `append` returns and the holder folds them in — but it never rewrites the
   * snapshot from its own copy. A lock whose pid is gone is stale and is
   * taken; a lock this process already holds (a second store on the same
   * directory in one process) is treated as ours.
   */
  #acquireCompactionLock() {
    if (this.lockHeld) return true
    try { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }) } catch { return false }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lock, 'wx', 0o600)
        try { fs.writeSync(fd, `${process.pid}\n`) } finally { fs.closeSync(fd) }
        this.lockHeld = true
        return true
      } catch { /* held by someone — decide whether they are still alive */ }
      let pid = 0
      try { pid = Number(String(fs.readFileSync(this.lock, 'utf8')).trim()) } catch { continue }
      if (pid === process.pid) { this.lockHeld = true; return true }
      if (pid > 0) {
        try { process.kill(pid, 0); return false } catch (error) { if (error?.code === 'EPERM') return false }
      }
      try { fs.unlinkSync(this.lock) } catch { /* another process won the steal */ }
    }
    return false
  }

  /** Give the compaction lock back. Safe to call more than once. */
  releaseCompactionLock() {
    if (!this.lockHeld) return
    this.lockHeld = false
    try {
      if (Number(String(fs.readFileSync(this.lock, 'utf8')).trim()) === process.pid) fs.unlinkSync(this.lock)
    } catch { /* already gone */ }
  }

  /**
   * Run `fn` with saves batched into one write at the end.
   *
   * Every `append` rewrites the whole state file, so a loop that touches N
   * records is N full serialisations — startup reconciliation did 79 of them
   * on the author's machine before the cockpit answered a request. The file is
   * still written exactly once per logical operation, just not once per
   * record. A throw still flushes, so a partial batch is never lost.
   */
  batch(fn) {
    this.deferred = Number(this.deferred || 0) + 1
    try { return fn() } finally {
      this.deferred -= 1
      if (!this.deferred && this.pendingSave) { this.pendingSave = false; this.save() }
    }
  }

  /**
   * Ask for a snapshot. The durable record of the change is already on disk —
   * `append` journalled it synchronously — so the full rewrite can be
   * coalesced instead of run once per streamed provider event. A chatty run
   * used to turn 600 events into 600 full-file rewrites and 265 MB of writes.
   */
  save() {
    if (this.deferred) { this.pendingSave = true; return }
    if (this.saveDelayMs > 0 && this.journalBytes < SNAPSHOT_JOURNAL_BYTES) {
      // A true debounce: a burst of appends snapshots once, after it ends.
      if (this.saveTimer) clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(() => { this.saveTimer = null; this.#writeSnapshot() }, this.saveDelayMs)
      this.saveTimer.unref?.()
      return
    }
    this.#writeSnapshot()
  }

  /** Close the open journal handle. Safe to call more than once. */
  close() {
    this.flush()
    if (this.journalFd != null) { try { fs.closeSync(this.journalFd) } catch { /* already closed */ } }
    this.journalFd = null
    this.releaseCompactionLock()
    AgentControlStore.open.delete(this)
  }

  /**
   * Write the snapshot now and drop the journal it supersedes.
   *
   * `force` writes even when this store appended nothing — which `backup()`
   * needs, because a store that only replayed the journal still holds records
   * the state file on disk does not.
   */
  flush({ force = false } = {}) {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    if (this.deferred) { this.pendingSave = true; return }
    this.#writeSnapshot(force)
  }

  /** One journal line per logical change: small, synchronous, crash-durable. */
  #journal(op) {
    this.seq = Number(this.seq || 0) + 1
    const line = JSON.stringify({ s: this.seq, w: this.writerId, ...op }) + '\n'
    // Set before the write, not after: a journal that cannot be written is
    // exactly when the snapshot has to happen.
    this.dirty = true
    try {
      // The journal fd stays open. Re-opening the file for every streamed
      // provider event is most of what an append costs once the write itself
      // is one short line.
      if (this.journalFd === undefined || this.journalFd === null) this.#openJournal()
      const written = fs.writeSync(this.journalFd, line)
      this.journalBytes = Number(this.journalBytes || 0) + written
      this.journalOwnBytes = Number(this.journalOwnBytes || 0) + written
      // The fd may have been rotated aside by another process's compaction
      // between opening it and this write. Put the line back in the live
      // journal before returning, so what `append` acknowledges is always
      // recoverable.
      this.#rewriteIfRotated(line)
      this.absorbed.set(this.writerId, this.seq)
    } catch { /* a journal that cannot be written still leaves the snapshot */ }
    return this.seq
  }

  #writeSnapshot(force = false) {
    // Nothing was appended, so state.json plus the journal already describe
    // this store exactly. Writing anyway is how a read-only open clobbered a
    // writer's records.
    if (!this.dirty && !force) return
    // Only the lock holder rewrites the snapshot. A second writer keeps
    // journalling — its records are durable the moment `append` returns — and
    // the holder folds them in below.
    if (!this.#acquireCompactionLock()) { this.snapshotsDeclined = Number(this.snapshotsDeclined || 0) + 1; return }
    // Rotate first, then fold in: after this returns the live journal is a
    // fresh, empty file and `journal.compacting` holds everything the
    // snapshot below is about to supersede.
    this.#compactJournal()
    this.snapshots = Number(this.snapshots || 0) + 1
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    // Every record is redacted once, on `append`. Re-redacting the whole state
    // on each save also re-applied `redact`'s bounds to the *collections*, so
    // past 80 runs or 80 claims each save silently dropped the oldest records
    // — the store quietly deleted the user's evidence while claiming to
    // persist it. Records go to disk exactly as they were admitted.
    this.state.journalSeq = Number(this.seq || 0)
    // The high-water marks used to be reset to this writer alone once the
    // journal was truncated, because an empty journal cannot replay anything.
    // A rotated journal is not empty: a writer that noticed the rotation
    // re-writes its line into the new file, and forgetting its mark would
    // replay that line — a duplicate in the event ring. So the marks are
    // kept, and what bounds the map instead is dropping writers whose process
    // is gone: a dead pid cannot append, so its lines are all in this
    // snapshot already. (`bin/agent` mints a new writer id per invocation, so
    // without this the map would grow forever.)
    this.#forgetDeadWriters()
    this.state.journalWriters = Object.fromEntries(this.absorbed)
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(temp, this.file)
    // The snapshot now contains everything the rotated journal held, so that
    // file can go. Removing it after the rename is what makes a crash between
    // the two safe: startup replays it, and `journalWriters` then skips the
    // records the snapshot already has.
    this.journalBytes = 0
    this.dirty = false
    // Only once the successor exists: a rotated file is the sole durable copy
    // of its records until the snapshot lands, and it is also what keeps its
    // inode number out of circulation while a straggler may still be holding
    // an fd to it.
    try { if (fs.existsSync(this.journal)) fs.unlinkSync(this.compacting) } catch { /* nothing was rotated */ }
  }

  /** Drop absorbed-marks for writers whose process no longer exists. */
  #forgetDeadWriters() {
    for (const writer of [...this.absorbed.keys()]) {
      if (writer === '' || writer === this.writerId) continue
      const pid = Number(String(writer).split('-')[0])
      if (!(pid > 0)) continue
      try { process.kill(pid, 0) } catch (error) { if (error?.code !== 'EPERM') this.absorbed.delete(writer) }
    }
  }

  /**
   * Copy the current state file into `~/.quorum/agent-control/backups/` before
   * a migration rewrites records. Returns the backup path, or null when there
   * is nothing to copy yet.
   */
  backup(label = 'manual') {
    // The snapshot is debounced, so the file on disk can lag the records a
    // migration is about to rewrite. A backup of a stale snapshot is worse
    // than no backup: flush first, then copy.
    this.flush({ force: true })
    if (!fs.existsSync(this.file)) return null
    const dir = path.join(this.dir, 'backups')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const safe = String(label).replace(/[^a-z0-9-]/gi, '-').slice(0, 40) || 'manual'
    const target = path.join(dir, `state-${safe}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.copyFileSync(this.file, target)
    return target
  }

  /** Durable "this migration already ran" markers. Never holds run content. */
  getMarker(key) { return this.state.markers?.[String(key)] || null }
  setMarker(key, value) {
    if (!this.state.markers) this.state.markers = {}
    this.state.markers[String(key)] = redact(value)
    this.#journal({ m: { key: String(key), value: this.state.markers[String(key)] } })
    this.save()
    return this.state.markers[String(key)]
  }

  /**
   * Move the oldest-admitted records of one collection out of the hot state
   * file once it is over its cap, appending them to
   * `~/.quorum/agent-control/archive/<kind>.jsonl` first. Returns how many
   * moved.
   *
   * Insertion order is the age order: JavaScript preserves it for string keys,
   * and re-appending an existing record keeps its original position, so a
   * record's place in the object is the moment it first entered the store.
   * Live runs, active claims and `keepId` are skipped whatever their age.
   */
  prune(kind, keepId = null) {
    const cap = this.retention?.[kind]
    const bucket = this.state[kind]
    if (!cap || !bucket) return 0
    const ids = Object.keys(bucket)
    if (ids.length <= cap) return 0
    const excess = ids.length - cap
    const doomed = []
    for (const id of ids) {
      if (doomed.length >= excess) break
      if (id === keepId) continue
      if (isLive(kind, bucket[id])) continue
      doomed.push(id)
    }
    if (!doomed.length) return 0
    try {
      const dir = path.join(this.dir, 'archive')
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const lines = doomed.map(id => JSON.stringify({ archivedAt: Date.now(), kind, record: bucket[id] })).join('\n')
      fs.appendFileSync(path.join(dir, `${String(kind).replace(/[^a-z0-9-]/gi, '-')}.jsonl`), `${lines}\n`, { mode: 0o600 })
    } catch {
      // Records are only ever dropped from the hot file once they are safely
      // on disk somewhere else. If the archive cannot be written, the state
      // file is allowed to grow instead.
      return 0
    }
    for (const id of doomed) delete bucket[id]
    this.pendingPrune = { kind, ids: doomed }
    if (!this.state.retention) this.state.retention = {}
    const previous = this.state.retention[kind] || { cap, archived: 0 }
    this.state.retention[kind] = { cap, archived: Number(previous.archived || 0) + doomed.length, lastArchivedAt: Date.now() }
    return doomed.length
  }

  append(kind, record) {
    if (!this.state[kind]) this.state[kind] = {}
    this.state[kind][record.id] = redact(record)
    const event = redact({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, runId: record.runId, ts: Date.now(), status: record.status })
    this.state.events.push(event)
    if (this.state.events.length > 500) this.state.events.splice(0, this.state.events.length - 500)
    this.pendingPrune = null
    this.prune(kind, record.id)
    const pruned = this.pendingPrune?.ids?.length ? { del: this.pendingPrune.ids, ret: { k: kind, v: this.state.retention?.[kind] } } : {}
    this.#journal({ k: kind, r: this.state[kind][record.id], e: event, ...pruned })
    this.pendingPrune = null
    this.save()
    return this.state[kind][record.id]
  }

  static open = new Set()
  static exitHooked = false

  list(kind) { return Object.values(this.state[kind] || {}).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))) }
  get(kind, id) { return this.state[kind]?.[id] || null }
  delete(kind, id) { if (this.state[kind]?.[id]) { delete this.state[kind][id]; this.#journal({ k: kind, del: [id] }); this.flush() } }
}
