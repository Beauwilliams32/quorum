import crypto from 'node:crypto'

// The daily cloud budget, enforced against spend that was actually recorded.
//
// `dailyCloudBudgetUsd` (25) was displayed in the standing-job limits and
// never consulted; only `maxConcurrentCloudAgents` was checked, so the number
// on screen was decoration. This ledger records what each managed run cost —
// from the provider's own `total_cost_usd`, the same field the roundtable
// reads — and refuses new cloud runs once the day's recorded spend reaches the
// ceiling.
//
// It is deliberately explicit about what it cannot price. `codex exec --json`
// reports no dollar figure, so those runs are counted as *unpriced*, reported
// as such, and never silently treated as free. A caller that shows "spent
// $3.10 of $25" without also showing "4 runs unpriced" is lying by omission.

const DAY_MS = 24 * 60 * 60 * 1000
const round = value => Math.round(Number(value) * 10_000) / 10_000

/**
 * The price of a run, or null when the provider did not state one.
 *
 * `Number(null)` and `Number('')` are both 0, and 0 is finite — so a bare
 * `Number.isFinite(Number(value))` guard turns "no price reported" into "this
 * run was free". Every caller that wants a dollar figure out of provider
 * output goes through here so that the silent zero has exactly one place it
 * could come back.
 */
export function priceOf(costUsd) {
  if (typeof costUsd === 'number') return Number.isFinite(costUsd) && costUsd >= 0 ? round(costUsd) : null
  if (typeof costUsd === 'string' && costUsd.trim() !== '') {
    const value = Number(costUsd)
    return Number.isFinite(value) && value >= 0 ? round(value) : null
  }
  return null
}

export class CloudBudget {
  constructor({ store = null, limitUsd = 25, now = () => Date.now(), windowMs = DAY_MS } = {}) {
    this.store = store
    this.limitUsd = Math.max(0, Number(limitUsd) || 0)
    this.now = now
    this.windowMs = windowMs
    this.memory = []
  }

  #all() {
    if (!this.store) return this.memory
    try { return this.store.list('spend') || [] } catch { return this.memory }
  }

  /**
   * Record one run's spend. `costUsd: null` is a real value meaning "the
   * provider reported no price", and is stored as such rather than as zero.
   */
  record({ runId, runtime, costUsd = null, missionId = null, taskId = null } = {}) {
    const at = this.now()
    // `Number(null)` is 0, so a null price would otherwise be recorded as a
    // free run — the exact silent-zero this ledger exists to avoid.
    const price = priceOf(costUsd)
    const entry = {
      id: `spend-${at.toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      runId: String(runId || ''), runtime: String(runtime || ''), missionId, taskId,
      costUsd: price, priced: price !== null, at, updatedAt: at,
    }
    if (this.store) { try { this.store.append('spend', entry); return entry } catch { /* fall through to memory */ } }
    this.memory.push(entry)
    this.memory = this.memory.slice(-500)
    return entry
  }

  /** What the current window actually knows: priced total, and how much it could not price. */
  window({ now = this.now(), inFlightRuns = 0 } = {}) {
    const since = now - this.windowMs
    const entries = this.#all().filter(entry => Number(entry.at) >= since)
    const priced = entries.filter(entry => entry.priced)
    const unpriced = entries.filter(entry => !entry.priced)
    return {
      since, now,
      inFlightRuns: Math.max(0, Number(inFlightRuns) || 0),
      limitUsd: this.limitUsd,
      spentUsd: round(priced.reduce((total, entry) => total + Number(entry.costUsd || 0), 0)),
      pricedRuns: priced.length,
      unpricedRuns: unpriced.length,
      unpricedRuntimes: [...new Set(unpriced.map(entry => entry.runtime).filter(Boolean))],
    }
  }

  /**
   * `{ allowed, reason, ... }` for starting one more cloud run. The reason is
   * always populated, including on the allowed path, so an operator surface
   * can state the ceiling and its blind spot rather than just a colour.
   */
  check({ now = this.now(), inFlightRuns = 0 } = {}) {
    const state = this.window({ now, inFlightRuns })
    const blindSpot = state.unpricedRuns ? ` ${state.unpricedRuns} run(s) in this window reported no price (${state.unpricedRuntimes.join(', ') || 'unknown runtime'}) and are not counted.` : ''
    // A run is priced at its exit, so anything still running has spent money
    // this figure does not contain. Concurrency caps the overshoot; saying so
    // is what stops the number reading as committed spend.
    const inFlight = state.inFlightRuns ? ` ${state.inFlightRuns} cloud run(s) are still in flight and will only be priced when they exit, so this is recorded spend, not committed spend.` : ''
    if (this.limitUsd <= 0) return { ...state, allowed: true, enforced: false, reason: `no daily cloud budget is configured, so nothing is enforced.${blindSpot}${inFlight}` }
    if (state.spentUsd >= this.limitUsd) return { ...state, allowed: false, enforced: true, reason: `daily cloud budget reached: $${state.spentUsd.toFixed(2)} of $${this.limitUsd.toFixed(2)} recorded in the last 24h.${blindSpot}${inFlight}` }
    return { ...state, allowed: true, enforced: true, reason: `$${state.spentUsd.toFixed(2)} of $${this.limitUsd.toFixed(2)} recorded in the last 24h.${blindSpot}${inFlight}` }
  }
}
