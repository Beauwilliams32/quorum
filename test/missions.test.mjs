import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MissionStore } from '../src/missions.js'

test('mission store preserves dependency graph and durable task state', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-missions-')), 'missions.json')
  const store = new MissionStore(file)
  const mission = store.create({ title: 'Ship index', objective: 'Make local agent memory searchable.', tasks: [
    { id: 'scan', title: 'Scan sources', description: 'Build the metadata index.', worktree: '/tmp/worktree', branch: 'feature/index' },
    { id: 'verify', title: 'Verify recall', description: 'Search and open an artifact.', dependsOn: ['scan'] },
  ] })
  assert.deepEqual(store.readyTasks(mission.id).map(task => task.id), ['scan'])
  assert.equal(mission.tasks[0].worktree, '/tmp/worktree')
  store.setTask(mission.id, 'scan', { status: 'completed' })
  assert.deepEqual(store.readyTasks(mission.id).map(task => task.id), ['verify'])
  store.setTask(mission.id, 'verify', { status: 'completed' })
  assert.equal(store.get(mission.id).status, 'completed')
  const reloaded = new MissionStore(file)
  assert.equal(reloaded.get(mission.id).status, 'completed')
  assert.equal(reloaded.get(mission.id).tasks.length, 2)
})
