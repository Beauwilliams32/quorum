// Simulate a chatty managed run: RuntimeManager.emit() appends one
// `runtimeEvents` record per streamed provider event, and every append used to
// re-serialise and rewrite the whole state file on the event loop.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const events = Number(process.env.BENCH_EVENTS || 600)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-store-bench-'))

// Write accounting, one layer only. fs.appendFileSync delegates to
// fs.writeFileSync, and fs.writeFileSync loops fs.writeSync for large
// payloads, so patching more than one of them double-counts and invents a
// win. Instead: every snapshot lands via renameSync, and its exact size is
// the temp file's size at that moment; journal bytes are attributed by fd.
const fdPaths = new Map()
let snapshotWrites = 0
let snapshotBytes = 0
let journalBytes = 0
let archiveBytes = 0

const originalOpenSync = fs.openSync
fs.openSync = (file, ...rest) => { const fd = originalOpenSync(file, ...rest); fdPaths.set(fd, String(file)); return fd }
const originalWriteSync = fs.writeSync
fs.writeSync = (fd, data, ...rest) => {
  const n = originalWriteSync(fd, data, ...rest)
  const file = fdPaths.get(fd) || ''
  if (file.endsWith('journal.jsonl')) journalBytes += n
  return n
}
const originalAppendFileSync = fs.appendFileSync
fs.appendFileSync = (file, data, ...rest) => { if (String(file).includes('/archive/')) archiveBytes += Buffer.byteLength(String(data)); return originalAppendFileSync(file, data, ...rest) }
const originalRenameSync = fs.renameSync
fs.renameSync = (from, to, ...rest) => {
  if (String(to).endsWith('state.json')) { snapshotWrites += 1; try { snapshotBytes += fs.statSync(from).size } catch { /* gone */ } }
  return originalRenameSync(from, to, ...rest)
}
const reset = () => { snapshotWrites = 0; snapshotBytes = 0; journalBytes = 0; archiveBytes = 0 }

const { AgentControlStore } = await import('../../src/agent-control/store.js')
const store = new AgentControlStore(dir)

// Seed a realistic backlog so each rewrite carries the weight a live cockpit
// would: the phase-1 reviewer measured the hot file at multi-MB at the
// shipped retention caps.
for (let i = 0; i < 400; i++) store.append('runs', { id: `run-${i}`, runId: `run-${i}`, status: 'closed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), summary: 'x'.repeat(400) })
const seeded = { snapshotWrites, snapshotBytes, journalBytes }
reset()

// Pace the events across real wall clock so any debounce actually fires: a
// chatty run streams over a minute, it does not arrive in one synchronous
// loop. BENCH_SPAN_MS=0 measures the blocking cost with no pacing at all.
const span = Number(process.env.BENCH_SPAN_MS ?? 10_000)
const gap = span / events
const started = process.hrtime.bigint()
let blockingMs = 0
for (let i = 0; i < events; i++) {
  const t = process.hrtime.bigint()
  store.append('runtimeEvents', { id: `ev-${i}`, runId: 'run-hot', status: 'streaming', at: new Date().toISOString(), type: 'assistant', text: 'token '.repeat(20), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  blockingMs += Number(process.hrtime.bigint() - t) / 1e6
  if (gap >= 1) await new Promise(resolve => setTimeout(resolve, gap))
}
await new Promise(resolve => setTimeout(resolve, 1_500))
store.flush?.()
const ms = Number(process.hrtime.bigint() - started) / 1e6

const size = f => { try { return fs.statSync(path.join(dir, f)).size } catch { return 0 } }
// A run that streams this many events takes on the order of a minute.
const minutes = Math.max(span, 1) / 60_000 || 1
console.log(JSON.stringify({
  dir,
  events,
  seeded,
  spanMs: span,
  elapsedMs: +ms.toFixed(1),
  blockingMsTotal: +blockingMs.toFixed(1),
  blockingMsPerEvent: +(blockingMs / events).toFixed(3),
  fullStateRewrites: snapshotWrites,
  fullStateRewritesPerMinute: +(snapshotWrites / minutes).toFixed(1),
  snapshotBytes,
  journalBytes,
  archiveBytes,
  totalBytesWritten: snapshotBytes + journalBytes + archiveBytes,
  totalBytesPerMinute: Math.round((snapshotBytes + journalBytes + archiveBytes) / minutes),
  stateFileBytes: size('state.json'),
  journalFileBytes: size('journal.jsonl'),
}, null, 2))
