import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decisionFromEvents, runStructuredVerification, reviewTaskPrompt } from '../src/agent-control/verification-run.js'
import { buildTaskLaunch } from '../src/agent-control/adapters.js'
import { AgentControlManager } from '../src/agent-control/manager.js'
import { AgentControlStore } from '../src/agent-control/store.js'
import { RuntimeManager } from '../src/runtime-manager.js'
import { MissionStore } from '../src/missions.js'
import { defer, scratchDir } from './helpers/scratch.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The production deadline timers are unref'd on purpose: the spawned reviewer
// keeps the loop alive, and a stray timer must never hold the cockpit open.
// These tests drive a fake child with no real handles, so without a ref'd
// timer of their own the loop drains before the deadline fires and the test
// never settles (green on macOS, cancelled on Linux CI).
async function withLoopAlive(fn) {
  const keepalive = setInterval(() => {}, 5)
  try { return await fn() } finally { clearInterval(keepalive) }
}

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 4711
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = signal => { child.signals = [...(child.signals || []), signal]; return true }
  return child
}

const codexMessage = text => `${JSON.stringify({ type: 'item.completed', thread_id: 'thread-review', item: { type: 'agent_message', text } })}\n`

test('a verdict is read from parsed provider text, not from terminal scrollback', () => {
  assert.equal(decisionFromEvents([{ type: 'assistant', text: 'Looks fine.\nAPPROVE: diff is focused' }]).decision, 'approve')
  assert.equal(decisionFromEvents([{ type: 'assistant', text: 'REJECT: no tests' }]).decision, 'reject')
  // The last verdict wins, so a reviewer that reconsiders is read correctly.
  assert.equal(decisionFromEvents([{ type: 'assistant', text: 'APPROVE' }, { type: 'assistant', text: 'REJECT: on reflection' }]).decision, 'reject')
  assert.equal(decisionFromEvents([{ type: 'assistant', text: 'I considered approving this.' }]), null)
  assert.equal(decisionFromEvents([]), null)
  // Within one message the last verdict wins too: a reviewer that argues
  // against approving and then rejects must not be read as an approval.
  assert.equal(decisionFromEvents([{ type: 'assistant', text: 'I reviewed the change. APPROVE is not warranted because the migration drops rows. REJECT' }]).decision, 'reject')
  // A child's stderr arrives as `output`; prose there is not a verdict.
  assert.equal(decisionFromEvents([{ type: 'output', text: 'APPROVE: warning printed by a linter' }]), null)
})

test('the review prompt asks for a machine-readable verdict and forbids edits', () => {
  const prompt = reviewTaskPrompt('run-1')
  assert.match(prompt, /run-1/)
  assert.match(prompt, /APPROVE or REJECT/)
  assert.match(prompt, /Do not modify anything/)
})

test('the review launch is a non-interactive structured invocation in a read-only sandbox', () => {
  const plan = buildTaskLaunch({ runtime: 'codex', role: 'reviewer', cwd: '/tmp/review', task: 'review it', structured: true })
  assert.equal(plan.args[0], 'exec')
  assert.equal(plan.args.includes('--json'), true)
  assert.deepEqual(plan.args.slice(-5), ['--cd', '/tmp/review', '--sandbox', 'read-only', '--json'])
  assert.equal(plan.args.includes('--ask-for-approval'), false, 'codex exec has no interactive approval prompt')
  assert.equal(plan.safety.readOnly, true, 'a reviewer must not be launched with write access')
  assert.equal(plan.shellCommand.includes(';'), false)
})

test('an approving reviewer is reported as approve with its reasoning', async () => {
  const child = fakeChild()
  const pids = []
  const pending = runStructuredVerification({ runtime: 'codex', cwd: '/tmp', task: 'review', executablePathImpl: () => true, spawnImpl: async () => child, onPid: pid => pids.push(pid) })
  await new Promise(resolve => setImmediate(resolve))
  child.stdout.emit('data', codexMessage('The diff is focused and tested.\nAPPROVE: tests cover the change'))
  child.emit('exit', 0, null)
  const result = await pending
  assert.equal(result.decision, 'approve')
  assert.match(result.reasoning, /tests cover the change/)
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.deepEqual(pids, [4711])
})

test('a reviewer that states no verdict is recorded as no-decision, not as a rejection', async () => {
  const child = fakeChild()
  const pending = runStructuredVerification({ runtime: 'codex', cwd: '/tmp', task: 'review', executablePathImpl: () => true, spawnImpl: async () => child })
  await new Promise(resolve => setImmediate(resolve))
  child.stdout.emit('data', codexMessage('I had a look and I am not sure.'))
  child.emit('exit', 0, null)
  const result = await pending
  assert.equal(result.decision, 'no-decision')
  assert.match(result.reasoning, /without stating APPROVE or REJECT/)
})

test('a reviewer that never finishes is stopped at its deadline and recorded as no-decision', async () => {
  const child = fakeChild()
  const killed = []
  const result = await withLoopAlive(() => runStructuredVerification({
    runtime: 'codex', cwd: '/tmp', task: 'review', timeoutMs: 25,
    executablePathImpl: () => true, spawnImpl: async () => child,
    processKillImpl: (pid, signal) => { killed.push([pid, signal]); child.emit('exit', null, signal) },
  }))
  assert.equal(result.decision, 'no-decision')
  assert.equal(result.timedOut, true)
  assert.match(result.reasoning, /exceeded its .*budget and was stopped/)
  assert.deepEqual(killed, [[-4711, 'SIGTERM']])
})

test('a reviewer that ignores SIGTERM is killed rather than left running', async () => {
  const child = fakeChild()
  const killed = []
  const result = await withLoopAlive(() => runStructuredVerification({
    runtime: 'codex', cwd: '/tmp', task: 'review', timeoutMs: 15, killGraceMs: 15,
    executablePathImpl: () => true, spawnImpl: async () => child,
    // The process group swallows SIGTERM: nothing exits.
    processKillImpl: (pid, signal) => { killed.push([pid, signal]) },
  }))
  assert.deepEqual(killed, [[-4711, 'SIGTERM'], [-4711, 'SIGKILL']], 'the deadline escalates instead of giving up on the process')
  assert.equal(result.decision, 'no-decision')
  assert.equal(result.timedOut, true)
})

test('a missing runtime resolves as no-decision instead of hanging', async () => {
  const result = await runStructuredVerification({ runtime: 'codex', cwd: '/tmp', task: 'review', executablePathImpl: () => null, spawnImpl: async () => { throw new Error('should not spawn') } })
  assert.equal(result.decision, 'no-decision')
  assert.match(result.reasoning, /executable is not available/)
})

test('a spawn failure resolves as no-decision with the reason', async () => {
  const result = await runStructuredVerification({ runtime: 'codex', cwd: '/tmp', task: 'review', executablePathImpl: () => true, spawnImpl: async () => { throw new Error('EACCES') } })
  assert.equal(result.decision, 'no-decision')
  assert.match(result.reasoning, /could not start.*EACCES/)
})

// ---------------------------------------------------------------------------
// Reachability. The module above works in isolation; these tests exercise the
// path a real mission task takes, because the previous version of this feature
// was correct in isolation and unreachable in the product.
// ---------------------------------------------------------------------------

function reviewRepo(t) {
  const dir = fs.realpathSync(scratchDir(t, 'quorum-review-repo-'))
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['config', 'user.name', 'Quorum Test'])
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'seed'])
  return dir
}

function runtimeChild() {
  const child = new EventEmitter()
  child.pid = 9124
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }
  child.kill = () => true
  return child
}

/** Drive one managed mission task all the way to a settled status. */
async function managedTask(t, { reviewImpl = null, changeWorktree = true, providerCompletes = true } = {}) {
  const dir = reviewRepo(t)
  const stateDir = scratchDir(t, 'quorum-review-state-')
  const control = new AgentControlManager({ store: new AgentControlStore(stateDir), startKeyImpl: () => 'start-key' })
  // Closed before its directory is removed: an open store flushes at exit and
  // would re-create it.
  defer(t, () => control.store.close())
  const missions = new MissionStore(path.join(stateDir, 'missions.json'))
  const mission = missions.create({ title: 'Review', objective: 'Only ship reviewed work.', tasks: [{ id: 'task', title: 'Do the work' }] })
  const child = runtimeChild()
  const manager = new RuntimeManager({
    agentControl: control, missions,
    memoryBridge: { recall: async () => '', captureCloseout: async () => {}, writeMissionNote: () => ({ ok: true }) },
    executablePathImpl: () => true, spawnImpl: async () => child, heartbeatMs: 60_000, reviewImpl,
  })
  await manager.start({ missionId: mission.id, taskId: 'task', runtime: 'codex', role: 'builder', cwd: dir, worktree: dir, task: 'do the work' })
  if (changeWorktree) fs.writeFileSync(path.join(dir, 'agent-output.txt'), 'the run really wrote something\n')
  child.stdout.emit('data', '{"type":"thread.started","thread_id":"thread-r"}\n')
  if (providerCompletes) child.stdout.emit('data', '{"type":"turn.completed","thread_id":"thread-r"}\n')
  child.emit('exit', 0, null)
  for (let attempt = 0; attempt < 400 && missions.get(mission.id).tasks[0].status === 'working'; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  return { task: missions.get(mission.id).tasks[0], control, missions, mission, dir }
}

test('a mission task that passed the evidence gate is still blocked when the reviewer rejects', async t => {
  const calls = []
  const { task } = await managedTask(t, { reviewImpl: async input => { calls.push(input); return { decision: 'reject', reasoning: 'the migration drops rows' } } })
  assert.equal(calls.length, 1, 'the reviewer is reached on the managed mission path')
  assert.equal(calls[0].taskId, 'task')
  assert.ok(calls[0].runId, 'the reviewer is told which run to review')
  assert.equal(task.status, 'blocked', `evidence passed, so only the review can block: ${task.error}`)
  assert.match(task.error, /independent review rejected: the migration drops rows/)
  assert.ok(task.verification.some(line => /independent-review: reject/.test(line)), task.verification.join(' | '))
})

test('a mission task completes only once the reviewer approves', async t => {
  const { task } = await managedTask(t, { reviewImpl: async () => ({ decision: 'approve', reasoning: 'focused and tested' }) })
  assert.equal(task.status, 'completed', `blocked with: ${task.error}`)
  assert.equal(task.error, null)
  assert.ok(task.verification.some(line => /independent-review: approve — focused and tested/.test(line)), task.verification.join(' | '))
})

test('a reviewer that states no verdict blocks the task rather than passing it', async t => {
  const { task } = await managedTask(t, { reviewImpl: async () => ({ decision: 'no-decision', reasoning: 'exceeded its 600s budget and was stopped' }) })
  assert.equal(task.status, 'blocked')
  assert.match(task.error, /independent review returned no decision/)
})

test('a reviewer that throws blocks the task instead of being ignored', async t => {
  const { task } = await managedTask(t, { reviewImpl: async () => { throw new Error('codex is not installed') } })
  assert.equal(task.status, 'blocked')
  assert.match(task.error, /independent review could not run: codex is not installed/)
})

test('with no reviewer configured the task says it was not reviewed instead of implying it was', async t => {
  const { task } = await managedTask(t, { reviewImpl: null })
  assert.equal(task.status, 'completed')
  assert.ok(task.verification.some(line => /not measured — independent review: no reviewer is configured/.test(line)), task.verification.join(' | '))
})

test('a run the evidence gate already blocked is never sent for review', async t => {
  const calls = []
  const { task } = await managedTask(t, { changeWorktree: false, reviewImpl: async input => { calls.push(input); return { decision: 'approve' } } })
  assert.equal(task.status, 'blocked')
  assert.equal(calls.length, 0, 'there is nothing for a reviewer to approve, and a cloud run would be wasted')
})

test('server.js reaches the reviewer through the managed path, not through a flag nothing sets', () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8')
  const construction = source.match(/new RuntimeManager\(\{[^}]*\}\)/)
  assert.ok(construction, 'server.js constructs the runtime manager')
  assert.match(construction[0], /reviewImpl/, 'the reviewer is wired into the only path a mission task can take')
  assert.match(source, /async function reviewManagedRun\(/)
  assert.match(source, /runStructuredVerification\(/)
  // The old trigger hung off `run.verified`, which nothing set any more. Only
  // executable lines count here; the comment explaining the retirement stays.
  const executable = source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  assert.equal(/run\.verified/.test(executable), false, 'no review path may depend on a flag no code sets')
  assert.equal(/\bverified:\s*input\.verified/.test(fs.readFileSync(path.join(root, 'src/agent-control/manager.js'), 'utf8')), false, 'the dead flag is gone from the run record too')
})
