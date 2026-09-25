// The agent-control state file is an append-only journal compacted into a
// snapshot, so an unbounded collection is still an unbounded file — the
// snapshot carries every live record. (It is no longer an O(total state) cost
// per append; `store.flush()` below is what forces the snapshot the
// assertions measure.) `redact(this.state)` used to bound it as a side effect — and
// silently deleted the user's evidence doing so. Retention is now explicit,
// archives rather than deletes, and is what these tests measure.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { AgentControlStore, RETENTION } from '../src/agent-control/store.js'
import { defer, scratchDir } from './helpers/scratch.mjs'

const scratch = t => scratchDir(t, 'quorum-retention-')
// Closed before its directory is removed: an open store flushes at exit and
// would re-create it.
function openStore(t, dir, options) {
  const store = new AgentControlStore(dir, options)
  defer(t, () => store.close())
  return store
}

test('every collection the control plane appends to has a declared cap', () => {
  // Any kind reachable by `store.append` that is missing here grows forever.
  for (const kind of ['runs', 'claims', 'actions', 'checkpoints', 'executionPlans', 'evidence', 'verifications', 'learning', 'spend', 'runtimeEvents']) {
    assert.equal(typeof RETENTION[kind], 'number', `${kind} has no retention cap`)
    assert.ok(RETENTION[kind] >= 400, `${kind}'s cap is too tight to be useful`)
  }
})

test('a collection stops growing at its cap and the state file stops growing with it', t => {
  const dir = scratch(t)
  const cap = 40
  const store = openStore(t, dir, { retention: { evidence: cap } })
  let written = 0
  const write = count => { for (let i = 0; i < count; i++, written++) store.append('evidence', { id: `evidence-${written}`, runId: 'run-1', observed: `observation ${written}`.padEnd(200, '.') }) }

  // Warm up past the 500-entry event log as well, so the baseline is a file
  // whose every collection has already reached its bound.
  write(600)
  store.flush()
  const baseline = fs.statSync(store.file).size
  assert.equal(store.list('evidence').length, cap)

  // Ten more capfuls. Without retention the file grows linearly with them.
  write(cap * 10)
  store.flush()
  const after = fs.statSync(store.file).size

  assert.equal(store.list('evidence').length, cap, 'the hot collection is held at its cap')
  assert.ok(after <= baseline * 1.05, `state file grew from ${baseline} to ${after} bytes across 10x the cap`)

  // The newest records are the ones that stayed.
  const kept = store.list('evidence').map(record => record.id)
  assert.ok(kept.includes(`evidence-${written - 1}`), 'the most recent record is in the hot file')
  assert.equal(kept.includes('evidence-0'), false, 'the oldest record left the hot file')
})

test('records leave the hot file only by being archived, never by being dropped', t => {
  const dir = scratch(t)
  const cap = 40
  const store = openStore(t, dir, { retention: { evidence: cap } })
  const total = cap + 50
  for (let i = 0; i < total; i++) store.append('evidence', { id: `evidence-${i}`, runId: 'run-1', observed: `observation ${i}` })

  const archive = path.join(dir, 'archive', 'evidence.jsonl')
  assert.ok(fs.existsSync(archive), 'the archive file exists')
  const archived = fs.readFileSync(archive, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(archived.length, total - cap)
  assert.equal(archived[0].record.id, 'evidence-0', 'the oldest record is the first one archived')
  assert.equal(archived[0].kind, 'evidence')
  // Nothing is lost: hot + archived accounts for every record ever admitted.
  const ids = new Set([...store.list('evidence').map(record => record.id), ...archived.map(entry => entry.record.id)])
  assert.equal(ids.size, total)
  // The state says how much it moved, so "400 runs" is not read as "all runs".
  const reloaded = openStore(t, dir, { retention: { evidence: cap } })
  assert.equal(reloaded.state.retention.evidence.cap, cap)
  assert.equal(reloaded.state.retention.evidence.archived, total - cap)
})

test('a live run is never archived, however old it is', t => {
  const dir = scratch(t)
  const cap = 40
  const store = openStore(t, dir, { retention: { runs: cap } })
  // The oldest record in the store, and still working.
  store.append('runs', { id: 'run-live', runId: 'run-live', status: 'active' })
  store.append('runs', { id: 'run-claimed', runId: 'run-claimed', status: 'stale' })
  for (let i = 0; i < cap + 60; i++) store.append('runs', { id: `run-${i}`, runId: `run-${i}`, status: 'completed' })

  const ids = store.list('runs').map(run => run.runId)
  assert.ok(ids.includes('run-live'), 'an active run stays in the hot file')
  assert.ok(ids.includes('run-claimed'), 'a stale run is still awaiting a recovery decision')
  assert.equal(store.list('runs').length, cap)
  const archived = fs.readFileSync(path.join(dir, 'archive', 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(archived.some(entry => ['run-live', 'run-claimed'].includes(entry.record.runId)), false)
})

test('re-appending a record that is already over the cap still returns that record', t => {
  const dir = scratch(t)
  const cap = 40
  const store = openStore(t, dir, { retention: { runs: cap } })
  for (let i = 0; i < cap; i++) store.append('runs', { id: `run-${i}`, runId: `run-${i}`, status: 'completed' })
  // run-0 is the oldest and not live, so it is the first archive candidate —
  // but it is also the record being written, and an append must not return
  // undefined for the thing it just stored.
  const written = store.append('runs', { id: 'run-0', runId: 'run-0', status: 'completed', disposition: 'updated' })
  assert.equal(written.disposition, 'updated')
  assert.equal(store.get('runs', 'run-0').disposition, 'updated')
})

test('an unbounded collection with no declared cap is left alone rather than guessed at', t => {
  const dir = scratch(t)
  const store = openStore(t, dir)
  for (let i = 0; i < 50; i++) store.append('markersLike', { id: `x-${i}` })
  assert.equal(store.list('markersLike').length, 50)
  assert.equal(store.prune('markersLike'), 0)
})
