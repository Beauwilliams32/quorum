import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { redact } from './store.js'

const makeId = prefix => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
const clean = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function normalizeCriterion(input, index) {
  return {
    id: clean(input?.id || `criterion-${index + 1}`, 80),
    description: clean(input?.description, 500),
  }
}

function normalizeAction(input, index) {
  return {
    id: clean(input?.id || `action-${index + 1}`, 80),
    action: clean(input?.action, 80),
    expected: clean(input?.expected, 500),
    criterionIds: Array.isArray(input?.criterionIds) ? [...new Set(input.criterionIds.map(value => clean(value, 80)).filter(Boolean))].slice(0, 20) : [],
    target: redact(input?.target || null),
    requiresArtifact: input?.requiresArtifact === true,
  }
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep)
}

function validateArtifacts(values, run) {
  const roots = [run?.worktree, run?.repoRoot].filter(Boolean).map(value => {
    try { return fs.realpathSync(path.resolve(value)) } catch { return path.resolve(value) }
  })
  const valid = []
  const invalid = []
  for (const raw of Array.isArray(values) ? values.slice(0, 20) : []) {
    const value = clean(raw, 500)
    if (!value) continue
    if (/^kanban-attachment:\/\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(value)) {
      valid.push(value)
      continue
    }
    const candidate = path.resolve(run?.worktree || run?.repoRoot || process.cwd(), value)
    try {
      const resolved = fs.realpathSync(candidate)
      if (roots.some(root => within(root, resolved))) valid.push(resolved)
      else invalid.push(value)
    } catch { invalid.push(value) }
  }
  return { valid: [...new Set(valid)], invalid: [...new Set(invalid)] }
}

function normalizeEvidence(input, { planId, runId, actionId, attempt, revision, executorId, artifacts, timestamp }) {
  if (!input || typeof input !== 'object') return null
  const status = clean(input.status, 80)
  const exitCode = Number.isInteger(input.exitCode) ? input.exitCode : null
  if (!status || (exitCode === null && artifacts.length === 0)) return null
  return redact({
    id: makeId('evidence'), planId, runId, actionId, attempt, revision,
    executorId: clean(executorId, 120), status, resultState: clean(input.resultState || status, 120), exitCode, artifacts,
    observed: clean(input.observed, 1_200),
    readback: clean(input.readback, 1_200),
    replayedTests: Array.isArray(input.replayedTests) ? input.replayedTests.map(value => clean(value, 1_200)).filter(Boolean).slice(0, 20) : [],
    startedAt: input.startedAt || null,
    finishedAt: input.finishedAt || new Date(timestamp).toISOString(),
    createdAt: timestamp,
  })
}

export class EvidenceExecutionEngine {
  constructor({ control, clock = () => Date.now() } = {}) {
    if (!control?.store) throw new Error('evidence execution requires agent control')
    this.control = control
    this.store = control.store
    this.clock = clock
    this.inFlight = new Map()
  }

  createPlan(runId, input = {}) {
    this.control.getRun(runId)
    const idempotencyKey = clean(input.idempotencyKey, 160)
    if (idempotencyKey) {
      const existing = this.store.list('executionPlans').find(plan => plan.runId === runId && plan.idempotencyKey === idempotencyKey)
      if (existing) return existing
    }
    const acceptanceCriteria = (Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : []).slice(0, 20).map(normalizeCriterion)
    const actions = (Array.isArray(input.actions) ? input.actions : []).slice(0, 20).map(normalizeAction)
    if (!acceptanceCriteria.length) throw new Error('execution plan needs at least one acceptance criterion')
    if (!actions.length) throw new Error('execution plan needs at least one action')
    const criterionIds = new Set(acceptanceCriteria.map(item => item.id))
    if (criterionIds.size !== acceptanceCriteria.length) throw new Error('acceptance criterion ids must be unique')
    if (actions.some(action => !action.action || !action.criterionIds.length || action.criterionIds.some(id => !criterionIds.has(id)))) throw new Error('each action must name valid criterion ids')
    const stamp = this.clock()
    const plan = {
      id: makeId('plan'), runId, idempotencyKey: idempotencyKey || null,
      source: redact(input.source || null),
      acceptanceCriteria, actions,
      maxAttempts: Math.max(1, Math.min(Number(input.maxAttempts) || Number(this.control.policy?.retries?.maxAttempts) || 3, 5)),
      attempts: 0, revision: 1, status: 'ready', disposition: null,
      authorizationIds: [], evidenceIds: [], verificationIds: [], learningIds: [], rework: [],
      createdAt: stamp, updatedAt: stamp,
    }
    this.store.append('executionPlans', plan)
    return this.store.get('executionPlans', plan.id)
  }

  getPlan(planId) {
    const plan = this.store.get('executionPlans', planId)
    if (!plan) throw new Error(`unknown execution plan: ${planId}`)
    return plan
  }

  execute(planId, actors = {}) {
    if (this.inFlight.has(planId)) return this.inFlight.get(planId)
    const pending = this.#execute(planId, actors)
    this.inFlight.set(planId, pending)
    pending.finally(() => {
      if (this.inFlight.get(planId) === pending) this.inFlight.delete(planId)
    }).catch(() => {})
    return pending
  }

  async #execute(planId, { executor, verifier } = {}) {
    const plan = this.getPlan(planId)
    if (['completed', 'denied', 'cancelled', 'exhausted'].includes(plan.status)) return plan
    if (plan.status === 'rework' && plan.lastAttemptRevision === plan.revision) return plan
    if (plan.attempts >= plan.maxAttempts) {
      plan.status = 'exhausted'; plan.disposition = 'exhausted'; plan.updatedAt = this.clock()
      this.store.append('executionPlans', plan)
      return this.getPlan(plan.id)
    }
    if (!executor?.id || typeof executor.run !== 'function') throw new Error('executor identity and run function are required')
    if (!verifier?.id || typeof verifier.verify !== 'function') throw new Error('independent verifier identity and verify function are required')
    if (clean(executor.id) === clean(verifier.id)) throw new Error('implementer and verifier must be independent identities')

    const run = this.control.getRun(plan.runId)
    const authorizations = plan.actions.map(action => ({
      action,
      authorization: this.control.createAction(plan.runId, {
        action: action.action,
        target: action.target,
        planId: plan.id,
        revision: plan.revision,
        actionId: action.id,
        idempotencyKey: action.target?.idempotencyKey,
      }),
    }))
    plan.authorizationIds = [...new Set([...plan.authorizationIds, ...authorizations.map(item => item.authorization.id)])].slice(-100)
    const denied = authorizations.find(item => ['cancelled', 'denied'].includes(item.authorization.status))
    if (denied) {
      plan.status = 'denied'
      plan.disposition = 'denied'
      plan.rework = denied.action.criterionIds.map(criterionId => ({
        criterionId, actionId: denied.action.id, authorizationId: denied.authorization.id,
        reason: `human approval denied for ${denied.action.action}`,
      }))
      plan.updatedAt = this.clock()
      this.store.append('executionPlans', plan)
      return this.getPlan(plan.id)
    }
    const waiting = authorizations.filter(item => item.authorization.status === 'pending-approval')
    if (waiting.length) {
      plan.status = 'waiting-approval'
      plan.disposition = null
      plan.rework = waiting.flatMap(({ action, authorization }) => action.criterionIds.map(criterionId => ({
        criterionId, actionId: action.id, authorizationId: authorization.id,
        reason: `human approval required for ${action.action}`,
      })))
      plan.updatedAt = this.clock()
      this.store.append('executionPlans', plan)
      return this.getPlan(plan.id)
    }

    const attempt = plan.attempts + 1
    const evidence = []
    const missingByCriterion = new Map()
    const missing = (criterionIds, value) => {
      for (const criterionId of criterionIds) {
        const entries = missingByCriterion.get(criterionId) || []
        entries.push(value)
        missingByCriterion.set(criterionId, entries)
      }
    }
    plan.status = 'executing'
    plan.attempts = attempt
    plan.lastAttemptRevision = plan.revision
    plan.rework = []
    plan.updatedAt = this.clock()
    this.store.append('executionPlans', plan)

    for (const { action, authorization } of authorizations) {
      if (authorization.status === 'executed' && authorization.evidenceId) {
        const existing = this.store.get('evidence', authorization.evidenceId)
        if (existing) evidence.push(existing)
        continue
      }
      if (!['proposed', 'approved'].includes(authorization.status)) {
        missing(action.criterionIds, { criterionId: null, actionId: action.id, authorizationId: authorization.id, reason: `authorization is ${authorization.status}` })
        continue
      }
      this.control.startAction(authorization.id, executor.id)
      const pendingLearning = plan.learningIds.map(id => this.store.get('learning', id)).filter(item => item?.reviewerStatus === 'pending' && item.revision === plan.revision && action.criterionIds.includes(item.source?.criterionId))
      const replayTests = [...new Set(pendingLearning.map(item => item.reproducibleTest).filter(Boolean))]
      let raw
      try {
        raw = await executor.run({ plan: redact(plan), action: redact(action), authorization: redact(authorization), attempt, replayTests })
      } catch (error) {
        const reason = clean(error?.message || error || 'executor failed', 500)
        this.control.completeAction(authorization.id, { status: 'failed', resultState: 'executor-error' })
        missing(action.criterionIds, { criterionId: null, actionId: action.id, authorizationId: authorization.id, reason: `executor failed for action ${action.id}${reason ? `: ${reason}` : ''}` })
        continue
      }
      const artifactCheck = validateArtifacts(raw?.artifacts, run)
      const record = normalizeEvidence(raw, {
        planId: plan.id, runId: plan.runId, actionId: action.id, attempt, revision: plan.revision,
        executorId: executor.id, artifacts: artifactCheck.valid, timestamp: this.clock(),
      })
      if (!record) {
        this.control.completeAction(authorization.id, { status: 'failed', resultState: 'missing-evidence' })
        missing(action.criterionIds, { criterionId: null, actionId: action.id, authorizationId: authorization.id, reason: `missing tool evidence for action ${action.id}` })
        continue
      }
      this.store.append('evidence', record)
      plan.evidenceIds.push(record.id)
      evidence.push(record)
      const evidenceProblems = []
      if (action.requiresArtifact && !record.artifacts.length) evidenceProblems.push(artifactCheck.invalid.length ? `required artifact is invalid or outside the claimed worktree for action ${action.id}` : `required artifact evidence is missing for action ${action.id}`)
      if (authorization.requiresReadback && !record.readback) evidenceProblems.push(`post-action readback is missing for ${action.action}`)
      const replayMissing = replayTests.filter(value => !record.replayedTests.includes(value))
      if (replayMissing.length) evidenceProblems.push(`reproducible test was not replayed: ${replayMissing.join(', ')}`)
      const failed = record.exitCode !== null && record.exitCode !== 0 || /^(failed|error|denied|cancelled)$/i.test(record.resultState)
      if (failed) evidenceProblems.push(`tool action ${action.id} failed with result ${record.resultState}${record.exitCode === null ? '' : ` and exit ${record.exitCode}`}`)
      this.control.completeAction(authorization.id, {
        status: failed || evidenceProblems.length ? 'failed' : 'executed', evidenceId: record.id,
        resultState: failed ? record.resultState : evidenceProblems.length ? 'evidence-incomplete' : record.resultState,
        readbackCaptured: Boolean(record.readback),
      })
      if (evidenceProblems.length) missing(action.criterionIds, {
        criterionId: null, actionId: action.id, authorizationId: authorization.id,
        evidenceIds: [record.id], reason: evidenceProblems.join('; '),
      })
    }

    const rework = []
    for (const criterion of plan.acceptanceCriteria) {
      const missingEntries = missingByCriterion.get(criterion.id) || []
      if (missingEntries.length) {
        rework.push(...missingEntries.map(item => ({ ...item, criterionId: criterion.id })))
        continue
      }
      const relevant = evidence.filter(record => plan.actions.some(action => action.id === record.actionId && action.criterionIds.includes(criterion.id)))
      if (!relevant.length) {
        rework.push({ criterionId: criterion.id, reason: 'missing tool evidence for criterion', evidenceIds: [], verificationIds: [] })
        continue
      }
      let decision
      try {
        decision = await verifier.verify({ planId: plan.id, runId: plan.runId, criterion: redact(criterion), evidence: redact(relevant), attempt, revision: plan.revision })
      } catch (error) {
        decision = { passed: false, observed: `independent verifier failed: ${clean(error?.message || error, 500)}` }
      }
      const verification = redact({
        id: makeId('verification'), planId: plan.id, runId: plan.runId, criterionId: criterion.id,
        attempt, revision: plan.revision, verifierId: clean(verifier.id, 120), passed: decision?.passed === true,
        observed: clean(decision?.observed, 1_200), evidenceIds: relevant.map(record => record.id), createdAt: this.clock(),
      })
      this.store.append('verifications', verification)
      plan.verificationIds.push(verification.id)
      if (!verification.passed) rework.push({
        criterionId: criterion.id,
        actionIds: [...new Set(relevant.map(item => item.actionId))],
        evidenceIds: verification.evidenceIds,
        verificationIds: [verification.id],
        reason: verification.observed || 'independent verification failed',
      })
    }

    plan.rework = rework
    plan.status = rework.length ? (plan.attempts >= plan.maxAttempts ? 'exhausted' : 'rework') : 'completed'
    plan.disposition = rework.length ? (plan.status === 'exhausted' ? 'exhausted' : null) : 'completed'
    plan.updatedAt = this.clock()
    this.store.append('executionPlans', plan)
    return this.getPlan(plan.id)
  }

  recordCorrection(planId, input = {}) {
    const plan = this.getPlan(planId)
    const criterionId = clean(input.criterionId, 80)
    const criterion = plan.acceptanceCriteria.find(item => item.id === criterionId)
    if (!criterion) throw new Error(`unknown acceptance criterion: ${criterionId}`)
    if (plan.status !== 'rework') throw new Error('corrections require a failed verification attempt')
    const failureClassification = clean(input.failureClassification, 120)
    const correction = clean(input.correction, 1_200)
    const reproducibleTest = clean(input.reproducibleTest, 1_200)
    const reusableLesson = clean(input.reusableLesson, 1_200)
    const rollback = clean(input.rollback, 1_200)
    const sourceLinks = Array.isArray(input.sourceLinks) ? input.sourceLinks.map(value => clean(value, 500)).filter(Boolean).slice(0, 20) : []
    if (!failureClassification || !correction || !reproducibleTest || !reusableLesson || !rollback || !sourceLinks.length) throw new Error('failure classification, correction, reproducible test, reusable lesson, rollback, and source links are required')
    const actions = plan.actions.filter(action => action.criterionIds.includes(criterionId))
    const evidence = plan.evidenceIds.map(id => this.store.get('evidence', id)).filter(item => item?.attempt === plan.attempts && actions.some(action => action.id === item.actionId))
    const verifications = plan.verificationIds.map(id => this.store.get('verifications', id)).filter(item => item?.attempt === plan.attempts && item.criterionId === criterionId)
    const stamp = this.clock()
    const learning = redact({
      id: makeId('learning'),
      source: { planId: plan.id, runId: plan.runId, criterionId, attempt: plan.attempts, revision: plan.revision, evidenceIds: evidence.map(item => item.id), verificationIds: verifications.map(item => item.id) },
      sourceLinks,
      attemptedAction: actions.map(action => ({ id: action.id, action: action.action })),
      expected: actions.map(action => action.expected).filter(Boolean),
      observed: evidence.map(item => ({ status: item.status, resultState: item.resultState, exitCode: item.exitCode, observed: item.observed, readback: item.readback, artifacts: item.artifacts })),
      failureClassification,
      correction,
      reproducibleTest,
      verification: { status: 'pending-replay', detail: '', evidenceIds: [] },
      reusableLesson,
      reviewerStatus: 'pending', reviewerId: null,
      revision: plan.revision + 1,
      rollback,
      status: 'draft', createdAt: stamp, updatedAt: stamp,
    })
    this.store.append('learning', learning)
    plan.learningIds.push(learning.id)
    plan.revision += 1
    plan.status = 'ready'
    plan.disposition = null
    plan.rework = []
    plan.updatedAt = stamp
    this.store.append('executionPlans', plan)
    return this.store.get('learning', learning.id)
  }

  reviewLearning(learningId, input = {}) {
    const learning = this.store.get('learning', learningId)
    if (!learning) throw new Error(`unknown learning record: ${learningId}`)
    const status = clean(input.status, 40)
    if (!['verified', 'rejected'].includes(status)) throw new Error('learning review must be verified or rejected')
    const reviewerId = clean(input.reviewerId, 120)
    if (!reviewerId) throw new Error('learning review requires a reviewer identity')
    const evidenceIds = Array.isArray(input.evidenceIds) ? [...new Set(input.evidenceIds.map(value => clean(value, 120)).filter(Boolean))].slice(0, 20) : []
    const verificationIds = Array.isArray(input.verificationIds) ? [...new Set(input.verificationIds.map(value => clean(value, 120)).filter(Boolean))].slice(0, 20) : []
    if (status === 'verified') {
      if (!evidenceIds.length || !verificationIds.length) throw new Error('verified learning review requires replay evidence and verification ids')
      const evidence = evidenceIds.map(id => this.store.get('evidence', id))
      const verifications = verificationIds.map(id => this.store.get('verifications', id))
      if (evidence.some(item => !item) || verifications.some(item => !item)) throw new Error('learning review references unknown evidence')
      if (evidence.some(item => item.executorId === reviewerId)) throw new Error('learning review must be independent of the executor')
      if (evidence.some(item => item.planId !== learning.source.planId || item.attempt <= learning.source.attempt || item.revision !== learning.revision)) throw new Error('learning review evidence must come from a later replay of the corrected revision')
      if (!evidence.some(item => item.replayedTests?.includes(learning.reproducibleTest))) throw new Error('learning review requires the reproducible test replay')
      if (verifications.some(item => !item.passed || item.planId !== learning.source.planId || item.criterionId !== learning.source.criterionId || item.revision !== learning.revision)) throw new Error('learning review requires a passing criterion verification for the corrected revision')
      const cited = new Set(verifications.flatMap(item => item.evidenceIds || []))
      if (evidenceIds.some(id => !cited.has(id))) throw new Error('learning review verification does not cite the replay evidence')
      if (this.getPlan(learning.source.planId).status !== 'completed') throw new Error('learning review requires a completed evidence-gated plan')
    }
    learning.reviewerStatus = status
    learning.reviewerId = reviewerId
    learning.verification = {
      status,
      detail: clean(input.verification, 1_200),
      evidenceIds,
      verificationIds,
    }
    learning.status = status === 'verified' ? 'reviewed' : 'rejected'
    learning.updatedAt = this.clock()
    this.store.append('learning', learning)
    return this.store.get('learning', learning.id)
  }

  promoteLearning(learningId) {
    const learning = this.store.get('learning', learningId)
    if (!learning) throw new Error(`unknown learning record: ${learningId}`)
    if (learning.reviewerStatus !== 'verified' || learning.status !== 'reviewed' || !learning.verification?.evidenceIds?.length || !learning.verification?.verificationIds?.length) throw new Error('learning promotion requires verified review')
    learning.status = 'promoted'
    learning.updatedAt = this.clock()
    this.store.append('learning', learning)
    return this.store.get('learning', learning.id)
  }

  snapshot() {
    return {
      plans: this.store.list('executionPlans').slice(0, 100),
      evidence: this.store.list('evidence').slice(0, 200),
      verifications: this.store.list('verifications').slice(0, 200),
      learning: this.store.list('learning').slice(0, 200),
    }
  }
}
