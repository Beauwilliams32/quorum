import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { AgentControlStore, redact } from './store.js'
import { actionAllowed, isProtectedPath, loadPolicy, policySummary, rolePolicy } from './policy.js'
import { redactRuntimeText } from '../runtime-events.js'
import { processStartKey, runLiveness } from '../process-liveness.js'

const id = prefix => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
const now = () => Date.now()
const clean = value => redactRuntimeText(value).slice(0, 300)
const DIGEST = /^[a-f0-9]{64}$/i

// Task content belongs to the selected runtime, not the control-plane store.
// Keep a bounded, redacted receipt so that a recovered run can be identified
// and audited without copying a prompt, recall payload, or transcript.
function taskPacket(input = {}) {
  const packet = input && typeof input === 'object' ? input : {}
  const packetInput = packet.input && typeof packet.input === 'object' ? packet.input : {}
  const packetMemory = packet.memory && typeof packet.memory === 'object' ? packet.memory : {}
  const inputDigest = clean(packet.inputDigest ?? packetInput.sha256).toLowerCase()
  return {
    schemaVersion: 1,
    id: clean(packet.id) || id('packet'),
    source: clean(packet.source || 'manual'),
    missionId: clean(packet.missionId),
    taskId: clean(packet.taskId),
    input: {
      sha256: DIGEST.test(inputDigest) ? inputDigest : null,
      chars: Math.max(0, Math.min(8_000, Number(packet.inputChars ?? packetInput.chars) || 0)),
      bytes: Math.max(0, Math.min(32_000, Number(packet.inputBytes ?? packetInput.bytes) || 0)),
      maxChars: 8_000,
      truncated: packet.truncated === true || packetInput.truncated === true,
    },
    memory: {
      included: packet.memoryIncluded === true || packetMemory.included === true,
      bytes: Math.max(0, Math.min(32_000, Number(packet.memoryBytes ?? packetMemory.bytes) || 0)),
    },
  }
}

function readinessEvidence(value) {
  const source = value && typeof value === 'object' ? value : {}
  const status = key => clean(source[key] || 'not-reported')
  return {
    source: status('source'),
    environment: status('environment'),
    provider: status('provider'),
    owner: status('owner'),
    release: status('release'),
  }
}

export class AgentControlManager {
  constructor({ store = new AgentControlStore(), policy = loadPolicy(), clock = now, startKeyImpl = processStartKey } = {}) {
    this.store = store
    this.policy = policy
    this.clock = clock
    this.startKeyImpl = startKeyImpl
  }

  /** `{ alive, reason }` for a run, from the exact (pid, start-time) pair it was bound to. */
  liveness(runId, { startKeyImpl = this.startKeyImpl } = {}) {
    const run = typeof runId === 'object' && runId ? runId : this.getRun(runId)
    return runLiveness(run, { startKeyImpl })
  }

  /**
   * A start-key reader for one sweep: each pid is asked about once, and only
   * `budget` distinct pids are asked about at all.
   *
   * `processStartKey` shells out with a synchronous `execFileSync('ps', …)` on
   * the event loop. A sweep over a backlog of expired runs was therefore N
   * synchronous process spawns, blocking the cockpit's HTTP and WS handling
   * for as long as it took. A sweep that has spent its budget reports
   * `undefined`, which callers must read as "not measured this sweep" and
   * leave the run alone until the next one — never as "dead".
   */
  #sweepStartKey(budget = 32) {
    const seen = new Map()
    let spent = 0
    return pid => {
      const key = String(pid)
      if (seen.has(key)) return seen.get(key)
      if (spent >= budget) return undefined
      spent += 1
      const value = this.startKeyImpl(pid)
      seen.set(key, value)
      return value
    }
  }

  /**
   * Bind a run to the process that is actually doing its work. Until a run is
   * bound it can heartbeat but it can never be *recovered*, because there is
   * no owner whose death could be confirmed.
   */
  bindProcess(runId, pid, pidStartedAt = null) {
    const run = this.getRun(runId)
    const value = Number(pid)
    if (!Number.isInteger(value) || value <= 0) throw new Error('process binding requires a pid')
    const key = clean(pidStartedAt) || this.startKeyImpl(value) || ''
    run.pid = value
    run.pidStartedAt = key
    run.updatedAt = this.clock()
    this.store.append('runs', run)
    return this.getRun(runId)
  }

  summary() { return policySummary(this.policy) }

  createRun(input = {}) {
    const role = clean(input.role || 'researcher')
    rolePolicy(this.policy, role)
    const repoRoot = path.resolve(clean(input.repoRoot || process.cwd()))
    const worktree = path.resolve(clean(input.worktree || repoRoot))
    const maxClaimedPaths = Number(this.policy.lease?.maxClaimedPaths || 40)
    const claimedPaths = Array.isArray(input.claimedPaths) ? [...new Set(input.claimedPaths.map(value => path.resolve(String(value))).filter(Boolean))].slice(0, maxClaimedPaths) : [worktree]
    if (claimedPaths.some(candidate => isProtectedPath(this.policy, candidate))) throw new Error('run claims a protected path')
    const activeClaims = this.store.list('claims').filter(claim => ['active', 'recovery-pending'].includes(claim.status) && Number(claim.leaseExpiresAt) > this.clock())
    const conflict = activeClaims.find(claim => claimedPaths.some(candidate => candidate === claim.path || candidate.startsWith(claim.path + path.sep) || claim.path.startsWith(candidate + path.sep)))
    if (conflict) throw new Error(`claimed path is already owned by run ${conflict.runId}: ${conflict.path}`)
    const stamp = this.clock()
    const runId = id('run')
    const ttl = (this.policy.lease?.ttlSeconds || 900) * 1000
    const run = {
      id: runId, runId, runtime: clean(input.runtime || 'generic'), role, packId: clean(input.packId), modelRef: clean(input.modelRef), repoRoot, worktree,
      branch: clean(input.branch || ''), owner: clean(input.owner || os.userInfo().username), missionId: clean(input.missionId), parentTask: clean(input.parentTask),
      claimedPaths, leaseExpiresAt: stamp + ttl, heartbeatAt: stamp, missedHeartbeats: 0,
      plannedActions: Array.isArray(input.plannedActions) ? input.plannedActions.map(clean).filter(Boolean).slice(0, 20) : [],
      requiredGates: Array.isArray(input.requiredGates) ? input.requiredGates.map(clean).filter(Boolean).slice(0, 20) : [],
      taskPacket: taskPacket(input.taskPacket), providerSessionId: clean(input.providerSessionId) || null,
      recovery: input.recovery && typeof input.recovery === 'object' ? {
        sourceRunId: clean(input.recovery.sourceRunId) || null,
        providerSessionId: clean(input.recovery.providerSessionId) || null,
        checkpointIds: Array.isArray(input.recovery.checkpointIds) ? input.recovery.checkpointIds.map(clean).filter(Boolean).slice(-50) : [],
      } : null,
      checkpoints: [], tests: [], blockers: [], externalActionIds: [],
      pid: Number.isInteger(input.pid) && input.pid > 0 ? input.pid : null,
      pidStartedAt: clean(input.pidStartedAt) || (Number.isInteger(input.pid) && input.pid > 0 ? clean(this.startKeyImpl(input.pid)) : ''),
      // How many recoveries deep this run already is. A replacement inherits
      // its source's depth plus one, and `recover()` refuses past the cap, so
      // a failing recovery can no longer spawn an unbounded chain.
      recoveryDepth: Math.max(0, Math.min(Number(input.recoveryDepth) || 0, 50)),
      status: 'active', phase: 'claimed', disposition: null,
      createdAt: stamp, updatedAt: stamp,
    }
    this.store.append('runs', run)
    for (const claimPath of claimedPaths) this.store.append('claims', { id: id('claim'), runId, path: claimPath, leaseExpiresAt: run.leaseExpiresAt, status: 'active', createdAt: stamp, updatedAt: stamp })
    this.checkpoint(runId, { phase: 'claimed', reason: 'run-start' })
    return this.getRun(runId)
  }

  getRun(runId) {
    const run = this.store.get('runs', runId)
    if (!run) throw new Error(`unknown run: ${runId}`)
    return run
  }

  heartbeat(runId, input = {}) {
    const run = this.getRun(runId)
    if (run.status !== 'active') throw new Error(`run is ${run.status}`)
    const stamp = this.clock()
    run.heartbeatAt = stamp; run.leaseExpiresAt = stamp + (this.policy.lease?.ttlSeconds || 900) * 1000; run.missedHeartbeats = 0; run.phase = clean(input.phase || run.phase); run.updatedAt = stamp
    this.store.append('runs', run)
    for (const claim of this.store.list('claims').filter(item => item.runId === runId && item.status === 'active')) { claim.leaseExpiresAt = run.leaseExpiresAt; claim.updatedAt = stamp; this.store.append('claims', claim) }
    return this.getRun(runId)
  }

  providerSession(runId, providerSessionId) {
    const run = this.getRun(runId)
    const sessionId = clean(providerSessionId)
    if (!sessionId) return run
    run.providerSessionId = sessionId
    run.updatedAt = this.clock()
    this.store.append('runs', run)
    return this.getRun(runId)
  }

  checkpoint(runId, input = {}) {
    const run = this.getRun(runId)
    if (!['active', 'stale', 'recovery-pending'].includes(run.status)) throw new Error(`run is ${run.status}`)
    const stamp = this.clock()
    const checkpoint = { id: id('checkpoint'), runId, taskPacketId: run.taskPacket?.id || null, phase: clean(input.phase || run.phase), reason: clean(input.reason || 'manual'), tests: Array.isArray(input.tests) ? input.tests.map(clean).slice(0, 20) : [], changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles.map(clean).slice(0, 40) : [], blockers: Array.isArray(input.blockers) ? input.blockers.map(clean).slice(0, 20) : [], verification: Array.isArray(input.verification) ? input.verification.map(clean).slice(0, 20) : [], createdAt: stamp }
    run.checkpoints = [...(run.checkpoints || []), checkpoint.id].slice(-50); run.tests = checkpoint.tests; run.blockers = checkpoint.blockers; run.phase = checkpoint.phase; run.updatedAt = stamp
    this.store.append('checkpoints', checkpoint); this.store.append('runs', run)
    return this.store.get('checkpoints', checkpoint.id)
  }

  close(runId, input = {}) {
    const run = this.getRun(runId)
    if (['closed', 'blocked', 'cancelled'].includes(run.status)) return run
    const stamp = this.clock()
    const disposition = clean(input.disposition || 'completed')
    if (!['completed', 'blocked', 'cancelled'].includes(disposition)) throw new Error(`unsupported closeout disposition: ${disposition}`)
    const blockers = Array.isArray(input.blockers) ? input.blockers.map(clean).filter(Boolean).slice(0, 20) : []
    if (disposition === 'blocked' && blockers.length === 0) throw new Error('blocked closeout requires a truthful blocker')
    const lastCheckpoint = this.store.get('checkpoints', run.checkpoints?.at(-1)) || {}
    const verification = Array.isArray(input.verification) ? input.verification.map(clean).filter(Boolean).slice(0, 20) : (lastCheckpoint.verification || [])
    const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles.map(clean).filter(Boolean).slice(0, 40) : (lastCheckpoint.changedFiles || [])
    const checks = Array.isArray(input.checks) ? input.checks.map(clean).filter(Boolean).slice(0, 30) : (lastCheckpoint.tests || run.tests || [])
    const execution = input.execution && typeof input.execution === 'object' ? {
      planId: clean(input.execution.planId) || null,
      authorizationIds: Array.isArray(input.execution.authorizationIds) ? input.execution.authorizationIds.map(clean).filter(Boolean).slice(0, 20) : [],
      evidenceIds: Array.isArray(input.execution.evidenceIds) ? input.execution.evidenceIds.map(clean).filter(Boolean).slice(0, 40) : [],
      verificationIds: Array.isArray(input.execution.verificationIds) ? input.execution.verificationIds.map(clean).filter(Boolean).slice(0, 40) : [],
      learningIds: Array.isArray(input.execution.learningIds) ? input.execution.learningIds.map(clean).filter(Boolean).slice(0, 20) : [],
    } : null
    run.status = disposition === 'cancelled' ? 'cancelled' : disposition === 'blocked' ? 'blocked' : 'closed'; run.disposition = disposition; run.phase = 'closed'; run.closeout = { taskPacketId: run.taskPacket?.id || null, changedFiles, checks, blockers, verification, execution, externalActionIds: Array.isArray(input.externalActionIds) ? input.externalActionIds.map(clean).slice(0, 20) : run.externalActionIds, rollback: clean(input.rollback), readiness: typeof input.readiness === 'string' ? clean(input.readiness) : '', readinessEvidence: readinessEvidence(input.readiness), nextOwnerAction: clean(input.nextOwnerAction) }; run.updatedAt = stamp
    this.store.append('runs', run)
    for (const claim of this.store.list('claims').filter(item => item.runId === runId && item.status === 'active')) { claim.status = 'released'; claim.updatedAt = stamp; this.store.append('claims', claim) }
    return this.getRun(runId)
  }

  cancel(runId, input = {}) { return this.close(runId, { ...input, disposition: 'cancelled', nextOwnerAction: input.nextOwnerAction || 'resume only after inspecting the preserved checkpoint' }) }

  createAction(runId, input = {}) {
    const run = this.getRun(runId)
    const action = clean(input.action)
    const allowed = actionAllowed(this.policy, run.role, action, { target: input.target })
    if (!allowed.ok) throw new Error(allowed.reason)
    const planId = clean(input.planId)
    const actionId = clean(input.actionId)
    const revision = Math.max(1, Number(input.revision) || 1)
    const explicitKey = clean(input.idempotencyKey || input.target?.idempotencyKey)
    const idempotencyKey = planId && actionId ? `${planId}:${revision}:${actionId}` : explicitKey
    if (idempotencyKey) {
      const existing = this.store.list('actions').find(item => item.runId === runId && item.idempotencyKey === idempotencyKey)
      if (existing) return existing
    }
    const stamp = this.clock()
    const record = {
      id: id('action'), runId, planId: planId || null, actionId: actionId || null, revision,
      idempotencyKey: idempotencyKey || null, providerIdempotencyKey: explicitKey || null,
      action, target: redact(input.target || null), status: allowed.rule.approval ? 'pending-approval' : 'proposed',
      verification: allowed.rule.verification, requiresReadback: allowed.rule.postActionReadback === true,
      executorId: null, evidenceId: null, resultState: null, createdAt: stamp, updatedAt: stamp,
    }
    this.store.append('actions', record)
    run.externalActionIds = [...(run.externalActionIds || []), record.id].slice(-50); run.updatedAt = this.clock(); this.store.append('runs', run)
    return this.store.get('actions', record.id)
  }

  approveAction(actionId) { return this.#setAction(actionId, 'approved') }
  cancelAction(actionId) { return this.#setAction(actionId, 'cancelled') }
  denyAction(actionId) { return this.#setAction(actionId, 'denied') }
  startAction(actionId, executorId) {
    const action = this.store.get('actions', actionId)
    if (!action) throw new Error(`unknown action: ${actionId}`)
    if (action.status === 'executing' || action.status === 'executed') return action
    if (!['proposed', 'approved'].includes(action.status)) throw new Error(`action is ${action.status}`)
    const actor = clean(executorId)
    if (!actor) throw new Error('action execution requires an executor identity')
    action.status = 'executing'; action.executorId = actor; action.startedAt = this.clock(); action.updatedAt = this.clock()
    this.store.append('actions', action)
    return this.store.get('actions', action.id)
  }
  completeAction(actionId, input = {}) {
    const action = this.store.get('actions', actionId)
    if (!action) throw new Error(`unknown action: ${actionId}`)
    const evidenceId = clean(input.evidenceId)
    if (action.status === 'executed' && action.evidenceId === evidenceId) return action
    if (action.status !== 'executing') throw new Error(`action is ${action.status}`)
    if (action.requiresReadback && input.status !== 'failed' && input.readbackCaptured !== true) throw new Error('action requires post-action readback')
    action.status = input.status === 'failed' ? 'failed' : 'executed'
    action.evidenceId = evidenceId || null
    action.resultState = clean(input.resultState || action.status)
    action.readbackCaptured = input.readbackCaptured === true
    action.finishedAt = this.clock(); action.updatedAt = this.clock()
    this.store.append('actions', action)
    return this.store.get('actions', action.id)
  }
  #setAction(actionId, status) {
    const action = this.store.get('actions', actionId)
    if (!action) throw new Error(`unknown action: ${actionId}`)
    if (action.status === status) return action
    if (!['pending-approval', 'proposed', 'approved'].includes(action.status)) throw new Error(`action is ${action.status}`)
    action.status = status; action.updatedAt = this.clock(); this.store.append('actions', action); return action
  }

  /**
   * Retire a run that can never make progress again, releasing its claims.
   * Abandonment is a terminal state that costs nothing: no replacement run, no
   * lease, no process. Nothing is deleted — the record and its checkpoints stay
   * exactly where they were, with a truthful reason attached.
   */
  abandon(runId, reason, current = this.clock()) {
    const run = this.getRun(runId)
    run.status = 'abandoned'
    run.phase = 'abandoned'
    run.disposition = clean(reason) || 'abandoned'
    run.updatedAt = current
    this.store.append('runs', run)
    for (const claim of this.store.list('claims').filter(item => item.runId === run.runId && ['active', 'recovery-pending'].includes(item.status))) {
      claim.status = 'released'; claim.updatedAt = current; this.store.append('claims', claim)
    }
    return this.getRun(run.runId)
  }

  /**
   * Replace runs whose owning process is confirmed dead.
   *
   * Three gates, all of which were missing:
   *   1. A live owner is never recovered — an expired lease on a running
   *      process is a heartbeat problem, so the lease is refreshed instead.
   *   2. A run with no bound process is abandoned, not replaced. It never had
   *      an owner, so there is nothing to take over, and minting a successor
   *      only produces another ownerless run.
   *   3. Recovery depth is capped. Past the cap the run is abandoned with the
   *      cap named in its disposition.
   *
   * Returns `{ recovered, abandoned }` — the two outcomes are different facts
   * and a caller that reports "recovered" for a retirement is lying.
   */
  recover({ now: current = this.clock() } = {}) {
    const recovered = []
    const abandoned = []
    const maxDepth = Math.max(0, Number(this.policy.lease?.maxRecoveryDepth ?? 1))
    const startKeyImpl = this.#sweepStartKey(Math.max(1, Number(this.policy.lease?.maxLivenessProbesPerSweep ?? 32)))
    for (const run of this.store.list('runs')) {
      if (!['active', 'stale'].includes(run.status) || Number(run.leaseExpiresAt) > current) continue
      const live = this.liveness(run, { startKeyImpl })
      // The sweep ran out of probe budget before reaching this run. It is not
      // dead, it is unmeasured, and nothing is decided about an unmeasured
      // run: it waits for the next sweep.
      if (live.unmeasured) continue
      if (live.alive) {
        // The owner is still running: an expired lease here means heartbeats
        // were lost, not that the work stopped. Never hand its paths away.
        run.leaseExpiresAt = current + (this.policy.lease?.ttlSeconds || 900) * 1000
        run.missedHeartbeats = 0
        run.status = 'active'
        run.disposition = `lease extended: ${live.reason}`
        run.lastRecoveryCheckAt = current
        run.updatedAt = current
        this.store.append('runs', run)
        for (const claim of this.store.list('claims').filter(item => item.runId === run.runId && item.status === 'active')) { claim.leaseExpiresAt = run.leaseExpiresAt; claim.updatedAt = current; this.store.append('claims', claim) }
        continue
      }
      if (run.lastRecoveryCheckAt && current - Number(run.lastRecoveryCheckAt) < (this.policy.lease?.heartbeatSeconds || 120) * 1000) continue
      const misses = Number(run.missedHeartbeats || 0) + 1; run.missedHeartbeats = misses; run.lastRecoveryCheckAt = current; run.updatedAt = current; this.store.append('runs', run)
      if (run.status === 'active') { run.status = 'stale'; run.disposition = 'lease expired; awaiting missed-heartbeat confirmation'; run.updatedAt = current; this.store.append('runs', run) }
      if (misses < (this.policy.lease?.recoveryMisses || 3)) continue
      if (!Number.isInteger(Number(run.pid)) || Number(run.pid) <= 0) {
        abandoned.push(this.abandon(run.runId, `no recovery: ${live.reason}`, current))
        continue
      }
      const depth = Number(run.recoveryDepth || 0)
      if (depth >= maxDepth) {
        abandoned.push(this.abandon(run.runId, `no recovery: recovery depth cap ${maxDepth} reached`, current))
        continue
      }
      const replacement = this.createRun({ runtime: run.runtime, role: 'recovery', repoRoot: run.repoRoot, worktree: run.worktree, branch: run.branch, owner: os.userInfo().username, missionId: run.missionId, parentTask: run.runId, claimedPaths: run.claimedPaths, plannedActions: ['recovery.inspect'], requiredGates: ['lease-expiry', 'missed-heartbeats'], packId: 'recovery', taskPacket: run.taskPacket, recoveryDepth: depth + 1, recovery: { sourceRunId: run.runId, providerSessionId: run.providerSessionId, checkpointIds: run.checkpoints } })
      run.status = 'recovery-pending'; run.disposition = `replaced by ${replacement.runId}`; run.updatedAt = current; this.store.append('runs', run)
      for (const claim of this.store.list('claims').filter(item => item.runId === run.runId && item.status === 'active')) { claim.status = 'recovery-pending'; claim.updatedAt = current; this.store.append('claims', claim) }
      recovered.push(replacement)
    }
    return { recovered, abandoned }
  }

  /**
   * One-time, loudly-logged pass over runs that predate process binding.
   *
   * These are the runs the old `recover()` minted: no pid, an expired lease, a
   * `recovery-pending` or `stale` status, and a successor that was itself
   * ownerless. They are marked abandoned so liveness stops lying; nothing is
   * deleted, and the state file is copied into `~/.quorum` first. The marker
   * in the store makes the pass idempotent across restarts.
   */
  reconcilePhantomRuns({ now: current = this.clock(), log = () => {} } = {}) {
    const existing = this.store.getMarker?.('phantomRunReconciliation')
    if (existing) return { ...existing, skipped: true }
    const phantoms = this.store.list('runs').filter(run =>
      ['active', 'stale', 'recovery-pending'].includes(run.status)
      && !(Number.isInteger(Number(run.pid)) && Number(run.pid) > 0)
      && Number(run.leaseExpiresAt || 0) <= current)
    if (!phantoms.length) {
      const record = { at: new Date(current).toISOString(), backup: null, count: 0 }
      this.store.setMarker?.('phantomRunReconciliation', record)
      return { ...record, skipped: false }
    }
    const backup = this.store.backup?.('phantom-reconciliation') || null
    log(`agent-control: reconciling ${phantoms.length} run(s) that were never bound to a process; state backed up to ${backup || 'no backup path'}`)
    // One write for the whole pass, not one per phantom.
    const abandonAll = () => { for (const run of phantoms) this.abandon(run.runId, 'reconciled: run was never bound to a process and its lease had expired', current) }
    if (typeof this.store.batch === 'function') this.store.batch(abandonAll)
    else abandonAll()
    const record = { at: new Date(current).toISOString(), backup, count: phantoms.length }
    this.store.setMarker?.('phantomRunReconciliation', record)
    return { ...record, skipped: false }
  }

  snapshot() {
    return { policy: this.summary(), runs: this.store.list('runs').slice(0, 100), claims: this.store.list('claims').slice(0, 200), actions: this.store.list('actions').slice(0, 100) }
  }
}
