import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { AgentControlManager } from '../src/agent-control/manager.js'
import { AgentControlStore, redact } from '../src/agent-control/store.js'
import { actionAllowed, classifyAction, isProtectedPath, loadPolicy } from '../src/agent-control/policy.js'
import { buildLaunch, buildTaskLaunch, executablePath } from '../src/agent-control/adapters.js'
import { publicAgentPacks } from '../src/agents/packs.js'
import { defer, scratchDir } from './helpers/scratch.mjs'

function manager(t) {
  const store = new AgentControlStore(scratchDir(t, 'quorum-control-'))
  // Closed before its directory is removed: an open store flushes at exit and
  // would re-create it.
  defer(t, () => store.close())
  let time = 1_700_000_000_000
  // No real process backs a test run, so every bound pid reads as dead. Runs
  // that need a live owner say so explicitly with their own startKeyImpl.
  const m = new AgentControlManager({ store, policy: loadPolicy(), clock: () => time, startKeyImpl: () => null })
  return { m, tick: ms => { time += ms } }
}

test('policy grants roles narrowly and classifies structured commands', () => {
  const policy = loadPolicy()
  assert.equal(actionAllowed(policy, 'researcher', 'git.push').ok, false)
  assert.equal(actionAllowed(policy, 'builder', 'git.push').ok, true)
  assert.equal(actionAllowed(policy, 'operator', 'deploy', { target: { account: 'acct', project: 'app', rollback: true, audit: true, idempotencyKey: 'deploy-1' } }).ok, true)
  assert.equal(actionAllowed(policy, 'operator', 'deploy', { target: { account: 'acct', project: 'app' } }).ok, false)
  assert.equal(actionAllowed(policy, 'operator', 'secret.change', { target: { account: 'vault', project: 'app', rollback: true, audit: true, idempotencyKey: 'secret-1' } }).rule.approval, 'target-record')
  assert.equal(actionAllowed(policy, 'operator', 'financial.execute', { target: { account: 'billing', project: 'app', rollback: true, audit: true, idempotencyKey: 'payment-1' } }).rule.postActionReadback, true)
  assert.equal(classifyAction(['git', 'push', 'origin', 'main']), 'git.push')
  assert.equal(classifyAction(['npm', 'run', 'qa:core']), 'test')
  assert.equal(classifyAction(['wrangler', 'deploy']), 'deploy')
  assert.equal(classifyAction(['wrangler', 'secret', 'put', 'TOKEN']), 'secret.change')
  assert.equal(classifyAction(['billing', 'refund', '--charge', 'ch_123']), 'financial.execute')
  assert.equal(classifyAction(['rm', '-rf', 'Media']), 'protected')
})

test('protected paths cover descendants and telemetry is redacted', () => {
  const policy = loadPolicy()
  assert.equal(isProtectedPath(policy, path.join(os.homedir(), '.codex', 'auth.json')), true)
  assert.equal(isProtectedPath(policy, path.join(os.homedir(), '.codex', 'auth.json', 'child')), true)
  assert.equal(isProtectedPath(policy, '/tmp/ordinary-project'), false)
  const value = redact({ prompt: 'do not retain', apiKey: 'sk-secret', nested: { transcript: 'nope' }, note: 'safe metadata' })
  assert.equal(value.prompt, '[redacted]')
  assert.equal(value.apiKey, '[redacted]')
  assert.equal(value.nested.transcript, '[redacted]')
  assert.equal(value.note, 'safe metadata')
  assert.deepEqual(redact({ authorizationIds: ['action-1'], authorization: 'Bearer private' }), { authorizationIds: ['action-1'], authorization: '[redacted]' })
})

test('a key prefix redacts where a token starts, never inside a word or an id Quorum minted', () => {
  // `note` is not a secret key name, so only the value pattern decides here.
  const note = value => redact({ note: value }).note
  for (const secret of ['sk-proj-abc123', 'key is sk-ant-api03-xyz', 'OPENAI_API_KEY=sk-live1', '"sk-abc"', 'KEY_sk-abc', 'Authorization Bearer abc.def', 'token ghp_abcdef', 'xoxb-1234', 'AIzaSyD-abc']) {
    assert.equal(note(secret), '[redacted]', secret)
  }
  // The millisecond near the 2026-09-23 CI failure whose base36 form ends in
  // "sk": every id minted in it read as an OpenAI key and became
  // '[redacted]', so records keyed by it overwrote each other.
  const skMillisecond = Date.parse('2026-09-23T05:16:11.012Z')
  assert.match(skMillisecond.toString(36), /sk$/)
  const minted = `verification-${skMillisecond.toString(36)}-3fa1b2c4`
  for (const ordinary of [minted, 'task-1', '/Users/someone/desk-app', 'risk-review', 'plan-mu1xoxb-12ab']) {
    assert.equal(note(ordinary), ordinary, ordinary)
  }
})

test('leases, checkpoints, closeout, approval and takeover preserve evidence', t => {
  const { m, tick } = manager(t)
  const run = m.createRun({ role: 'builder', runtime: 'codex', repoRoot: '/tmp/project', worktree: '/tmp/project', plannedActions: ['git.push'] })
  assert.equal(run.status, 'active')
  const checkpoint = m.checkpoint(run.runId, { reason: 'before push', tests: ['npm test'], changedFiles: ['src/a.js'], verification: ['diff reviewed'] })
  assert.equal(m.store.get('checkpoints', checkpoint.id).tests[0], 'npm test')
  m.heartbeat(run.runId, { phase: 'testing' })
  const action = m.createAction(run.runId, { action: 'git.push' })
  assert.equal(action.status, 'proposed')
  m.close(run.runId, { disposition: 'completed', changedFiles: ['src/a.js'], checks: ['npm test'], execution: { planId: 'plan-1', authorizationIds: [action.id], evidenceIds: ['evidence-1'], verificationIds: ['verification-1'], learningIds: ['learning-1'] }, nextOwnerAction: 'verify remote head' })
  assert.equal(m.getRun(run.runId).status, 'closed')
  assert.deepEqual(m.getRun(run.runId).closeout.execution, { planId: 'plan-1', authorizationIds: [action.id], evidenceIds: ['evidence-1'], verificationIds: ['verification-1'], learningIds: ['learning-1'] })
  // Recovery replaces a run whose owning process is confirmed dead: the run
  // is bound to a pid, and this manager's start-key probe reports it gone.
  const stale = m.createRun({ role: 'builder', runtime: 'claude', missionId: 'mission-recovery', repoRoot: '/tmp/other', worktree: '/tmp/other', pid: 4242, pidStartedAt: 'start-key-stale' })
  tick(16 * 60 * 1000)
  assert.deepEqual(m.recover().recovered, [])
  assert.deepEqual(m.recover().recovered, [])
  tick(16 * 60 * 1000)
  assert.deepEqual(m.recover().recovered, [])
  tick(16 * 60 * 1000)
  const { recovered } = m.recover()
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].role, 'recovery')
  assert.equal(recovered[0].missionId, 'mission-recovery')
  assert.equal(m.getRun(stale.runId).status, 'recovery-pending')
  assert.equal(m.getRun(recovered[0].runId).parentTask, stale.runId)
  assert.equal(recovered[0].providerSessionId, null)
  assert.equal(recovered[0].recovery.sourceRunId, stale.runId)
  assert.deepEqual(recovered[0].recovery.checkpointIds, stale.checkpoints)

  // A run that never had a process is a different case: there is no owner to
  // take over, so it is retired rather than replaced.
  const ownerless = m.createRun({ role: 'builder', runtime: 'claude', repoRoot: '/tmp/ownerless', worktree: '/tmp/ownerless' })
  for (let pass = 0; pass < 3; pass++) { tick(16 * 60 * 1000); m.recover() }
  assert.equal(m.getRun(ownerless.runId).status, 'abandoned')
  assert.equal(m.store.list('runs').some(item => item.parentTask === ownerless.runId), false, 'an ownerless run never mints a successor')
})

test('overlapping claims conflict and cancellation releases ownership', t => {
  const { m } = manager(t)
  const first = m.createRun({ role: 'builder', repoRoot: '/tmp/claim-root', worktree: '/tmp/claim-root', claimedPaths: ['/tmp/claim-root/src'] })
  assert.throws(() => m.createRun({ role: 'researcher', repoRoot: '/tmp/claim-root', worktree: '/tmp/claim-root', claimedPaths: ['/tmp/claim-root/src/lib'] }), /already owned by run/)
  const cancelled = m.cancel(first.runId)
  assert.equal(cancelled.status, 'cancelled')
  const second = m.createRun({ role: 'researcher', repoRoot: '/tmp/claim-root', worktree: '/tmp/claim-root', claimedPaths: ['/tmp/claim-root/src/lib'] })
  assert.equal(second.status, 'active')
})

test('run packets and closeouts retain bounded redacted evidence without prompts', t => {
  const { m } = manager(t)
  const run = m.createRun({ role: 'builder', repoRoot: '/tmp/packet-root', worktree: '/tmp/packet-root', taskPacket: { source: 'mission', missionId: 'mission-1', taskId: 'task-1', inputDigest: 'a'.repeat(64), inputChars: 99999, inputBytes: 99999, memoryIncluded: true, memoryBytes: 99999, prompt: 'never persist this' } })
  assert.equal(run.taskPacket.input.chars, 8000)
  assert.equal(run.taskPacket.input.bytes, 32000)
  assert.equal(run.taskPacket.memory.bytes, 32000)
  assert.equal(JSON.stringify(run.taskPacket).includes('never persist this'), false)
  const checkpoint = m.checkpoint(run.runId, { reason: 'gate' })
  assert.equal(checkpoint.taskPacketId, run.taskPacket.id)
  assert.throws(() => m.close(run.runId, { disposition: 'blocked' }), /truthful blocker/)
  const closed = m.close(run.runId, { disposition: 'blocked', blockers: ['provider unavailable'], readiness: { source: 'ready', provider: 'blocked', owner: 'action-required' }, verification: ['provider probe failed'] })
  assert.equal(closed.closeout.readinessEvidence.provider, 'blocked')
  assert.equal(closed.closeout.readinessEvidence.release, 'not-reported')
  assert.deepEqual(closed.closeout.verification, ['provider probe failed'])
})

test('recovery preserves the canonical packet receipt without stealing provider identity', t => {
  const { m, tick } = manager(t)
  const run = m.createRun({ role: 'builder', runtime: 'codex', repoRoot: '/tmp/recovery-packet', worktree: '/tmp/recovery-packet', providerSessionId: 'thread-original', pid: 4242, pidStartedAt: 'start-key-packet', taskPacket: { source: 'mission', missionId: 'mission-packet', taskId: 'task-packet', inputDigest: 'b'.repeat(64), inputChars: 731, inputBytes: 812, truncated: true, memoryIncluded: true, memoryBytes: 144 } })
  tick(16 * 60 * 1000); m.recover()
  tick(16 * 60 * 1000); m.recover()
  tick(16 * 60 * 1000)
  const [replacement] = m.recover().recovered
  assert.deepEqual(replacement.taskPacket, run.taskPacket)
  assert.equal(replacement.providerSessionId, null)
  assert.equal(replacement.recovery.providerSessionId, 'thread-original')
  assert.equal(replacement.recovery.sourceRunId, run.runId)
})

test('Claude adapter adds shared prompt and explicit permission mode', () => {
  const plan = buildLaunch({ runtime: 'claude', role: 'builder', cwd: '/tmp/project' })
  assert.equal(plan.args.includes('--append-system-prompt-file'), true)
  assert.equal(plan.args.includes('--permission-mode'), true)
  assert.equal(plan.args.includes('bypassPermissions'), false)
  assert.equal(path.isAbsolute(plan.cwd), true)
  assert.equal(typeof executablePath('node'), 'string')
  const codex = buildLaunch({ runtime: 'codex', role: 'researcher', cwd: '/tmp/project' })
  assert.deepEqual(codex.args.slice(-6), ['--cd', '/tmp/project', '--sandbox', 'read-only', '--ask-for-approval', 'untrusted'])
  const hermes = buildLaunch({ runtime: 'hermes', role: 'builder', cwd: '/tmp/project' })
  assert.deepEqual(hermes.args.slice(-2), ['--in', '/tmp/project'])
  assert.equal(hermes.args.includes('--yolo'), false)
  const openclaw = buildLaunch({ runtime: 'openclaw', role: 'builder', cwd: '/tmp/project' })
  assert.equal(openclaw.args.includes('--no-color'), true)
  const profiledOpenclaw = buildLaunch({ runtime: 'openclaw', role: 'builder', cwd: '/tmp/project', argv: ['openclaw', '--profile', 'local'] })
  assert.equal(profiledOpenclaw.args.includes('--no-color'), true)
  const gemini = buildLaunch({ runtime: 'gemini', role: 'researcher', cwd: '/tmp/project' })
  assert.deepEqual(gemini.args.slice(-2), ['--approval-mode', 'plan'])
  assert.equal(gemini.args.includes('--yolo'), false)
})

test('task packs route one bounded task through interchangeable runtimes', () => {
  const packs = publicAgentPacks({ runtimes: [{ id: 'claude', command: 'claude' }, { id: 'ollama', command: 'ollama' }], modelOptions: [{ id: 'claude:sonnet', provider: 'claude', model: 'sonnet', available: true }] })
  assert.ok(packs.some(pack => pack.id === 'builder' && pack.role === 'builder'))
  const plan = buildTaskLaunch({ runtime: 'claude', role: 'builder', cwd: '/tmp/project', task: 'Review $HOME safely', model: 'sonnet', promptFile: '/tmp/pack.md' })
  assert.match(plan.shellCommand, /Review \$HOME safely/)
  assert.equal('env' in plan, true)
  assert.equal(plan.env.QUORUM_AGENT_ROLE, 'builder')
  const local = buildTaskLaunch({ runtime: 'ollama', role: 'researcher', cwd: '/tmp/project', task: 'map the repo', model: 'llama3:8b' })
  assert.deepEqual(local.args.slice(0, 3), ['run', 'llama3:8b', 'map the repo'])
  const managedClaude = buildTaskLaunch({ runtime: 'claude', role: 'builder', cwd: '/tmp/project', task: 'managed', structured: true })
  assert.deepEqual(managedClaude.args.slice(-3), ['--output-format', 'stream-json', '--verbose'])
  const managedCodex = buildTaskLaunch({ runtime: 'codex', role: 'builder', cwd: '/tmp/project', task: 'managed', structured: true })
  assert.equal(managedCodex.args.at(-1), '--json')
  assert.equal(managedCodex.args.includes('--ask-for-approval'), false)
})
