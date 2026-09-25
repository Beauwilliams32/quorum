import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemoteGateway, REMOTE_WS_MESSAGES, RemoteSessionPolicy } from '../src/remote-gateway.js'

test('remote sessions are identity-bound, expiring, rate-limited, and read-only by default', () => {
  let now = 1000
  const policy = new RemoteSessionPolicy({ clock: () => now, sessionMs: 100, rateLimit: 2, operatorIdentities: 'operator@example.com' })
  const viewer = policy.authorize({ headers: { 'tailscale-user-login': 'viewer@example.com' }, method: 'GET', pathname: '/api/city' })
  assert.equal(viewer.ok, true)
  assert.equal(viewer.session.role, 'viewer')
  assert.equal(policy.authorize({ headers: { 'tailscale-user-login': 'viewer@example.com' }, method: 'POST', pathname: '/api/openclaw/actions/preview', sessionToken: viewer.sessionToken }).status, 403)
  assert.equal(policy.authorize({ headers: { 'tailscale-user-login': 'viewer@example.com' }, method: 'GET', pathname: '/api/city', sessionToken: viewer.sessionToken }).status, 429)
  assert.equal(policy.authorize({ headers: {}, method: 'GET', pathname: '/api/city' }).status, 401)
  assert.equal(policy.authorize({ headers: { 'tailscale-user-login': 'viewer@example.com' }, method: 'GET', pathname: '/api/city', sessionToken: 'replayed-token' }).status, 401)
  now += 101
  assert.equal(policy.authorize({ headers: { 'tailscale-user-login': 'viewer@example.com' }, method: 'GET', pathname: '/api/city', sessionToken: viewer.sessionToken }).status, 401)
})

test('remote gateway proxies bounded HTTP routes and never grants viewer writes', async () => {
  const seen = []
  const policy = new RemoteSessionPolicy({ operatorIdentities: 'operator@example.com' })
  const gateway = createRemoteGateway({
    upstream: 'http://127.0.0.1:4747',
    policy,
    fetchImpl: async (url, options) => { seen.push({ url: String(url), options }); return new Response(JSON.stringify({ ok: true }), { status: options.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } }) },
  })
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  const address = gateway.server.address()
  const base = `http://127.0.0.1:${address.port}`
  try {
    const malformed = await fetch(`${base}/api/city`, { headers: { 'tailscale-user-login': 'viewer@example.com', cookie: 'quorum_remote_session=%E0%A4%A' } })
    assert.equal(malformed.status, 401)
    assert.match((await malformed.json()).error, /session expired or invalid/)
    assert.equal(seen.length, 0)
    const read = await fetch(`${base}/api/city`, { headers: { 'tailscale-user-login': 'viewer@example.com' } })
    assert.equal(read.status, 200)
    assert.match(read.headers.get('set-cookie'), /quorum_remote_session=/)
    const denied = await fetch(`${base}/api/openclaw/actions/preview`, { method: 'POST', headers: { 'tailscale-user-login': 'viewer@example.com', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(denied.status, 403)
    const allowed = await fetch(`${base}/api/openclaw/actions/preview`, { method: 'POST', headers: { 'tailscale-user-login': 'operator@example.com', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(allowed.status, 201)
    assert.equal(seen.length, 2)
    assert.equal(seen[0].options.headers.authorization, undefined)
  } finally { gateway.close() }
})

test('the remote websocket allow-list covers recovery and nothing that acts', () => {
  // The gateway relays every upstream frame verbatim, so a remote client now
  // receives `patch` messages and can see a version gap. `state.resync` is the
  // only way out of one, and it is read-only — it returns the current value of
  // a key the client is already being sent. Without it the transport is
  // asymmetric and a gapped remote client wedges on stale state for that key,
  // because public/app.js only clears `resyncPending` on an `update` for it.
  assert.deepEqual([...REMOTE_WS_MESSAGES].sort(), ['state.resync', 'unwatch', 'watch'])
  // The non-negotiable: nothing that spawns, kills, types or steers.
  for (const blocked of ['pty.create', 'pty.input', 'pty.attach', 'pty.kill', 'proc.kill', 'chat.open', 'rt.start', 'rt.cancel', 'command.run']) {
    assert.equal(REMOTE_WS_MESSAGES.has(blocked), false, `${blocked} must never be remotely reachable`)
  }
})
