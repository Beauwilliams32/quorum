import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { AgentControlStore } from './store.js'
import { actionAllowed, isProtectedPath, loadPolicy, policySummary, rolePolicy } from './policy.js'

const id = prefix => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
const now = () => Date.now()
const clean = value => String(value || '').trim().slice(0, 300)

export class AgentControlManager {
  constructor({ store = new AgentControlStore(), policy = loadPolicy(), clock = now } = {}) {
    this.store = store
    this.policy = policy
    this.clock = clock
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
      branch: clean(input.branch || ''), owner: clean(input.owner || os.userInfo().username), parentTask: clean(input.parentTask),
      claimedPaths, leaseExpiresAt: stamp + ttl, heartbeatAt: stamp, missedHeartbeats: 0,
      plannedActions: Array.isArray(input.plannedActions) ? input.plannedActions.map(clean).filter(Boolean).slice(0, 20) : [],
      requiredGates: Array.isArray(input.requiredGates) ? input.requiredGates.map(clean).filter(Boolean).slice(0, 20) : [],
      checkpoints: [], tests: [], blockers: [], externalActionIds: [], pid: Number.isInteger(input.pid) ? input.pid : null, pidStartedAt: clean(input.pidStartedAt), status: 'active', phase: 'claimed', disposition: null,
      createdAt: stamp, updatedAt: stamp,
    }
    this.store.append('runs', run)
    for (const claimPath of claimedPaths) this.store.append('claims', { id: id('claim'), runId, path: claimPath, leaseExpiresAt: run.leaseExpiresAt, status: 'active', createdAt: stamp, updatedAt: stamp })
    return run
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
    return run
  }

  checkpoint(runId, input = {}) {
    const run = this.getRun(runId)
    if (!['active', 'stale', 'recovery-pending'].includes(run.status)) throw new Error(`run is ${run.status}`)
    const stamp = this.clock()
    const checkpoint = { id: id('checkpoint'), runId, phase: clean(input.phase || run.phase), reason: clean(input.reason || 'manual'), tests: Array.isArray(input.tests) ? input.tests.map(clean).slice(0, 20) : [], changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles.map(clean).slice(0, 40) : [], blockers: Array.isArray(input.blockers) ? input.blockers.map(clean).slice(0, 20) : [], verification: Array.isArray(input.verification) ? input.verification.map(clean).slice(0, 20) : [], createdAt: stamp }
    run.checkpoints = [...(run.checkpoints || []), checkpoint.id].slice(-50); run.tests = checkpoint.tests; run.blockers = checkpoint.blockers; run.phase = checkpoint.phase; run.updatedAt = stamp
    this.store.append('checkpoints', checkpoint); this.store.append('runs', run)
    return checkpoint
  }

  close(runId, input = {}) {
    const run = this.getRun(runId)
    if (run.status === 'closed') return run
    const stamp = this.clock()
    const disposition = clean(input.disposition || 'completed')
    run.status = disposition === 'cancelled' ? 'cancelled' : disposition === 'blocked' ? 'blocked' : 'closed'; run.disposition = disposition; run.phase = 'closed'; run.closeout = { changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles.map(clean).slice(0, 40) : [], checks: Array.isArray(input.checks) ? input.checks.map(clean).slice(0, 30) : [], blockers: Array.isArray(input.blockers) ? input.blockers.map(clean).slice(0, 20) : [], externalActionIds: Array.isArray(input.externalActionIds) ? input.externalActionIds.map(clean).slice(0, 20) : run.externalActionIds, rollback: clean(input.rollback), readiness: clean(input.readiness), nextOwnerAction: clean(input.nextOwnerAction) }; run.updatedAt = stamp
    this.store.append('runs', run)
    for (const claim of this.store.list('claims').filter(item => item.runId === runId && item.status === 'active')) { claim.status = 'released'; claim.updatedAt = stamp; this.store.append('claims', claim) }
    return run
  }

  cancel(runId, input = {}) { return this.close(runId, { ...input, disposition: 'cancelled', nextOwnerAction: input.nextOwnerAction || 'resume only after inspecting the preserved checkpoint' }) }

  createAction(runId, input = {}) {
    const run = this.getRun(runId)
    const action = clean(input.action)
    const allowed = actionAllowed(this.policy, run.role, action, { target: input.target })
    if (!allowed.ok) throw new Error(allowed.reason)
    const record = { id: id('action'), runId, action, target: input.target || null, status: allowed.rule.approval ? 'pending-approval' : 'proposed', verification: allowed.rule.verification, createdAt: this.clock(), updatedAt: this.clock() }
    this.store.append('actions', record)
    run.externalActionIds = [...(run.externalActionIds || []), record.id].slice(-50); run.updatedAt = this.clock(); this.store.append('runs', run)
    return record
  }

  approveAction(actionId) { return this.#setAction(actionId, 'approved') }
  cancelAction(actionId) { return this.#setAction(actionId, 'cancelled') }
  #setAction(actionId, status) {
    const action = this.store.get('actions', actionId)
    if (!action) throw new Error(`unknown action: ${actionId}`)
    if (!['pending-approval', 'proposed', 'approved'].includes(action.status)) throw new Error(`action is ${action.status}`)
    action.status = status; action.updatedAt = this.clock(); this.store.append('actions', action); return action
  }

  recover({ now: current = this.clock() } = {}) {
    const recovered = []
    for (const run of this.store.list('runs')) {
      if (!['active', 'stale'].includes(run.status) || Number(run.leaseExpiresAt) > current) continue
      if (run.lastRecoveryCheckAt && current - Number(run.lastRecoveryCheckAt) < (this.policy.lease?.heartbeatSeconds || 120) * 1000) continue
      const misses = Number(run.missedHeartbeats || 0) + 1; run.missedHeartbeats = misses; run.lastRecoveryCheckAt = current; run.updatedAt = current; this.store.append('runs', run)
      if (run.status === 'active') { run.status = 'stale'; run.disposition = 'lease expired; awaiting missed-heartbeat confirmation'; run.updatedAt = current; this.store.append('runs', run) }
      if (misses < (this.policy.lease?.recoveryMisses || 3)) continue
      const replacement = this.createRun({ runtime: run.runtime, role: 'recovery', repoRoot: run.repoRoot, worktree: run.worktree, branch: run.branch, owner: os.userInfo().username, parentTask: run.runId, claimedPaths: run.claimedPaths, plannedActions: ['recovery.inspect'], requiredGates: ['lease-expiry', 'missed-heartbeats'], packId: 'recovery' })
      run.status = 'recovery-pending'; run.disposition = `replaced by ${replacement.runId}`; run.updatedAt = current; this.store.append('runs', run)
      for (const claim of this.store.list('claims').filter(item => item.runId === run.runId && item.status === 'active')) { claim.status = 'recovery-pending'; claim.updatedAt = current; this.store.append('claims', claim) }
      recovered.push(replacement)
    }
    return recovered
  }

  snapshot() {
    return { policy: this.summary(), runs: this.store.list('runs').slice(0, 100), claims: this.store.list('claims').slice(0, 200), actions: this.store.list('actions').slice(0, 100) }
  }
}
