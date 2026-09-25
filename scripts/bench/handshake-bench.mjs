// Boot the cockpit on a throwaway port under a scratch HOME and time the
// WebSocket handshake — connect to first snapshot frame — plus a direct
// buildCatalog() sample. Never point this at the owner's running instance.
import { spawn } from 'node:child_process'
import net from 'node:net'
import { WebSocket } from 'ws'

const home = process.env.HOME
if (!home || !home.includes('qbench')) { console.error('refusing to run outside a scratch HOME'); process.exit(1) }
const rounds = Number(process.env.BENCH_ROUNDS || 12)

const freePort = () => new Promise(resolve => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

const port = await freePort()
const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('../..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(port), QUORUM_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', () => {})
child.stderr.on('data', d => process.env.BENCH_VERBOSE && process.stderr.write(d))

const ready = async () => {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/state`); if (r.ok) return true } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}
if (!await ready()) { child.kill('SIGTERM'); console.error('server never became ready'); process.exit(1) }

const handshake = () => new Promise((resolve, reject) => {
  const started = process.hrtime.bigint()
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } })
  const timer = setTimeout(() => { ws.terminate(); reject(new Error('handshake timeout')) }, 30_000)
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw) } catch { return }
    if (msg.type !== 'snapshot' && msg.type !== 'hello' && msg.type !== 'cast') return
    clearTimeout(timer)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    ws.close()
    resolve(+ms.toFixed(1))
  })
  ws.on('error', err => { clearTimeout(timer); reject(err) })
})

const samples = []
for (let i = 0; i < rounds; i++) samples.push(await handshake())

const catalogSamples = []
for (let i = 0; i < rounds; i++) {
  const started = process.hrtime.bigint()
  await fetch(`http://127.0.0.1:${port}/api/catalog`).then(r => r.json())
  catalogSamples.push(+(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1))
}

child.kill('SIGTERM')
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }
console.log(JSON.stringify({
  port,
  handshakeMs: samples,
  handshakeFirst: samples[0],
  handshakeMedian: median(samples),
  handshakeMax: Math.max(...samples),
  catalogRouteMs: catalogSamples,
  catalogRouteMedian: median(catalogSamples),
}, null, 2))
