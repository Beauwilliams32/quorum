// PtyManager drives node-pty. Spawn a real login shell in a scratch cwd, prove
// data flows to attached sockets, that CLAUDE* env never leaks into the child,
// and that kill() removes the record and broadcasts the list.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PtyManager } from '../src/pty.js'

function fakeState() {
  const s = { events: [], broadcasts: [] }
  s.event = e => s.events.push(e)
  s.broadcast = m => s.broadcasts.push(m)
  return s
}

function fakeWs() {
  const ws = { readyState: 1, msgs: [] }
  ws.send = s => ws.msgs.push(JSON.parse(s))
  return ws
}

const waitFor = (pred, ms = 8000) => new Promise((resolve, reject) => {
  const t0 = Date.now()
  const tick = () => pred() ? resolve() : Date.now() - t0 > ms ? reject(new Error('timeout')) : setTimeout(tick, 50)
  tick()
})

test('PtyManager spawns a shell, streams output to attached sockets, strips CLAUDE* env, and kills cleanly', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-pty-'))
  const state = fakeState()
  const mgr = new PtyManager(state)
  const ws = fakeWs()

  process.env.CLAUDE_TEST_LEAK = 'should-not-appear'
  const rec = mgr.create('shell', cwd, 80, 24)
  delete process.env.CLAUDE_TEST_LEAK

  assert.match(rec.id, /^t\d+$/)
  assert.equal(rec.cwd, cwd)
  assert.deepEqual(mgr.list(), [{ id: rec.id, profile: 'shell', cwd, exited: false }])
  assert.equal(state.events[0].kind, 'spawn')
  assert.equal(state.broadcasts.at(-1).type, 'pty.list')

  mgr.attach(rec.id, ws)
  assert.equal(ws.msgs[0].type, 'pty.attach')
  assert.equal(ws.msgs[0].id, rec.id)

  mgr.input(rec.id, 'printf "MARK:%s:%s\\n" "$PWD" "${CLAUDE_TEST_LEAK:-unset}"\r')
  await waitFor(() => rec.buf.includes('MARK:'))
  await waitFor(() => /MARK:[^\r\n]*:(unset|should-not-appear)/.test(rec.buf))
  const m = rec.buf.match(/MARK:([^:\r\n]*):(unset|should-not-appear)/)
  assert.ok(m, rec.buf)
  assert.equal(fs.realpathSync(m[1]), fs.realpathSync(cwd), 'shell starts in the requested cwd')
  assert.equal(m[2], 'unset', 'CLAUDE* variables must not reach the spawned shell')
  assert.ok(ws.msgs.some(x => x.type === 'pty.data' && x.id === rec.id), 'attached socket received pty.data')

  // resize on a live pty does not throw; attach to an unknown id is a no-op
  mgr.resize(rec.id, 100, 40)
  mgr.resize(rec.id, 0, 40)
  mgr.attach('nope', ws)

  mgr.detachAll(ws)
  const before = ws.msgs.length
  mgr.input(rec.id, 'echo after-detach\r')
  await waitFor(() => rec.buf.includes('after-detach'))
  assert.equal(ws.msgs.length, before, 'detached sockets receive nothing')

  mgr.kill(rec.id)
  assert.deepEqual(mgr.list(), [])
  assert.equal(state.broadcasts.at(-1).type, 'pty.list')
  assert.deepEqual(state.broadcasts.at(-1).ptys, [])
  await waitFor(() => state.broadcasts.some(b => b.type === 'pty.exit' && b.id === rec.id))
  assert.equal(rec.exited, true)
  assert.ok(state.events.some(e => e.kind === 'exit' && e.text.includes(rec.id)))
  mgr.kill(rec.id) // idempotent
})

test('PtyManager falls back to `true` for an unknown profile so the pty exits promptly', async () => {
  const state = fakeState()
  const mgr = new PtyManager(state)
  const rec = mgr.create('no-such-runtime-xyz', os.tmpdir())
  await waitFor(() => rec.exited)
  assert.equal(mgr.list()[0].exited, true)
  mgr.kill(rec.id)
})
