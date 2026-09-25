// Collectors tick on fixed intervals whether or not the thing they watch
// moved. Two costs follow: the scan, and a byte-identical broadcast to every
// connected client. These tests hold the line on both — cheaper ticks must
// not mean a session, a task or a change that never reaches the UI.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { State } from '../src/state.js'
import { FULL_SWEEP_TICKS } from '../src/collectors/sessions.js'
import { scratchDir } from './helpers/scratch.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function client(readyState = 1) {
  const c = { readyState, sent: [] }
  c.send = s => c.sent.push(JSON.parse(s))
  return c
}

test('an identical payload is stored but not re-broadcast', () => {
  const s = new State()
  const c = client()
  s.clients.add(c)
  s.update('sessions', { cards: [{ id: 'a' }] })
  s.update('sessions', { cards: [{ id: 'a' }] })
  s.update('sessions', { cards: [{ id: 'a' }] })
  assert.equal(c.sent.length, 1, 'three identical ticks, one frame')
  assert.deepEqual(s.data.sessions, { cards: [{ id: 'a' }] }, 'the store still holds the value')

  s.update('sessions', { cards: [{ id: 'b' }] })
  assert.equal(c.sent.length, 2, 'a real change still goes out immediately')
})

test('a payload that differs only in when it was built costs a patch, not a resend', () => {
  // The delta publisher does not drop a timestamp-only tick: the client still
  // learns the collector ran. What it must not do is re-send the whole payload
  // for a field nobody renders, so the frame has to be a patch carrying ts alone.
  const s = new State()
  const c = client()
  s.clients.add(c)
  s.update('tasks', { tasks: [{ id: 'a', title: 'a task with a body long enough to notice' }], counts: { pending: 0 }, ts: 1 })
  const full = c.sent.length
  assert.equal(full, 1, 'the first payload goes out whole')
  const firstBytes = JSON.stringify(c.sent[0]).length

  s.update('tasks', { tasks: [{ id: 'a', title: 'a task with a body long enough to notice' }], counts: { pending: 0 }, ts: 2 })
  assert.equal(c.sent.length, 2)
  const patch = c.sent[1]
  assert.equal(patch.type, 'patch', 'a ts-only change is a patch')
  assert.deepEqual(Object.keys(patch.set || {}), ['ts'], 'and it carries only the field that moved')
  assert.ok(JSON.stringify(patch).length < firstBytes / 2, 'a patch that is not much smaller is not worth sending')
  assert.equal(s.data.tasks.ts, 2, 'the stored payload is still the latest one')

  s.update('tasks', { tasks: [], counts: { pending: 1 }, ts: 3 })
  assert.equal(c.sent.length, 3, 'a real change still goes out')
})

test('a changed payload is still sent after repeats were suppressed', () => {
  const s = new State()
  const c = client()
  s.clients.add(c)
  s.update('city', { blocks: [] })
  s.update('city', { blocks: [] })
  assert.equal(c.sent.length, 1, 'the repeat is suppressed')
  s.update('city', { blocks: [{ id: 'a' }] })
  assert.equal(c.sent.length, 2, 'a real change still reaches the client')
})

test('a new client still receives everything in its snapshot after suppression', () => {
  const s = new State()
  const early = client()
  s.clients.add(early)
  s.update('sessions', { cards: [{ id: 'a' }] })
  s.update('sessions', { cards: [{ id: 'a' }] })
  const late = client()
  s.clients.add(late)
  assert.deepEqual(s.snapshot().data.sessions, { cards: [{ id: 'a' }] })
})

test('suppression compares the broadcast payload, not the stored one', () => {
  const s = new State()
  const c = client()
  s.clients.add(c)
  s.update('system', { latest: 1, hist: [1] }, { latest: 1 })
  s.update('system', { latest: 1, hist: [1, 1] }, { latest: 1 })
  assert.equal(c.sent.length, 1, 'the client saw no change, because none was sent to it')
  assert.deepEqual(s.data.system.hist, [1, 1], 'the store kept the fuller value')
})

// ── the sessions mtime cursor ────────────────────────────────────────────────

function sessionHome(t) {
  const home = scratchDir(t, 'quorum-cursor-')
  const project = path.join(home, '.claude', 'projects', '-tmp-work')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(home, '.claude', 'jobs'), { recursive: true })
  return { home, project }
}

const transcript = (text) => JSON.stringify({ type: 'user', cwd: '/tmp/work', message: { content: text } }) + '\n'

function drive(home, body) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.setInterval = () => ({ unref() {} })
    const S = await import('./src/collectors/sessions.js')
    const seen = []
    const state = { update: (key, value) => seen.push(value) }
    const tick = () => S.startSessions(state)
    ${body}
    process.stdout.write(JSON.stringify(out))
  `], { cwd: ROOT, env: { ...process.env, HOME: home }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('a transcript appended to between ticks is picked up without a full sweep', t => {
  const { home, project } = sessionHome(t)
  const file = path.join(project, 'aaaabbbb-0000-4000-8000-000000000001.jsonl')
  fs.writeFileSync(file, transcript('first message'))
  const out = drive(home, `
    import fs from 'node:fs'
    tick()                                   // full sweep (tick 0)
    const before = seen.at(-1).cards[0].summary
    fs.appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(transcript('second message'))})
    tick()                                   // cheap tick
    const out = { before, after: seen.at(-1).cards[0].summary, ticks: seen.length }
  `)
  assert.equal(out.before, '❯ first message')
  assert.equal(out.after, '❯ second message', 'a cheap tick must still see a live session move')
})

test('a transcript created between ticks is picked up without a full sweep', t => {
  const { home, project } = sessionHome(t)
  fs.writeFileSync(path.join(project, 'aaaabbbb-0000-4000-8000-000000000001.jsonl'), transcript('one'))
  const out = drive(home, `
    import fs from 'node:fs'
    tick()
    fs.writeFileSync(${JSON.stringify(path.join(project, 'ccccdddd-0000-4000-8000-000000000002.jsonl'))}, ${JSON.stringify(transcript('two'))})
    tick()
    const out = { ids: seen.at(-1).cards.map(card => card.id).sort() }
  `)
  assert.deepEqual(out.ids, ['aaaabbbb-0000-4000-8000-000000000001', 'ccccdddd-0000-4000-8000-000000000002'],
    'creating a file moves its directory mtime, which a cheap tick watches')
})

test('a session dormant past the freshness window resurfaces within one full sweep', t => {
  const { home, project } = sessionHome(t)
  const old = path.join(project, 'eeeeffff-0000-4000-8000-000000000003.jsonl')
  fs.writeFileSync(old, transcript('ancient'))
  const longAgo = Date.now() / 1000 - 30 * 86_400
  fs.utimesSync(old, longAgo, longAgo)
  // The directory's own mtime is what a cheap tick watches, so put it back
  // too: this is the one case cheap ticks cannot see.
  fs.utimesSync(project, longAgo, longAgo)

  const out = drive(home, `
    import fs from 'node:fs'
    tick()
    const cold = seen.at(-1).cards.length
    // Resume the dormant transcript without touching its directory.
    const now = Date.now() / 1000
    fs.utimesSync(${JSON.stringify(old)}, now, now)
    fs.utimesSync(${JSON.stringify(project)}, ${longAgo}, ${longAgo})
    const cheap = []
    for (let i = 1; i < ${FULL_SWEEP_TICKS}; i++) { tick(); cheap.push(seen.at(-1).cards.length) }
    tick()   // the next full sweep
    const out = { cold, cheap, afterSweep: seen.at(-1).cards.length }
  `)
  assert.equal(out.cold, 0, 'a month-old transcript is outside the window')
  assert.deepEqual(out.cheap, Array(FULL_SWEEP_TICKS - 1).fill(0), 'cheap ticks do not see it — this is the documented cost')
  assert.equal(out.afterSweep, 1, 'the full sweep finds it, bounding the delay')
})

test('the transcript cache drops files that no longer exist', t => {
  const { home, project } = sessionHome(t)
  const gone = path.join(project, 'aaaabbbb-0000-4000-8000-000000000001.jsonl')
  fs.writeFileSync(gone, transcript('here'))
  fs.writeFileSync(path.join(project, 'ccccdddd-0000-4000-8000-000000000002.jsonl'), transcript('stays'))
  const out = drive(home, `
    import fs from 'node:fs'
    tick()
    const before = seen.at(-1).cards.length
    fs.unlinkSync(${JSON.stringify(gone)})
    for (let i = 0; i < ${FULL_SWEEP_TICKS}; i++) tick()
    const out = { before, after: seen.at(-1).cards.length }
  `)
  assert.equal(out.before, 2)
  assert.equal(out.after, 1, 'a deleted transcript must not linger in an unevicted cache')
})
