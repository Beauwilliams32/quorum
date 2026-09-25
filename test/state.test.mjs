import test from 'node:test'
import assert from 'node:assert/strict'
import { State } from '../src/state.js'

function fakeClient(readyState = 1) {
  const c = { readyState, sent: [] }
  c.send = s => c.sent.push(JSON.parse(s))
  return c
}

test('update stores the value and broadcasts it to open clients only', () => {
  const s = new State()
  const open = fakeClient(1), closed = fakeClient(3)
  s.clients.add(open); s.clients.add(closed)
  s.update('system', { latest: 1 })
  assert.deepEqual(s.data.system, { latest: 1 })
  assert.deepEqual(open.sent, [{ type: 'update', key: 'system', v: 1, data: { latest: 1 } }])
  assert.equal(closed.sent.length, 0)
})

test('update can broadcast a lighter payload than what it stores', () => {
  const s = new State()
  const c = fakeClient()
  s.clients.add(c)
  s.update('system', { latest: 2, hist: [1, 2, 3] }, { latest: 2 })
  assert.deepEqual(s.data.system.hist, [1, 2, 3])
  assert.deepEqual(c.sent[0].data, { latest: 2 })
})

test('event stamps a timestamp, keeps a 200-item ring and broadcasts', () => {
  const s = new State()
  const c = fakeClient()
  s.clients.add(c)
  for (let i = 0; i < 205; i++) s.event({ kind: 'spawn', text: `e${i}` })
  assert.equal(s.feed.length, 200)
  assert.equal(s.feed[0].text, 'e5')
  assert.equal(typeof s.feed[0].ts, 'number')
  assert.equal(c.sent.length, 205)
  assert.equal(c.sent[0].type, 'event')
})

test('snapshot carries data and feed in the shape the client expects', () => {
  const s = new State()
  s.data.x = 1
  assert.deepEqual(s.snapshot(), { type: 'snapshot', data: { x: 1 }, versions: {}, feed: [] })
})

/* ── broadcast diffing ────────────────────────────────────
 * The store used to serialise and send the whole value of a key on every
 * collector tick, whether or not anything in it had moved. These assert the
 * three cases that replaced that: unchanged sends nothing, a partial change
 * sends only the parts that moved, and a client that missed a patch can tell
 * and ask for the whole value back. */

test('an unchanged value is not sent again', () => {
  const s = new State()
  const c = fakeClient()
  s.clients.add(c)
  s.update('city', { buildings: [{ id: 'a', status: 'ok' }], ts: 1 })
  s.update('city', { buildings: [{ id: 'a', status: 'ok' }], ts: 1 })
  s.update('city', { buildings: [{ id: 'a', status: 'ok' }], ts: 1 })
  assert.equal(c.sent.length, 1, 'only the first value crossed the socket')
})

test('a partial change sends a patch naming the version it applies to', () => {
  const s = new State()
  const c = fakeClient()
  s.clients.add(c)
  const services = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, state: 'running' }))
  s.update('city', { services, ts: 1 })
  s.update('city', { services, ts: 2 })
  assert.equal(c.sent.length, 2)
  const patch = c.sent[1]
  assert.equal(patch.type, 'patch')
  assert.equal(patch.key, 'city')
  assert.equal(patch.from, 1)
  assert.equal(patch.v, 2)
  assert.deepEqual(patch.set, { ts: 2 })
  assert.equal(patch.rows, undefined, 'an untouched row array is not mentioned at all')
  assert.ok(JSON.stringify(patch).length < JSON.stringify(c.sent[0]).length / 4, 'the patch is a fraction of the full value')
})

test('one changed row in an array is sent on its own, not the whole array', () => {
  const s = new State()
  const c = fakeClient()
  s.clients.add(c)
  const rows = n => Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, state: i === n ? 'working' : 'idle' }))
  s.update('city', { workers: rows(-1), ts: 1 })
  s.update('city', { workers: rows(7), ts: 2 })
  const patch = c.sent[1]
  assert.equal(patch.type, 'patch')
  assert.deepEqual(patch.rows.workers.upsert, [{ id: 'w7', state: 'working' }])
  assert.deepEqual(patch.rows.workers.remove, [])
  assert.equal(patch.rows.workers.order, null, 'unchanged order is not resent')
})

test('a row that disappears is removed and a new order is sent when it changes', () => {
  const s = new State()
  const c = fakeClient()
  s.clients.add(c)
  const workers = Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, state: 'idle', label: `worker number ${i}` }))
  s.update('city', { workers })
  s.update('city', { workers: [workers[39], ...workers.slice(0, 39).filter(w => w.id !== 'w3')] })
  const patch = c.sent[1]
  assert.equal(patch.type, 'patch')
  assert.deepEqual(patch.rows.workers.remove, ['w3'])
  assert.deepEqual(patch.rows.workers.order, ['w39', ...workers.slice(0, 39).filter(w => w.id !== 'w3').map(w => w.id)])
  assert.deepEqual(patch.rows.workers.upsert, [], 'no row content changed, only the set and its order')
})

test('a first value, and a value that is not a plain object, is sent whole', () => {
  const s = new State()
  const c = fakeClient()
  s.clients.add(c)
  s.update('feedish', [1, 2, 3])
  s.update('feedish', [1, 2, 4])
  assert.equal(c.sent[0].type, 'update')
  assert.equal(c.sent[1].type, 'update')
  assert.deepEqual(c.sent[1].data, [1, 2, 4])
})

test('resync resends the whole value to one client and tells that client it happened', () => {
  const s = new State()
  const asking = fakeClient(), other = fakeClient()
  s.clients.add(asking); s.clients.add(other)
  s.update('city', { workers: [{ id: 'a' }], ts: 1 })
  s.update('city', { workers: [{ id: 'a' }], ts: 2 })
  asking.sent.length = 0; other.sent.length = 0

  assert.equal(s.resync('city', asking), true)
  const full = asking.sent.find(message => message.type === 'update')
  assert.deepEqual(full, { type: 'update', key: 'city', v: 2, data: { workers: [{ id: 'a' }], ts: 2 } })
  // A resync is never silent — the cockpit it happened to says so in its own
  // feed, so one that is quietly resyncing every few seconds is visible.
  const note = asking.sent.find(message => message.type === 'event' && message.item.kind === 'sync')
  assert.ok(note, 'the asking client is told its state was resent')
  assert.match(note.item.text, /city/)
  assert.ok(Number.isFinite(note.item.ts), 'the note is timestamped like every other feed item')
  // …but it is NOT everyone else's business, and it does not consume the
  // shared 200-entry ring that holds the real spawn/exit/kill history.
  assert.deepEqual(other.sent, [], 'a second cockpit hears nothing about another client falling behind')
  assert.ok(!s.feed.some(item => item.kind === 'sync'), 'the shared ring is untouched')
  assert.equal(s.resync('nothing-here', asking), false)
})

test('one client cannot flood resync and erase every cockpit history', () => {
  // Reproduced before the fix: 300 `state.resync` requests from one socket
  // returned 300 full `city` payloads and broadcast 300 `sync` events, which
  // flushed the 200-entry ring and wiped the real history for every open
  // cockpit. The feed is the exact surface this transport nominates as the
  // thing that keeps resyncs honest, so it must not be the thing a resync
  // destroys.
  const s = new State()
  const flooder = fakeClient(), other = fakeClient()
  s.clients.add(flooder); s.clients.add(other)
  s.update('city', { workers: [{ id: 'a' }], ts: 1 })
  for (let i = 0; i < 40; i++) s.event({ kind: i % 2 ? 'spawn' : 'kill', text: `pid ${1000 + i}` })
  const history = s.feed.map(item => item.text)
  flooder.sent.length = 0; other.sent.length = 0

  let answered = 0
  for (let i = 0; i < 300; i++) if (s.resync('city', flooder)) answered += 1

  assert.ok(answered > 0 && answered <= 32, `the burst was bounded, not unbounded (${answered} answered)`)
  assert.equal(s.resyncs, answered)
  assert.equal(s.resyncsRefused, 300 - answered, 'and what was refused is counted, not hidden')
  assert.deepEqual(other.sent, [], 'the innocent cockpit received nothing at all')
  assert.deepEqual(s.feed.map(item => item.text), history, 'every real event survived the burst')

  // A second socket has its own budget: one client in a loop must not lock a
  // healthy one out of recovering.
  const healthy = fakeClient()
  s.clients.add(healthy)
  assert.equal(s.resync('city', healthy), true)
})

test('a resync budget refills once its window has passed', () => {
  const s = new State()
  const c = fakeClient()
  s.clients.add(c)
  s.update('city', { ts: 1 })
  const start = Date.now()
  let answered = 0
  for (let i = 0; i < 200; i++) if (s.resyncAllowed(c, start)) answered += 1
  assert.ok(answered > 0 && answered < 200, `bounded inside one window (${answered})`)
  // Ten seconds later the same socket is served again: this is a rate limit,
  // not a ban, and a long-lived cockpit must keep being able to recover.
  assert.equal(s.resyncAllowed(c, start + 10_000), true)
})

test('resync answers only for keys the store has published, never a prototype member', () => {
  // `key` arrives straight off the wire and `wire`/`versions` are plain
  // objects, so `constructor` and friends used to resolve truthy, walk past the
  // `if (!entry)` guard, and be concatenated into a frame that is not valid
  // JSON — `{"v":function Object() { [native code] },"data":undefined}` — which
  // throws in the client's JSON.parse and takes ws.onmessage down with it.
  const s = new State()
  const raw = { readyState: 1, sent: [] }
  raw.send = text => raw.sent.push(text)
  s.clients.add(raw)
  s.update('city', { workers: [{ id: 'a' }], ts: 1 })
  raw.sent.length = 0

  for (const key of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'prototype', '']) {
    assert.equal(s.resync(key, raw), false, `"${key}" is not a key this store published`)
  }
  for (const key of [null, undefined, 42, {}, ['city']]) {
    assert.equal(s.resync(key, raw), false, `a non-string key is refused (${String(key)})`)
  }
  assert.deepEqual(raw.sent, [], 'nothing was sent at all, so nothing malformed could be')

  // Everything the store really published still resyncs, and every frame it
  // sends parses.
  assert.equal(s.resync('city', raw), true)
  assert.ok(raw.sent.length > 0)
  for (const text of raw.sent) JSON.parse(text)
  const full = JSON.parse(raw.sent.find(text => text.startsWith('{"type":"update"')))
  assert.deepEqual(full, { type: 'update', key: 'city', v: 1, data: { workers: [{ id: 'a' }], ts: 1 } })
})

test('the snapshot carries versions and the lighter payload patches apply to', () => {
  const s = new State()
  s.update('processes', { procs: [], inventory: [{ pid: 1 }] }, { procs: [] })
  s.update('sessions', { cards: [] })
  const snap = s.snapshot()
  assert.deepEqual(snap.versions, { processes: 1, sessions: 1 })
  assert.deepEqual(snap.data.processes.inventory, [{ pid: 1 }], 'the server keeps the heavy value')
  assert.deepEqual(snap.wire, { processes: { procs: [] } }, 'the browser is told what patches apply to')
  assert.equal(snap.wire.sessions, undefined, 'keys with nothing lighter to send are not duplicated')

  const parsed = JSON.parse(s.snapshotMessage())
  assert.deepEqual(parsed, { type: 'snapshot', ...snap, feed: [] })
})
