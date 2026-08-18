#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { State } from './src/state.js'
import { startProcesses } from './src/collectors/processes.js'
import { startSessions, TranscriptWatcher } from './src/collectors/sessions.js'
import { startServices } from './src/collectors/services.js'
import { startSystem } from './src/collectors/system.js'
import { startProjects, resolveProjectId } from './src/collectors/projects.js'
import { startTasks } from './src/collectors/tasks.js'
import { startComposio } from './src/collectors/composio.js'
import { startAgents } from './src/collectors/agents.js'
import { stampPresence } from './src/presence.js'
import { PtyManager } from './src/pty.js'
import { withinDir, isAllowedOrigin } from './src/util.js'
import { buildHealth } from './src/health.js'
import { publicCast } from './src/cast.js'
import { loadEdition, editionInfo } from './src/edition.js'
import { RoundtableRegistry, EST_COST_PER_TURN_USD } from './src/roundtable.js'
import { debateToMarkdown } from './src/decision-record.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 4747)
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
roundtables.loadArchive()

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

wss.on('connection', ws => {
  state.clients.add(ws)
  ws.send(JSON.stringify(state.snapshot()))
  ws.send(JSON.stringify({ type: 'pty.list', ptys: ptys.list() }))
  // The cast is static for the life of the process, so it rides the handshake
  // rather than the 2s collector tick.
  ws.send(JSON.stringify({
    type: 'cast',
    cast: publicCast(editionInfo().locked),
    edition: editionInfo(),
    estCostPerTurnUsd: EST_COST_PER_TURN_USD,
  }))
  ws.send(JSON.stringify({ type: 'rt.list', ...roundtables.list() }))
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

  const room = (state.data.projects?.catalog || []).find(r => r.id === m.roomId) || null
  const rt = roundtables.start({
    topic: m.topic,
    roomId: room?.id || null,
    roomLabel: room?.label || 'the workspace',
    cwd: room?.cwd || null,
    participants: m.participants,
    model: m.model,
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
