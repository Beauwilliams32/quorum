import test from 'node:test'
import assert from 'node:assert/strict'
import { detectRuntimes, buildTaskLaunch } from '../src/agent-control/adapters.js'
import { PROVIDER_SPECS, RUNTIME_ADAPTERS, providerCatalog, resolveProviderSpec, taskRoute } from '../src/agent-control/provider-registry.js'
import { BENCHMARK_PROMPT, benchmarkPlan, runBenchmarks } from '../src/agent-control/benchmark.js'

test('registry covers requested providers without storing credentials', () => {
  const ids = new Set(PROVIDER_SPECS.map(spec => spec.id))
  for (const id of ['anthropic', 'openai', 'openai-codex', 'ollama', 'openrouter', 'minimax', 'google-gemini', 'xai', 'aws-bedrock', 'openai-compatible']) assert.ok(ids.has(id), id)
  for (const spec of PROVIDER_SPECS) {
    assert.equal(typeof spec.authReference, 'string')
    assert.doesNotMatch(JSON.stringify(spec), /sk-[A-Za-z0-9]{8,}/)
    assert.doesNotMatch(JSON.stringify(spec), /(?:api[_-]?key|bearer|token|secret)\s*:/i)
    assert.ok(Array.isArray(spec.capabilities))
    assert.equal(spec.benchmark?.supported === true || spec.benchmark?.supported === false, true)
  }
})

test('every built-in runtime has a safe adapter and installed detection is truthful', () => {
  const detected = detectRuntimes({ PATH: '/nonexistent' })
  for (const id of ['claude', 'codex', 'copilot', 'gemini', 'hermes', 'openclaw', 'ollama', 'cursor']) {
    assert.ok(RUNTIME_ADAPTERS[id], id)
    assert.equal(resolveProviderSpec(id).id, id)
    const entry = detected.find(runtime => runtime.id === id)
    assert.ok(entry, id)
    assert.equal(entry.available, typeof entry.path === 'string')
    assert.equal(entry.contractVersion, 1)
  }
})

test('catalog separates installed, configured, and verified provider states', () => {
  const catalog = providerCatalog({ runtimes: [{ id: 'codex', available: true }, { id: 'ollama', available: true }], configuredProviders: ['openrouter'] })
  const codex = catalog.find(item => item.id === 'openai-codex')
  const openrouter = catalog.find(item => item.id === 'openrouter')
  assert.equal(codex.readiness, 'installed-unverified')
  assert.equal(codex.authReference, 'codex-oauth-existing')
  assert.equal(openrouter.readiness, 'configured-unverified')
  assert.equal(openrouter.authStatus, 'reference-configured')
  assert.equal(catalog.find(item => item.id === 'ollama').authStatus, 'not-required')
})

test('interactive providers remain interactive and task routing is explicit', () => {
  const cursor = buildTaskLaunch({ runtime: 'cursor', role: 'builder', cwd: '/tmp/project', task: 'do not inject' })
  assert.equal(cursor.promptTransport, 'interactive')
  assert.equal(cursor.input, null)
  assert.equal(cursor.taskIncluded, true)
  assert.deepEqual(taskRoute('architecture').preferred.slice(0, 2), ['codex', 'claude'])
})

test('benchmark harness is dry-run friendly, sequential, and output-redacted', async () => {
  const plans = benchmarkPlan({ runtimes: [{ id: 'codex', provider: 'openai-codex', kind: 'cloud', available: true }, { id: 'cursor', provider: 'cursor', kind: 'local', available: true }] })
  assert.equal(plans.find(plan => plan.runtime === 'codex').status, 'ready-to-benchmark')
  assert.equal(plans.find(plan => plan.runtime === 'cursor').status, 'interactive-only')
  const result = await runBenchmarks({ runtimes: [{ id: 'codex', provider: 'openai-codex', kind: 'cloud', available: true }] })
  assert.equal(result.prompt, '[redacted benchmark prompt]')
  assert.equal(result.results[0].status, 'skipped-cloud')
  assert.equal(BENCHMARK_PROMPT.includes('Do not use tools'), true)
})
