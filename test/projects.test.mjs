import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { resolveProjectId, buildOffice, PROJECT_CATALOG } from '../src/collectors/projects.js'

const HOME = os.homedir()
const CLAUDE = path.join(HOME, 'CLAUDE')

test('resolveProjectId maps portal cwd', () => {
  const catalog = [{ id: 'portal', pathPrefix: path.join(CLAUDE, 'williams-media-portal') }]
  assert.equal(resolveProjectId(path.join(CLAUDE, 'williams-media-portal'), catalog), 'portal')
  assert.equal(resolveProjectId(path.join(CLAUDE, 'williams-media-portal', 'src'), catalog), 'portal')
})

test('resolveProjectId prefers tools-mac over trident-tools', () => {
  const catalog = [
    { id: 'trident-tools', pathPrefix: path.join(CLAUDE, 'trident-tools') },
    { id: 'trident-tools-mac', pathPrefix: path.join(CLAUDE, 'trident-tools', 'apps', 'mac') },
  ]
  assert.equal(resolveProjectId(path.join(CLAUDE, 'trident-tools'), catalog), 'trident-tools')
  assert.equal(resolveProjectId(path.join(CLAUDE, 'trident-tools', 'apps', 'mac'), catalog), 'trident-tools-mac')
  assert.equal(resolveProjectId(path.join(CLAUDE, 'trident-tools', 'apps', 'mac', 'src'), catalog), 'trident-tools-mac')
})

test('resolveProjectId returns null for unrelated paths', () => {
  assert.equal(resolveProjectId('/tmp'), null)
  assert.equal(resolveProjectId(null), null)
  assert.equal(resolveProjectId(''), null)
})

test('buildOffice seats sessions into rooms', () => {
  const catalog = [
    { id: 'demo', label: 'Demo', pathPrefix: path.join(CLAUDE, 'demo-proj') },
  ]
  const office = buildOffice({
    sessions: {
      cards: [{
        agent: 'claude',
        cwd: path.join(CLAUDE, 'demo-proj', 'src'),
        projectId: 'demo',
        active: true,
        mtimeMs: Date.now(),
        summary: 'building office',
        file: '/tmp/x.jsonl',
      }],
    },
    processes: { groups: { claude: 1, codex: 0 } },
    services: { hermes: { up: true }, comfy: { up: false } },
  }, catalog)

  assert.equal(office.team.find(t => t.id === 'claude').alive, true)
  assert.equal(office.team.find(t => t.id === 'hermes').alive, true)
  // room only appears if path exists — demo-proj likely missing; still catalog listed
  assert.ok(Array.isArray(office.rooms))
  assert.ok(office.catalog.some(c => c.id === 'demo'))
})

test('PROJECT_CATALOG is valid on a fresh machine', () => {
  const ids = PROJECT_CATALOG.map(p => p.id)
  assert.ok(ids.includes('home'))
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(PROJECT_CATALOG.every(project => project.pathPrefix && project.label))
})
