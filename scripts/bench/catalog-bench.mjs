// Count the subprocesses and the wall clock a catalog build costs. The
// handshake, every roundtable start and every command preview pay this.
import fs from 'node:fs'

// Subprocesses are counted with a `zsh` shim on PATH rather than by patching
// child_process: catalog.js imports `execFileSync` as a binding, so patching
// the module namespace would silently count zero and report a false win.
const counter = process.env.QBENCH_ZSH_COUNT
const spawned = () => { try { return fs.statSync(counter).size } catch { return 0 } }
if (!counter) { console.error('set QBENCH_ZSH_COUNT and put scripts/bench shim dir first on PATH'); process.exit(1) }
try { fs.writeFileSync(counter, '') } catch { /* first run */ }
const rounds = Number(process.env.BENCH_ROUNDS || 20)

const { buildCatalog, roundtableModelOptions } = await import('../../src/catalog.js')

const samples = []
const spawnsPerRound = []
for (let i = 0; i < rounds; i++) {
  const before = spawned()
  const started = process.hrtime.bigint()
  const catalog = buildCatalog()
  roundtableModelOptions({ catalog })
  samples.push(+(Number(process.hrtime.bigint() - started) / 1e6).toFixed(2))
  spawnsPerRound.push(spawned() - before)
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }
console.log(JSON.stringify({
  rounds,
  firstBuildMs: samples[0],
  subsequentMedianMs: median(samples.slice(1)),
  totalMs: +samples.reduce((a, b) => a + b, 0).toFixed(1),
  loginShellsSpawnedTotal: spawned(),
  loginShellsFirstBuild: spawnsPerRound[0],
  loginShellsPerBuildAfterFirst: +(spawnsPerRound.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, rounds - 1)).toFixed(2),
  samples,
  spawnsPerRound,
}, null, 2))
