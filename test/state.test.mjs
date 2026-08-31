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
  assert.deepEqual(open.sent, [{ type: 'update', key: 'system', data: { latest: 1 } }])
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
  assert.deepEqual(s.snapshot(), { type: 'snapshot', data: { x: 1 }, feed: [] })
})
