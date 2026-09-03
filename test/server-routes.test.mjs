// Boots the real server.js on a free port and exercises its HTTP surface.
// Collectors read ~/.claude but nothing is written unless a pty is created.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4700 + Math.floor(Math.random() * 90)
const base = `http://127.0.0.1:${PORT}`
const controlStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-route-state-'))
const missionStateFile = path.join(controlStateDir, 'missions.json')

let child
test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), AGENT_CONTROL_STATE_DIR: controlStateDir, QUORUM_MISSIONS_PATH: missionStateFile }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000)
    child.stdout.on('data', d => { if (String(d).includes(`:${PORT}`)) { clearTimeout(t); resolve() } })
    child.on('exit', c => reject(new Error('server exited ' + c)))
  })
})
test.after(() => { child?.kill('SIGTERM') })

test('GET /health returns the readiness document', async () => {
  const r = await fetch(`${base}/health`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const h = await r.json()
  assert.ok(['ok', 'degraded'].includes(h.status))
  assert.equal(h.readiness.cockpit, 'ready')
  assert.equal(typeof h.uptimeMs, 'number')
})

test('GET / and the vendored xterm bundle are served with the right types', async () => {
  const idx = await fetch(`${base}/`)
  assert.equal(idx.status, 200)
  assert.match(idx.headers.get('content-type'), /text\/html/)
  assert.match(await idx.text(), /<script[^>]*app\.js/)
  const v = await fetch(`${base}/vendor/xterm.css`)
  assert.equal(v.status, 200)
  assert.match(v.headers.get('content-type'), /text\/css/)
})

test('GET /api/state exposes state, feed and roundtable lists but no persona prompts', async () => {
  const r = await fetch(`${base}/api/state`)
  assert.equal(r.status, 200)
  const s = await r.json()
  assert.ok(Array.isArray(s.feed))
  assert.ok(Array.isArray(s.roundtables.live))
  assert.ok(Array.isArray(s.roundtables.recent))
  assert.equal(JSON.stringify(s).includes('"prompt":'), false)
})

test('GET /api/operations exposes a bounded operator projection', async () => {
  const r = await fetch(`${base}/api/operations`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const operations = await r.json()
  assert.ok(Array.isArray(operations.sessions))
  assert.ok(Array.isArray(operations.nodes))
  assert.ok(Array.isArray(operations.channels))
  assert.equal(JSON.stringify(operations).includes('prompt'), false)
})

test('registry, workspace, task, and memory API surfaces are bounded and truthful', async () => {
  const [agents, workspaces, tasks, tools, mcp, memory] = await Promise.all([
    fetch(`${base}/api/agents`),
    fetch(`${base}/api/workspaces`),
    fetch(`${base}/api/tasks`),
    fetch(`${base}/api/tools`),
    fetch(`${base}/api/mcp`),
    fetch(`${base}/api/memory?q=agent&limit=2`),
  ])
  assert.equal(agents.status, 200)
  assert.equal(workspaces.status, 200)
  assert.equal(tasks.status, 200)
  assert.equal(tools.status, 200)
  assert.equal(mcp.status, 200)
  assert.equal(memory.status, 200)
  assert.ok(Array.isArray((await workspaces.json()).workspaces))
  assert.ok(Array.isArray((await tasks.json()).tasks))
  const toolPayload = await tools.json()
  assert.ok(toolPayload.tools.some(tool => tool.id === 'terminal' && tool.approval === 'explicit'))
  assert.equal(JSON.stringify(toolPayload).includes('credential'), false)
  assert.ok(Array.isArray((await mcp.json()).servers))
  assert.ok(Array.isArray((await memory.json()).results))
})

test('runtime and memory bridge endpoints expose local integration state', async () => {
  const [runtime, memory] = await Promise.all([fetch(`${base}/api/runtime-runs`), fetch(`${base}/api/memory/status`)])
  assert.equal(runtime.status, 200)
  assert.equal(memory.status, 200)
  const runtimeBody = await runtime.json()
  const memoryBody = await memory.json()
  assert.ok(Array.isArray(runtimeBody.runs))
  assert.equal(memoryBody.claudeMem.loopbackOnly, true)
  assert.equal(memoryBody.obsidian.writeScope, '09_AI_AGENTS/Quorum/Missions')
  assert.ok(['ready', 'reachable', 'offline', 'unknown'].includes(memoryBody.claudeMem.state))
})

test('memory recall and sync routes return bounded integration evidence', async () => {
  const recall = await fetch(`${base}/api/memory/recall?q=operator&limit=2`)
  assert.equal(recall.status, 200)
  const recallBody = await recall.json()
  assert.equal(typeof recallBody.context, 'string')
  assert.equal(recallBody.query, 'operator')
  assert.ok(recallBody.bridge.claudeMem.loopbackOnly)

  const sync = await fetch(`${base}/api/memory/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(sync.status, 200)
  const syncBody = await sync.json()
  assert.ok(typeof syncBody.syncedAt === 'string')
  assert.ok(typeof syncBody.artifacts.stats.total === 'number')
})

test('artifact open actions reject foreign origins before touching the filesystem', async () => {
  const denied = await fetch(`${base}/api/artifacts/000000000000000000000000/open`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(denied.status, 403)
})

test('mission API persists an objective and cancellation closes queued work', async () => {
  const created = await fetch(`${base}/api/missions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Route mission', objective: 'Verify durable API state', tasks: [{ id: 't1', title: 'Wait', description: 'Remain queued' }] }) })
  assert.equal(created.status, 201)
  const mission = (await created.json()).mission
  assert.equal(mission.status, 'planning')
  const cancelled = await fetch(`${base}/api/missions/${mission.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(cancelled.status, 200)
  const result = (await cancelled.json()).mission
  assert.equal(result.status, 'cancelled')
  assert.equal(result.tasks[0].status, 'cancelled')
  assert.equal((await fetch(`${base}/api/missions/${mission.id}`)).status, 200)
})

test('agent-control routes create, heartbeat, checkpoint, approve and close redacted runs', async () => {
  const created = await fetch(`${base}/api/agent-control/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'builder', runtime: 'codex', repoRoot: '/tmp/quorum-route-test', worktree: '/tmp/quorum-route-test', action: 'git.push' }) })
  assert.equal(created.status, 201)
  const payload = await created.json()
  assert.match(payload.run.runId, /^run-/)
  assert.equal(JSON.stringify(payload).includes('prompt'), false)
  const action = Object.values(payload.control.actions).find(item => item.runId === payload.run.runId)
  assert.ok(action)
  const beat = await fetch(`${base}/api/agent-control/runs/${payload.run.runId}/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phase: 'testing' }) })
  assert.equal(beat.status, 200)
  const checkpoint = await fetch(`${base}/api/agent-control/runs/${payload.run.runId}/checkpoint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'route test', tests: ['node --test'] }) })
  assert.equal(checkpoint.status, 201)
  const approved = await fetch(`${base}/api/agent-control/actions/${action.id}/approve`, { method: 'POST' })
  assert.equal(approved.status, 200)
  const closed = await fetch(`${base}/api/agent-control/runs/${payload.run.runId}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disposition: 'completed', checks: ['route test'] }) })
  assert.equal(closed.status, 200)
  assert.equal((await fetch(`${base}/api/agent-control/claims`)).status, 200)
})

test('agent-control discovery endpoints are bounded and mutating routes reject foreign origins', async () => {
  const packs = await fetch(`${base}/api/agent-control/packs`)
  assert.equal(packs.status, 200)
  assert.ok((await packs.json()).packs.some(pack => pack.id === 'builder'))
  const runtimes = await fetch(`${base}/api/agent-control/runtimes`)
  assert.equal(runtimes.status, 200)
  assert.ok((await runtimes.json()).runtimes.some(runtime => runtime.id === 'ollama'))
  const doctor = await fetch(`${base}/api/agent-control/doctor`)
  assert.equal(doctor.status, 200)
  const report = await doctor.json()
  assert.equal('environment' in report, false)
  assert.ok(Array.isArray(report.blockers))
  const denied = await fetch(`${base}/api/agent-control/runs`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(denied.status, 403)
})

test('unknown roundtables and files 404, and traversal out of public/ is refused', async () => {
  assert.equal((await fetch(`${base}/api/roundtable/does-not-exist.md`)).status, 404)
  assert.equal((await fetch(`${base}/nope.js`)).status, 404)
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404)
  assert.equal((await fetch(`${base}/public/../server.js`)).status, 404)
  assert.equal((await fetch(`${base}/%2e%2e/%2e%2e/package.json`)).status, 404)
})

test('websocket handshake sends cast, edition, runtimes and models, and rejects foreign origins', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: `http://127.0.0.1:${PORT}` })
  const msgs = []
  await new Promise((resolve, reject) => {
    ws.on('error', reject)
    ws.on('message', m => { msgs.push(JSON.parse(m)); if (msgs.length >= 4) resolve() })
  })
  const types = msgs.map(m => m.type)
  assert.deepEqual(types.slice(0, 4), ['snapshot', 'pty.list', 'cast', 'rt.list'])
  const cast = msgs[2]
  assert.ok(Array.isArray(msgs[0].data.runtimeRuns?.runs))
  assert.ok(cast.cast.length >= 3)
  assert.equal(cast.cast.some(c => 'prompt' in c), false)
  assert.ok(['free', 'pro'].includes(cast.edition.tier))
  assert.ok(cast.runtimes.some(r => r.id === 'claude' && r.builtin))
  assert.ok(cast.models.includes('sonnet'))
  assert.equal(typeof cast.estCostPerTurnUsd, 'number')

  // A bad message yields an error frame rather than a dropped socket.
  const err = new Promise(r => ws.on('message', m => { const j = JSON.parse(m); if (j.type === 'error') r(j) }))
  ws.send(JSON.stringify({ type: 'proc.kill', pid: 1 }))
  assert.match((await err).error, /not in the tracked AI process list/)
  const err2 = new Promise(r => ws.on('message', m => { const j = JSON.parse(m); if (j.type === 'error' && /sessionId/.test(j.error)) r(j) }))
  ws.send(JSON.stringify({ type: 'chat.open', sessionId: '../etc' }))
  assert.match((await err2).error, /invalid sessionId/)
  ws.close()

  const foreign = await new Promise(resolve => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: 'https://evil.example' })
    w.on('open', () => { w.close(); resolve('open') })
    w.on('error', () => resolve('rejected'))
  })
  assert.equal(foreign, 'rejected')
})
