// Keys that only say when a payload was assembled. Two payloads that differ
// in nothing else are the same news, and re-sending them is what made a
// cockpit at rest cost ~240 full-state frames and 5 MB a minute.
const VOLATILE_KEYS = new Set(['ts', 'generatedAt'])

/**
 * A comparable form of a broadcast payload, or null when it cannot be
 * compared — in which case it is always sent, because "I could not tell"
 * must never read as "nothing changed".
 */
export function payloadSignature(value) {
  try {
    const signature = JSON.stringify(value, (key, item) => (VOLATILE_KEYS.has(key) ? undefined : item))
    return signature === undefined ? null : signature
  } catch { return null }
}

// Central store: collectors write here, every websocket client gets diffs.
//
// The store used to serialise the whole value of a key and push it at every
// socket on every collector tick — ~215 full broadcasts a minute with nothing
// happening, most of them byte-identical to the one before. `update()` now:
//
//   1. skips the send entirely when the serialised payload is unchanged, and
//   2. sends a per-property patch when only part of the value moved, with
//      row-level upserts for arrays of `{ id }` objects (the city's 400
//      services and 180 workers, where one row changing used to resend all).
//
// Every key carries a monotonic version. A patch names the version it applies
// to (`from`), so a client that missed one can tell — it asks for `state.resync`
// and gets the full value back. Nothing about this is silent: the resync is
// written into the asking cockpit's own event feed.
//
// `notify()` is deliberately left whole-value and unconditional. The gateway
// projections in src/quorum-gateway.js read it, and they are not diff-aware.

// A resync is one client's recovery, not a machine-wide event. Its
// acknowledgement used to be appended to the shared 200-entry feed ring AND
// broadcast to every socket, so a single client could send 300 `state.resync`
// requests and erase every cockpit's real spawn/exit/kill history. The note now
// goes to the asking socket only, and each socket gets a bounded number of
// answers per window: a genuinely unlucky reconnect can gap every published key
// at once and still be answered, a socket in a loop cannot.
const RESYNC_WINDOW_MS = 10_000
const RESYNC_BURST = 24

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isRowArray = value => Array.isArray(value) && value.length > 0 && value.every(item => isPlainObject(item) && (typeof item.id === 'string' || typeof item.id === 'number'))

/**
 * What the store remembers about the last payload it broadcast for a key:
 * the exact JSON text of the whole value, the JSON text of each top-level
 * property, and — for properties that are arrays of `{ id }` rows — the JSON
 * text of each row by id, so a single changed row can be sent on its own.
 */
function fingerprint(payload) {
  const whole = JSON.stringify(payload)
  if (!isPlainObject(payload)) return { whole, props: null, rows: null }
  const props = new Map()
  const rows = new Map()
  for (const [prop, value] of Object.entries(payload)) {
    props.set(prop, JSON.stringify(value))
    if (isRowArray(value)) {
      const byId = new Map()
      for (const row of value) byId.set(String(row.id), JSON.stringify(row))
      rows.set(prop, byId)
    }
  }
  return { whole, props, rows }
}

/** Row-level delta for one array-of-`{id}` property, or null when a whole-value replacement is cheaper. */
function rowDelta(previous, next, value) {
  const upsert = []
  for (const row of value) {
    const id = String(row.id)
    if (previous.get(id) !== next.get(id)) upsert.push(row)
  }
  const remove = []
  for (const id of previous.keys()) if (!next.has(id)) remove.push(id)
  const order = [...next.keys()]
  const previousOrder = [...previous.keys()]
  const sameOrder = order.length === previousOrder.length && order.every((id, index) => id === previousOrder[index])
  // A delta that touches most of the array is not worth its bookkeeping.
  if (upsert.length > value.length * 0.6) return null
  return { upsert, remove, order: sameOrder ? null : order }
}

export class State {
  constructor() {
    this.data = {}
    this.feed = []
    this.clients = new Set()
    this.listeners = new Set()
    // key -> monotonic version of the last payload actually sent
    this.versions = {}
    // key -> fingerprint of the last payload actually sent
    this.wire = {}
    // keys whose broadcast payload is lighter than what `data` stores
    this.lightened = new Set()
    this.resyncs = 0
    this.resyncsRefused = 0
    // socket -> { since, count }. A WeakMap, so a closed socket needs no
    // cleanup and a flooder cannot grow this without bound.
    this.resyncBudget = new WeakMap()
  }

  /**
   * Count one resync request against `ws`'s budget and say whether to answer
   * it. A refusal is deliberately silent on the wire: telling a flooding client
   * it was refused would be one more frame per request, and telling everyone
   * else would be the very broadcast this budget exists to stop. The count is
   * on `resyncsRefused`.
   */
  resyncAllowed(ws, now = Date.now()) {
    if (!ws) return true
    let bucket = this.resyncBudget.get(ws)
    if (!bucket || now - bucket.since >= RESYNC_WINDOW_MS) {
      bucket = { since: now, count: 0 }
      this.resyncBudget.set(ws, bucket)
    }
    bucket.count += 1
    return bucket.count <= RESYNC_BURST
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(message) {
    for (const listener of this.listeners) {
      try { listener(message) } catch { /* observers must never break the state store */ }
    }
  }

  /**
   * Set a key and broadcast it (optionally broadcast a lighter payload than
   * what's stored). Returns whether anything went out.
   *
   * Collectors tick on fixed intervals whether or not the thing they watch
   * moved, so most ticks on an idle machine produced a byte-identical frame.
   * A repeat is stored — `this.data` and therefore every new client's
   * snapshot stay current — but not sent. `force` re-sends regardless.
   *
   * This suppresses repeats only. Every payload a client would have received
   * it still receives; it just receives each one once.
   */
  update(key, value, broadcastValue, { force = false } = {}) {
    this.data[key] = value
    const payload = broadcastValue !== undefined ? broadcastValue : value
    if (broadcastValue !== undefined) this.lightened.add(key)
    this.notify({ type: 'update', key, data: payload })
    this.publish(key, payload)
  }

  /**
   * Broadcast `payload` for `key` as cheaply as the previous payload allows:
   * nothing at all when it is unchanged, a patch when part of it moved, a full
   * value the first time or when a patch would not be smaller.
   * Returns the message that went out, or null when nothing did.
   */
  publish(key, payload) {
    const previous = this.wire[key]
    const next = fingerprint(payload)
    if (previous && previous.whole === next.whole) return null

    let patch = null
    if (previous && previous.props && next.props) {
      const set = {}
      const rows = {}
      const del = []
      for (const [prop, json] of next.props) {
        if (previous.props.get(prop) === json) continue
        const before = previous.rows?.get(prop)
        const after = next.rows?.get(prop)
        const delta = before && after ? rowDelta(before, after, payload[prop]) : null
        if (delta) rows[prop] = delta
        else set[prop] = payload[prop]
      }
      for (const prop of previous.props.keys()) if (!next.props.has(prop)) del.push(prop)
      // Only a key order change, which nothing downstream can observe.
      if (!Object.keys(set).length && !Object.keys(rows).length && !del.length) { this.wire[key] = next; return null }
      patch = { type: 'patch', key, v: 0, from: 0 }
      if (Object.keys(set).length) patch.set = set
      if (Object.keys(rows).length) patch.rows = rows
      if (del.length) patch.del = del
    }

    const version = (this.versions[key] = (this.versions[key] || 0) + 1)
    const fullText = `{"type":"update","key":${JSON.stringify(key)},"v":${version},"data":${next.whole}}`
    let message = { type: 'update', key, v: version, data: payload }
    let text = fullText
    if (patch) {
      patch.v = version
      patch.from = version - 1
      const patchText = JSON.stringify(patch)
      // A patch that is not actually smaller is pure bookkeeping.
      if (patchText.length < fullText.length) { message = patch; text = patchText }
    }
    this.wire[key] = next
    this.broadcastText(text)
    return message
  }

  /**
   * Send one client the whole current value of a key. This is the answer to a
   * client that noticed a version gap, and it stays visible — a cockpit that is
   * quietly resyncing every few seconds says so in its own feed rather than
   * looking healthy. What it no longer does is say so in *everyone else's*
   * feed: see RESYNC_BURST above.
   *
   * `key` arrives straight off the wire, and `wire`/`versions` are plain
   * objects — so `constructor`, `__proto__`, `toString` and friends used to
   * resolve truthy, walk past the guard, and be concatenated into a frame that
   * is not valid JSON (`"v":function Object() { [native code] }`). Every one of
   * those throws in the client's `JSON.parse`. The known key set is exactly the
   * set of keys this store has actually published, so ask it with `hasOwn`.
   */
  resync(key, ws) {
    if (typeof key !== 'string' || !Object.hasOwn(this.wire, key)) return false
    const entry = this.wire[key]
    if (!entry) return false
    if (!this.resyncAllowed(ws)) { this.resyncsRefused += 1; return false }
    this.resyncs += 1
    const version = Object.hasOwn(this.versions, key) ? this.versions[key] : 0
    if (ws && ws.readyState === 1) {
      ws.send(`{"type":"update","key":${JSON.stringify(key)},"v":${Number(version) || 0},"data":${entry.whole}}`)
      ws.send(JSON.stringify({ type: 'event', item: { kind: 'sync', ts: Date.now(), text: `resent full "${key}" state after this cockpit fell behind` } }))
    }
    return true
  }

  // Append to the event feed ring and broadcast.
  event(item) {
    item.ts = Date.now()
    this.feed.push(item)
    if (this.feed.length > 200) this.feed.shift()
    this.notify({ type: 'event', item })
    this.broadcast({ type: 'event', item })
  }

  snapshot() {
    const out = { type: 'snapshot', data: this.data, versions: { ...this.versions }, feed: this.feed }
    // Keys whose broadcast payload is lighter than the stored value need the
    // broadcast payload too: that, not `data`, is what later patches apply to.
    const wire = {}
    for (const key of this.lightened) if (this.wire[key]) wire[key] = JSON.parse(this.wire[key].whole)
    if (Object.keys(wire).length) out.wire = wire
    return out
  }

  /** The snapshot as wire text, reusing the JSON already computed for each key. */
  snapshotMessage() {
    const wire = []
    for (const key of this.lightened) if (this.wire[key]) wire.push(`${JSON.stringify(key)}:${this.wire[key].whole}`)
    return `{"type":"snapshot","data":${JSON.stringify(this.data)},"versions":${JSON.stringify(this.versions)}` +
      (wire.length ? `,"wire":{${wire.join(',')}}` : '') +
      `,"feed":${JSON.stringify(this.feed)}}`
  }

  broadcast(msg) {
    this.broadcastText(JSON.stringify(msg))
  }

  /** Send wire text that has already been serialised — the diffing path reuses the JSON it built. */
  broadcastText(text) {
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(text)
  }
}
