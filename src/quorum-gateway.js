import crypto from 'node:crypto'

const PROTOCOL_VERSION = 4
const MAX_FRAME_BYTES = 64 * 1024
const MAX_ITEMS = 100
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const READ_METHODS = new Set(['sessions.list', 'sessions.history', 'cron.list', 'channels.status', 'nodes.list', 'skills.list', 'config.get', 'system.info', 'usage.status', 'quorum.status'])
const ACTION_METHODS = new Set(['quorum.action.preview', 'quorum.action.confirm', 'quorum.action.cancel'])

function clean(value, max = 300) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) }
function id(prefix) { return `${prefix}-${crypto.randomBytes(12).toString('hex')}` }
function bounded(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return depth > 3 ? '[bounded]' : value
  if (typeof value === 'string') return clean(value, 500)
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(item => bounded(item, depth + 1))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [clean(key, 80), bounded(item, depth + 1)]))
  return typeof value === 'number' || typeof value === 'boolean' ? value : clean(value)
}

function credentialStatus(env) {
  const read = (refKey, valueKey) => {
    const reference = typeof env[refKey] === 'string' ? env[refKey].trim() : ''
    return { configured: Boolean(reference && ENV_NAME.test(reference) && typeof env[reference] === 'string' && env[reference].length > 0), reference: reference && ENV_NAME.test(reference) ? reference : null, value: valueKey ? String(env[reference] || '') : '' }
  }
  return { source: 'environment-reference', token: read('QUORUM_GATEWAY_TOKEN_ENV', true), password: read('QUORUM_GATEWAY_PASSWORD_ENV', true) }
}

function publicCredentials(status) { return { source: status.source, token: { configured: status.token.configured, reference: status.token.reference }, password: { configured: status.password.configured, reference: status.password.reference } } }

function errorFrame(idValue, code, message, details = null) { return { type: 'res', id: idValue, ok: false, error: { code, message: clean(message, 180), ...(details ? { details: bounded(details) } : {}) } } }

function sessionProjection(state) { return (state.data.sessions?.cards || []).slice(0, MAX_ITEMS).map(item => ({ id: clean(item.id, 100), title: clean(item.title || item.summary || item.agent || 'session'), agent: clean(item.agent), model: clean(item.model), projectId: clean(item.projectId), active: item.active === true, updatedAt: item.mtimeMs || null })) }
function runProjection(state) { return (state.data.runtimeRuns?.runs || []).slice(0, MAX_ITEMS).map(item => ({ id: clean(item.id || item.runId, 100), status: clean(item.status), phase: clean(item.phase), runtime: clean(item.runtime), heartbeatAt: item.heartbeatAt || null })) }

export class QuorumGateway {
  constructor({ state, env = process.env, originAllowed = () => true, openclawActions = null } = {}) {
    this.state = state; this.env = env; this.originAllowed = originAllowed; this.credentials = credentialStatus(env); this.openclawActions = openclawActions; this.clients = new Set(); this.unsubscribe = state?.subscribe?.(message => this.publishState(message)) || null; this.tick = setInterval(() => this.broadcast({ type: 'event', event: 'tick', payload: { ts: Date.now() } }), 15_000); this.tick.unref?.()
  }

  attach(ws, request = {}) {
    if (!this.originAllowed(request.headers?.origin || '')) { ws.close?.(1008, 'origin not allowed'); return false }
    const client = { ws, authenticated: false, connId: id('conn'), challenge: crypto.randomBytes(18).toString('base64url') }
    this.clients.add(client)
    ws.on('message', raw => this.receive(client, raw))
    ws.on('close', () => this.clients.delete(client))
    ws.on('error', () => this.clients.delete(client))
    this.send(client, { type: 'event', event: 'connect.challenge', payload: { nonce: client.challenge, ts: Date.now() } })
    return true
  }

  close() { clearInterval(this.tick); this.unsubscribe?.(); for (const client of this.clients) client.ws.close?.(); this.clients.clear() }

  receive(client, raw) {
    if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) return this.reject(client, null, 'PAYLOAD_TOO_LARGE', 'gateway frame exceeded 64 KiB', true)
    let frame
    try { frame = JSON.parse(String(raw)) } catch { return this.reject(client, null, 'INVALID_FRAME', 'gateway frame was not JSON', false) }
    if (!frame || frame.type !== 'req' || !frame.id || !frame.method) return this.reject(client, frame?.id, 'INVALID_FRAME', 'expected a request frame', false)
    if (!client.authenticated) return this.connect(client, frame)
    if (frame.method === 'connect') return this.respond(client, frame.id, false, null, errorFrame(frame.id, 'ALREADY_CONNECTED', 'gateway connection is already authenticated').error)
    this.dispatch(client, frame).catch(error => this.respond(client, frame.id, false, null, { code: 'UNAVAILABLE', message: clean(error.message || error) }))
  }

  connect(client, frame) {
    if (frame.method !== 'connect') return this.reject(client, frame.id, 'AUTH_REQUIRED', 'first request must be connect', true)
    const params = frame.params || {}
    if (!Number.isInteger(params.minProtocol) || !Number.isInteger(params.maxProtocol) || params.minProtocol > PROTOCOL_VERSION || params.maxProtocol < PROTOCOL_VERSION) return this.reject(client, frame.id, 'PROTOCOL_MISMATCH', 'gateway protocol version 4 is required', true)
    const auth = params.auth || {}; const expected = this.credentials.token.value || this.credentials.password.value
    const received = auth.token || auth.password || ''
    if (!expected || received !== expected) return this.reject(client, frame.id, 'AUTH_REQUIRED', 'gateway authentication required', true)
    if (params.role && params.role !== 'operator') return this.reject(client, frame.id, 'FORBIDDEN', 'operator role required', true)
    client.authenticated = true; client.role = 'operator'; client.scopes = ['operator.read', 'operator.write', 'operator.approvals']
    return this.respond(client, frame.id, true, { type: 'hello-ok', protocol: PROTOCOL_VERSION, server: { version: '0.1.0', connId: client.connId }, features: { methods: [...READ_METHODS, ...ACTION_METHODS], events: ['connect.challenge', 'quorum.state.updated', 'quorum.event', 'tick'] }, snapshot: this.snapshot(), auth: { role: client.role, scopes: client.scopes }, policy: { maxPayload: 25 * 1024 * 1024, maxBufferedBytes: 50 * 1024 * 1024, tickIntervalMs: 15_000 } })
  }

  async dispatch(client, frame) {
    if (READ_METHODS.has(frame.method)) return this.respond(client, frame.id, true, this.read(frame.method))
    if (ACTION_METHODS.has(frame.method)) {
      if (!this.openclawActions) return this.respond(client, frame.id, false, null, { code: 'UNAVAILABLE', message: 'Quorum action broker is not configured' })
      const params = frame.params || {}
      if (frame.method.endsWith('.confirm') && !clean(params.idempotencyKey, 120)) return this.respond(client, frame.id, false, null, { code: 'INVALID_REQUEST', message: 'mutating confirmations require an idempotencyKey' })
      const action = frame.method.endsWith('.preview') ? this.openclawActions.preview(params) : frame.method.endsWith('.confirm') ? await this.openclawActions.confirm(params.previewId) : this.openclawActions.cancel(params.previewId)
      return this.respond(client, frame.id, true, bounded(action))
    }
    if (frame.method.startsWith('agent') || frame.method.startsWith('chat.') || frame.method.startsWith('sessions.')) return this.respond(client, frame.id, false, null, { code: 'FORBIDDEN', message: 'mutating gateway actions require quorum.action.preview and quorum.action.confirm', details: { code: 'MISSING_PREVIEW', requiredScopes: ['operator.approvals'] } })
    return this.respond(client, frame.id, false, null, { code: 'METHOD_NOT_FOUND', message: 'gateway method is not available' })
  }

  read(method) {
    const data = this.state?.data || {}
    if (method === 'sessions.list') return { sessions: sessionProjection(this.state) }
    if (method === 'sessions.history') return { sessions: sessionProjection(this.state), history: [] }
    if (method === 'cron.list') return { jobs: (data.standingJobs?.jobs || []).slice(0, MAX_ITEMS).map(item => bounded(item)) }
    if (method === 'channels.status') return { channels: Object.entries(data.services || {}).slice(0, 50).map(([idValue, value]) => ({ id: clean(idValue), state: value?.up ? 'reachable' : 'offline', port: value?.port || null })) }
    if (method === 'nodes.list') return { nodes: (data.city?.buildings || []).slice(0, MAX_ITEMS).map(item => ({ id: clean(item.id), label: clean(item.label), state: clean(item.status), kind: clean(item.entityType) })) }
    if (method === 'skills.list') return { skills: (data.catalog?.skills || []).slice(0, MAX_ITEMS).map(item => bounded(item)) }
    if (method === 'config.get') return { configRevisionHash: null, appliedConfigHash: null, metadataOnly: true }
    if (method === 'system.info') return bounded(data.system || {})
    if (method === 'usage.status') return { activeRuns: runProjection(this.state), note: 'provider usage remains in its source runtime' }
    return { connectionState: 'connected', protocol: PROTOCOL_VERSION, clients: this.clients.size }
  }

  snapshot() { return { sessions: { sessions: sessionProjection(this.state) }, runs: { runs: runProjection(this.state) }, city: bounded(this.state?.data?.city || {}), openclaw: bounded(this.state?.data?.openclaw || {}) } }
  publishState(message) { if (!message) return; const payload = message.type === 'event' ? { kind: clean(message.item?.kind), text: clean(message.item?.text), ts: message.item?.ts || Date.now() } : { key: clean(message.key), data: bounded(message.key === 'openclaw' ? message.data : message.data), ts: Date.now() }; this.broadcast({ type: 'event', event: message.type === 'event' ? 'quorum.event' : 'quorum.state.updated', payload }) }
  broadcast(frame) { for (const client of this.clients) if (client.authenticated) this.send(client, frame) }
  send(client, frame) { if (client.ws.readyState === 1) client.ws.send(JSON.stringify(frame)) }
  respond(client, idValue, ok, payload, error = null) { this.send(client, ok ? { type: 'res', id: idValue, ok: true, payload } : { type: 'res', id: idValue, ok: false, error }) }
  reject(client, idValue, code, message, close) { if (idValue) this.respond(client, idValue, false, null, { code, message }); if (close) setTimeout(() => client.ws.close?.(1008, code), 0) }
  status() { return { schemaVersion: 1, wsPath: '/gateway', protocol: PROTOCOL_VERSION, connection: 'Quorum Gateway', credentials: publicCredentials(this.credentials), clients: [...this.clients].filter(client => client.authenticated).length } }
}

export { PROTOCOL_VERSION as QUORUM_GATEWAY_PROTOCOL_VERSION }
