import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { OpenClawBridge, credentialReferenceStatus, normalizeGatewayFrame } from '../src/openclaw-bridge.js'

test('credential references report configuration without exposing values', () => {
  const status = credentialReferenceStatus({
    QUORUM_OPENCLAW_TOKEN_ENV: 'OPENCLAW_TOKEN',
    OPENCLAW_TOKEN: 'super-secret-token',
  })
  assert.deepEqual(status.token, { configured: true, reference: 'OPENCLAW_TOKEN' })
  assert.equal(JSON.stringify(status).includes('super-secret-token'), false)
})

test('gateway frames are bounded and redact secret-bearing fields', () => {
  const frame = normalizeGatewayFrame({
    type: 'event',
    event: 'sessions.updated',
    seq: 7,
    payload: { token: 'secret', name: 'active session' },
  })
  assert.equal(frame.kind, 'event')
  assert.equal(frame.seq, 7)
  assert.equal(frame.payload.token, '[redacted-secret]')
  assert.equal(frame.payload.name, 'active session')
})

test('bridge refuses public internet endpoints', () => {
  assert.throws(() => new OpenClawBridge({ url: 'wss://example.com/gateway' }), /loopback or a Tailnet/)
})

test('mutating gateway actions require one expiring confirmation', async () => {
  let now = 1000
  const bridge = new OpenClawBridge({ clock: () => now })
  bridge.request = async (method, params) => ({ method, params, token: 'must-redact' })
  const preview = bridge.previewAction({ method: 'gateway.restart', reason: 'operator QA' })
  assert.equal(preview.requiresConfirmation, true)
  assert.equal(preview.risk, 'high')
  const result = await bridge.confirmAction(preview.id)
  assert.equal(result.status, 'executed')
  assert.equal(result.result.token, '[redacted-secret]')
  await assert.rejects(() => bridge.confirmAction(preview.id), /unknown or consumed/)

  const expired = bridge.previewAction({ method: 'chat.send' })
  now = expired.expiresAt + 1
  await assert.rejects(() => bridge.confirmAction(expired.id), /expired/)
})

test('authenticated bridge uses one server-side socket and redacts its public projection', async () => {
  const sent = []
  class FakeSocket extends EventEmitter {
    send(frame) { sent.push(JSON.parse(frame)) }
    close() { this.emit('close') }
  }
  const env = { QUORUM_OPENCLAW_TOKEN_ENV: 'OPENCLAW_TOKEN', OPENCLAW_TOKEN: 'gateway-secret' }
  const bridge = new OpenClawBridge({ env, fetchImpl: async () => ({ ok: true }), WebSocketImpl: FakeSocket })
  await bridge.start()
  const socket = bridge.socket
  assert.ok(socket)
  socket.emit('open')
  const connect = sent.find(frame => frame.id === 'quorum-connect')
  assert.equal(connect.type, 'req')
  assert.equal(connect.method, 'connect')
  assert.equal(connect.params.auth.token, 'gateway-secret')

  socket.emit('message', JSON.stringify({ type: 'res', id: 'quorum-connect', ok: true, payload: { protocol: 4 } }))
  assert.equal(bridge.status().connectionState, 'connected')
  socket.emit('message', JSON.stringify({ type: 'event', event: 'sessions.updated', seq: 2, payload: { sessions: [{ id: 's1', title: 'build' }], token: 'gateway-secret' } }))
  assert.equal(bridge.snapshot().projection.sessions[0].id, 's1')
  assert.equal(JSON.stringify(bridge.snapshot()).includes('gateway-secret'), false)

  const preview = bridge.previewAction({ method: 'chat.send', params: { message: 'ship it', password: 'gateway-secret' } })
  assert.equal(preview.params.password, '[redacted-secret]')
  const sentBeforeConfirm = sent.length
  const confirmed = bridge.confirmAction(preview.id)
  const actionRequest = await new Promise(resolve => {
    const timer = setInterval(() => {
      const frame = sent.slice(sentBeforeConfirm).find(item => item.method === 'chat.send')
      if (frame) { clearInterval(timer); resolve(frame) }
    }, 1)
  })
  socket.emit('message', JSON.stringify({ type: 'res', id: actionRequest.id, ok: true, payload: { accepted: true } }))
  assert.equal((await confirmed).status, 'executed')
  assert.equal(JSON.stringify(bridge.snapshot()).includes('gateway-secret'), false)
  bridge.disconnect()
})
