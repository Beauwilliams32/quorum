import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCatalog } from '../src/catalog.js'
import { previewAction } from '../src/command.js'
import { validateConfig } from '../src/validate.js'

const catalog = buildCatalog({
  config: { path: '/tmp/config.json', exists: true, projects: [], runtimes: [], models: [] },
  runtimes: [{ id: 'claude', label: 'claude', command: 'claude', builtin: true }, { id: 'custom', label: 'Custom', command: 'custom' }],
  models: ['sonnet'],
})
const state = { data: { projects: { rooms: [{ id: 'room', label: 'Room', cwd: '/tmp' }] } } }
const ptys = { list: () => [{ id: 't1', profile: 'claude', exited: false }] }

test('catalog contains the public-safe harness and model contract', () => {
  for (const id of ['claude', 'codex', 'openai-api', 'gemini', 'hermes', 'openclaw', 'comfyui-wan']) assert.ok(catalog.runtimes.some(runtime => runtime.id === id))
  assert.ok(catalog.models.every(model => !('prompt' in model) && !('token' in model) && !('key' in model)))
  assert.ok(catalog.pets.every(pet => ['built-in', 'generated', 'fallback'].includes(pet.source)))
})

test('command previews reject unknown rooms, runtimes, sessions, and chains', () => {
  assert.throws(() => previewAction({ action: 'launch', runtimeId: 'missing', roomId: 'room' }, catalog, state, ptys), /not launchable/)
  assert.throws(() => previewAction({ action: 'launch', runtimeId: 'claude', roomId: 'missing' }, catalog, state, ptys), /unknown project room/)
  assert.throws(() => previewAction({ action: 'stop', ptyId: 'missing' }, catalog, state, ptys), /tracked PTY/)
  assert.throws(() => previewAction({ action: 'chain', chainId: 'arbitrary', steps: ['rm -rf'] }, catalog, state, ptys), /approved orchestration/)
})

test('command previews are explicit before execution', () => {
  const preview = previewAction({ action: 'launch', runtimeId: 'claude', roomId: 'room' }, catalog, state, ptys)
  assert.equal(preview.summary, 'Launch Claude in Room')
  assert.equal(preview.command, 'claude')
})

test('configuration validation keeps command settings allowlisted', () => {
  const result = validateConfig({ roots: ['~/code'], modelMappings: { claude: 'claude-sonnet' }, pets: { claude: 'local.svg' }, display: { theme: 'dark', refreshSeconds: 10 }, secret: 'drop-me' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.modelMappings, { claude: 'claude-sonnet' })
  assert.equal('secret' in result.value, false)
})
