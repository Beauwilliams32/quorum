import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { QuorumGateway } from '../src/quorum-gateway.js'
import { State } from '../src/state.js'

class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; this.closed = false }
  send(value) { this.sent.push(JSON.parse(value)) }
  close() { this.closed = true; this.readyState = 3; this.emit('close') }
}

function request(ws, frame) { ws.emit('message', JSON.stringify(frame)); return ws.sent.at(-1) }

test('Quorum Gateway emits the v4 challenge, authenticates, bounds reads, and streams state events', () => {
  const state = new State()
  state.update('sessions', { cards: [{ id: 'session-1', title: 'Builder', active: true }] })
  const gateway = new QuorumGateway({
    state,
    env: { QUORUM_GATEWAY_TOKEN_ENV: 'QUORUM_TEST_TOKEN', QUORUM_TEST_TOKEN: 'local-secret' },
    openclawActions: { preview: input => input, confirm: async previewId => ({ previewId }), cancel: previewId => ({ previewId }) },
  })
  const ws = new FakeSocket()
  try {
    assert.equal(gateway.attach(ws, { headers: {} }), true)
    assert.equal(ws.sent[0].event, 'connect.challenge')
    assert.equal(typeof ws.sent[0].payload.nonce, 'string')

    const hello = request(ws, { type: 'req', id: 'connect', method: 'connect', params: { minProtocol: 4, maxProtocol: 4, role: 'operator', auth: { token: 'local-secret' } } })
    assert.equal(hello.ok, true)
    assert.equal(hello.payload.type, 'hello-ok')
    assert.equal(JSON.stringify(hello).includes('local-secret'), false)

    const sessions = request(ws, { type: 'req', id: 'list', method: 'sessions.list', params: {} })
    assert.deepEqual(sessions.payload.sessions, [{ id: 'session-1', title: 'Builder', agent: '', model: '', projectId: '', active: true, updatedAt: null }])

    const missingApproval = request(ws, { type: 'req', id: 'confirm', method: 'quorum.action.confirm', params: { previewId: 'preview-1' } })
    assert.equal(missingApproval.error.code, 'INVALID_REQUEST')

    state.event({ kind: 'test', text: 'bounded event' })
    assert.equal(ws.sent.at(-1).event, 'quorum.event')
    assert.equal(ws.sent.at(-1).payload.text, 'bounded event')
  } finally { gateway.close() }
})

test('Quorum Gateway rejects pre-auth requests and keeps credential references secret-free', () => {
  const gateway = new QuorumGateway({ env: { QUORUM_GATEWAY_PASSWORD_ENV: 'QUORUM_TEST_PASSWORD', QUORUM_TEST_PASSWORD: 'pass-secret' } })
  const ws = new FakeSocket()
  try {
    gateway.attach(ws, { headers: {} })
    const denied = request(ws, { type: 'req', id: 'read-before-connect', method: 'sessions.list', params: {} })
    assert.equal(denied.error.code, 'AUTH_REQUIRED')
    assert.equal(JSON.stringify(gateway.status()).includes('pass-secret'), false)
    assert.equal(gateway.status().credentials.password.reference, 'QUORUM_TEST_PASSWORD')
  } finally { gateway.close() }
})
