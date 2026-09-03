import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCatalog, roundtableModelOptions } from '../src/catalog.js'
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
  for (const id of ['claude', 'codex', 'openai-api', 'gemini', 'hermes', 'openclaw', 'ollama', 'comfyui-wan']) assert.ok(catalog.runtimes.some(runtime => runtime.id === id))
  assert.ok(catalog.models.every(model => !('prompt' in model) && !('token' in model) && !('key' in model)))
  assert.ok(catalog.pets.every(pet => ['built-in', 'generated', 'fallback'].includes(pet.source)))
})

test('roundtable model options keep provider and model explicit', () => {
  const localCatalog = buildCatalog({
    config: { path: '/tmp/config.json', exists: true, projects: [], runtimes: [], models: [] },
    runtimes: [
      { id: 'ollama', label: 'Ollama', command: 'ollama', kind: 'local', roundtable: true },
      { id: 'llama-cpp', label: 'llama.cpp', command: 'llama-cli', kind: 'local', roundtable: true },
    ],
    models: [],
  })
  const options = roundtableModelOptions({ catalog: localCatalog, config: { modelMappings: {} }, models: ['ollama:gemma3:latest', 'llama-cpp:deepseek-r1:8b'] })
  assert.ok(options.some(option => option.id === 'ollama:gemma3:latest' && option.local))
  assert.ok(options.some(option => option.id === 'llama-cpp:deepseek-r1:8b' && option.provider === 'llama-cpp'))
  assert.equal(options.filter(option => option.id === 'ollama:gemma3:latest').length, 1)
  assert.ok(options.every(option => !('token' in option) && !('key' in option)))
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

test('task-pack previews carry role, route, and no inherited environment', () => {
  const packCatalog = buildCatalog({
    config: { path: '/tmp/config.json', exists: true, projects: [], runtimes: [], models: [] },
    runtimes: [{ id: 'claude', label: 'Claude', command: 'claude', builtin: true }],
    models: [],
  })
  const preview = previewAction({ action: 'launch', packId: 'review', runtimeId: 'claude', roomId: 'room', modelRef: 'claude:sonnet', task: 'Review the auth boundary' }, packCatalog, state, ptys)
  assert.equal(preview.role, 'researcher')
  assert.equal(preview.modelRef, 'claude:sonnet')
  assert.equal('env' in preview.launch, false)
  assert.match(preview.launch.shellCommand, /Review the auth boundary/)
})

test('managed task previews show the structured command that confirmation executes', () => {
  const packCatalog = buildCatalog({
    config: { path: '/tmp/config.json', exists: true, projects: [], runtimes: [], models: [] },
    runtimes: [{ id: 'codex', label: 'Codex', command: 'codex', builtin: true }],
    models: [],
  })
  const preview = previewAction({ action: 'launch', managed: true, packId: 'review', runtimeId: 'codex', roomId: 'room', task: 'Review the auth boundary' }, packCatalog, state, ptys)
  assert.equal(preview.launch.args.at(-1), '--json')
})

test('configuration validation keeps command settings allowlisted', () => {
  const result = validateConfig({ roots: ['~/code'], modelMappings: { claude: 'claude-sonnet' }, pets: { claude: 'local.svg' }, display: { theme: 'dark', refreshSeconds: 10 }, secret: 'drop-me' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.modelMappings, { claude: 'claude-sonnet' })
  assert.equal('secret' in result.value, false)
  const routed = validateConfig({ modelMappings: { ollama: 'deepseek-r1:8b' } })
  assert.equal(routed.ok, true)
  assert.equal(routed.value.modelMappings.ollama, 'deepseek-r1:8b')
})
