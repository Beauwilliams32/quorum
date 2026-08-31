import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shortName } from '../src/collectors/processes.js'
import { buildAgents } from '../src/collectors/agents.js'
import { buildTasks } from '../src/collectors/tasks.js'
import { TranscriptWatcher } from '../src/collectors/sessions.js'
import { tailBytes, jsonLines } from '../src/util.js'
import { loadRuntimes, loadModels, BUILTIN_RUNTIMES, BUILTIN_MODELS } from '../src/config.js'
import { lockedMember, LOCKED_CAST } from '../src/cast-locked.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-test-'))

test('shortName classifies the command lines the cockpit sees', () => {
  assert.equal(shortName('/usr/bin/python3 /x/ComfyUI/main.py --listen'), 'ComfyUI server')
  assert.equal(shortName('python3.11 /a/b/hermes_agent.py'), 'python3.11 hermes_agent.py')
  assert.equal(shortName('node /opt/thing/server.mjs'), 'node server.mjs')
  assert.equal(shortName('/opt/bin/hf download org/model file.safetensors'), 'hf ⇣ file.safetensors')
  assert.equal(shortName('/usr/local/bin/claude --session-id deadbeef-1234 -p hi'), 'claude deadbeef')
  assert.equal(shortName('claude --bg-pty-host'), 'claude pty-host')
  assert.equal(shortName('claude daemon'), 'claude daemon')
  assert.equal(shortName('/bin/zsh -l'), 'zsh')
})

test('buildAgents keeps only live sessions and never reports a socket it cannot see', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify({
    pid: process.pid, sessionId: 'abc12345-0000', name: 'me', cwd: '/tmp', status: 'busy',
    statusUpdatedAt: 5, messagingSocketPath: path.join(dir, 'missing.sock'),
  }))
  fs.writeFileSync(path.join(dir, 'dead.json'), JSON.stringify({ pid: 2147483000, sessionId: 'dead' }))
  fs.writeFileSync(path.join(dir, 'nopid.json'), JSON.stringify({ sessionId: 'nopid' }))
  fs.writeFileSync(path.join(dir, 'garbage.json'), '{not json')
  const { agents } = buildAgents(dir)
  assert.equal(agents.length, 1)
  assert.equal(agents[0].sessionId, 'abc12345-0000')
  assert.equal(agents[0].name, 'me')
  assert.equal(agents[0].kind, 'interactive')
  assert.equal(agents[0].chatCapable, false)
  assert.deepEqual(buildAgents(path.join(dir, 'nope')).agents, [])
})

test('buildTasks aggregates per-session task files, joins live sessions and orders by status', () => {
  const dir = tmp()
  const s1 = path.join(dir, 'sess-1'), s2 = path.join(dir, 'sess-2')
  fs.mkdirSync(s1); fs.mkdirSync(s2)
  fs.writeFileSync(path.join(s1, '1.json'), JSON.stringify({ id: 1, subject: 'done thing', status: 'completed' }))
  fs.writeFileSync(path.join(s1, '2.json'), JSON.stringify({ id: 2, subject: 'doing', status: 'in_progress', blockedBy: [1] }))
  fs.writeFileSync(path.join(s2, '3.json'), JSON.stringify({ subject: 'todo', status: 'weird' }))
  fs.writeFileSync(path.join(s2, 'bad.json'), 'nope')
  fs.writeFileSync(path.join(dir, 'stray.json'), '{}')
  const out = buildTasks({ agents: { agents: [{ sessionId: 'sess-1', projectId: 'portal', cwd: '/p', status: 'busy' }] } }, dir)
  assert.deepEqual(out.counts, { pending: 1, in_progress: 1, completed: 1 })
  assert.deepEqual(out.tasks.map(t => t.status), ['in_progress', 'pending', 'completed'])
  const doing = out.tasks.find(t => t.id === '2')
  assert.equal(doing.projectId, 'portal')
  assert.equal(doing.live, true)
  assert.equal(doing.sessionActive, true)
  assert.deepEqual(doing.blockedBy, ['1'])
  const todo = out.tasks.find(t => t.subject === 'todo')
  assert.equal(todo.id, '3')
  assert.equal(todo.status, 'pending')
  assert.equal(todo.live, false)
  assert.deepEqual(out.byProject.portal, { pending: 0, in_progress: 1, completed: 1 })
  assert.deepEqual(out.byProject._unassigned, { pending: 1, in_progress: 0, completed: 0 })
  assert.deepEqual(buildTasks({}, path.join(dir, 'missing')).tasks, [])
})

test('TranscriptWatcher refuses files outside the session directories', () => {
  const dir = tmp()
  const file = path.join(dir, 'x.jsonl')
  fs.writeFileSync(file, '{}\n')
  const w = new TranscriptWatcher({ readyState: 1, send() {} })
  assert.throws(() => w.watch(file), /outside session directories/)
  assert.throws(() => w.watch(path.join(dir, 'missing.jsonl')))
  w.stop()
})

test('tailBytes and jsonLines read partial transcripts defensively', () => {
  const dir = tmp()
  const file = path.join(dir, 't.jsonl')
  fs.writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":')
  assert.equal(tailBytes(file, 5), '{"c":')
  assert.equal(tailBytes(file, 1e6), '{"a":1}\n{"b":2}\n{"c":')
  assert.equal(tailBytes(path.join(dir, 'missing'), 10), '')
  assert.deepEqual(jsonLines(tailBytes(file, 1e6)), [{ a: 1 }, { b: 2 }])
  assert.deepEqual(jsonLines('plain text\n  {"ok":true}  \n'), [{ ok: true }])
})

test('runtimes and models always include the built-ins and built-in ids cannot be overridden', () => {
  const rts = loadRuntimes()
  for (const b of BUILTIN_RUNTIMES) {
    const hits = rts.filter(r => r.id === b.id)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].builtin, true)
  }
  const models = loadModels()
  for (const m of BUILTIN_MODELS) assert.ok(models.includes(m))
  assert.equal(new Set(models).size, models.length)
})

test('lockedMember looks up Pro appearance metadata without a persona', () => {
  assert.equal(lockedMember('sable').role, 'Adversary')
  assert.equal(lockedMember('nobody'), null)
  for (const c of LOCKED_CAST) {
    assert.equal(c.edition, 'pro')
    assert.equal('prompt' in c, false)
  }
})
