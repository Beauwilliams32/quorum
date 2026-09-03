import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryBridge } from '../src/memory-bridge.js'

test('Obsidian bridge writes only inside its Quorum mission folder', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-vault-'))
  const bridge = new MemoryBridge({ vault, memUrl: '', now: () => new Date('2026-09-01T12:00:00.000Z') })
  const mission = { id: 'mission-123', title: 'Index the workspace', objective: 'Keep agent recall bounded.' }
  const task = { id: 'scan', title: 'Scan files' }
  const run = { runId: 'run-123', runtime: 'codex', status: 'closed', disposition: 'completed', worktree: '/tmp/worktree', providerSessionId: 'thread-123', closeout: { changedFiles: ['src/index.js'] } }
  const result = bridge.writeMissionNote({ mission, task, run, closeout: 'Status: completed' })
  assert.equal(result.ok, true)
  assert.equal(fs.readFileSync(result.path, 'utf8').includes('quorum_mission: mission-123'), true)
  assert.equal(path.relative(vault, result.path).startsWith('09_AI_AGENTS/Quorum/Missions/'), true)
})

test('memory status includes the source-of-truth pointer health', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-vault-status-'))
  const bridge = new MemoryBridge({ vault, memUrl: '' })
  const status = bridge.status()
  assert.equal(typeof status.sourceOfTruth.ok, 'boolean')
  assert.equal(status.sourceOfTruth.memory.exists, true)
  assert.ok(Array.isArray(status.sourceOfTruth.references))
})

test('mission notes preserve human text and retain separate task sections', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-vault-notes-'))
  const bridge = new MemoryBridge({ vault, memUrl: '', now: () => new Date('2026-09-01T12:00:00.000Z') })
  const mission = { id: 'mission-456', title: 'Ship safely', objective: 'Preserve every note.' }
  const run = { runId: 'run-456', runtime: 'codex', status: 'closed', disposition: 'completed', worktree: '/tmp/worktree' }
  const first = bridge.writeMissionNote({ mission, task: { id: 'scan', title: 'Scan' }, run, closeout: 'scan complete' })
  fs.appendFileSync(first.path, '\nHuman decision: keep the rollback window.\n')
  bridge.writeMissionNote({ mission, task: { id: 'ship', title: 'Ship' }, run, closeout: 'ship complete' })
  const body = fs.readFileSync(first.path, 'utf8')
  assert.match(body, /Human decision: keep the rollback window\./)
  assert.match(body, /quorum-task:scan:start/)
  assert.match(body, /quorum-task:ship:start/)
})

test('claude-mem capture is loopback-only and best effort', async () => {
  const calls = []
  const bridge = new MemoryBridge({ memUrl: 'https://example.invalid', fetchImpl: async (...args) => { calls.push(args); return { ok: true, status: 200, json: async () => ({}) } } })
  const result = await bridge.captureCloseout({ sessionId: 'session-1', closeout: 'bounded' })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, 'claude-mem-not-configured')
  assert.equal(calls.length, 0)
})

test('claude-mem capture initializes a bounded synthetic session before closeout', async () => {
  const calls = []
  const bridge = new MemoryBridge({ memUrl: 'http://127.0.0.1:37701', fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ status: 'queued' }) } } })
  const result = await bridge.captureCloseout({ sessionId: 'thread-1', closeout: 'completed', cwd: '/tmp/project' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/api/sessions/init', '/api/sessions/summarize'])
  assert.equal(calls[0].body.prompt, 'Quorum managed run closeout')
  assert.equal(calls[1].body.last_assistant_message, 'completed')
})

test('claude-mem probe records a reachable local endpoint without exposing response data', async () => {
  const bridge = new MemoryBridge({ memUrl: 'http://127.0.0.1:37701', fetchImpl: async url => ({ ok: true, status: 200, url }) })
  const status = await bridge.probe()
  assert.equal(status.claudeMem.state, 'ready')
  assert.equal(status.claudeMem.reachable, true)
  assert.equal(status.claudeMem.endpoint, '/health')
  assert.equal('body' in status.claudeMem, false)
})

test('bridge sync invokes the fixed review-first exporter with a bounded environment', async () => {
  let invocation
  const bridgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-memory-bridge-'))
  fs.mkdirSync(path.join(bridgeRoot, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(bridgeRoot, 'config.json'), '{}')
  fs.writeFileSync(path.join(bridgeRoot, 'scripts', 'sync-and-export.mjs'), '')
  const bridge = new MemoryBridge({ bridgeRoot, memUrl: 'http://127.0.0.1:37701', execFileImpl: async (...args) => {
    invocation = args
    return { stdout: JSON.stringify({ ok: true, heartbeat: true, sync: { newItems: 3, fetched: 8 }, ledger: { counts: { pending: 12 } }, reviewQueue: { pending: 12 }, statusPath: '/vault/status.md' }) }
  } })
  const result = await bridge.sync()
  assert.equal(result.ok, true)
  assert.equal(result.heartbeat, true)
  assert.equal(result.newItems, 3)
  assert.equal(result.pending, 12)
  assert.match(invocation[0], /node$/)
  assert.equal(invocation[1][0], path.join(bridgeRoot, 'scripts', 'sync-and-export.mjs'))
  assert.equal(invocation[1][1], '--config')
  assert.equal(invocation[1][2], path.join(bridgeRoot, 'config.json'))
  assert.equal(invocation[2].cwd, bridgeRoot)
  assert.deepEqual(invocation[2].env, { HOME: os.homedir(), PATH: process.env.PATH || '/usr/bin:/bin:/opt/homebrew/bin' })
})
