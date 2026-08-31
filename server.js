#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { State } from './src/state.js'
import { startProcesses } from './src/collectors/processes.js'
import { startSessions, TranscriptWatcher } from './src/collectors/sessions.js'
import { startServices, readAuth, resolveRoundtableAuth } from './src/collectors/services.js'
import { startSystem } from './src/collectors/system.js'
import { startProjects, resolveProjectId } from './src/collectors/projects.js'
import { startTasks } from './src/collectors/tasks.js'
import { startComposio } from './src/collectors/composio.js'
import { startAgents } from './src/collectors/agents.js'
import { startMemory } from './src/collectors/memory.js'
import { stampPresence } from './src/presence.js'
import { PtyManager } from './src/pty.js'
import { withinDir, isAllowedOrigin } from './src/util.js'
import { buildHealth } from './src/health.js'
import { publicCast } from './src/cast.js'
import { loadEdition, editionInfo } from './src/edition.js'
import { loadRuntimes, loadModels } from './src/config.js'
import { buildCatalog, publicCatalog, roundtableModelOptions } from './src/catalog.js'
import { executeAction, previewAction } from './src/command.js'
import { RoundtableRegistry, EST_COST_PER_TURN_USD, resolveModelRef } from './src/roundtable.js'
import { debateToMarkdown } from './src/decision-record.js'
import { buildOperations } from './src/operations.js'
import { AgentControlManager } from './src/agent-control/manager.js'
import { publicAgentPacks, resolveAgentPack } from './src/agents/packs.js'
import { runDoctor } from './src/agent-control/doctor.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const portIndex = process.argv.indexOf('--port')
const cliPort = portIndex >= 0 ? process.argv[portIndex + 1] : undefined
const PORT = Number(cliPort || process.env.PORT || 4747)
const PUB = path.join(__dirname, 'public')
const startedAt = Date.now()

// Vendored browser libs served straight from node_modules.
const VENDOR = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
}
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json',
}

const state = new State()
const ptys = new PtyManager(state)
const roundtables = new RoundtableRegistry(state)
const agentControl = new AgentControlManager()
roundtables.loadArchive()
const supervisedRuns = new Map()

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 200_000) throw new Error('request body too large')
  }
  return JSON.parse(body || '{}')
}

function refreshAgentControl() { state.update('agentControl', agentControl.snapshot()) }
refreshAgentControl()

function emitAgentEvent(type, run) {
  state.broadcast({ type, run: { id: run.runId, status: run.status, phase: run.phase, heartbeatAt: run.heartbeatAt, leaseExpiresAt: run.leaseExpiresAt, packId: run.packId, runtime: run.runtime } })
}

function superviseRun(run, rec) {
  rec.quorumRunId = run.runId
  const interval = Math.max(5000, (agentControl.policy.lease?.heartbeatSeconds || 120) * 1000)
  const timer = setInterval(() => {
    try { const updated = agentControl.heartbeat(run.runId, { phase: 'running' }); refreshAgentControl(); emitAgentEvent('agent.run.heartbeat', updated) }
    catch { clearInterval(timer); supervisedRuns.delete(run.runId) }
  }, interval)
  supervisedRuns.set(run.runId, { ptyId: rec.id, timer })
  emitAgentEvent('agent.run.created', run)
  rec.term.onExit(({ exitCode }) => {
    clearInterval(timer); supervisedRuns.delete(run.runId)
    try {
      const checkpoint = agentControl.checkpoint(run.runId, { reason: exitCode === 0 ? 'process-exit' : 'failure', phase: 'finished', verification: [`exit:${exitCode ?? 'unknown'}`] })
      emitAgentEvent('agent.run.checkpoint', agentControl.getRun(run.runId))
      const closed = agentControl.close(run.runId, { disposition: exitCode === 0 ? 'completed' : 'blocked', blockers: exitCode === 0 ? [] : [`process exit ${exitCode ?? 'unknown'}`], nextOwnerAction: exitCode === 0 ? '' : `inspect run ${run.runId} and resume with a new task` })
      refreshAgentControl(); emitAgentEvent('agent.run.closed', closed)
      void checkpoint
    } catch { /* closeout is best-effort after the PTY exits */ }
  })
}

function rejectForeignOrigin(req) {
  const origin = req.headers.origin
  return origin && !isAllowedOrigin(origin, PORT)
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost')
  if (u.pathname === '/health') {
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    return res.end(JSON.stringify(buildHealth(state.data, { startedAt })))
  }
  if (u.pathname === '/api/state') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ ...state.data, feed: state.feed, roundtables: roundtables.list() }, null, 1))
  }
  if (u.pathname === '/api/catalog') {
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    const catalog = buildCatalog()
    return res.end(JSON.stringify({ ...publicCatalog(catalog), agentPacks: publicAgentPacks({ runtimes: loadRuntimes(), modelOptions: roundtableModelOptions({ catalog }) }) }))
  }
  if (u.pathname === '/api/operations') {
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    return res.end(JSON.stringify(buildOperations(state.data, state.feed, ptys.list(), publicCatalog(buildCatalog()))))
  }
  if (u.pathname === '/api/agent-control/runs' && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(input => {
      const run = agentControl.createRun(input)
      if (input.action) agentControl.createAction(run.runId, { action: input.action, target: input.target })
      refreshAgentControl(); sendJson(res, 201, { run, control: agentControl.snapshot() })
    }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  if (u.pathname === '/api/agent-control/runs' || u.pathname === '/api/agent-control/claims') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    const snapshot = agentControl.snapshot()
    const key = u.pathname.endsWith('/runs') ? 'runs' : 'claims'
    return sendJson(res, 200, { policy: snapshot.policy, [key]: snapshot[key], actions: snapshot.actions })
  }
  if (u.pathname === '/api/agent-control/packs' && req.method === 'GET') {
    const catalog = buildCatalog()
    return sendJson(res, 200, { packs: publicAgentPacks({ runtimes: loadRuntimes(), modelOptions: roundtableModelOptions({ catalog }) }) })
  }
  if (u.pathname === '/api/agent-control/runtimes' && req.method === 'GET') {
    return sendJson(res, 200, { runtimes: loadRuntimes().map(runtime => ({ id: runtime.id, label: runtime.label, command: runtime.command, kind: runtime.kind || 'custom', provider: runtime.provider || runtime.id, promptMode: runtime.promptMode || 'stdin', modelDiscovery: runtime.modelDiscovery || 'none', builtin: runtime.builtin === true })) })
  }
  if (u.pathname === '/api/agent-control/doctor' && req.method === 'GET') {
    runDoctor().then(report => sendJson(res, 200, report)).catch(error => sendJson(res, 500, { error: String(error.message || error) }))
    return
  }
  const heartbeat = u.pathname.match(/^\/api\/agent-control\/runs\/([^/]+)\/heartbeat$/)
  if (heartbeat && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(input => { const run = agentControl.heartbeat(heartbeat[1], input); refreshAgentControl(); sendJson(res, 200, { run }) }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  const checkpoint = u.pathname.match(/^\/api\/agent-control\/runs\/([^/]+)\/checkpoint$/)
  if (checkpoint && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(input => { const record = agentControl.checkpoint(checkpoint[1], input); refreshAgentControl(); sendJson(res, 201, { checkpoint: record }) }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  const close = u.pathname.match(/^\/api\/agent-control\/runs\/([^/]+)\/close$/)
  if (close && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(input => { const run = agentControl.close(close[1], input); refreshAgentControl(); sendJson(res, 200, { run }) }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  const recover = u.pathname.match(/^\/api\/agent-control\/runs\/([^/]+)\/recover$/)
  if (recover && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    try {
      const replacements = agentControl.recover({ now: Date.now() })
      const replacement = replacements.find(run => run.parentTask === recover[1])
      if (!replacement) return sendJson(res, 409, { error: 'run is not yet eligible for recovery', runs: replacements })
      refreshAgentControl(); return sendJson(res, 201, { run: replacement })
    } catch (error) { return sendJson(res, 400, { error: String(error.message || error) }) }
  }
  const cancelRun = u.pathname.match(/^\/api\/agent-control\/runs\/([^/]+)\/cancel$/)
  if (cancelRun && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(input => { const supervised = supervisedRuns.get(cancelRun[1]); if (supervised) ptys.kill(supervised.ptyId); const run = agentControl.cancel(cancelRun[1], input); refreshAgentControl(); emitAgentEvent('agent.run.closed', run); sendJson(res, 200, { run }) }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  const actionRoute = u.pathname.match(/^\/api\/agent-control\/actions\/([^/]+)\/(approve|cancel)$/)
  if (actionRoute && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    Promise.resolve().then(() => actionRoute[2] === 'approve' ? agentControl.approveAction(actionRoute[1]) : agentControl.cancelAction(actionRoute[1])).then(action => { refreshAgentControl(); sendJson(res, 200, { action }) }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  if (u.pathname === '/api/command') {
    if (req.method !== 'POST') { res.statusCode = 405; return res.end('method not allowed') }
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        const input = JSON.parse(body || '{}')
        const catalog = buildCatalog()
        const preview = previewAction({ ...input, modelOptions: roundtableModelOptions({ catalog }) }, catalog, state, ptys)
        const result = input.confirm === true ? executeAction(preview, input, { state, ptys, startPty: (profile, roomId, launch) => {
          const room = (state.data.projects?.rooms || []).find(r => r.id === roomId)
          const pack = preview.packId ? resolveAgentPack(preview.packId) : null
          const run = pack ? agentControl.createRun({ runtime: profile, role: pack.role, packId: pack.id, modelRef: preview.modelRef, repoRoot: room?.cwd, worktree: room?.cwd, plannedActions: pack.capabilities, requiredGates: pack.gates }) : null
          const rec = ptys.create(profile, room?.cwd, 120, 30, launch?.shellCommand || null, run ? { QUORUM_AGENT_PACK: pack.id, QUORUM_AGENT_RUN_ID: run.runId } : {})
          if (run) {
            superviseRun(run, rec); refreshAgentControl()
          }
          try { stampPresence({ projectId: room?.id, agent: profile, ptyId: rec.id, cwd: rec.cwd }) } catch { /* best-effort */ }
          return rec
        } }) : { ok: false, requiresConfirmation: true }
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ preview, ...result }))
      } catch (error) {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ error: String(error.message || error) }))
      }
    })
    return
  }
  // A debate is only worth what survives it, so every table is exportable as a
  // decision record you can drop into a repo or a vault next to the code.
  if (u.pathname.startsWith('/api/roundtable/')) {
    const id = u.pathname.slice('/api/roundtable/'.length).replace(/\.md$/, '')
    const all = roundtables.list()
    const debate = [...all.live, ...all.recent].find(d => d.id === id)
    if (!debate) { res.statusCode = 404; return res.end('no such roundtable') }
    res.setHeader('content-type', 'text/markdown; charset=utf-8')
    res.setHeader('content-disposition', `attachment; filename="${id}.md"`)
    return res.end(debateToMarkdown(debate))
  }
  let file = null
  if (VENDOR[u.pathname]) {
    file = path.join(__dirname, VENDOR[u.pathname])
  } else {
    const p = u.pathname === '/' ? '/index.html' : u.pathname
    const resolved = path.normalize(path.join(PUB, p))
    if (withinDir(resolved, PUB)) file = resolved
  }
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404
    return res.end('not found')
  }
  res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream')
  fs.createReadStream(file).pipe(res)
})

// Loopback binding alone does not gate this socket: WebSocket handshakes are
// exempt from the Same-Origin Policy, so any page open in the browser could
// otherwise connect and drive `pty.create`/`pty.input` — arbitrary local code
// execution. Reject every handshake whose Origin is not our own page.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ origin }) => isAllowedOrigin(origin, PORT),
})

let startupErrorHandled = false
function failStartup(error) {
  if (startupErrorHandled) return
  startupErrorHandled = true
  if (error?.code === 'EADDRINUSE') {
    console.error(`Quorum cannot start: 127.0.0.1:${PORT} is already in use. Stop the duplicate local instance, then retry.`)
  } else {
    console.error(`Quorum failed to start: ${error?.message || error}`)
  }
  process.exitCode = 1
  setImmediate(() => process.exit(1))
}
server.once('error', failStartup)
wss.once('error', failStartup)

wss.on('connection', ws => {
  state.clients.add(ws)
  ws.send(JSON.stringify(state.snapshot()))
  ws.send(JSON.stringify({ type: 'pty.list', ptys: ptys.list() }))
  // The cast is static for the life of the process, so it rides the handshake
  // rather than the 2s collector tick.
  // Launchable runtimes + debate models, built-ins plus the user's config —
  // the client renders its buttons and pickers from these, never a hardcoded
  // list, so adding a validated runtime is the integration story.
  const catalog = buildCatalog()
  ws.send(JSON.stringify({
    type: 'cast',
    cast: publicCast(editionInfo().locked),
    edition: editionInfo(),
    estCostPerTurnUsd: EST_COST_PER_TURN_USD,
    runtimes: loadRuntimes().map(r => ({ id: r.id, label: r.label, builtin: !!r.builtin })),
    models: loadModels(),
    modelOptions: roundtableModelOptions({ catalog }),
    catalog: { ...publicCatalog(catalog), agentPacks: publicAgentPacks({ runtimes: loadRuntimes(), modelOptions: roundtableModelOptions({ catalog }) }) },
  }))
  ws.send(JSON.stringify({ type: 'rt.list', ...roundtables.list() }))
  ws.send(JSON.stringify({ type: 'agent-control.runtimes', runtimes: loadRuntimes().map(runtime => ({ id: runtime.id, label: runtime.label, kind: runtime.kind || 'custom', provider: runtime.provider || runtime.id, builtin: runtime.builtin === true })) }))
  const watcher = new TranscriptWatcher(ws)

  ws.on('message', raw => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    try { handle(ws, m, watcher) } catch (e) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', error: String(e.message || e) }))
    }
  })
  ws.on('close', () => {
    state.clients.delete(ws)
    watcher.stop()
    ptys.detachAll(ws)
  })
})

function handle(ws, m, watcher) {
  switch (m.type) {
    case 'pty.create': {
      const rec = ptys.create(m.profile, m.cwd, m.cols, m.rows)
      const projectId = m.projectId || resolveProjectId(m.cwd)
      try {
        stampPresence({ projectId, agent: m.profile, ptyId: rec.id, cwd: rec.cwd })
      } catch { /* presence is best-effort */ }
      ptys.attach(rec.id, ws)
      break
    }
    case 'chat.open': {
      const id = openChat(ws, m)
      ptys.attach(id, ws)
      // The client must know which pty carries this chat: pty.attach does not
      // identify the request, and typing into the wrong terminal would run the
      // message as a shell command.
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: 'chat.opened', id, requestId: String(m.requestId || '') }))
      break
    }
    case 'pty.attach': ptys.attach(m.id, ws); break
    case 'pty.input': ptys.input(m.id, m.data); break
    case 'pty.resize': ptys.resize(m.id, m.cols, m.rows); break
    case 'pty.kill': ptys.kill(m.id); break
    case 'watch': watcher.watch(m.file, m.agent); break
    case 'unwatch': watcher.stop(); break
    case 'proc.kill': killProc(m.pid); break
    case 'rt.start': startRoundtable(m); break
    case 'rt.cancel': roundtables.cancel(String(m.id || '')); break
    case 'command.preview': {
      const catalog = buildCatalog()
      const preview = previewAction({ ...m, modelOptions: roundtableModelOptions({ catalog }) }, catalog, state, ptys)
      ws.send(JSON.stringify({ type: 'command.preview', preview }))
      break
    }
    case 'command.execute': {
      const catalog = buildCatalog()
      const preview = previewAction({ ...m, modelOptions: roundtableModelOptions({ catalog }) }, catalog, state, ptys)
      const result = executeAction(preview, m, { state, ptys, startPty: (profile, roomId, launch) => {
        const room = (state.data.projects?.rooms || []).find(r => r.id === roomId)
        if (!room) throw new Error('unknown project room')
        const pack = preview.packId ? resolveAgentPack(preview.packId) : null
        const run = pack ? agentControl.createRun({ runtime: profile, role: pack.role, packId: pack.id, modelRef: preview.modelRef, repoRoot: room.cwd, worktree: room.cwd, plannedActions: pack.capabilities, requiredGates: pack.gates }) : null
        const rec = ptys.create(profile, room.cwd, m.cols || 120, m.rows || 30, launch?.shellCommand || null, run ? { QUORUM_AGENT_PACK: pack.id, QUORUM_AGENT_RUN_ID: run.runId } : {})
        if (run) {
          superviseRun(run, rec); refreshAgentControl()
        }
        ptys.attach(rec.id, ws)
        return rec
      } })
      ws.send(JSON.stringify({ type: 'command.done', preview, result }))
      break
    }
    case 'agent-control.heartbeat': {
      const run = agentControl.heartbeat(String(m.runId || ''), { phase: m.phase }); refreshAgentControl(); emitAgentEvent('agent.run.heartbeat', run); ws.send(JSON.stringify({ type: 'agent-control.updated', run })); break
    }
    case 'agent-control.checkpoint': {
      const record = agentControl.checkpoint(String(m.runId || ''), m); refreshAgentControl(); emitAgentEvent('agent.run.checkpoint', agentControl.getRun(record.runId)); ws.send(JSON.stringify({ type: 'agent-control.checkpoint', checkpoint: record })); break
    }
    case 'agent-control.close': {
      const run = agentControl.close(String(m.runId || ''), m); refreshAgentControl(); emitAgentEvent('agent.run.closed', run); ws.send(JSON.stringify({ type: 'agent-control.updated', run })); break
    }
    case 'agent-control.cancel': {
      const runId = String(m.runId || '')
      const supervised = supervisedRuns.get(runId)
      if (supervised) ptys.kill(supervised.ptyId)
      const run = agentControl.cancel(runId, m); refreshAgentControl(); emitAgentEvent('agent.run.closed', run); ws.send(JSON.stringify({ type: 'agent-control.updated', run })); break
    }
    case 'agent-control.approve': {
      const action = agentControl.approveAction(String(m.actionId || '')); refreshAgentControl(); ws.send(JSON.stringify({ type: 'agent-control.action', action })); break
    }
  }
}

// A debate spends real money on every turn, so the room is resolved from the
// server-side catalog rather than trusting a client-supplied cwd — the same
// reason pty.create resolves projects itself.
function startRoundtable(m) {
  // A locked character would otherwise be silently dropped by the Roundtable
  // constructor, and the user would watch a three-seat debate run with two
  // seats and no explanation.
  const locked = new Set(editionInfo().locked.map(c => c.id))
  const asked = (Array.isArray(m.participants) ? m.participants : []).map(String)
  const blocked = asked.filter(id => locked.has(id))
  if (blocked.length)
    throw new Error(`${blocked.join(', ')} ${blocked.length > 1 ? 'are' : 'is'} part of Quorum Pro — unlock or seat someone else`)

  const catalog = buildCatalog()
  const selection = resolveModelRef(m.model || 'claude:sonnet')
  const option = roundtableModelOptions({ catalog }).find(item => item.id === selection.ref)
  if (!option) throw new Error(`${selection.ref} is not configured for roundtables`)
  if (!option.available) throw new Error(`${option.label} is not available in the Quorum launch environment`)

  const room = (state.data.projects?.catalog || []).find(r => r.id === m.roomId) || null
  // Resolve auth at the spend boundary, rather than trusting the five-second
  // collector snapshot or a browser-provided claim. The function returns only
  // a mode label, never a credential.
  const authMode = selection.provider === 'claude' ? resolveRoundtableAuth(readAuth(), m.authMode) : 'local'
  const rt = roundtables.start({
    topic: m.topic,
    roomId: room?.id || null,
    roomLabel: room?.label || 'the workspace',
    cwd: room?.cwd || null,
    participants: m.participants,
    model: selection.ref,
    authMode,
  })
  return rt
}

// Chat with an already-running agent by resuming its session in a PTY.
//
// The live session registry exposes a unix socket per session, but that protocol
// is undocumented and version-gated (desktop-launched sessions expose no socket
// at all), so writing to it risks corrupting a session mid-task. `claude --resume`
// is the documented path and reaches the same conversation.
//
// One resumed pty per session: `claude --resume` is not idempotent, so a
// double-submit must reuse the open terminal rather than start a second process
// racing the first against the same transcript.
const chatPtys = new Map()

function openChat(ws, m) {
  const sessionId = String(m.sessionId || '')
  // Whitelist against live agents — the id must be one we actually observed, and
  // must look like a UUID. It is never interpolated as free text.
  if (!/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) throw new Error('invalid sessionId')
  const agent = (state.data.agents?.agents || []).find(a => a.sessionId === sessionId)
  if (!agent) throw new Error(`session ${sessionId} is not a live agent`)

  const open = chatPtys.get(sessionId)
  if (open && ptys.list().some(p => p.id === open && !p.exited)) return open

  const rec = ptys.create('claude', agent.cwd, m.cols, m.rows, `claude --resume ${sessionId}`)
  chatPtys.set(sessionId, rec.id)
  try {
    stampPresence({ projectId: agent.projectId, agent: 'claude', ptyId: rec.id, cwd: rec.cwd })
  } catch { /* presence is best-effort */ }
  state.event({ kind: 'spawn', text: `chat → resumed ${agent.name} (${sessionId.slice(0, 8)})` })
  return rec.id
}

// Safe control: only SIGTERM, and only pids currently classified as AI processes.
function killProc(pid) {
  pid = Number(pid)
  const p = (state.data.processes?.procs || []).find(x => x.pid === pid)
  if (!p) throw new Error(`pid ${pid} is not in the tracked AI process list`)
  process.kill(pid, 'SIGTERM')
  state.event({ kind: 'kill', text: `SIGTERM → ${p.name} (${pid})` })
}

startProcesses(state)
startSessions(state)
startServices(state)
startSystem(state)
startProjects(state)
startTasks(state)
startComposio(state)
startAgents(state)
startMemory(state)

// The edition is resolved before the socket opens: a client that connected
// mid-load would cache a free cast for the life of the page and a paying user
// would see their Pro characters greyed out until they reloaded.
const edition = await loadEdition()

// Loopback only — this server can spawn terminals; it must never listen beyond localhost.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Quorum (${edition.tier}) → http://127.0.0.1:${PORT}`)
  if (edition.tier !== 'pro') console.log(`  free edition — ${edition.reason}`)
  else if (edition.customCount) console.log(`  ${edition.customCount} custom character(s) loaded`)
})
