import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentControlManager } from '../src/agent-control/manager.js'
import { AgentControlStore, redact } from '../src/agent-control/store.js'
import { actionAllowed, classifyAction, isProtectedPath, loadPolicy } from '../src/agent-control/policy.js'
import { buildLaunch, buildTaskLaunch, executablePath } from '../src/agent-control/adapters.js'
import { publicAgentPacks } from '../src/agents/packs.js'

function manager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-control-'))
  let time = 1_700_000_000_000
  const m = new AgentControlManager({ store: new AgentControlStore(dir), policy: loadPolicy(), clock: () => time })
  return { m, tick: ms => { time += ms } }
}

test('policy grants roles narrowly and classifies structured commands', () => {
  const policy = loadPolicy()
  assert.equal(actionAllowed(policy, 'researcher', 'git.push').ok, false)
  assert.equal(actionAllowed(policy, 'builder', 'git.push').ok, true)
  assert.equal(actionAllowed(policy, 'operator', 'deploy', { target: { account: 'acct', project: 'app', rollback: true, audit: true } }).ok, true)
  assert.equal(actionAllowed(policy, 'operator', 'deploy', { target: { account: 'acct', project: 'app' } }).ok, false)
  assert.equal(classifyAction(['git', 'push', 'origin', 'main']), 'git.push')
  assert.equal(classifyAction(['npm', 'run', 'qa:core']), 'test')
  assert.equal(classifyAction(['wrangler', 'deploy']), 'deploy')
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
})

test('leases, checkpoints, closeout, approval and takeover preserve evidence', () => {
  const { m, tick } = manager()
  const run = m.createRun({ role: 'builder', runtime: 'codex', repoRoot: '/tmp/project', worktree: '/tmp/project', plannedActions: ['git.push'] })
  assert.equal(run.status, 'active')
  const checkpoint = m.checkpoint(run.runId, { reason: 'before push', tests: ['npm test'], changedFiles: ['src/a.js'], verification: ['diff reviewed'] })
  assert.equal(m.store.get('checkpoints', checkpoint.id).tests[0], 'npm test')
  m.heartbeat(run.runId, { phase: 'testing' })
  const action = m.createAction(run.runId, { action: 'git.push' })
  assert.equal(action.status, 'proposed')
  m.close(run.runId, { disposition: 'completed', changedFiles: ['src/a.js'], checks: ['npm test'], nextOwnerAction: 'verify remote head' })
  assert.equal(m.getRun(run.runId).status, 'closed')
  const stale = m.createRun({ role: 'builder', runtime: 'claude', repoRoot: '/tmp/other', worktree: '/tmp/other' })
  tick(16 * 60 * 1000)
  assert.deepEqual(m.recover(), [])
  assert.deepEqual(m.recover(), [])
  tick(16 * 60 * 1000)
  assert.deepEqual(m.recover(), [])
  tick(16 * 60 * 1000)
  const recovered = m.recover()
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].role, 'recovery')
  assert.equal(m.getRun(stale.runId).status, 'recovery-pending')
  assert.equal(m.getRun(recovered[0].runId).parentTask, stale.runId)
})

test('overlapping claims conflict and cancellation releases ownership', () => {
  const { m } = manager()
  const first = m.createRun({ role: 'builder', repoRoot: '/tmp/claim-root', worktree: '/tmp/claim-root', claimedPaths: ['/tmp/claim-root/src'] })
  assert.throws(() => m.createRun({ role: 'researcher', repoRoot: '/tmp/claim-root', worktree: '/tmp/claim-root', claimedPaths: ['/tmp/claim-root/src/lib'] }), /already owned by run/)
  const cancelled = m.cancel(first.runId)
  assert.equal(cancelled.status, 'cancelled')
  const second = m.createRun({ role: 'researcher', repoRoot: '/tmp/claim-root', worktree: '/tmp/claim-root', claimedPaths: ['/tmp/claim-root/src/lib'] })
  assert.equal(second.status, 'active')
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
})
