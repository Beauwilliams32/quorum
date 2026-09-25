// Per-agent monthly budgets, computed from spend Quorum actually recorded.
//
// Paperclip's rule — an agent that hits its budget stops — applied to the
// ledger Quorum already keeps. Every managed run and independent review
// records the provider's own `total_cost_usd` (src/cloud-budget.js); HQ
// attributes those entries to the agent whose ticket the run served.
//
// Two blind spots are stated, never hidden:
//   · `codex exec --json` reports no price, so a codex run is counted as
//     UNPRICED and a cap cannot see it. The status says how many.
//   · A run is priced when it exits, so one run can carry an agent past its
//     cap before the next dispatch is refused. The overshoot is at most one run.
//
// Months are calendar months in UTC so the same ledger gives the same answer
// on every machine.

const round = value => Math.round(Number(value) * 100) / 100

export function monthStart(now = Date.now()) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

export function nextMonthStart(now = Date.now()) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

export const monthKey = (now = Date.now()) => new Date(monthStart(now)).toISOString().slice(0, 7)

/** Budget status for one agent from the HQ spend attribution. */
export function budgetFor(agent, spend = [], now = Date.now()) {
  const since = monthStart(now)
  const mine = spend.filter(entry => entry.agentId === agent.id && Number(entry.at) >= since)
  const priced = mine.filter(entry => entry.priced)
  const spentUsd = round(priced.reduce((total, entry) => total + Number(entry.costUsd || 0), 0))
  const limitUsd = Math.max(0, Number(agent.budget?.monthlyUsd) || 0)
  const warnPct = Math.min(100, Math.max(1, Number(agent.budget?.warnPct) || 80))
  const pct = limitUsd > 0 ? Math.min(999, Math.round((spentUsd / limitUsd) * 100)) : 0
  const state = limitUsd <= 0 ? 'uncapped' : spentUsd >= limitUsd ? 'over' : pct >= warnPct ? 'warn' : 'ok'
  return {
    month: monthKey(now),
    limitUsd, spentUsd, pct, warnPct, state,
    pricedRuns: priced.length,
    unpricedRuns: mine.length - priced.length,
    remainingUsd: limitUsd > 0 ? round(Math.max(0, limitUsd - spentUsd)) : null,
    resetsAt: new Date(nextMonthStart(now)).toISOString(),
  }
}

/** One-line description that always names the blind spot when there is one. */
export function budgetLine(status) {
  const unpriced = status.unpricedRuns ? ` · ${status.unpricedRuns} run(s) unpriced, not counted` : ''
  if (status.state === 'uncapped') return `$${status.spentUsd.toFixed(2)} this month · no monthly cap${unpriced}`
  return `$${status.spentUsd.toFixed(2)} of $${status.limitUsd.toFixed(2)} (${status.pct}%)${unpriced}`
}
