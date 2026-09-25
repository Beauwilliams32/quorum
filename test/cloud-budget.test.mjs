import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { CloudBudget, priceOf } from '../src/cloud-budget.js'
import { DEFAULT_LIMITS } from '../src/standing-jobs.js'
import { AgentControlManager } from '../src/agent-control/manager.js'
import { AgentControlStore } from '../src/agent-control/store.js'
import { RuntimeManager } from '../src/runtime-manager.js'
import { MissionStore } from '../src/missions.js'
import { parseRuntimeLine } from '../src/runtime-events.js'
import { defer, scratchDir } from './helpers/scratch.mjs'

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 8181
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }
  child.kill = () => true
  return child
}

test("a Claude result event carries the CLI's own total_cost_usd", () => {
  const event = parseRuntimeLine('claude', JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.42, session_id: 's1' }))
  assert.equal(event.type, 'completed')
  assert.equal(event.costUsd, 0.42)
  const unpriced = parseRuntimeLine('codex', JSON.stringify({ type: 'turn.completed', thread_id: 't1' }))
  assert.equal(unpriced.costUsd, undefined, 'codex reports no dollar figure and none is invented')
})

test('the ledger separates recorded spend from spend it could not price', () => {
  let now = 1_000_000_000
  const budget = new CloudBudget({ limitUsd: 25, now: () => now })
  budget.record({ runId: 'a', runtime: 'claude', costUsd: 1.5 })
  budget.record({ runId: 'b', runtime: 'codex', costUsd: null })
  budget.record({ runId: 'c', runtime: 'claude', costUsd: 2.25 })
  const state = budget.check()
  assert.equal(state.spentUsd, 3.75)
  assert.equal(state.pricedRuns, 2)
  assert.equal(state.unpricedRuns, 1)
  assert.deepEqual(state.unpricedRuntimes, ['codex'])
  assert.equal(state.allowed, true)
  assert.match(state.reason, /\$3\.75 of \$25\.00/)
  assert.match(state.reason, /1 run\(s\) in this window reported no price/)
})

test('spend older than the window stops counting', () => {
  let now = 1_000_000_000
  const budget = new CloudBudget({ limitUsd: 25, now: () => now })
  budget.record({ runId: 'old', runtime: 'claude', costUsd: 20 })
  now += 25 * 60 * 60 * 1000
  const state = budget.check()
  assert.equal(state.spentUsd, 0)
  assert.equal(state.pricedRuns, 0)
})

test('reaching the ceiling refuses the next cloud run', () => {
  let now = 1_000_000_000
  const budget = new CloudBudget({ limitUsd: 5, now: () => now })
  budget.record({ runId: 'a', runtime: 'claude', costUsd: 5 })
  const state = budget.check()
  assert.equal(state.allowed, false)
  assert.equal(state.enforced, true)
  assert.match(state.reason, /daily cloud budget reached: \$5\.00 of \$5\.00/)
})

test('a budget of zero is reported as not enforced rather than as a block', () => {
  const budget = new CloudBudget({ limitUsd: 0 })
  const state = budget.check()
  assert.equal(state.allowed, true)
  assert.equal(state.enforced, false)
  assert.match(state.reason, /no daily cloud budget is configured/)
})

test('the managed runtime refuses to start past the ceiling and records what a run cost', async t => {
  const dir = scratchDir(t, 'quorum-budget-')
  const control = new AgentControlManager({ store: new AgentControlStore(dir), startKeyImpl: () => 'start-key' })
  defer(t, () => control.store.close())
  const missions = new MissionStore(path.join(dir, 'missions.json'))
  const mission = missions.create({ title: 'Budget', objective: 'Spend within the ceiling.', tasks: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }] })
  const child = fakeChild()
  const manager = new RuntimeManager({
    agentControl: control, missions, memoryBridge: { recall: async () => '' },
    executablePathImpl: () => true, spawnImpl: async () => child, heartbeatMs: 60_000,
    dailyCloudBudgetUsd: 1,
  })
  assert.equal(manager.budgetStatus().limitUsd, 1)
  await manager.start({ missionId: mission.id, taskId: 'one', runtime: 'claude', role: 'builder', cwd: dir, worktree: dir, task: 'work' })
  child.stdout.emit('data', `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 1.4, session_id: 's1' })}\n`)
  child.emit('exit', 0, null)
  for (let attempt = 0; attempt < 200 && missions.get(mission.id).tasks[0].status === 'working'; attempt++) await new Promise(resolve => setTimeout(resolve, 10))

  const after = manager.budgetStatus()
  assert.equal(after.spentUsd, 1.4)
  assert.equal(after.pricedRuns, 1)
  assert.equal(after.allowed, false)
  await assert.rejects(() => manager.start({ missionId: mission.id, taskId: 'two', runtime: 'claude', role: 'builder', cwd: dir, worktree: dir, task: 'more work' }), /daily cloud budget reached/)
  // Refusal is durable: a fresh manager over the same store sees the spend.
  const restarted = new RuntimeManager({ agentControl: control, missions, memoryBridge: { recall: async () => '' }, dailyCloudBudgetUsd: 1 })
  assert.equal(restarted.budgetStatus().allowed, false)
})

test('a price the provider never stated is never a price', () => {
  assert.equal(priceOf(null), null)
  assert.equal(priceOf(undefined), null)
  assert.equal(priceOf(''), null)
  assert.equal(priceOf('   '), null)
  assert.equal(priceOf('not-a-number'), null)
  assert.equal(priceOf(Number.NaN), null)
  assert.equal(priceOf(-1), null)
  assert.equal(priceOf(0), 0, 'a provider that really reports $0 is priced at $0')
  assert.equal(priceOf('0.42'), 0.42)
})

test('an unpriced claude result is recorded as unpriced, not as a $0 priced run', async t => {
  const dir = scratchDir(t, 'quorum-unpriced-')
  const control = new AgentControlManager({ store: new AgentControlStore(dir), startKeyImpl: () => 'start-key' })
  defer(t, () => control.store.close())
  const missions = new MissionStore(path.join(dir, 'missions.json'))
  const mission = missions.create({ title: 'Unpriced', objective: 'Do not invent a price.', tasks: [{ id: 'one', title: 'One' }] })
  const child = fakeChild()
  const manager = new RuntimeManager({
    agentControl: control, missions, memoryBridge: { recall: async () => '' },
    executablePathImpl: () => true, spawnImpl: async () => child, heartbeatMs: 60_000, dailyCloudBudgetUsd: 25,
  })
  await manager.start({ missionId: mission.id, taskId: 'one', runtime: 'claude', role: 'builder', cwd: dir, worktree: dir, task: 'work' })
  // A real claude result line with no `total_cost_usd` at all.
  child.stdout.emit('data', `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 's1' })}\n`)
  child.emit('exit', 0, null)
  for (let attempt = 0; attempt < 200 && missions.get(mission.id).tasks[0].status === 'working'; attempt++) await new Promise(resolve => setTimeout(resolve, 10))

  const status = manager.budgetStatus()
  assert.equal(status.pricedRuns, 0, 'nothing here reported a price')
  assert.equal(status.unpricedRuns, 1)
  assert.deepEqual(status.unpricedRuntimes, ['claude'])
  assert.equal(status.spentUsd, 0)
  // The surface has to say the ceiling is blind, not just show $0.00.
  assert.match(status.reason, /1 run\(s\) in this window reported no price/)
  const ledger = control.store.list('spend')
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].priced, false)
  assert.equal(ledger[0].costUsd, null)
})

test('a run still in flight is reported as unpriced spend in the window, not hidden', async t => {
  const dir = scratchDir(t, 'quorum-inflight-')
  const control = new AgentControlManager({ store: new AgentControlStore(dir), startKeyImpl: () => 'start-key' })
  defer(t, () => control.store.close())
  const missions = new MissionStore(path.join(dir, 'missions.json'))
  const mission = missions.create({ title: 'In flight', objective: 'Say what is not yet priced.', tasks: [{ id: 'one', title: 'One' }] })
  const child = fakeChild()
  const manager = new RuntimeManager({
    agentControl: control, missions, memoryBridge: { recall: async () => '' },
    executablePathImpl: () => true, spawnImpl: async () => child, heartbeatMs: 60_000, dailyCloudBudgetUsd: 25,
  })
  assert.equal(manager.budgetStatus().inFlightRuns, 0)
  await manager.start({ missionId: mission.id, taskId: 'one', runtime: 'claude', role: 'builder', cwd: dir, worktree: dir, task: 'work' })

  const during = manager.budgetStatus()
  assert.equal(during.inFlightRuns, 1)
  // The ceiling is checked before a spawn and recorded at exit, so a
  // concurrently-started run reads a ledger that does not contain it. The
  // figure has to say so rather than read as committed spend.
  assert.match(during.reason, /1 cloud run\(s\) are still in flight/)
  assert.match(during.reason, /recorded spend, not committed spend/)

  child.stdout.emit('data', `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.5, session_id: 's1' })}\n`)
  child.emit('exit', 0, null)
  for (let attempt = 0; attempt < 200 && missions.get(mission.id).tasks[0].status === 'working'; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  const after = manager.budgetStatus()
  assert.equal(after.inFlightRuns, 0)
  assert.equal(after.spentUsd, 0.5)
  assert.equal(/still in flight/.test(after.reason), false)
})

test('an independent review is an unpriced cloud run in the same ledger', () => {
  const manager = new RuntimeManager({ agentControl: {}, missions: {}, dailyCloudBudgetUsd: 25 })
  manager.recordCloudSpend({ runId: 'reviewer-1', runtime: 'codex', costUsd: null, missionId: 'm', taskId: 't' })
  const status = manager.budgetStatus()
  assert.equal(status.unpricedRuns, 1, 'a review that ran is in the ledger')
  assert.equal(status.pricedRuns, 0)
  assert.deepEqual(status.unpricedRuntimes, ['codex'])
  assert.match(status.reason, /1 run\(s\) in this window reported no price/)
})

test('the advertised daily ceiling is the one the runtime enforces', () => {
  const manager = new RuntimeManager({ agentControl: {}, missions: {} })
  assert.equal(manager.budgetStatus().limitUsd, DEFAULT_LIMITS.dailyCloudBudgetUsd)
  assert.equal(manager.budgetStatus().enforced, true)
})
