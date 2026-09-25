// The control-plane store used to rewrite its whole state file synchronously
// on every append, and RuntimeManager.emit() appends once per streamed
// provider event — so a chatty run rewrote a multi-hundred-kilobyte file
// thousands of times a minute. Writes are now an append-only journal plus a
// debounced snapshot. These tests are about what that must not cost:
// durability. A record that `append` returned has to survive a crash before
// the next snapshot.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AgentControlStore } from '../src/agent-control/store.js'
import { defer, scratchDir } from './helpers/scratch.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STORE_URL = JSON.stringify(path.join(ROOT, 'src', 'agent-control', 'store.js'))

// Run `body` in a real child process against the same state directory. The
// bug these tests cover only exists across processes: the exit hook is what
// writes, and it only runs when a process ends.
function inChildProcess(dir, body) {
  const script = path.join(dir, `child-${Math.random().toString(36).slice(2, 8)}.mjs`)
  fs.writeFileSync(script, `import { AgentControlStore } from ${STORE_URL}\nconst store = new AgentControlStore(${JSON.stringify(dir)}, { saveDelayMs: 600000 })\n${body}\n`)
  return execFileSync(process.execPath, [script], { encoding: 'utf8' }).trim()
}

const scratch = t => scratchDir(t, 'quorum-journal-')
// Stores are left open mid-test on purpose, to stand in for a crashed process.
// Each is closed once its test is over, before its directory is removed: an
// open store flushes at exit and would re-create the directory.
function openStore(t, dir, options) {
  const store = new AgentControlStore(dir, options)
  defer(t, () => store.close())
  return store
}
// A delay no test will wait out: every snapshot in here is an explicit flush,
// so nothing depends on a timer firing.
const NEVER = { saveDelayMs: 600_000 }

test('a record survives a crash between the append and the snapshot', t => {
  const dir = scratch(t)
  const store = openStore(t, dir, NEVER)
  store.append('runs', { id: 'run-1', runId: 'run-1', status: 'active', observed: 'mid-flight' })
  assert.equal(fs.existsSync(store.file), false, 'no snapshot has been written yet')

  const recovered = openStore(t, dir, NEVER)
  assert.equal(recovered.get('runs', 'run-1').observed, 'mid-flight')
  assert.equal(recovered.state.events.length, 1)
})

test('replaying a journal the snapshot already contains duplicates nothing', t => {
  const dir = scratch(t)
  const store = openStore(t, dir, NEVER)
  for (let i = 0; i < 5; i++) store.append('runs', { id: `run-${i}`, runId: `run-${i}`, status: 'closed' })
  store.flush()
  store.append('runs', { id: 'run-late', runId: 'run-late', status: 'active' })

  const recovered = openStore(t, dir, NEVER)
  assert.equal(recovered.list('runs').length, 6)
  assert.equal(recovered.state.events.length, 6, 'the event ring must not replay what the snapshot already held')
  assert.ok(recovered.get('runs', 'run-late'))

  // And again, with nothing new since the snapshot.
  recovered.flush()
  const twice = openStore(t, dir, NEVER)
  assert.equal(twice.list('runs').length, 6)
  assert.equal(twice.state.events.length, 6)
})

test('a burst of appends costs one snapshot, not one per record', t => {
  const dir = scratch(t)
  const store = openStore(t, dir, NEVER)
  let snapshots = 0
  const rename = fs.renameSync
  fs.renameSync = (from, to, ...rest) => { if (String(to).endsWith('state.json')) snapshots += 1; return rename(from, to, ...rest) }
  try {
    for (let i = 0; i < 200; i++) store.append('runtimeEvents', { id: `ev-${i}`, runId: 'run-hot', status: 'streaming', text: 'token'.repeat(20) })
    assert.equal(snapshots, 0, '200 streamed events wrote no snapshot at all')
    store.flush()
    assert.equal(snapshots, 1)
  } finally { fs.renameSync = rename }

  const recovered = openStore(t, dir, NEVER)
  assert.equal(recovered.list('runtimeEvents').length, 200, 'every streamed event is still durable')
})

test('a torn journal line costs that line, not the store', t => {
  const dir = scratch(t)
  const store = openStore(t, dir, NEVER)
  store.append('runs', { id: 'run-1', runId: 'run-1', status: 'active' })
  store.append('runs', { id: 'run-2', runId: 'run-2', status: 'active' })
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"s":99,"k":"runs","r":{"id":"run-3"')

  const recovered = openStore(t, dir, NEVER)
  assert.deepEqual(recovered.list('runs').map(run => run.id).sort(), ['run-1', 'run-2'])
})

test('an archived record stays archived across a crash, and the count comes back with it', t => {
  const dir = scratch(t)
  const cap = 5
  const store = openStore(t, dir, { ...NEVER, retention: { evidence: cap } })
  for (let i = 0; i < cap + 4; i++) store.append('evidence', { id: `evidence-${i}`, runId: 'run-1', observed: `observation ${i}` })

  const recovered = openStore(t, dir, { ...NEVER, retention: { evidence: cap } })
  assert.equal(recovered.list('evidence').length, cap, 'pruned records did not come back from the journal')
  assert.equal(recovered.state.retention.evidence.archived, 4, 'the archived count survived the crash')
  const archived = fs.readFileSync(path.join(dir, 'archive', 'evidence.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(archived.map(entry => entry.record.id), ['evidence-0', 'evidence-1', 'evidence-2', 'evidence-3'])
})

test('markers and deletes are durable the moment they are made', t => {
  const dir = scratch(t)
  const store = openStore(t, dir, NEVER)
  store.append('runs', { id: 'run-1', runId: 'run-1', status: 'active' })
  store.setMarker('migration-x', { ranAt: 'now' })
  store.delete('runs', 'run-1')

  const recovered = openStore(t, dir, NEVER)
  assert.deepEqual(recovered.getMarker('migration-x'), { ranAt: 'now' })
  assert.equal(recovered.get('runs', 'run-1'), null, 'a deleted record must not be resurrected by the journal')
})

test('the journal is truncated by the snapshot rather than growing forever', t => {
  const dir = scratch(t)
  const store = openStore(t, dir, NEVER)
  const journal = path.join(dir, 'journal.jsonl')
  for (let i = 0; i < 50; i++) store.append('runs', { id: `run-${i}`, runId: `run-${i}`, status: 'closed' })
  assert.ok(fs.statSync(journal).size > 0)
  store.flush()
  assert.equal(fs.statSync(journal).size, 0)
  store.append('runs', { id: 'run-next', runId: 'run-next', status: 'active' })
  assert.ok(fs.statSync(journal).size > 0, 'the journal keeps working after truncation')
  const recovered = openStore(t, dir, NEVER)
  assert.equal(recovered.list('runs').length, 51)
})

test('batch still collapses a reconciliation loop into one snapshot', t => {
  const dir = scratch(t)
  const store = openStore(t, dir, { saveDelayMs: 0 })
  let snapshots = 0
  const rename = fs.renameSync
  fs.renameSync = (from, to, ...rest) => { if (String(to).endsWith('state.json')) snapshots += 1; return rename(from, to, ...rest) }
  try {
    store.batch(() => { for (let i = 0; i < 40; i++) store.append('runs', { id: `run-${i}`, runId: `run-${i}`, status: 'closed' }) })
  } finally { fs.renameSync = rename }
  assert.equal(snapshots, 1)
  assert.equal(store.list('runs').length, 40)
})

// A second process opening the same store used to rewrite state.json from its
// own stale copy on exit and ftruncate the journal to zero — so `agent doctor`
// run against a live cockpit destroyed every record the server had journalled
// since the CLI started. bin/agent constructs an AgentControlManager (and so a
// store) on every invocation, so this fired in normal use.

test('a read-only open in another process writes nothing and truncates nothing', t => {
  const dir = scratch(t)
  const server = openStore(t, dir, NEVER)
  server.append('runs', { id: 'r1', runId: 'r1', status: 'closed' })
  server.flush()
  // Journalled but not yet snapshotted — the debounce window a live cockpit
  // spends most of its time in.
  server.append('runs', { id: 'r3-critical', runId: 'r3', status: 'closed', observed: 'paid-for evidence' })
  // Hand the compaction lock over so the guard under test is "this process
  // appended nothing", not "somebody else holds the lock".
  server.releaseCompactionLock?.()

  const journal = path.join(dir, 'journal.jsonl')
  const journalBefore = fs.readFileSync(journal, 'utf8')
  const snapshotBefore = fs.readFileSync(server.file, 'utf8')
  assert.ok(journalBefore.includes('r3-critical'))
  assert.equal(snapshotBefore.includes('r3-critical'), false, 'the snapshot has not caught up yet')

  const seen = inChildProcess(dir, 'console.log(Object.keys(store.state.runs).join(","))')
  assert.equal(seen, 'r1,r3-critical', 'the reader replays the journal, so it sees both')

  assert.equal(fs.readFileSync(journal, 'utf8'), journalBefore, 'a read-only open truncated the journal')
  assert.equal(fs.readFileSync(server.file, 'utf8'), snapshotBefore, 'a read-only open rewrote the snapshot')

  // And the record is still there after the writer dies without snapshotting.
  const recovered = openStore(t, dir, NEVER)
  assert.ok(recovered.get('runs', 'r3-critical'), 'the journalled record did not survive')
})

test('a second process that appends has its records folded into the next snapshot, not clobbered', t => {
  const dir = scratch(t)
  const server = openStore(t, dir, NEVER)
  server.append('runs', { id: 'server-1', runId: 'server-1', status: 'closed' })
  server.flush()

  // The CLI appends while the server holds the compaction lock. It journals —
  // durable the moment append() returns — and leaves the snapshot alone.
  inChildProcess(dir, "store.append('runs', { id: 'cli-1', runId: 'cli-1', status: 'closed' })\nconsole.log('done')")
  assert.equal(JSON.parse(fs.readFileSync(server.file, 'utf8')).runs['server-1'] !== undefined, true)
  assert.equal(JSON.parse(fs.readFileSync(server.file, 'utf8')).runs['cli-1'], undefined, 'the second writer must not rewrite the snapshot')

  // The server's next snapshot absorbs the foreign lines before writing.
  server.append('runs', { id: 'server-2', runId: 'server-2', status: 'closed' })
  server.flush()
  const snapshot = JSON.parse(fs.readFileSync(server.file, 'utf8'))
  assert.deepEqual(Object.keys(snapshot.runs).sort(), ['cli-1', 'server-1', 'server-2'])
  assert.ok(server.get('runs', 'cli-1'), 'the live store absorbed the other writer too')
})

test('the journal is left alone when it holds lines this process has not folded in', t => {
  const dir = scratch(t)
  const store = openStore(t, dir, NEVER)
  store.append('runs', { id: 'mine', runId: 'mine', status: 'closed' })
  const journal = path.join(dir, 'journal.jsonl')
  // A line that arrived after this store last read the file, exactly as a
  // concurrent writer would leave it.
  fs.appendFileSync(journal, `${JSON.stringify({ s: 9_000, k: 'runs', r: { id: 'theirs', runId: 'theirs', status: 'closed' } })}\n`)
  store.flush()
  assert.ok(store.get('runs', 'theirs'), 'the foreign line was not absorbed before the snapshot')
  assert.ok(JSON.parse(fs.readFileSync(store.file, 'utf8')).runs.theirs, 'the snapshot dropped the foreign record')
})

test('backup() still snapshots first, even when this process appended nothing', t => {
  const dir = scratch(t)
  const writer = openStore(t, dir, NEVER)
  writer.append('runs', { id: 'only-in-the-journal', runId: 'r', status: 'closed' })

  // A second open that reads and backs up without appending anything of its
  // own — a migration's pre-flight. The copy must hold what the journal held.
  const reader = openStore(t, dir, NEVER)
  const target = reader.backup('pre-migration')
  assert.ok(target, 'backup() found nothing to copy')
  assert.ok(JSON.parse(fs.readFileSync(target, 'utf8')).runs['only-in-the-journal'], 'the backup is of a stale snapshot')
})

// ── the compaction window ────────────────────────────────────────────────────
//
// The snapshot used to end with: fstat the journal, compare its size against
// the bytes this store wrote, and ftruncate it to zero when they matched. A
// line another process appended between the fstat and the ftruncate was
// destroyed — after that process's `append()` had already returned, with no
// crash anywhere. A store whose entire job is to make an acknowledged record
// recoverable cannot carry a window like that, however narrow.
//
// The probe below drives a real second process into it. It patches the fs
// primitives a compaction uses to drop journal bytes and, the first time one
// is reached, runs a child that appends and exits before the call is allowed
// through. Nothing in `src/` knows this test exists: there is no test-only
// hook in the store, and no timing to lose.

const base = file => path.basename(String(file))

/**
 * Run `compact()` with a real second process appending at the exact instant
 * the compaction drops the journal's bytes. Returns the name of the fs call
 * the append was injected into, or null if none was reached.
 */
function appendDuringCompaction(dir, record, compact) {
  // `renameSync` to `state.json` is the point after which the old code's size
  // check ran; arming on it keeps the injection off the reads that precede it.
  let snapshotLanded = false
  const points = {
    // b211493: the size check whose answer the ftruncate below trusted. The
    // append goes in *after* the real call, so the caller gets the size the
    // journal had a moment ago — which is the whole shape of the bug.
    fstatSync: { after: true, matches: args => snapshotLanded && typeof args[0] === 'number' },
    ftruncateSync: { matches: args => typeof args[0] === 'number' },
    truncateSync: { matches: args => base(args[0]) === 'journal.jsonl' },
    // the rotation, and the removal of the file the journal is rotated into.
    renameSync: { matches: args => base(args[1]) === 'journal.compacting' },
    unlinkSync: { matches: args => base(args[0]) === 'journal.compacting' },
  }
  const originals = new Map()
  let fired = null
  let injecting = false
  const inject = name => {
    injecting = true
    fired = name
    try { inChildProcess(dir, `store.append('runs', ${JSON.stringify(record)})\nconsole.log('appended')`) } finally { injecting = false }
  }
  for (const [name, point] of Object.entries(points)) {
    const original = fs[name]
    originals.set(name, original)
    fs[name] = (...args) => {
      const hit = !fired && !injecting && point.matches(args)
      if (hit && !point.after) inject(name)
      if (name === 'renameSync' && base(args[1]) === 'state.json') snapshotLanded = true
      const result = original.apply(fs, args)
      if (hit && point.after) inject(name)
      return result
    }
  }
  try { compact() } finally { for (const [name, original] of originals) fs[name] = original }
  return fired
}

test('a line another process appends during a compaction is never dropped', t => {
  const dir = scratch(t)
  const store = openStore(t, dir, NEVER)
  store.append('runs', { id: 'server-1', runId: 'server-1', status: 'closed' })
  store.flush()                      // takes the compaction lock, and keeps it
  store.append('runs', { id: 'server-2', runId: 'server-2', status: 'closed' })

  const critical = { id: 'cli-critical', runId: 'cli', status: 'closed', observed: 'append() already returned' }
  const fired = appendDuringCompaction(dir, critical, () => store.flush())
  assert.ok(fired, 'the probe never reached a point where the journal loses its bytes')

  const recovered = openStore(t, dir, NEVER)
  assert.ok(recovered.get('runs', 'cli-critical'), `the child's acknowledged record was destroyed by the compaction at fs.${fired}`)
  assert.equal(recovered.get('runs', 'cli-critical').observed, 'append() already returned')
  assert.ok(recovered.get('runs', 'server-1'), 'the snapshot lost its own record')
  assert.ok(recovered.get('runs', 'server-2'), 'the snapshot lost the line it compacted')
})

test('a writer whose fd predates another process compaction still lands its line', t => {
  const dir = scratch(t)
  const straggler = openStore(t, dir, NEVER)
  straggler.append('runs', { id: 'before', runId: 'before', status: 'closed' })

  // A second process compacts: it takes the lock, folds the journal this fd
  // points at into the snapshot, and retires that file. The fd now addresses
  // something nothing will read again.
  inChildProcess(dir, "store.flush({ force: true })\nconsole.log('compacted')")

  straggler.append('runs', { id: 'after', runId: 'after', status: 'closed', observed: 'written through a retired fd' })

  const recovered = openStore(t, dir, NEVER)
  assert.ok(recovered.get('runs', 'before'), 'the compaction lost the record it folded in')
  assert.ok(recovered.get('runs', 'after'), 'the line went into a file the compaction had already retired')
})

test('an append through a rotated fd is re-written into the live journal', t => {
  const dir = scratch(t)
  const store = openStore(t, dir, NEVER)
  store.append('runs', { id: 'first', runId: 'first', status: 'closed' })
  const journal = path.join(dir, 'journal.jsonl')
  // A compaction in another process, caught halfway: the journal has been
  // renamed aside but not yet folded in and removed.
  fs.renameSync(journal, path.join(dir, 'journal.compacting'))

  store.append('runs', { id: 'second', runId: 'second', status: 'closed' })
  assert.ok(fs.readFileSync(journal, 'utf8').includes('"second"'), 'the line stayed behind in the rotated file')

  const recovered = openStore(t, dir, NEVER)
  assert.ok(recovered.get('runs', 'first'), 'the rotated file was not replayed')
  assert.ok(recovered.get('runs', 'second'))
})

test('a compaction that died mid-rotation is recovered, not overwritten', t => {
  const dir = scratch(t)
  // Exactly the state a crash between the rotation and the snapshot leaves:
  // a rotated journal, no state file, and nobody left to fold it in.
  const line = { s: 1, w: 'ghost-1', k: 'runs', r: { id: 'rotated-away', runId: 'rotated-away', status: 'closed' } }
  fs.writeFileSync(path.join(dir, 'journal.compacting'), `${JSON.stringify(line)}\n`)

  const next = openStore(t, dir, NEVER)
  assert.ok(next.get('runs', 'rotated-away'), 'the half-rotated journal was never replayed')
  next.append('runs', { id: 'fresh', runId: 'fresh', status: 'closed' })
  next.flush()
  const snapshot = JSON.parse(fs.readFileSync(next.file, 'utf8'))
  assert.deepEqual(Object.keys(snapshot.runs).sort(), ['fresh', 'rotated-away'], 'the next compaction overwrote the leftover file instead of folding it in')
  assert.equal(fs.existsSync(path.join(dir, 'journal.compacting')), false, 'the rotated file outlived the snapshot that superseded it')
})
