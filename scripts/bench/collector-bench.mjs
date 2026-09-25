// Per-tick cost of the polling collectors against a scratch HOME. Measures
// the scan itself, not the broadcast: State is stubbed out.
const home = process.env.HOME
if (!home || !home.includes('qbench')) { console.error('refusing to run outside a scratch HOME'); process.exit(1) }
const rounds = Number(process.env.BENCH_ROUNDS || 12)

const { buildTasks } = await import('../../src/collectors/tasks.js')
const projects = await import('../../src/collectors/projects.js')

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }
const time = (label, fn, extra = {}) => {
  const samples = []
  for (let i = 0; i < rounds; i++) {
    const started = process.hrtime.bigint()
    fn()
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  return { label, firstMs: +samples[0].toFixed(2), warmMedianMs: +median(samples.slice(1)).toFixed(2), ...extra }
}

// The sessions collector has no exported scan, so drive it through its module
// timer once and measure the same walk the tick does.
const sessionsModule = await import('../../src/collectors/sessions.js')
let sessionsResult = null
const fakeState = { data: {}, update(key, value) { this.data[key] = value; if (key === 'sessions') sessionsResult = value } }

const out = []
out.push(time('tasks.buildTasks', () => buildTasks({ sessions: { cards: [] }, agents: { agents: [] } })))
out.push(time('projects.buildOffice+configInfo', () => ({ ...projects.buildOffice({ sessions: { cards: [] }, processes: {}, services: {} }), config: projects.configInfo() })))
out.push(time('projects.refreshCatalog', () => projects.refreshCatalog()))

// sessions: start it, let one tick land, then time repeat ticks by calling the
// module's exported startSessions once and measuring its first synchronous tick.
const startedAt = process.hrtime.bigint()
const handle = sessionsModule.startSessions(fakeState)
const firstSessionsTickMs = Number(process.hrtime.bigint() - startedAt) / 1e6
out.push({ label: 'sessions.tick (first, includes cold transcript reads)', firstMs: +firstSessionsTickMs.toFixed(2), cards: sessionsResult?.cards?.length ?? 0 })

await new Promise(resolve => setTimeout(resolve, 3_500))
const warmStart = process.hrtime.bigint()
// A second startSessions runs the same scan against the warm cache.
sessionsModule.startSessions(fakeState)
out.push({ label: 'sessions.tick (warm, mtime cache hit)', firstMs: +(Number(process.hrtime.bigint() - warmStart) / 1e6).toFixed(2), cards: sessionsResult?.cards?.length ?? 0 })

console.log(JSON.stringify({ rounds, collectors: out }, null, 2))
process.exit(0)
