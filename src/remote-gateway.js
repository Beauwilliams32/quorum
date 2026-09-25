import crypto from 'node:crypto'
import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

const MAX_BODY = 200_000
const SESSION_MS = 30 * 60_000
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 120

const READ_ROUTES = new Set([
  '/', '/health', '/api/state', '/api/city', '/api/operations', '/api/agents',
  '/api/workspaces', '/api/tasks', '/api/tools', '/api/mcp', '/api/platform',
  '/api/processes', '/api/standing-jobs', '/api/runtime-runs', '/api/missions',
  '/api/openclaw/status', '/api/openclaw/snapshot', '/api/openclaw/events', '/api/gateway/status', '/ws',
])

const WRITE_PREFIXES = [
  '/api/openclaw/actions/', '/api/openclaw/connect', '/api/process-actions/',
  '/api/runtime-runs/', '/api/missions/', '/api/agent-control/',
]

const STATIC_PREFIXES = ['/assets/', '/vendor/']
const READ_PREFIXES = ['/api/missions/', '/api/runtime-runs/', '/api/agent-control/', '/api/roundtable/', '/api/artifacts/', '/api/memory/', '/api/pipeline/']
/* The only client -> upstream messages a remote client may send.
 *
 * `state.resync` is here because the patch stream is now relayed verbatim, so a
 * remote client can see a version gap — and `state.resync` is the only way out
 * of one. It is strictly read-only: it returns the current value of a key the
 * client is already being sent, and `State#resync` validates the key against
 * the keys the store published and rate-limits the socket. Without it the
 * transport is asymmetric: a gapped remote client is told the gateway blocks
 * control messages and then sits on stale state for that key forever, because
 * public/app.js only clears `resyncPending` when an `update` for it arrives.
 *
 * Everything that spawns, kills, types into a PTY or steers a roundtable stays
 * blocked, and this list is the whole of what does not. */
export const REMOTE_WS_MESSAGES = new Set(['watch', 'unwatch', 'state.resync'])

function clean(value, max = 240) { return String(value || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max) }
function token() { return crypto.randomBytes(32).toString('base64url') }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function header(headers, name) {
  const key = Object.keys(headers || {}).find(item => item.toLowerCase() === name.toLowerCase())
  return key ? clean(headers[key], 320) : ''
}
function cookie(headers, name) {
  const source = header(headers, 'cookie')
  const match = source.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  if (!match) return ''
  try { return clean(decodeURIComponent(match[1]), 160) }
  // Keep malformed cookies nonempty so authorization rejects the supplied
  // session instead of treating it as a request for a fresh session.
  catch { return match[1] }
}

function routeClass(method, pathname) {
  if (pathname === '/ws') return method === 'GET' ? 'read' : 'deny'
  if (method === 'GET' && (READ_ROUTES.has(pathname) || READ_PREFIXES.some(prefix => pathname.startsWith(prefix)) || STATIC_PREFIXES.some(prefix => pathname.startsWith(prefix)) || pathname.endsWith('.html') || pathname.endsWith('.js') || pathname.endsWith('.css') || pathname.endsWith('.map'))) return 'read'
  if (method === 'POST' && WRITE_PREFIXES.some(prefix => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix))) return 'write'
  return 'deny'
}

export class RemoteSessionPolicy {
  constructor({ clock = () => Date.now(), sessionMs = SESSION_MS, rateLimit = RATE_LIMIT, operatorIdentities = process.env.QUORUM_REMOTE_OPERATOR_IDENTITIES || '' } = {}) {
    this.clock = clock; this.sessionMs = sessionMs; this.rateLimit = rateLimit
    this.operatorIdentities = new Set(operatorIdentities.split(',').map(item => clean(item)).filter(Boolean))
    this.sessions = new Map(); this.buckets = new Map()
  }

  authorize({ headers = {}, method = 'GET', pathname = '/', sessionToken = cookie(headers, 'quorum_remote_session') } = {}) {
    const identity = header(headers, 'tailscale-user-login') || header(headers, 'x-tailscale-user-login')
    if (!identity) return { ok: false, status: 401, error: 'authenticated Tailscale/VPN identity required' }
    const now = this.clock(); const key = digest(sessionToken || identity); const existing = this.sessions.get(key)
    let session = existing && existing.expiresAt > now && existing.identity === identity ? existing : null
    if (sessionToken && !session) return { ok: false, status: 401, error: 'remote session expired or invalid' }
    if (!session) {
      sessionToken = token()
      session = { identity, role: this.operatorIdentities.has(identity) ? 'operator' : 'viewer', issuedAt: now, expiresAt: now + this.sessionMs, tokenHash: digest(sessionToken) }
      this.sessions.set(session.tokenHash, session)
    }
    const bucket = this.buckets.get(session.tokenHash)
    if (!bucket || bucket.expiresAt <= now) this.buckets.set(session.tokenHash, { count: 1, expiresAt: now + RATE_WINDOW_MS })
    else if (++bucket.count > this.rateLimit) return { ok: false, status: 429, error: 'remote rate limit exceeded', retryAfterMs: bucket.expiresAt - now }
    const access = routeClass(method, pathname)
    if (access === 'deny') return { ok: false, status: 404, error: 'remote route is not exposed' }
    if (access === 'write' && session.role !== 'operator') return { ok: false, status: 403, error: 'operator role required for remote control' }
    return { ok: true, session, sessionToken, access }
  }

  reap() {
    const now = this.clock()
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key)
    for (const [key, bucket] of this.buckets) if (bucket.expiresAt <= now) this.buckets.delete(key)
  }

  snapshot() { return { schemaVersion: 1, sessions: [...this.sessions.values()].map(({ tokenHash, ...session }) => session), defaults: { role: 'viewer', sessionMs: this.sessionMs, rateLimitPerMinute: this.rateLimit } } }
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (Buffer.byteLength(body) > MAX_BODY) throw new Error('request body too large')
  }
  return body
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers })
  res.end(body)
}

export function createRemoteGateway({ upstream = 'http://127.0.0.1:4747', policy = new RemoteSessionPolicy(), fetchImpl = fetch } = {}) {
  const upstreamUrl = new URL(upstream)
  if (!['127.0.0.1', 'localhost', '::1'].includes(upstreamUrl.hostname)) throw new Error('remote gateway upstream must be loopback')
  const websocketUrl = `${upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${upstreamUrl.host}/ws`
  const sockets = new Set()
  const wsServer = new WebSocketServer({ noServer: true })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://remote-gateway')
    const auth = policy.authorize({ headers: req.headers, method: req.method, pathname: url.pathname })
    if (!auth.ok) return send(res, auth.status, JSON.stringify({ error: auth.error, retryAfterMs: auth.retryAfterMs }), { 'content-type': 'application/json', ...(auth.retryAfterMs ? { 'retry-after': String(Math.ceil(auth.retryAfterMs / 1000)) } : {}) })
    const headers = { 'content-type': req.headers['content-type'] || 'application/json' }
    if (auth.sessionToken && !cookie(req.headers, 'quorum_remote_session')) headers['set-cookie'] = `quorum_remote_session=${encodeURIComponent(auth.sessionToken)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(policy.sessionMs / 1000)}`
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined
      const upstreamResponse = await fetchImpl(new URL(`${url.pathname}${url.search}`, upstreamUrl), { method: req.method, headers: body === undefined ? {} : { 'content-type': req.headers['content-type'] || 'application/json' }, body, signal: AbortSignal.timeout(10_000) })
      headers['content-type'] = upstreamResponse.headers.get('content-type') || 'application/json'
      send(res, upstreamResponse.status, await upstreamResponse.text(), headers)
    } catch (error) { send(res, 502, JSON.stringify({ error: clean(error.message || error) }), { 'content-type': 'application/json', ...headers }) }
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://remote-gateway')
    const auth = policy.authorize({ headers: req.headers, method: 'GET', pathname: url.pathname })
    if (!auth.ok || auth.access !== 'read') { socket.write(`HTTP/1.1 ${auth.status || 403} Forbidden\r\nConnection: close\r\n\r\n`); socket.destroy(); return }
    wsServer.handleUpgrade(req, socket, head, client => wsServer.emit('connection', client, req, auth))
  })

  wsServer.on('connection', (client, _req, auth) => {
    const upstreamSocket = new WebSocket(websocketUrl)
    sockets.add(client); sockets.add(upstreamSocket)
    const close = () => { client.close?.(); upstreamSocket.close?.(); sockets.delete(client); sockets.delete(upstreamSocket) }
    client.on('message', raw => {
      try {
        const message = JSON.parse(String(raw))
        if (!REMOTE_WS_MESSAGES.has(message.type)) return client.send(JSON.stringify({ type: 'error', error: 'remote gateway blocks direct PTY and control messages; use preview/confirm routes' }))
        upstreamSocket.readyState === WebSocket.OPEN && upstreamSocket.send(JSON.stringify(message))
      } catch { client.send(JSON.stringify({ type: 'error', error: 'invalid websocket message' })) }
    })
    upstreamSocket.on('open', () => {})
    upstreamSocket.on('message', raw => { if (client.readyState === WebSocket.OPEN) client.send(raw) })
    client.on('close', close); client.on('error', close); upstreamSocket.on('close', close); upstreamSocket.on('error', close)
  })

  const reapTimer = setInterval(() => policy.reap(), 60_000); reapTimer.unref?.()
  const close = () => { clearInterval(reapTimer); for (const socket of sockets) socket.close?.(); server.close() }
  return { server, policy, close }
}
