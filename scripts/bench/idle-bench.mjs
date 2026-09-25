// Count what a cockpit at rest sends and does. Boots the server on a
// throwaway port under a scratch HOME, attaches one WebSocket client, and
// records every frame plus the server process's RSS.
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
import { WebSocket } from 'ws'

const home = process.env.HOME
if (!home || !home.includes('qbench')) { console.error('refusing to run outside a scratch HOME'); process.exit(1) }
const seconds = Number(process.env.BENCH_SECONDS || 120)

const freePort = () => new Promise(resolve => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

const port = await freePort()
const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('../..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', () => {})
child.stderr.on('data', d => process.env.BENCH_VERBOSE && process.stderr.write(d))

for (let i = 0; i < 300; i++) {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/state`); if (r.ok) break } catch { /* not up */ }
  await new Promise(r => setTimeout(r, 100))
}

const rssMB = () => {
  try { return +(Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()) / 1024).toFixed(1) } catch { return null }
}

const byKey = new Map()
let frames = 0
let bytes = 0
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } })
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })

// Settle first: the boot burst is not what idle costs.
await new Promise(r => setTimeout(r, 10_000))
const rssStart = rssMB()
const startedAt = Date.now()
ws.on('message', raw => {
  frames += 1
  bytes += raw.length
  let msg; try { msg = JSON.parse(raw) } catch { return }
  const key = msg.type === 'update' ? `update:${msg.key}` : msg.type
  const seen = byKey.get(key) || { count: 0, bytes: 0 }
  byKey.set(key, { count: seen.count + 1, bytes: seen.bytes + raw.length })
})
const rss = [rssStart]
for (let i = 0; i < seconds; i += 15) { await new Promise(r => setTimeout(r, 15_000)); rss.push(rssMB()) }

const elapsedMin = (Date.now() - startedAt) / 60_000
ws.close()
child.kill('SIGTERM')

console.log(JSON.stringify({
  seconds,
  elapsedMin: +elapsedMin.toFixed(2),
  framesTotal: frames,
  framesPerMinute: +(frames / elapsedMin).toFixed(1),
  bytesTotal: bytes,
  bytesPerMinute: Math.round(bytes / elapsedMin),
  byKey: Object.fromEntries([...byKey].sort((a, b) => b[1].count - a[1].count).map(([k, v]) => [k, { count: v.count, perMinute: +(v.count / elapsedMin).toFixed(1), bytes: v.bytes }])),
  rssSamplesMB: rss,
}, null, 2))
