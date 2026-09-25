import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentControlManager } from '../src/agent-control/manager.js'
import { AgentControlStore } from '../src/agent-control/store.js'
import { EvidenceExecutionEngine } from '../src/agent-control/execution.js'
import { defer, scratchDir } from './helpers/scratch.mjs'

function harness(t, role = 'builder') {
  const dir = scratchDir(t, 'quorum-evidence-')
  const control = new AgentControlManager({ store: new AgentControlStore(dir) })
  // Closed before its directory is removed: an open store flushes at exit and
  // would re-create it.
  defer(t, () => control.store.close())
  const run = control.createRun({ role, runtime: 'codex', repoRoot: dir, worktree: dir })
  return { control, engine: new EvidenceExecutionEngine({ control }), run }
}

test('a success claim without tool evidence cannot complete a criterion', async t => {
  const { engine, run } = harness(t)
  const plan = engine.createPlan(run.runId, {
    idempotencyKey: 'missing-evidence',
    acceptanceCriteria: [{ id: 'tests-pass', description: 'focused tests pass' }],
    actions: [{ id: 'test', action: 'test', expected: 'exit 0', criterionIds: ['tests-pass'] }],
  })
  let verifierCalls = 0

  const result = await engine.execute(plan.id, {
    executor: { id: 'builder-1', run: async () => ({ claimedSuccess: true }) },
    verifier: { id: 'reviewer-1', verify: async () => { verifierCalls += 1; return { passed: true } } },
  })

  assert.equal(result.status, 'rework')
  assert.equal(result.disposition, null)
  assert.equal(result.rework[0].criterionId, 'tests-pass')
  assert.match(result.rework[0].reason, /missing tool evidence/i)
  assert.equal(verifierCalls, 0)
})

test('an independent verifier cannot override failed tool evidence', async t => {
  const { engine, run } = harness(t)
  const plan = engine.createPlan(run.runId, {
    acceptanceCriteria: [{ id: 'tests-pass', description: 'focused tests pass' }],
    actions: [{ id: 'test', action: 'test', expected: 'exit 0', criterionIds: ['tests-pass'] }],
    maxAttempts: 1,
  })
  let verifierCalls = 0
  const result = await engine.execute(plan.id, {
    executor: { id: 'builder-1', run: async () => ({ status: 'failed', resultState: 'failed', exitCode: 1, observed: 'assertion failed' }) },
    verifier: { id: 'reviewer-1', verify: async () => { verifierCalls += 1; return { passed: true, observed: 'claimed pass' } } },
  })
  assert.equal(result.status, 'exhausted')
  assert.equal(result.disposition, 'exhausted')
  assert.match(result.rework[0].reason, /exit 1/)
  assert.equal(verifierCalls, 0)
})

test('failed evidence can be corrected and replayed, while lessons stay review-gated', async t => {
  const { engine, run } = harness(t)
  const plan = engine.createPlan(run.runId, {
    idempotencyKey: 'failure-correction',
    acceptanceCriteria: [{ id: 'regression', description: 'regression test passes' }],
    actions: [{ id: 'test', action: 'test', expected: 'exit 0', criterionIds: ['regression'] }],
  })
  const verifier = {
    id: 'qa-1',
    verify: async ({ evidence }) => ({ passed: evidence.every(item => item.exitCode === 0), observed: `exit ${evidence[0].exitCode}` }),
  }

  const failed = await engine.execute(plan.id, {
    executor: { id: 'builder-1', run: async () => ({ status: 'failed', exitCode: 1, observed: 'assertion failed sk-private-value' }) },
    verifier,
  })
  assert.equal(failed.status, 'rework')

  const lesson = engine.recordCorrection(plan.id, {
    criterionId: 'regression',
    failureClassification: 'test-failure',
    correction: 'fix the result parser before replaying the same test',
    reproducibleTest: 'node --test test/result-parser.test.mjs',
    reusableLesson: 'Treat process exit as transport evidence, not acceptance evidence.',
    rollback: 'revert the parser patch',
    sourceLinks: ['test/result-parser.test.mjs'],
  })
  assert.equal(lesson.reviewerStatus, 'pending')
  assert.equal(lesson.source.planId, plan.id)
  assert.equal(lesson.source.runId, run.runId)
  assert.equal(JSON.stringify(lesson).includes('sk-private-value'), false)
  assert.throws(() => engine.promoteLearning(lesson.id), /verified review/)

  const passed = await engine.execute(plan.id, {
    executor: { id: 'builder-1', run: async ({ replayTests }) => ({ status: 'passed', exitCode: 0, replayedTests: replayTests, observed: '1 test passed' }) },
    verifier,
  })
  assert.equal(passed.status, 'completed')
  assert.equal(passed.disposition, 'completed')
  assert.equal(passed.attempts, 2)

  const snapshot = engine.snapshot()
  const replayVerification = snapshot.verifications.find(item => item.planId === plan.id && item.attempt === 2 && item.passed)
  assert.ok(replayVerification)
  const replayEvidence = snapshot.evidence.find(item => replayVerification.evidenceIds.includes(item.id))
  assert.equal(replayEvidence.executorId, 'builder-1')
  assert.equal(replayEvidence.resultState, 'passed')
  assert.equal(replayEvidence.exitCode, 0)
  assert.deepEqual(replayEvidence.replayedTests, ['node --test test/result-parser.test.mjs'])
  assert.throws(() => engine.reviewLearning(lesson.id, {
    reviewerId: 'builder-1', status: 'verified', verification: 'self review',
    evidenceIds: replayVerification.evidenceIds, verificationIds: [replayVerification.id],
  }), /independent/i)
  const reviewed = engine.reviewLearning(lesson.id, {
    reviewerId: 'qa-1', status: 'verified', verification: 'replay passed on attempt 2',
    evidenceIds: replayVerification.evidenceIds, verificationIds: [replayVerification.id],
  })
  assert.equal(reviewed.reviewerStatus, 'verified')
  assert.deepEqual(reviewed.sourceLinks, ['test/result-parser.test.mjs'])
  assert.equal(engine.promoteLearning(lesson.id).status, 'promoted')
})

test('approval is idempotent, does not spend an attempt while pending, and denial is controlled', async t => {
  const { control, engine, run } = harness(t, 'operator')
  const target = { account: 'acct', project: 'ledger', rollback: true, audit: true, idempotencyKey: 'charge-42' }
  const plan = engine.createPlan(run.runId, {
    idempotencyKey: 'financial-plan',
    acceptanceCriteria: [{ id: 'readback', description: 'provider readback confirms the operation' }],
    actions: [{ id: 'charge', action: 'financial.execute', expected: 'charge recorded once', criterionIds: ['readback'], target }],
  })
  let executorCalls = 0
  const actors = {
    executor: { id: 'operator-1', run: async () => { executorCalls += 1; return { status: 'passed', exitCode: 0, readback: 'provider receipt charge-42' } } },
    verifier: { id: 'reviewer-1', verify: async ({ evidence }) => ({ passed: evidence[0].readback.includes('charge-42'), observed: 'provider readback matched' }) },
  }

  const waiting = await engine.execute(plan.id, actors)
  assert.equal(waiting.status, 'waiting-approval')
  assert.equal(waiting.attempts, 0)
  assert.equal(executorCalls, 0)
  const [approval] = control.store.list('actions')
  assert.equal(approval.action, 'financial.execute')
  assert.equal(control.createAction(run.runId, { action: 'financial.execute', target, planId: plan.id, revision: 1, actionId: 'charge' }).id, approval.id)

  control.approveAction(approval.id)
  const completed = await engine.execute(plan.id, actors)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.attempts, 1)
  assert.equal(executorCalls, 1)
  assert.equal(control.store.list('actions').filter(item => item.runId === run.runId).length, 1)
  assert.equal(control.store.get('actions', approval.id).status, 'executed')

  const deniedPlan = engine.createPlan(run.runId, {
    idempotencyKey: 'secret-plan',
    acceptanceCriteria: [{ id: 'rotated', description: 'secret reference is rotated' }],
    actions: [{ id: 'rotate', action: 'secret.change', expected: 'secret reference changed', criterionIds: ['rotated'], target: { ...target, idempotencyKey: 'secret-42' } }],
  })
  const deniedWaiting = await engine.execute(deniedPlan.id, actors)
  const denial = control.store.list('actions').find(item => item.planId === deniedPlan.id)
  control.cancelAction(denial.id)
  const denied = await engine.execute(deniedPlan.id, actors)
  assert.equal(deniedWaiting.attempts, 0)
  assert.equal(denied.status, 'denied')
  assert.equal(denied.disposition, 'denied')
  assert.equal(denied.attempts, 0)
  assert.equal(executorCalls, 1)
})

test('concurrent duplicate execution shares one attempt and one executor call', async t => {
  const { engine, run } = harness(t)
  const plan = engine.createPlan(run.runId, {
    idempotencyKey: 'concurrent',
    acceptanceCriteria: [{ id: 'test', description: 'test passes once' }],
    actions: [{ id: 'test', action: 'test', expected: 'exit 0', criterionIds: ['test'] }],
  })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let calls = 0
  const actors = {
    executor: { id: 'builder-1', run: async () => { calls += 1; await gate; return { status: 'passed', exitCode: 0 } } },
    verifier: { id: 'reviewer-1', verify: async () => ({ passed: true, observed: 'passed' }) },
  }
  const first = engine.execute(plan.id, actors)
  const second = engine.execute(plan.id, actors)
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(a.status, 'completed')
  assert.equal(b.status, 'completed')
  assert.equal(a.attempts, 1)
  assert.equal(b.attempts, 1)
})

test('invalid required artifact evidence cannot reach the verifier or complete', async t => {
  const { engine, run } = harness(t)
  const plan = engine.createPlan(run.runId, {
    acceptanceCriteria: [{ id: 'artifact', description: 'report exists' }],
    actions: [{ id: 'report', action: 'test', expected: 'report written', criterionIds: ['artifact'], requiresArtifact: true }],
    maxAttempts: 1,
  })
  let verifierCalls = 0
  const result = await engine.execute(plan.id, {
    executor: { id: 'builder-1', run: async () => ({ status: 'passed', exitCode: 0, artifacts: ['/definitely/missing/quorum-report.json'] }) },
    verifier: { id: 'reviewer-1', verify: async () => { verifierCalls += 1; return { passed: true } } },
  })
  assert.equal(result.status, 'exhausted')
  assert.equal(result.disposition, 'exhausted')
  assert.match(result.rework[0].reason, /artifact/i)
  assert.equal(verifierCalls, 0)
})
