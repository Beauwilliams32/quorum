import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentControlManager } from '../src/agent-control/manager.js'
import { AgentControlStore } from '../src/agent-control/store.js'
import { RuntimeManager } from '../src/runtime-manager.js'
import { MissionStore } from '../src/missions.js'

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 9123
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }
  child.kill = signal => { child.lastSignal = signal; return true }
  return child
}

test('managed runtime enforces the configured cloud concurrency ceiling', async () => {
  const manager = new RuntimeManager({ agentControl: {}, missions: {}, maxConcurrentCloudAgents: 4 })
  for (let index = 0; index < 4; index++) manager.runs.set(`run-${index}`, { runtime: index % 2 ? 'claude' : 'codex', status: 'running', finished: false })
  await assert.rejects(() => manager.start({ runtime: 'codex' }), /concurrency limit reached \(4\)/)
})

test('managed runtime links provider session, lease closeout, mission task, and events', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-runtime-'))
  const control = new AgentControlManager({ store: new AgentControlStore(dir) })
  const missions = new MissionStore(path.join(dir, 'missions.json'))
  const mission = missions.create({ title: 'Managed run', objective: 'Exercise the runtime supervisor.', tasks: [{ id: 'task', title: 'Run agent' }] })
  const child = fakeChild()
  const memoryCalls = []
  const manager = new RuntimeManager({ agentControl: control, missions, memoryBridge: { recall: async () => '', captureCloseout: async input => memoryCalls.push(input), writeMissionNote: () => ({ ok: true }) }, executablePathImpl: () => true, spawnImpl: async () => child, heartbeatMs: 60_000 })
  const started = await manager.start({ missionId: mission.id, taskId: 'task', runtime: 'codex', role: 'builder', cwd: dir, worktree: dir, task: 'run bounded task' })
  child.stdout.emit('data', '{"type":"thread.started","thread_id":"thread-abc"}\n')
  child.stdout.emit('data', '{"type":"turn.completed","thread_id":"thread-abc"}\n')
  child.emit('exit', 0, null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(started.run.status, 'active')
  assert.equal(manager.snapshot()[0].providerSessionId, 'thread-abc')
  assert.equal(control.snapshot().runs[0].status, 'closed')
  assert.equal(control.snapshot().runs[0].missionId, mission.id)
  assert.equal(missions.get(mission.id).tasks[0].status, 'completed')
  assert.equal(memoryCalls.length, 1)
  assert.ok(manager.events(started.run.runId).some(event => event.type === 'completed'))

  const restarted = new RuntimeManager({ agentControl: control, missions, memoryBridge: { recall: async () => '' } })
  assert.equal(restarted.snapshot()[0].missionId, mission.id)
  assert.ok(restarted.events(started.run.runId).some(event => event.runId === started.run.runId && event.type === 'completed'))
})

test('managed runtime cancellation sends termination and records cancelled task', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-runtime-cancel-'))
  const control = new AgentControlManager({ store: new AgentControlStore(dir) })
  const missions = new MissionStore(path.join(dir, 'missions.json'))
  const mission = missions.create({ title: 'Cancel run', objective: 'Stop safely.', tasks: [{ id: 'task', title: 'Long task' }] })
  const child = fakeChild()
  const signals = []
  const manager = new RuntimeManager({ agentControl: control, missions, memoryBridge: { recall: async () => '' }, executablePathImpl: () => true, spawnImpl: async () => child, processKillImpl: (pid, signal) => signals.push({ pid, signal }), heartbeatMs: 60_000 })
  const started = await manager.start({ missionId: mission.id, taskId: 'task', runtime: 'claude', role: 'builder', cwd: dir, worktree: dir, task: 'wait' })
  manager.cancel(started.run.runId)
  assert.deepEqual(signals, [{ pid: -child.pid, signal: 'SIGTERM' }])
  child.emit('exit', 143, 'SIGTERM')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(control.snapshot().runs[0].status, 'cancelled')
  assert.equal(missions.get(mission.id).tasks[0].status, 'cancelled')
})

test('provider spawn failure closes the lease instead of orphaning the mission', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-runtime-spawn-'))
  const control = new AgentControlManager({ store: new AgentControlStore(dir) })
  const missions = new MissionStore(path.join(dir, 'missions.json'))
  const mission = missions.create({ title: 'Spawn failure', objective: 'Keep failed launches visible.', tasks: [{ id: 'task', title: 'Unavailable agent' }] })
  const manager = new RuntimeManager({ agentControl: control, missions, memoryBridge: { recall: async () => '' }, spawnImpl: async () => { throw new Error('spawn ENOENT') }, executablePathImpl: () => true })
  await assert.rejects(() => manager.start({ missionId: mission.id, taskId: 'task', runtime: 'codex', role: 'builder', cwd: dir, worktree: dir, task: 'fail' }), /spawn ENOENT/)
  assert.equal(control.snapshot().runs[0].status, 'blocked')
  assert.equal(missions.get(mission.id).tasks[0].status, 'failed')
})
