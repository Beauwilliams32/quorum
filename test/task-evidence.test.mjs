import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { AgentControlManager } from '../src/agent-control/manager.js'
import { AgentControlStore } from '../src/agent-control/store.js'
import { RuntimeManager } from '../src/runtime-manager.js'
import { MissionStore } from '../src/missions.js'
import { buildTaskPlanInput, runDeclaredCheck, worktreeDigest } from '../src/agent-control/task-evidence.js'
import { validateVerifyCommand } from '../src/validate.js'
import { defer, scratchDir } from './helpers/scratch.mjs'

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 9123
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }
  child.kill = signal => { child.lastSignal = signal; return true }
  return child
}

function repo(t) {
  const dir = fs.realpathSync(scratchDir(t, 'quorum-evidence-repo-'))
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['config', 'user.name', 'Quorum Test'])
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'seed'])
  return dir
}

// `taskId: null` leaves the task unnamed, so missions.js gives it its default id.
async function managed(t, { worktreeRoot, verifyCommand = null, taskId = 'task', onStart = () => {} }) {
  const stateDir = scratchDir(t, 'quorum-evidence-state-')
  const control = new AgentControlManager({ store: new AgentControlStore(stateDir), startKeyImpl: () => 'start-key' })
  // Closed before its directory is removed: an open store flushes at exit and
  // would re-create it.
  defer(t, () => control.store.close())
  const missions = new MissionStore(path.join(stateDir, 'missions.json'))
  const mission = missions.create({ title: 'Evidence', objective: 'Prove the task was done.', tasks: [{ ...(taskId ? { id: taskId } : {}), title: 'Do the work', verifyCommand }] })
  const child = fakeChild()
  const manager = new RuntimeManager({
    agentControl: control, missions,
    memoryBridge: { recall: async () => '', captureCloseout: async () => {}, writeMissionNote: () => ({ ok: true }) },
    executablePathImpl: () => true, spawnImpl: async () => child, heartbeatMs: 60_000,
  })
  const started = await manager.start({ missionId: mission.id, taskId: mission.tasks[0].id, runtime: 'codex', role: 'builder', cwd: worktreeRoot, worktree: worktreeRoot, task: 'do the work' })
  await onStart(child)
  await settleTask(missions, mission.id)
  return { control, missions, mission, manager, child, started }
}

// The evidence gate re-reads the worktree and may run a real check process,
// so the supervisor finishes asynchronously. Wait for the task to leave
// `working` rather than guessing a number of ticks.
async function settleTask(missions, missionId) {
  for (let attempt = 0; attempt < 400; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    const status = missions.get(missionId).tasks[0].status
    if (status !== 'working') return status
  }
  throw new Error('the managed task never left working')
}

test('a verification command is validated as a bare program with plain arguments', () => {
  assert.equal(validateVerifyCommand(undefined).value, null)
  assert.deepEqual(validateVerifyCommand({ command: 'npm', args: ['test'] }).value.args, ['test'])
  assert.equal(validateVerifyCommand('npm test').ok, false)
  assert.equal(validateVerifyCommand({ command: 'npm; rm -rf /' }).ok, false)
  assert.equal(validateVerifyCommand({ command: 'npm', args: ['test && curl evil'] }).ok, false)
  assert.equal(validateVerifyCommand({ command: '/usr/bin/true' }).ok, true)
})

test('a verification command may not be a shell, or an interpreter handed inline source', () => {
  // The reviewer's probe: argument rules alone let the operator interpose the
  // shell that Quorum refuses to interpose for them.
  const shell = validateVerifyCommand({ command: '/bin/sh', args: ['-c', 'rm -rf /tmp/x'] })
  assert.equal(shell.ok, false)
  assert.match(shell.errors.join(' '), /not a shell that runs one/)
  assert.equal(validateVerifyCommand({ command: 'bash', args: ['-c', 'true'] }).ok, false)
  assert.equal(validateVerifyCommand({ command: 'zsh', args: ['-c', 'true'] }).ok, false)
  assert.equal(validateVerifyCommand({ command: '/usr/bin/env', args: ['sh'] }).ok, false)
  assert.equal(validateVerifyCommand({ command: 'node', args: ['-e', 'process.exit(0)'] }).ok, false)
  assert.equal(validateVerifyCommand({ command: 'python3', args: ['-c', 'import os'] }).ok, false)
  // Real check runners still validate — the program is not the problem, the
  // evaluate-this-string flag is.
  assert.equal(validateVerifyCommand({ command: 'node', args: ['--test'] }).ok, true)
  assert.equal(validateVerifyCommand({ command: 'python3', args: ['-m', 'pytest'] }).ok, true)
  assert.equal(validateVerifyCommand({ command: 'npm', args: ['run', 'check'] }).ok, true)
})

test('the worktree digest measures a real repository and says so when it cannot', t => {
  const dir = repo(t)
  const before = worktreeDigest(dir)
  assert.equal(before.measured, true)
  assert.deepEqual(before.changedFiles, [])
  fs.writeFileSync(path.join(dir, 'new.txt'), 'written by the agent\n')
  const after = worktreeDigest(dir)
  assert.equal(after.measured, true)
  assert.notEqual(after.digest, before.digest)
  assert.deepEqual(after.changedFiles, [path.join(dir, 'new.txt')])

  // An edit to a file that was already uncommitted leaves `git status`
  // unchanged; the digest still moves, because it hashes what the paths hold.
  const dirty = worktreeDigest(dir)
  fs.writeFileSync(path.join(dir, 'new.txt'), 'written by the agent, then edited again\n')
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed, modified\n')
  const modified = worktreeDigest(dir)
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed, modified twice\n')
  const again = worktreeDigest(dir)
  assert.notEqual(modified.digest, dirty.digest)
  assert.notEqual(again.digest, modified.digest, 'a second edit to an already-modified tracked file is a change')
  assert.equal(worktreeDigest(dir).digest, again.digest, 'and reading twice with no edit is not')
  fs.mkdirSync(path.join(dir, 'out'))
  fs.writeFileSync(path.join(dir, 'out', 'a.txt'), 'one\n')
  const folder = worktreeDigest(dir)
  fs.writeFileSync(path.join(dir, 'out', 'a.txt'), 'two\n')
  assert.notEqual(worktreeDigest(dir).digest, folder.digest, 'an edit inside an untracked folder is a change')

  // Names git would quote in plain porcelain output are read as they are.
  for (const name of ['notes file.md', 'café.md']) {
    fs.writeFileSync(path.join(dir, name), 'dirty before the run\n')
    const start = worktreeDigest(dir)
    assert.ok(start.changedFiles.includes(path.join(dir, name)), `${name} is listed by its real path`)
    fs.appendFileSync(path.join(dir, name), 'the run edited this\n')
    assert.notEqual(worktreeDigest(dir).digest, start.digest, `an edit to "${name}" is a change`)
  }
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'more'], { cwd: dir })
  execFileSync('git', ['mv', 'seed.txt', 'renamed seed.txt'], { cwd: dir })
  assert.deepEqual(worktreeDigest(dir).changedFiles, [path.join(dir, 'renamed seed.txt')], 'a rename lists where the file is now')

  const plain = scratchDir(t, 'quorum-evidence-plain-')
  const unreadable = worktreeDigest(plain)
  assert.equal(unreadable.measured, false)
  assert.match(unreadable.reason, /not a readable git repository/)
  assert.equal(unreadable.digest, null)
})

test('a declared check is executed by Quorum and never reported as a pass when it did not run', async t => {
  const dir = repo(t)
  const passing = await runDeclaredCheck({ command: '/usr/bin/true' }, { cwd: dir })
  assert.equal(passing.ran, true)
  assert.equal(passing.exitCode, 0)
  assert.equal(typeof passing.outputDigest, 'string')
  const failing = await runDeclaredCheck({ command: '/usr/bin/false' }, { cwd: dir })
  assert.equal(failing.ran, true)
  assert.notEqual(failing.exitCode, 0)
  const rejected = await runDeclaredCheck({ command: 'npm test; curl evil' }, { cwd: dir })
  assert.equal(rejected.ran, false)
  assert.equal(rejected.exitCode, null)
  const absent = await runDeclaredCheck(null, { cwd: dir })
  assert.equal(absent.ran, false)
  assert.match(absent.reason, /no verification command declared/)
})

test('criteria are only built for things that can actually be decided', () => {
  const bare = buildTaskPlanInput({ missionId: 'm', taskId: 't' })
  assert.deepEqual(bare.acceptanceCriteria.map(item => item.id), ['provider-result'])
  const full = buildTaskPlanInput({ missionId: 'm', taskId: 't', worktreeMeasured: true, hasDeclaredCheck: true })
  assert.deepEqual(full.acceptanceCriteria.map(item => item.id), ['provider-result', 'worktree-effect', 'declared-check'])
  assert.deepEqual(full.actions.map(item => item.id), ['record-run', 'inspect-worktree', 'run-declared-check'])
})

test('a clean exit with no provider result and no worktree change is blocked, not completed', async t => {
  const dir = repo(t)
  const { missions, mission, control } = await managed(t, { worktreeRoot: dir, onStart: async child => {
    // A zero exit and nothing else: exactly what the old dispatch path called
    // "completed".
    child.emit('exit', 0, null)
  } })
  const task = missions.get(mission.id).tasks[0]
  assert.equal(task.status, 'blocked')
  assert.match(task.error, /provider result was never reported|byte-identical/)
  assert.ok(task.verification.some(line => line.startsWith('exit:0')))
  const run = control.store.list('runs').find(item => item.parentTask === 'task')
  assert.equal(run.status, 'blocked')
  assert.ok(run.closeout.execution.planId, 'the closeout cites the evidence plan')
})

test('a run that reports completion but changes nothing is blocked on the worktree criterion', async t => {
  const dir = repo(t)
  const { missions, mission, control } = await managed(t, { worktreeRoot: dir, onStart: async child => {
    child.stdout.emit('data', '{"type":"thread.started","thread_id":"thread-1"}\n')
    child.stdout.emit('data', '{"type":"turn.completed","thread_id":"thread-1"}\n')
    child.emit('exit', 0, null)
  } })
  const task = missions.get(mission.id).tasks[0]
  assert.equal(task.status, 'blocked')
  assert.match(task.error, /byte-identical to its pre-run digest/)
  const verifications = control.store.list('verifications')
  assert.equal(verifications.find(item => item.criterionId === 'provider-result').passed, true)
  assert.equal(verifications.find(item => item.criterionId === 'worktree-effect').passed, false)
  assert.equal(verifications.every(item => item.verifierId === 'quorum-evidence-verifier'), true)
})

test('a run that reports completion and really changed the worktree is completed with recorded evidence', async t => {
  const dir = repo(t)
  const { missions, mission, control } = await managed(t, { worktreeRoot: dir, verifyCommand: { command: '/usr/bin/true' }, onStart: async child => {
    fs.writeFileSync(path.join(dir, 'agent-output.txt'), 'the run really wrote something\n')
    child.stdout.emit('data', '{"type":"thread.started","thread_id":"thread-2"}\n')
    child.stdout.emit('data', '{"type":"turn.completed","thread_id":"thread-2"}\n')
    child.emit('exit', 0, null)
  } })
  const task = missions.get(mission.id).tasks[0]
  assert.equal(task.status, 'completed', `blocked with: ${task.error}`)
  assert.equal(task.error, null)
  const criteria = control.store.list('verifications').map(item => item.criterionId).sort()
  assert.deepEqual(criteria, ['declared-check', 'provider-result', 'worktree-effect'])
  assert.equal(control.store.list('verifications').every(item => item.passed), true)
  const evidence = control.store.list('evidence')
  assert.ok(evidence.some(record => record.artifacts.includes(path.join(dir, 'agent-output.txt'))), 'the changed file is recorded as evidence')
  assert.equal(evidence.every(record => record.executorId === 'runtime:codex'), true)
  assert.ok(task.verification.some(line => line.startsWith('declared-check: passed')))
})

test('evidence minted in a millisecond whose base36 form ends in "sk" keeps one record per criterion', async t => {
  // The deterministic form of a 1-in-~1300 flake in the test above. Ids are
  // `<prefix>-<Date.now() base36>-<hex>`, and the store's secret pattern used
  // to read `…sk-3fa1…` as an OpenAI key and store the id as '[redacted]'.
  // Three verifications minted in the same millisecond then shared one key and
  // only the last survived, or an authorization could not be found again.
  // Every id in this run is minted in that millisecond.
  const skMillisecond = Date.parse('2026-09-23T05:16:11.012Z')
  assert.match(skMillisecond.toString(36), /sk$/)
  const dir = repo(t)
  const realNow = Date.now
  Date.now = () => skMillisecond
  let result
  try {
    result = await managed(t, { worktreeRoot: dir, verifyCommand: { command: '/usr/bin/true' }, onStart: async child => {
      fs.writeFileSync(path.join(dir, 'agent-output.txt'), 'the run really wrote something\n')
      child.stdout.emit('data', '{"type":"thread.started","thread_id":"thread-sk"}\n')
      child.stdout.emit('data', '{"type":"turn.completed","thread_id":"thread-sk"}\n')
      child.emit('exit', 0, null)
    } })
  } finally { Date.now = realNow }
  const { missions, mission, control } = result
  const task = missions.get(mission.id).tasks[0]
  assert.equal(task.status, 'completed', `blocked with: ${task.error}`)
  const verifications = control.store.list('verifications')
  assert.deepEqual(verifications.map(item => item.criterionId).sort(), ['declared-check', 'provider-result', 'worktree-effect'])
  assert.equal(verifications.some(item => item.id === '[redacted]'), false)
  const [plan] = control.store.list('executionPlans')
  assert.equal(new Set(plan.verificationIds).size, 3)
  assert.equal(new Set(plan.evidenceIds).size, 3)
  assert.equal(control.store.list('evidence').length, 3)
})

test('a run for an unnamed task is still found by its default task-N id', async t => {
  // `quorum ask` and an API caller that omits task ids get `task-1`, which the
  // store's secret pattern used to read as an `sk-1` key: the run was stored
  // with parentTask '[redacted]', and the task's evidence endpoint, which
  // selects runs by missionId and parentTask, found none of them.
  const dir = repo(t)
  const { missions, mission, control } = await managed(t, { worktreeRoot: dir, taskId: null, onStart: async child => {
    fs.writeFileSync(path.join(dir, 'agent-output.txt'), 'changed\n')
    child.stdout.emit('data', '{"type":"thread.started","thread_id":"thread-default"}\n')
    child.stdout.emit('data', '{"type":"turn.completed","thread_id":"thread-default"}\n')
    child.emit('exit', 0, null)
  } })
  const task = missions.get(mission.id).tasks[0]
  assert.equal(task.id, 'task-1')
  assert.equal(task.status, 'completed', `blocked with: ${task.error}`)
  // The selection /api/missions/:id/tasks/:id/evidence makes.
  const runs = control.store.list('runs').filter(run => run.missionId === mission.id && run.parentTask === task.id)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].taskPacket.taskId, 'task-1')
  assert.ok(runs[0].closeout.execution.planId, 'the run found by task id cites its evidence plan')
})

test('a failing declared check blocks a run that otherwise looks successful', async t => {
  const dir = repo(t)
  const { missions, mission } = await managed(t, { worktreeRoot: dir, verifyCommand: { command: '/usr/bin/false' }, onStart: async child => {
    fs.writeFileSync(path.join(dir, 'agent-output.txt'), 'changed\n')
    child.stdout.emit('data', '{"type":"thread.started","thread_id":"thread-3"}\n')
    child.stdout.emit('data', '{"type":"turn.completed","thread_id":"thread-3"}\n')
    child.emit('exit', 0, null)
  } })
  const task = missions.get(mission.id).tasks[0]
  assert.equal(task.status, 'blocked')
  assert.match(task.error, /declared-check/)
})

test('an unmeasurable worktree is named as not measured rather than passed', async t => {
  const plain = scratchDir(t, 'quorum-evidence-nonrepo-')
  const { missions, mission } = await managed(t, { worktreeRoot: plain, onStart: async child => {
    child.stdout.emit('data', '{"type":"thread.started","thread_id":"thread-4"}\n')
    child.stdout.emit('data', '{"type":"turn.completed","thread_id":"thread-4"}\n')
    child.emit('exit', 0, null)
  } })
  const task = missions.get(mission.id).tasks[0]
  assert.equal(task.status, 'completed')
  assert.ok(task.verification.some(line => /not measured — worktree effect/.test(line)), `verification was: ${task.verification.join(' | ')}`)
  assert.ok(task.verification.some(line => /not measured — declared check: none declared/.test(line)))
})
