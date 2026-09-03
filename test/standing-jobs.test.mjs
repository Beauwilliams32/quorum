import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LIMITS, StandingJobScheduler } from '../src/standing-jobs.js'
import { buildCityState } from '../src/city-state.js'

test('standing jobs remain truthful monitors with bounded cloud limits', async () => {
  let now = 100
  const scheduler = new StandingJobScheduler({ clock: () => now })
  assert.equal(scheduler.jobs.length, 9)
  assert.equal(DEFAULT_LIMITS.maxConcurrentCloudAgents, 4)
  assert.equal(DEFAULT_LIMITS.dailyCloudBudgetUsd, 25)
  scheduler.register('runtime-health', async () => ({ detail: 'two runtimes ready' }))
  await scheduler.run('runtime-health')
  assert.equal(scheduler.jobs[0].status, 'monitoring')
  assert.equal(scheduler.jobs[0].detail, 'two runtimes ready')
  scheduler.suspend('runtime-health', true)
  assert.equal(scheduler.jobs[0].status, 'sleeping')
})

test('city projection maps projects, agents, processes and infrastructure', () => {
  const city = buildCityState({ projects: { rooms: [{ id: 'app', label: 'App', cwd: '/app', active: true }] }, sessions: { cards: [{ projectId: 'app' }] }, agents: { agents: [{ sessionId: 'a1', name: 'Builder', projectId: 'app', status: 'testing' }] }, processes: { inventory: [{ id: 'process:2', pid: 2, name: 'zsh', kind: 'terminal', ownership: 'user-owned' }] }, services: { openclaw: { up: true, port: 18789, connectionState: 'reachable', authState: 'required' } }, memory: { ok: true }, agentControl: { actions: [] } }, { jobs: [] }, [])
  assert.equal(city.schemaVersion, 1)
  assert.equal(city.buildings.length, 5)
  assert.equal(city.characters[0].state, 'testing')
  assert.equal(city.workers[0].kind, 'terminal')
  assert.equal(city.buildings.find(item => item.id === 'building:gateway:openclaw').connectionState, 'reachable')
})
