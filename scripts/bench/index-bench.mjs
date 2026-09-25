// Measure the artifact index against a throwaway HOME. Refuses to run outside
// a scratch HOME: it writes ~/.quorum/artifact-index.* wherever it is pointed.
import fs from 'node:fs'
import path from 'node:path'

const home = process.env.HOME
const ticks = Number(process.env.BENCH_TICKS || 8)
if (!home || !home.includes('qbench')) { console.error('refusing to run outside a scratch HOME'); process.exit(1) }

// Write accounting, one layer only — the same rule scripts/bench/store-bench.mjs
// states and follows. `fs.writeFileSync` called WITH a `mode` option leaves the
// writeFileUtf8 fast path and loops through `fs.openSync` + `fs.writeSync`, and
// both the pre-v2 artifact-index.json path and the new meta write pass
// {mode: 0o600}. Patching writeFileSync AND writeSync therefore counted those
// writes twice on both sides of the A/B: this bench used to print 460,859,510
// B/tick before and 1,700 after, against true figures of 230,429,755 and 850.
// Each write is now attributed exactly once, to the call the caller made, and
// broken down per file so the total can be audited against the file sizes.
const fdPaths = new Map()
const perFile = new Map()
let bytesWritten = 0
let tickBytes = 0
let insideWriteFile = 0

const label = file => {
  const name = path.basename(String(file))
  return name.replace(/\.\d+\.tmp$/, '') || name
}
const count = (file, n) => {
  if (!(n > 0)) return
  bytesWritten += n
  tickBytes += n
  const key = label(file)
  perFile.set(key, (perFile.get(key) || 0) + n)
}

const originalOpenSync = fs.openSync
fs.openSync = (file, ...rest) => { const fd = originalOpenSync(file, ...rest); fdPaths.set(fd, String(file)); return fd }
const originalCloseSync = fs.closeSync
fs.closeSync = (fd, ...rest) => { fdPaths.delete(fd); return originalCloseSync(fd, ...rest) }
for (const name of ['writeFileSync', 'appendFileSync']) {
  const original = fs[name]
  fs[name] = (file, data, ...rest) => {
    insideWriteFile += 1
    try {
      const result = original(file, data, ...rest)
      count(file, Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data)))
      return result
    } finally { insideWriteFile -= 1 }
  }
}
const originalWriteSync = fs.writeSync
fs.writeSync = (fd, data, ...rest) => {
  const n = originalWriteSync(fd, data, ...rest)
  // Skip the writes that are writeFileSync's own loop; they are already counted.
  if (!insideWriteFile && (typeof data === 'string' || Buffer.isBuffer(data))) count(fdPaths.get(fd) || `fd-${fd}`, n)
  return n
}
const tickPerFile = () => { const snapshot = Object.fromEntries(perFile); perFile.clear(); return snapshot }

const { reindexArtifacts } = await import('../../src/artifacts.js')

const indexFiles = () => {
  const dir = path.join(home, '.quorum')
  try {
    return fs.readdirSync(dir).filter(n => n.startsWith('artifact-index'))
      .map(n => ({ name: n, bytes: fs.statSync(path.join(dir, n)).size }))
  } catch { return [] }
}

const rssMB = () => +(process.memoryUsage.rss() / 1024 / 1024).toFixed(1)
const samples = []

for (let i = 0; i < ticks; i++) {
  tickBytes = 0
  perFile.clear()
  const started = process.hrtime.bigint()
  const state = await reindexArtifacts()
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  samples.push({ tick: i, ms: +ms.toFixed(1), entries: state.stats.total, rssMB: rssMB(), bytesWritten: tickBytes, bytesByFile: tickPerFile(), indexBytes: indexFiles().reduce((a, f) => a + f.bytes, 0) })
}

const steady = samples.slice(1)
const steadyBytes = steady.reduce((a, s) => a + s.bytesWritten, 0) / Math.max(1, steady.length)
console.log(JSON.stringify({
  ticks: samples,
  cold: samples[0],
  warmMedianMs: +median(steady.map(s => s.ms)).toFixed(1),
  entries: samples.at(-1).entries,
  indexFiles: indexFiles(),
  indexBytes: samples.at(-1).indexBytes,
  rssMBFinal: rssMB(),
  rssMBPeak: Math.max(...samples.map(s => s.rssMB)),
  steadyBytesPerTick: Math.round(steadyBytes),
  steadyBytesPerTickByFile: Object.fromEntries([...new Set(steady.flatMap(sample => Object.keys(sample.bytesByFile)))]
    .map(key => [key, Math.round(steady.reduce((total, sample) => total + (sample.bytesByFile[key] || 0), 0) / Math.max(1, steady.length))])),
  projectedBytesPerHourAt30s: Math.round(steadyBytes * 120),
  totalBytesWritten: bytesWritten,
}, null, 2))

function median(xs) { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }
