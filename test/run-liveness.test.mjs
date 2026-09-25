import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { AgentControlManager } from '../src/agent-control/manager.js'
import { AgentControlStore } from '../src/agent-control/store.js'
import { runLiveness, processStartKey } from '../src/process-liveness.js'
import { loadPolicy } from '../src/agent-control/policy.js'
import { defer, scratchDir } from './helpers/scratch.mjs'

// Closed before its directory is removed: an open store flushes at exit and
// would re-create it.
function openStore(t, dir) {
  const store = new AgentControlStore(dir)
  defer(t, () => store.close())
  return store
}

test('a run is alive only when its exact bound process is still running', () => {
  assert.equal(runLiveness({}).alive, false)
  assert.match(runLiveness({}).reason, /not bound to a process/)
  assert.equal(runLiveness({ pid: 4242 }).alive, false)
  assert.match(runLiveness({ pid: 4242 }).reason, /no process start key/)
  assert.equal(runLiveness({ pid: 4242, pidStartedAt: 'Mon Sep 22 09:00:00 2026' }, { startKeyImpl: () => null }).alive, false)
  assert.match(runLiveness({ pid: 4242, pidStartedAt: 'Mon Sep 22 09:00:00 2026' }, { startKeyImpl: () => null }).reason, /no longer running/)
  const reused = runLiveness({ pid: 4242, pidStartedAt: 'Mon Sep 22 09:00:00 2026' }, { startKeyImpl: () => 'Tue Sep 23 11:00:00 2026' })
  assert.equal(reused.alive, false)
  assert.match(reused.reason, /reused by a different process/)
  assert.equal(runLiveness({ pid: 4242, pidStartedAt: 'same' }, { startKeyImpl: () => 'same' }).alive, true)
})

test('this process reports a real start key and a never-allocated pid reports none', () => {
  assert.equal(typeof processStartKey(process.pid), 'string')
  assert.ok(processStartKey(process.pid).length > 0)
  assert.equal(processStartKey(0), null)
  assert.equal(processStartKey(-1), null)
})

test('a live owner is never recovered: the lease is extended instead', t => {
  const dir = scratchDir(t, 'quorum-liveness-live-')
  let clock = 1_000_000
  const control = new AgentControlManager({ store: openStore(t, dir), clock: () => clock, startKeyImpl: () => 'start-key-1' })
  const run = control.createRun({ runtime: 'codex', role: 'builder', repoRoot: dir, worktree: dir, pid: 4242 })
  assert.equal(control.getRun(run.runId).pidStartedAt, 'start-key-1')
  clock += 10_000_000
  const result = control.recover({ now: clock })
  assert.deepEqual(result.recovered, [])
  assert.deepEqual(result.abandoned, [])
  const after = control.getRun(run.runId)
  assert.equal(after.status, 'active')
  assert.match(after.disposition, /lease extended/)
  assert.ok(after.leaseExpiresAt > clock)
})

test('a run that was never bound to a process is abandoned, not replaced', t => {
  const dir = scratchDir(t, 'quorum-liveness-phantom-')
  let clock = 1_000_000
  const control = new AgentControlManager({ store: openStore(t, dir), clock: () => clock, startKeyImpl: () => null })
  const run = control.createRun({ runtime: 'codex', role: 'builder', repoRoot: dir, worktree: dir })
  for (let pass = 0; pass < 4; pass++) { clock += 10_000_000; control.recover({ now: clock }) }
  const runs = control.store.list('runs')
  assert.equal(runs.length, 1, 'no replacement run was minted')
  assert.equal(control.getRun(run.runId).status, 'abandoned')
  assert.match(control.getRun(run.runId).disposition, /not bound to a process/)
  assert.equal(control.store.list('claims').every(claim => claim.status === 'released'), true)
})

test('recovery of a dead owner happens once and stops at the depth cap', t => {
  const dir = scratchDir(t, 'quorum-liveness-depth-')
  let clock = 1_000_000
  const control = new AgentControlManager({ store: openStore(t, dir), clock: () => clock, startKeyImpl: () => null })
  const run = control.createRun({ runtime: 'codex', role: 'builder', repoRoot: dir, worktree: dir, pid: 4242, pidStartedAt: 'start-key-1' })
  for (let pass = 0; pass < 4; pass++) { clock += 10_000_000; control.recover({ now: clock }) }
  const replacement = control.store.list('runs').find(item => item.role === 'recovery')
  assert.ok(replacement, 'a dead owner with a real pid is recovered once')
  assert.equal(replacement.recoveryDepth, 1)
  assert.equal(control.getRun(run.runId).status, 'recovery-pending')
  // The replacement has no process of its own, so the next sweep retires it
  // rather than minting a third run. This is the loop that produced 79
  // self-spawned runs on the author's machine.
  for (let pass = 0; pass < 4; pass++) { clock += 10_000_000; control.recover({ now: clock }) }
  const all = control.store.list('runs')
  assert.equal(all.length, 2, `expected the chain to stop at two runs, saw ${all.length}`)
  assert.equal(control.getRun(replacement.runId).status, 'abandoned')
})

test('reconciliation retires ownerless runs once, after backing the state file up', t => {
  const dir = scratchDir(t, 'quorum-liveness-reconcile-')
  let clock = 1_000_000
  const store = openStore(t, dir)
  // The owned run's pid must look alive on every machine: a bare `() => null`
  // made liveness depend on whether pid 4242 happened to exist, which differs
  // between a developer's Mac and a CI container and made this assertion flaky.
  const control = new AgentControlManager({
    store,
    clock: () => clock,
    startKeyImpl: pid => (Number(pid) === 4242 ? 'start-key-1' : null),
  })
  const phantom = control.createRun({ runtime: 'codex', role: 'builder', repoRoot: dir, worktree: dir })
  const otherRoot = scratchDir(t, 'quorum-liveness-owned-')
  const owned = control.createRun({ runtime: 'codex', role: 'builder', repoRoot: otherRoot, worktree: otherRoot, pid: 4242, pidStartedAt: 'start-key-1' })
  clock += 10_000_000
  const logs = []
  const first = control.reconcilePhantomRuns({ now: clock, log: line => logs.push(line) })
  assert.equal(first.skipped, false)
  assert.equal(first.count, 1)
  assert.ok(fs.existsSync(first.backup), 'the state file is copied before records are rewritten')
  assert.equal(JSON.parse(fs.readFileSync(first.backup, 'utf8')).runs[phantom.runId].status, 'active', 'the backup holds the pre-migration record')
  assert.equal(logs.length, 1)
  assert.match(logs[0], /never bound to a process/)
  assert.equal(control.getRun(phantom.runId).status, 'abandoned')
  assert.equal(control.getRun(owned.runId).status, 'active', 'a bound run is left alone')

  const second = control.reconcilePhantomRuns({ now: clock, log: line => logs.push(line) })
  assert.equal(second.skipped, true, 'the pass is one-time')
  assert.equal(logs.length, 1)
  const ids = control.store.list('runs').map(run => run.runId).sort()
  assert.deepEqual(ids, [phantom.runId, owned.runId].sort(), 'reconciliation deletes nothing and invents nothing')
})

test('the store persists more records than the redaction bound, instead of dropping the oldest', t => {
  const dir = scratchDir(t, 'quorum-store-bound-')
  const store = openStore(t, dir)
  for (let index = 0; index < 120; index++) store.append('runs', { id: `run-${String(index).padStart(3, '0')}`, runId: `run-${index}`, status: 'active', updatedAt: index })
  assert.equal(store.list('runs').length, 120)
  const reloaded = openStore(t, dir)
  assert.equal(reloaded.list('runs').length, 120, 'records survive a reload')
  assert.ok(reloaded.get('runs', 'run-000'), 'the oldest record is still there')
  assert.ok(reloaded.get('runs', 'run-119'), 'the newest record is still there')
})

test('a recovery sweep asks about each pid once and stops at its probe budget', t => {
  const dir = scratchDir(t, 'quorum-liveness-budget-')
  let clock = 1_000
  const probes = []
  const control = new AgentControlManager({
    store: openStore(t, dir),
    clock: () => clock,
    startKeyImpl: pid => { probes.push(pid); return null },
    policy: { ...loadPolicy(), lease: { ...loadPolicy().lease, maxLivenessProbesPerSweep: 3, recoveryMisses: 1 } },
  })
  // Ten expired runs, but only three distinct pids between them. Each needs
  // its own worktree because a run claims the path it works in.
  for (let index = 0; index < 10; index++) {
    const root = scratchDir(t, 'quorum-liveness-budget-repo-')
    control.createRun({ runtime: 'codex', role: 'builder', repoRoot: root, worktree: root, pid: 5000 + (index % 3), pidStartedAt: 'start-key' })
  }
  clock += 10_000_000
  control.recover({ now: clock })
  assert.equal(probes.length, 3, `each pid is asked about once per sweep, not once per run: ${probes.join(',')}`)
  assert.deepEqual([...new Set(probes)].sort(), [5000, 5001, 5002])

  // A budget smaller than the number of distinct pids leaves the rest alone.
  const tight = new AgentControlManager({
    store: openStore(t, scratchDir(t, 'quorum-liveness-tight-')),
    clock: () => clock,
    startKeyImpl: () => null,
    policy: { ...loadPolicy(), lease: { ...loadPolicy().lease, maxLivenessProbesPerSweep: 2, recoveryMisses: 1 } },
  })
  for (let index = 0; index < 6; index++) { const each = scratchDir(t, 'quorum-liveness-tight-repo-'); tight.createRun({ runtime: 'codex', role: 'builder', repoRoot: each, worktree: each, pid: 6000 + index, pidStartedAt: 'start-key' }) }
  clock += 10_000_000
  tight.recover({ now: clock })
  const touched = tight.store.list('runs').filter(run => Number(run.missedHeartbeats || 0) > 0)
  assert.equal(touched.length, 2, 'runs past the probe budget are left for the next sweep, not assumed dead')
  assert.equal(tight.store.list('runs').some(run => run.status === 'abandoned'), false, 'an unmeasured run is never recorded as dead')
})

test('an unmeasured liveness reading is a different fact from a dead process', () => {
  assert.equal(runLiveness({ pid: 42, pidStartedAt: 'k' }, { startKeyImpl: () => undefined }).unmeasured, true)
  assert.match(runLiveness({ pid: 42, pidStartedAt: 'k' }, { startKeyImpl: () => undefined }).reason, /was not measured/)
  assert.equal(runLiveness({ pid: 42, pidStartedAt: 'k' }, { startKeyImpl: () => null }).unmeasured, undefined)
  assert.match(runLiveness({ pid: 42, pidStartedAt: 'k' }, { startKeyImpl: () => null }).reason, /no longer running/)
})

test('reconciling a backlog of phantom runs writes the state file once, not once per run', t => {
  const dir = scratchDir(t, 'quorum-reconcile-writes-')
  let clock = 1_000
  const store = openStore(t, dir)
  const control = new AgentControlManager({ store, clock: () => clock, startKeyImpl: () => null })
  for (let index = 0; index < 40; index++) { const root = scratchDir(t, 'quorum-reconcile-writes-repo-'); control.createRun({ runtime: 'codex', role: 'builder', repoRoot: root, worktree: root }) }
  clock += 10_000_000

  // Count real writes: `save()` finishes with an atomic rename onto the state
  // file, so one rename is one full re-serialisation of the whole store.
  let writes = 0
  const realRename = fs.renameSync
  fs.renameSync = (from, to) => { if (to === store.file) writes += 1; return realRename(from, to) }
  try {
    const result = control.reconcilePhantomRuns({ now: clock })
    assert.equal(result.count, 40)
  } finally { fs.renameSync = realRename }

  // One write for the pass plus one for the idempotence marker. Before
  // batching this was one per phantom — 79 on the author's machine, all
  // before the cockpit answered its first request.
  assert.ok(writes <= 2, `reconciliation rewrote the whole state file ${writes} times`)
  assert.equal(control.store.list('runs').filter(run => run.status === 'abandoned').length, 40)
  // And the batched write really landed on disk.
  const reloaded = openStore(t, dir)
  assert.equal(reloaded.list('runs').filter(run => run.status === 'abandoned').length, 40)
})
