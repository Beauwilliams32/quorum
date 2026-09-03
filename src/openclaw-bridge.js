import crypto from 'node:crypto'
import { WebSocket as NodeWebSocket } from 'ws'

const PROTOCOL_VERSION = 4
const MAX_FRAME_BYTES = 64 * 1024
const MAX_TEXT = 300
const MAX_LIST = 100
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

const READ_METHODS = new Set([
  'sessions.list', 'sessions.history', 'cron.list', 'channels.status', 'nodes.list',
  'skills.list', 'config.get', 'system.info', 'usage.status',
])

const WRITE_METHODS = new Set([
  'agent', 'chat.send', 'sessions.patch', 'sessions.delete', 'cron.add', 'cron.remove',
  'channels.login', 'channels.logout', 'nodes.approve', 'nodes.reject', 'skills.install',
  'skills.update', 'config.patch', 'gateway.restart',
])

function text(value, max = MAX_TEXT) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function id(prefix) { return `${prefix}-${crypto.randomBytes(12).toString('hex')}` }

function isLoopbackOrTailnet(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:'
      ? /^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(parsed.hostname) || parsed.hostname.endsWith('.ts.net')
      : false
  } catch { return false }
}

function publicParams(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return depth > 3 ? '[bounded]' : value
  if (typeof value === 'string') return /token|password|secret|credential|authorization|cookie|private.?key/i.test(value) ? '[redacted-secret]' : text(value, 500)
  if (Array.isArray(value)) return value.slice(0, 20).map(item => publicParams(item, depth + 1))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, /token|password|secret|credential|authorization|cookie|private.?key/i.test(key) ? '[redacted-secret]' : publicParams(item, depth + 1)]))
  return typeof value === 'number' || typeof value === 'boolean' ? value : text(value)
}

function boundedParams(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return depth > 3 ? '[bounded]' : value
  if (typeof value === 'string') return value.slice(0, 2000)
  if (Array.isArray(value)) return value.slice(0, 20).map(item => boundedParams(item, depth + 1))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [text(key, 80), boundedParams(item, depth + 1)]))
  return typeof value === 'number' || typeof value === 'boolean' ? value : text(value)
}

function errorCode(error) {
  const raw = text(error?.code || error?.message || error, 120).toLowerCase()
  if (/auth|unauthor|forbidden|credential|token|password/.test(raw)) return 'auth-required'
  if (/protocol|version|frame|payload/.test(raw)) return 'protocol-error'
  return 'gateway-error'
}

export function credentialReferenceStatus(env = process.env) {
  const refs = {}
  for (const [key, label] of [['QUORUM_OPENCLAW_TOKEN_ENV', 'token'], ['QUORUM_OPENCLAW_PASSWORD_ENV', 'password']]) {
    const ref = typeof env[key] === 'string' ? env[key].trim() : ''
    refs[label] = { configured: Boolean(ref && ENV_NAME.test(ref) && typeof env[ref] === 'string' && env[ref].length > 0), reference: ref && ENV_NAME.test(ref) ? ref : null }
  }
  return { source: 'environment-reference', token: refs.token, password: refs.password }
}

function credentialValues(env) {
  const status = credentialReferenceStatus(env)
  const value = kind => {
    const ref = status[kind].reference
    return status[kind].configured ? String(env[ref]) : ''
  }
  return { token: value('token'), password: value('password') }
}

export function normalizeGatewayFrame(frame) {
  if (!frame || typeof frame !== 'object') return { kind: 'invalid', summary: 'invalid gateway frame' }
  if (frame.type === 'event') return { kind: 'event', event: text(frame.event, 80), seq: Number.isFinite(frame.seq) ? frame.seq : null, payload: publicParams(frame.payload), summary: text(`${frame.event || 'gateway'} event`) }
  if (frame.type === 'res') return { kind: 'response', id: text(frame.id, 80), ok: frame.ok === true, error: frame.ok === true ? null : errorCode(frame.error), summary: frame.ok === true ? 'gateway response accepted' : `gateway response ${errorCode(frame.error)}` }
  return { kind: text(frame.type || 'unknown', 40), summary: 'gateway frame received' }
}

export class OpenClawBridge {
  constructor({ env = process.env, url = env.QUORUM_OPENCLAW_URL || 'ws://127.0.0.1:18789', fetchImpl = fetch, WebSocketImpl = NodeWebSocket, clock = () => Date.now(), onUpdate = () => {}, onEvent = () => {} } = {}) {
    if (!isLoopbackOrTailnet(url)) throw new Error('OpenClaw URL must be loopback or a Tailnet host')
    this.env = env; this.url = url; this.fetchImpl = fetchImpl; this.WebSocketImpl = WebSocketImpl; this.clock = clock; this.onUpdate = onUpdate; this.onEvent = onEvent
    this.socket = null; this.pending = new Map(); this.preview = new Map(); this.previewParams = new Map(); this.reconnectTimer = null; this.connectSent = false; this.started = false; this.backoffMs = 1000
    this.state = { schemaVersion: 1, connectionState: 'offline', authState: 'unknown', url: this.url, port: Number(new URL(url).port || 18789), protocolVersion: null, lastHandshakeAt: null, lastEventAt: null, lastError: null, reconnectAttempt: 0, credentials: credentialReferenceStatus(env), projection: { sessions: [], runs: [], cronJobs: [], channels: [], nodes: [], skills: [], config: null, events: [] }, audit: [] }
  }

  snapshot() { return structuredClone(this.state) }
  status() { const current = this.snapshot(); delete current.projection; delete current.audit; return current }

  async start() { this.started = true; await this.probe(); if (this.state.credentials.token.configured || this.state.credentials.password.configured) this.connect(); return this.snapshot() }

  async probe() {
    const httpUrl = this.url.replace(/^ws/, 'http')
    try {
      const response = await this.fetchImpl(httpUrl, { signal: AbortSignal.timeout(1800) })
      if (response.ok) {
        this.patch({ connectionState: (this.state.connectionState === 'connected' ? 'connected' : 'auth-required'), authState: this.state.connectionState === 'connected' ? 'accepted' : 'required', lastError: null })
        return true
      }
    } catch { /* the WebSocket path reports the actionable error */ }
    this.patch({ connectionState: 'offline', authState: 'unknown', lastError: 'gateway not reachable' })
    return false
  }

  connect() {
    if (!this.started || this.socket || this.state.connectionState === 'connected') return
    this.patch({ connectionState: 'connecting', authState: this.state.credentials.token.configured || this.state.credentials.password.configured ? 'configured' : 'required', lastError: null, reconnectAttempt: this.state.reconnectAttempt + 1 })
    const socket = new this.WebSocketImpl(this.url)
    this.socket = socket; this.connectSent = false
    socket.on('open', () => { this.sendConnect() })
    socket.on('message', data => this.receive(data))
    socket.on('error', error => { this.patch({ connectionState: errorCode(error), lastError: errorCode(error) }) })
    socket.on('close', () => { this.socket = null; for (const [, pending] of this.pending) pending.reject(new Error('OpenClaw gateway disconnected')); this.pending.clear(); if (this.state.connectionState === 'connected') this.patch({ connectionState: 'degraded', lastError: 'gateway disconnected' }); if (this.started && this.state.connectionState !== 'auth-required') this.scheduleReconnect() })
  }

  disconnect() { this.started = false; clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this.socket?.close?.(); this.socket = null; this.patch({ connectionState: 'offline', authState: 'unknown' }) }

  sendConnect() {
    if (this.connectSent || !this.socket) return
    this.connectSent = true
    const credentials = credentialValues(this.env)
    this.socket.send(JSON.stringify({ type: 'req', id: 'quorum-connect', method: 'connect', params: { minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION, client: { id: 'quorum', version: '0.1.0', platform: process.platform, mode: 'operator' }, role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.approvals'], caps: [], commands: [], permissions: {}, auth: credentials.token ? { token: credentials.token } : credentials.password ? { password: credentials.password } : {} } }))
  }

  receive(raw) {
    const bytes = Buffer.byteLength(raw)
    if (bytes > MAX_FRAME_BYTES) { this.patch({ connectionState: 'protocol-error', lastError: 'gateway frame exceeded 64 KiB' }); this.socket?.close?.(); return }
    let frame
    try { frame = JSON.parse(String(raw)) } catch { this.patch({ connectionState: 'protocol-error', lastError: 'gateway frame was not JSON' }); return }
    const normalized = normalizeGatewayFrame(frame)
    if (frame.type === 'event') {
      if (frame.event === 'connect.challenge') this.sendConnect()
      this.state.lastEventAt = this.clock(); this.ingestEvent(frame.event, frame.payload, frame.seq); this.onEvent(normalized)
      return
    }
    if (frame.type === 'res') {
      if (frame.id === 'quorum-connect') {
        if (frame.ok) { this.backoffMs = 1000; this.patch({ connectionState: 'connected', authState: 'accepted', protocolVersion: frame.payload?.protocol || PROTOCOL_VERSION, lastHandshakeAt: this.clock(), lastError: null }); this.requestSnapshot() }
        else { this.patch({ connectionState: errorCode(frame.error), authState: 'required', lastError: errorCode(frame.error) }); this.socket?.close?.() }
        return
      }
      const pending = this.pending.get(String(frame.id)); if (!pending) return
      this.pending.delete(String(frame.id)); frame.ok ? pending.resolve(publicParams(frame.payload)) : pending.reject(new Error(errorCode(frame.error)))
    }
  }

  ingestEvent(event, payload, seq = null) {
    const name = text(event, 80)
    const projection = this.state.projection
    const data = publicParams(payload)
    if (/session/i.test(name)) projection.sessions = Array.isArray(data) ? data.slice(0, MAX_LIST) : Array.isArray(data?.sessions) ? data.sessions.slice(0, MAX_LIST) : projection.sessions
    if (/agent|run/i.test(name)) projection.runs = Array.isArray(data) ? data.slice(0, MAX_LIST) : Array.isArray(data?.runs) ? data.runs.slice(0, MAX_LIST) : projection.runs
    if (/cron/i.test(name)) projection.cronJobs = Array.isArray(data) ? data.slice(0, MAX_LIST) : Array.isArray(data?.jobs) ? data.jobs.slice(0, MAX_LIST) : projection.cronJobs
    if (/channel/i.test(name)) projection.channels = Array.isArray(data) ? data.slice(0, MAX_LIST) : Array.isArray(data?.channels) ? data.channels.slice(0, MAX_LIST) : projection.channels
    if (/node/i.test(name)) projection.nodes = Array.isArray(data) ? data.slice(0, MAX_LIST) : Array.isArray(data?.nodes) ? data.nodes.slice(0, MAX_LIST) : projection.nodes
    if (/skill/i.test(name)) projection.skills = Array.isArray(data) ? data.slice(0, MAX_LIST) : Array.isArray(data?.skills) ? data.skills.slice(0, MAX_LIST) : projection.skills
    projection.events = [...projection.events, { event: name, seq, ts: this.clock(), payload: data }].slice(-50)
    this.patch({ projection })
  }

  requestSnapshot() { for (const method of ['sessions.list', 'cron.list', 'channels.status', 'nodes.list', 'skills.list']) this.request(method, {}).catch(() => {}) }

  request(method, params = {}) {
    if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) return Promise.reject(new Error('OpenClaw method is not allowlisted'))
    if (!this.socket || this.state.connectionState !== 'connected') return Promise.reject(new Error(`OpenClaw is ${this.state.connectionState}`))
    const requestId = id('rpc')
    return new Promise((resolve, reject) => { this.pending.set(requestId, { resolve, reject }); this.socket.send(JSON.stringify({ type: 'req', id: requestId, method, params: boundedParams(params) })) })
  }

  previewAction(input = {}) {
    const method = text(input.method, 80)
    if (!WRITE_METHODS.has(method)) throw new Error('OpenClaw action is not an approved mutating method')
    const record = { schemaVersion: 1, id: id('oc-preview'), method, params: publicParams(input.params || {}), actor: text(input.actor || 'operator', 80), reason: text(input.reason || 'operator request', 240), risk: method === 'gateway.restart' || method === 'config.patch' ? 'high' : 'medium', status: 'pending-confirmation', requiresConfirmation: true, createdAt: this.clock(), expiresAt: this.clock() + 60_000 }
    this.preview.set(record.id, record); this.previewParams.set(record.id, boundedParams(input.params || {})); this.audit(record, 'previewed'); return structuredClone(record)
  }

  async confirmAction(previewId) {
    const record = this.preview.get(String(previewId))
    if (!record || record.status !== 'pending-confirmation') throw new Error('unknown or consumed OpenClaw preview')
    if (record.expiresAt < this.clock()) { record.status = 'expired'; this.audit(record, 'expired'); this.preview.delete(record.id); this.previewParams.delete(record.id); throw new Error('OpenClaw preview expired') }
    record.status = 'confirmed'; this.preview.delete(record.id); const params = this.previewParams.get(record.id) || record.params; this.previewParams.delete(record.id); this.audit(record, 'confirmed')
    try { const result = await this.request(record.method, params); record.status = 'executed'; record.result = publicParams(result); this.audit(record, 'executed'); return structuredClone(record) }
    catch (error) { record.status = 'failed'; record.error = errorCode(error); this.audit(record, 'failed'); throw error }
  }

  audit(record, outcome) { this.state.audit = [...this.state.audit, { schemaVersion: 1, id: record.id, method: record.method, risk: record.risk, outcome, actor: record.actor, reason: record.reason, ts: this.clock() }].slice(-100); this.patch({ audit: this.state.audit }) }
  scheduleReconnect() { clearTimeout(this.reconnectTimer); const wait = Math.min(30_000, this.backoffMs); this.backoffMs = Math.min(30_000, this.backoffMs * 2); this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect() }, wait) }
  patch(value) { Object.assign(this.state, value); this.onUpdate(this.snapshot()) }
}
