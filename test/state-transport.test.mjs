import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { State } from '../src/state.js'

/* The server no longer sends the whole value of a key on every tick — it sends
 * patches. That is only safe if the browser ends up holding EXACTLY what a full
 * broadcast would have given it, so this drives the real server store and the
 * real client-side transport against each other and compares the two copies
 * after every message.
 *
 * public/app.js is one browser module with no export boundary, so the transport
 * block is lifted the same way test/deck.test.mjs and test/chat-send.test.mjs
 * lift their sections. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')

function loadClient() {
  const start = app.indexOf('const wire = {}')
  const end = app.indexOf('/* ── view-scoped rendering')
  assert.ok(start > 0 && end > start, 'transport block not found in public/app.js')

  const S = { feed: [], hist: [], system: null }
  const sent = []
  const applied = []
  const warnings = []
  const factory = new Function(
    'S', 'send', 'paint', 'applyUpdate', 'renderAll', 'console',
    `${app.slice(start, end)}\nreturn { handlers, wire, wireVersion, resyncPending }`)
  const client = factory(
    S,
    message => sent.push(message),
    () => {},
    (key, data) => applied.push({ key, data }),
    () => {},
    { warn: message => warnings.push(message) })
  return { ...client, S, sent, applied, warnings }
}

/** A server whose broadcasts are fed straight into one client. */
function wired() {
  const state = new State()
  const client = loadClient()
  const socket = { readyState: 1, send: text => { const m = JSON.parse(text); client.handlers[m.type]?.(m) } }
  state.clients.add(socket)
  return { state, client, socket }
}

const city = (n, workingIndex = -1) => ({
  buildings: [{ id: 'b1', status: 'active' }],
  workers: Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, state: i === workingIndex ? 'working' : 'idle', label: `worker ${i}` })),
  services: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, state: 'running', detail: `service number ${i}` })),
  ts: n,
})

test('the browser copy matches the server copy after a run of patches', () => {
  const { state, client, socket } = wired()
  state.update('city', city(1))
  socket.send(state.snapshotMessage())

  for (let tick = 2; tick <= 12; tick++) {
    state.update('city', city(tick, tick % 5 === 0 ? tick : -1))
    assert.deepEqual(client.wire.city, JSON.parse(state.wire.city.whole), `client diverged at tick ${tick}`)
  }
  // Rows removed and reordered, not just edited.
  const shuffled = city(13)
  shuffled.workers = [shuffled.workers[9], ...shuffled.workers.filter(w => w.id !== 'w9' && w.id !== 'w4')]
  state.update('city', shuffled)
  assert.deepEqual(client.wire.city, JSON.parse(state.wire.city.whole))
  // A property disappearing is applied too.
  const trimmed = city(14)
  delete trimmed.services
  state.update('city', trimmed)
  assert.deepEqual(client.wire.city, JSON.parse(state.wire.city.whole))
  assert.equal(client.wire.city.services, undefined)
})

test('a snapshot seeds patches from the lighter payload the browser is actually sent', () => {
  const { state, client, socket } = wired()
  state.update('processes', { procs: [{ pid: 1 }], groups: { claude: 1 }, inventory: Array.from({ length: 500 }, (_, i) => ({ pid: i })) }, { procs: [{ pid: 1 }], groups: { claude: 1 } })
  state.update('system', { latest: { freeMB: 100 }, hist: [1, 2, 3] }, { latest: { freeMB: 100 } })
  socket.send(state.snapshotMessage())

  assert.equal(client.wire.processes.inventory, undefined, 'the browser is not handed the 500-row inventory')
  assert.deepEqual(client.S.hist, [1, 2, 3], 'history still reaches the client through the snapshot')

  state.update('processes', { procs: [{ pid: 2 }], groups: { claude: 1 }, inventory: [] }, { procs: [{ pid: 2 }], groups: { claude: 1 } })
  assert.deepEqual(client.wire.processes, { procs: [{ pid: 2 }], groups: { claude: 1 } })
  assert.deepEqual(client.applied.at(-1), { key: 'processes', data: { procs: [{ pid: 2 }], groups: { claude: 1 } } })
})

test('a missed patch is noticed, said out loud, and answered with the whole value', () => {
  const { state, client, socket } = wired()
  state.update('city', city(1))
  socket.send(state.snapshotMessage())

  // Drop one message on the floor, exactly as a dropped frame would.
  state.clients.delete(socket)
  state.update('city', city(2))
  state.clients.add(socket)
  state.update('city', city(3))

  assert.deepEqual(client.sent, [{ type: 'state.resync', key: 'city' }], 'the client asked for the whole key back')
  assert.equal(client.warnings.length, 1)
  assert.match(client.warnings[0], /out of sync/)
  assert.equal(client.S.feed.at(-1).kind, 'sync', 'the gap is visible in the event feed, not swallowed')
  // The client does not act on a patch it could not apply: its copy is still
  // the stale one, and nothing was handed to the renderers from it.
  assert.equal(client.wire.city.ts, 1)
  assert.notDeepEqual(client.wire.city, JSON.parse(state.wire.city.whole))

  // …and the server's answer puts it back in step, once.
  state.resync('city', socket)
  assert.deepEqual(client.wire.city, JSON.parse(state.wire.city.whole))
  assert.deepEqual(client.sent, [{ type: 'state.resync', key: 'city' }], 'one request, not a storm')

  state.update('city', city(4))
  assert.deepEqual(client.wire.city, JSON.parse(state.wire.city.whole), 'patching resumes after the resync')
})

test('patching cuts what crosses the socket for a city that is barely moving', () => {
  const state = new State()
  let bytes = 0
  state.clients.add({ readyState: 1, send: text => { bytes += Buffer.byteLength(text) } })
  state.update('city', city(1))
  const first = bytes
  for (let tick = 2; tick <= 25; tick++) state.update('city', city(tick, tick % 5 === 0 ? tick : -1))
  const afterFirst = bytes - first
  assert.ok(afterFirst < first, `24 near-identical ticks (${afterFirst}B) must cost less than one full value (${first}B)`)
})
