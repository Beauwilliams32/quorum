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
import { startArtifacts, reindexArtifacts, searchArtifacts, readArtifact, openArtifact, openDirectory } from './src/artifacts.js'
import { MissionStore, publicMission } from './src/missions.js'
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
import { buildMcpRegistry, buildTaskRegistry, buildToolRegistry, buildWorkspaceRegistry } from './src/registry.js'
import { MemoryBridge } from './src/memory-bridge.js'
import { RuntimeManager } from './src/runtime-manager.js'
import { listServices, platformCapabilities, ProcessController } from './src/platform-control.js'
import { StandingJobScheduler } from './src/standing-jobs.js'
import { buildCityState } from './src/city-state.js'
import { OpenClawBridge } from './src/openclaw-bridge.js'
import { repurposeVideo as runPipelineRepurpose, verifyVideo as runPipelineVerify, generateVariants as runPipelineVariants, fetchAsset as runPipelineAsset, newJobId } from './scripts/pipeline/pipeline.mjs'

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
  '/vendor/three.module.js': 'node_modules/three/build/three.module.js',
  '/vendor/three.core.js': 'node_modules/three/build/three.core.js',
}
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.map': 'application/json',
}

const state = new State()
const ptys = new PtyManager(state)
const roundtables = new RoundtableRegistry(state)
const agentControl = new AgentControlManager()
const missions = new MissionStore()
const memoryBridge = new MemoryBridge()
const runtimeManager = new RuntimeManager({ agentControl, missions, memoryBridge, state })
const processController = new ProcessController({ resolveProcess: pid => (state.data.processes?.inventory || []).find(item => item.pid === Number(pid)) || null })
const standingJobs = new StandingJobScheduler()
const pipelineJobs = new Map()
const PIPELINE_JOB_LIMIT = 50
let platformServices = []
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

function refreshMissions() {
  state.update('missions', { missions: missions.list().map(publicMission), ts: Date.now() })
}
refreshMissions()
state.update('runtimeRuns', { runs: runtimeManager.snapshot(), ts: Date.now() })
state.update('memoryBridge', memoryBridge.status())
state.update('standingJobs', standingJobs.snapshot())

function refreshCity() { state.update('city', buildCityState(state.data, standingJobs.snapshot(), platformServices)) }
async function refreshPlatformServices() { platformServices = await listServices(); state.update('platformServices', { schemaVersion: 1, services: platformServices, capabilities: platformCapabilities(), ts: Date.now() }); refreshCity() }
const openclawBridge = new OpenClawBridge({
  onUpdate: snapshot => { state.update('openclaw', snapshot); refreshCity() },
  onEvent: event => state.event({ kind: 'openclaw', text: event.summary }),
})
state.update('openclaw', openclawBridge.snapshot())
void openclawBridge.start()
standingJobs.register('runtime-health', async () => ({ attention: !(state.data.services?.claude?.up || state.data.processes?.groups?.codex), detail: 'runtime inventory checked' }))
standingJobs.register('daemon-health', async () => ({ attention: platformServices.some(item => item.state === 'error'), detail: `${platformServices.length} services observed` }))
standingJobs.register('memory-maintenance', async () => ({ attention: !state.data.memory?.ok, detail: state.data.memory?.ok ? 'memory index healthy' : 'memory index needs attention' }))
standingJobs.register('failed-run-recovery', async () => { const recovered = agentControl.recover({ now: Date.now() }); if (recovered.length) refreshAgentControl(); return { attention: recovered.length > 0, detail: recovered.length ? `${recovered.length} recovery lease created` : 'no stale runs' } })
standingJobs.start(snapshot => { state.update('standingJobs', snapshot); refreshCity() })
void refreshPlatformServices()
setInterval(() => { void refreshPlatformServices() }, 30_000).unref?.()

async function refreshMemoryBridge() {
  const status = await memoryBridge.probe()
  state.update('memoryBridge', status)
  return status
}

void refreshMemoryBridge()
setInterval(() => { void refreshMemoryBridge() }, 15_000)

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
  if (u.pathname === '/api/openclaw/status' && req.method === 'GET') return sendJson(res, 200, openclawBridge.status())
  if (u.pathname === '/api/openclaw/snapshot' && req.method === 'GET') return sendJson(res, 200, openclawBridge.snapshot())
  if (u.pathname === '/api/openclaw/events' && req.method === 'GET') return sendJson(res, 200, { schemaVersion: 1, events: openclawBridge.snapshot().projection.events, ts: Date.now() })
  if (u.pathname === '/api/openclaw/connect' && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    openclawBridge.connect()
    return sendJson(res, 202, { status: openclawBridge.status() })
  }
  if (u.pathname === '/api/openclaw/actions/preview' && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(input => sendJson(res, 201, { preview: openclawBridge.previewAction(input) })).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  if (u.pathname === '/api/openclaw/actions/confirm' && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(input => openclawBridge.confirmAction(input.previewId)).then(action => sendJson(res, 200, { action })).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  if (u.pathname === '/api/catalog') {
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    const catalog = buildCatalog()
    return res.end(JSON.stringify({ ...publicCatalog(catalog), agentPacks: publicAgentPacks({ runtimes: loadRuntimes(), modelOptions: roundtableModelOptions({ catalog }) }) }))
  }
  if (u.pathname === '/api/agents' && req.method === 'GET') {
    return sendJson(res, 200, state.data.agents || { agents: [], ts: Date.now() })
  }
  if (u.pathname === '/api/workspaces' && req.method === 'GET') {
    return sendJson(res, 200, { workspaces: buildWorkspaceRegistry(state.data, missions.list().map(publicMission)), ts: Date.now() })
  }
  if (u.pathname === '/api/tasks' && req.method === 'GET') {
    return sendJson(res, 200, { tasks: buildTaskRegistry(missions.list().map(publicMission)), ts: Date.now() })
  }
  if (u.pathname === '/api/tools' && req.method === 'GET') {
    return sendJson(res, 200, { tools: buildToolRegistry(state.data, buildCatalog()), ts: Date.now() })
  }
  if (u.pathname === '/api/mcp' && req.method === 'GET') {
    return sendJson(res, 200, { servers: buildMcpRegistry(state.data), ts: Date.now() })
  }
  if (u.pathname === '/api/platform' && req.method === 'GET') return sendJson(res, 200, { schemaVersion: 1, capabilities: platformCapabilities(), services: platformServices, ts: Date.now() })
  if (u.pathname === '/api/processes' && req.method === 'GET') return sendJson(res, 200, { schemaVersion: 1, processes: state.data.processes?.inventory || [], capabilities: state.data.processes?.capabilities || platformCapabilities(), control: processController.snapshot(), ts: Date.now() })
  if (u.pathname === '/api/city' && req.method === 'GET') return sendJson(res, 200, buildCityState(state.data, standingJobs.snapshot(), platformServices))
  if (u.pathname === '/api/standing-jobs' && req.method === 'GET') return sendJson(res, 200, standingJobs.snapshot())
  const standingJobRoute = u.pathname.match(/^\/api\/standing-jobs\/([^/]+)\/(run|suspend|resume)$/)
  if (standingJobRoute && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    const [jobId, action] = standingJobRoute.slice(1)
    Promise.resolve(action === 'run' ? standingJobs.run(jobId, snapshot => state.update('standingJobs', snapshot)) : standingJobs.suspend(jobId, action === 'suspend')).then(job => { state.update('standingJobs', standingJobs.snapshot()); refreshCity(); sendJson(res, 200, { job, scheduler: standingJobs.snapshot() }) }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  if (u.pathname === '/api/process-actions/preview' && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(input => { const proc = (state.data.processes?.inventory || []).find(item => item.id === input.processId || item.pid === Number(input.pid)); return sendJson(res, 201, { preview: processController.preview(input, proc) }) }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  if (u.pathname === '/api/process-actions/confirm' && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(input => { const action = processController.confirm(input.previewId); state.event({ kind: 'process-control', text: `${action.signal} → ${action.target.name} (${action.target.pid})` }); return sendJson(res, 200, { action }) }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  if (u.pathname === '/api/artifacts/search' && req.method === 'GET') {
    return sendJson(res, 200, searchArtifacts(u.searchParams.get('q') || '', { source: u.searchParams.get('source') || '', limit: u.searchParams.get('limit') || 40 }))
  }
  if (u.pathname === '/api/memory' && req.method === 'GET') {
    return sendJson(res, 200, searchArtifacts(u.searchParams.get('q') || '', { source: u.searchParams.get('source') || '', limit: u.searchParams.get('limit') || 40 }))
  }
  if (u.pathname === '/api/memory/status' && req.method === 'GET') {
    refreshMemoryBridge().then(status => sendJson(res, 200, status)).catch(error => sendJson(res, 500, { error: String(error.message || error), ...memoryBridge.status() }))
    return
  }
  if (u.pathname === '/api/memory/recall' && req.method === 'GET') {
    const query = u.searchParams.get('q') || ''
    memoryBridge.recall(query, { limit: u.searchParams.get('limit') || 8 }).then(context => sendJson(res, 200, { query: query.slice(0, 200), context, bridge: memoryBridge.status(), ts: Date.now() })).catch(error => sendJson(res, 500, { error: String(error.message || error) }))
    return
  }
  if (u.pathname === '/api/memory/sync' && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    Promise.all([reindexArtifacts(), refreshMemoryBridge()]).then(async ([artifacts, bridgeBeforeSync]) => {
      const sync = bridgeBeforeSync.claudeMem.reachable
        ? await memoryBridge.sync()
        : { ok: false, state: bridgeBeforeSync.claudeMem.state, error: 'claude-mem endpoint is not reachable' }
      const bridge = await refreshMemoryBridge()
      const bridgeLabel = sync.ok ? `bridge +${sync.newItems} new` : `bridge ${bridge.claudeMem.state}`
      state.event({ kind: 'memory', text: `memory sync → ${artifacts.stats.total} indexed artifacts · ${bridgeLabel}` })
      return sendJson(res, 200, { artifacts, bridge, sync, syncedAt: new Date().toISOString() })
    }).catch(error => sendJson(res, 500, { error: String(error.message || error) }))
    return
  }
  if (u.pathname === '/api/artifacts/reindex' && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    reindexArtifacts().then(result => sendJson(res, 200, result)).catch(error => sendJson(res, 500, { error: String(error.message || error) }))
    return
  }
  const artifactRoute = u.pathname.match(/^\/api\/artifacts\/([a-f0-9]{24})$/)
  if (artifactRoute && req.method === 'GET') {
    try { return sendJson(res, 200, readArtifact(artifactRoute[1])) } catch (error) { return sendJson(res, 404, { error: String(error.message || error) }) }
  }
  const artifactOpenRoute = u.pathname.match(/^\/api\/artifacts\/([a-f0-9]{24})\/(open|reveal)$/)
  if (artifactOpenRoute && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    try { return sendJson(res, 200, openArtifact(artifactOpenRoute[1], artifactOpenRoute[2] === 'reveal' ? 'reveal' : 'default')) } catch (error) { return sendJson(res, 400, { error: String(error.message || error) }) }
  }
  const projectOpenRoute = u.pathname.match(/^\/api\/projects\/([^/]+)\/(open|reveal)$/)
  if (projectOpenRoute && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    let projectId
    try { projectId = decodeURIComponent(projectOpenRoute[1]) } catch { return sendJson(res, 400, { error: 'invalid project id' }) }
    const room = (state.data.projects?.rooms || []).find(item => item.id === projectId)
    if (!room) return sendJson(res, 404, { error: 'unknown project' })
    try { return sendJson(res, 200, openDirectory(room.cwd, projectOpenRoute[2] === 'reveal' ? 'reveal' : 'default', [{ id: projectId, path: room.cwd }])) } catch (error) { return sendJson(res, 400, { error: String(error.message || error) }) }
  }
  if (u.pathname === '/api/missions' && req.method === 'GET') {
    return sendJson(res, 200, { missions: missions.list().map(publicMission) })
  }
  if (u.pathname === '/api/missions' && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(input => {
      const mission = missions.create(input)
      refreshMissions(); state.event({ kind: 'mission', text: `mission created → ${mission.title}` })
      sendJson(res, 201, { mission: publicMission(mission) })
    }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  const missionTaskDispatch = u.pathname.match(/^\/api\/missions\/([^/]+)\/tasks\/([^/]+)\/dispatch$/)
  if (missionTaskDispatch && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(async input => {
      const [missionId, taskId] = missionTaskDispatch.slice(1)
      const mission = missions.get(missionId)
      if (!mission) throw new Error('unknown mission')
      const task = mission.tasks.find(item => item.id === taskId)
      if (!task) throw new Error('unknown mission task')
      if (!missions.readyTasks(missionId).some(item => item.id === taskId) && task.status !== 'working') throw new Error('task is blocked by incomplete dependencies')
      const room = (state.data.projects?.rooms || []).find(item => item.id === (input.roomId || task.roomId))
      if (!room) throw new Error('unknown project room')
      const worktree = path.resolve(String(input.worktree || task.worktree || room.cwd))
      if (!fs.existsSync(worktree) || !fs.statSync(worktree).isDirectory()) throw new Error('worktree directory does not exist')
      const catalog = buildCatalog()
      const preview = previewAction({
        action: 'launch',
        runtimeId: input.runtimeId || task.runtimeId || 'codex',
        roomId: input.roomId || task.roomId,
        packId: input.packId || task.packId || 'builder',
        modelRef: input.modelRef || task.modelRef || undefined,
        task: input.task || task.description || task.title,
        modelOptions: roundtableModelOptions({ catalog }),
      }, catalog, state, ptys)
      if (input.confirm !== true) return sendJson(res, 200, { requiresConfirmation: true, mission: publicMission(mission), task, preview })
      if (input.managed === true) {
        const pack = resolveAgentPack(input.packId || task.packId || preview.packId || 'builder')
        const started = await runtimeManager.start({ missionId, taskId, runtime: input.runtimeId || task.runtimeId || 'codex', role: input.role || pack.role, cwd: room.cwd, worktree, branch: input.branch || task.branch || room.branch, task: input.task || task.description || task.title, packId: pack.id, modelRef: input.modelRef || task.modelRef || preview.modelRef })
        refreshAgentControl(); refreshMissions()
        return sendJson(res, 202, { ...started, mission: publicMission(missions.get(mission.id)), task: missions.get(mission.id)?.tasks.find(item => item.id === task.id), memory: memoryBridge.status() })
      }
      const result = executeAction(preview, { ...input, roomId: preview.roomId, confirm: true }, { state, ptys, startPty: (profile, roomId, launch) => {
        const pack = preview.packId ? resolveAgentPack(preview.packId) : null
        const run = pack ? agentControl.createRun({ runtime: profile, role: pack.role, packId: pack.id, modelRef: preview.modelRef, repoRoot: room.cwd, worktree, branch: input.branch || task.branch, plannedActions: pack.capabilities, requiredGates: pack.gates, parentTask: task.id }) : null
        const rec = ptys.create(profile, worktree, 120, 30, launch?.shellCommand || null, run ? { QUORUM_AGENT_PACK: pack.id, QUORUM_AGENT_RUN_ID: run.runId, QUORUM_MISSION_ID: mission.id, QUORUM_TASK_ID: task.id } : {})
        if (run) { superviseRun(run, rec); refreshAgentControl() }
        rec.term.onExit(({ exitCode }) => {
          try {
            if (missions.get(mission.id)?.tasks.find(item => item.id === task.id)?.status === 'cancelled') return
            missions.setTask(mission.id, task.id, { status: exitCode === 0 ? 'completed' : 'failed', ptyId: rec.id, error: exitCode === 0 ? null : `process exit ${exitCode ?? 'unknown'}` })
            refreshMissions(); state.event({ kind: 'mission', text: `task ${task.id} ${exitCode === 0 ? 'completed' : 'failed'} → ${mission.title}` })
          } catch { /* the process exit must never crash the cockpit */ }
        })
        missions.setTask(mission.id, task.id, { status: 'working', ptyId: rec.id, worktree, branch: input.branch || task.branch, startedAt: new Date().toISOString() })
        missions.event(mission.id, 'TASK_STARTED', `${task.title} → ${profile}`)
        refreshMissions()
        return rec
      } })
      return sendJson(res, 200, { ...result, mission: publicMission(missions.get(mission.id)), task: missions.get(mission.id)?.tasks.find(item => item.id === task.id) })
    }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  const missionRoute = u.pathname.match(/^\/api\/missions\/([^/]+)$/)
  if (missionRoute && req.method === 'GET') {
    const mission = missions.get(missionRoute[1])
    return mission ? sendJson(res, 200, { mission: publicMission(mission), readyTasks: missions.readyTasks(mission.id).map(task => task.id) }) : sendJson(res, 404, { error: 'unknown mission' })
  }
  if (missionRoute && req.method === 'PATCH') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(input => { const mission = missions.update(missionRoute[1], input); refreshMissions(); sendJson(res, 200, { mission: publicMission(mission) }) }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  const missionCancel = u.pathname.match(/^\/api\/missions\/([^/]+)\/(cancel|stop)$/)
  if (missionCancel && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    try {
      const mission = missions.update(missionCancel[1], { status: 'cancelled' })
      runtimeManager.cancelMission(mission.id)
      for (const task of mission.tasks) {
        if (task.status === 'working' && task.ptyId) ptys.kill(task.ptyId)
        if (['queued', 'ready', 'working'].includes(task.status)) missions.setTask(mission.id, task.id, { status: 'cancelled' })
      }
      const updated = missions.event(mission.id, 'MISSION_CANCELLED', 'cancelled by operator')
      refreshMissions(); state.event({ kind: 'mission', text: `mission cancelled → ${updated.title}` })
      return sendJson(res, 200, { mission: publicMission(updated) })
    } catch (error) { return sendJson(res, 400, { error: String(error.message || error) }) }
  }
  if (u.pathname === '/api/runtime-runs' && req.method === 'GET') {
    return sendJson(res, 200, { runs: runtimeManager.snapshot(), memory: memoryBridge.status(), ts: Date.now() })
  }
  const runtimeEvents = u.pathname.match(/^\/api\/runtime-runs\/([^/]+)\/events$/)
  if (runtimeEvents && req.method === 'GET') return sendJson(res, 200, { runId: runtimeEvents[1], events: runtimeManager.events(runtimeEvents[1]) })
  const runtimeAction = u.pathname.match(/^\/api\/runtime-runs\/([^/]+)\/(pause|resume|cancel)$/)
  if (runtimeAction && req.method === 'POST') {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    try {
      const [runId, action] = runtimeAction.slice(1)
      const run = action === 'pause' ? runtimeManager.pause(runId) : action === 'resume' ? runtimeManager.resume(runId) : runtimeManager.cancel(runId)
      refreshAgentControl(); refreshMissions()
      return sendJson(res, 200, { run })
    } catch (error) { return sendJson(res, 400, { error: String(error.message || error) }) }
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
  // Content Repurposing Pipeline — local ffmpeg jobs that turn a landscape
  // source into vertical shorts and verify the output. Jobs run async because
  // ffmpeg is synchronous and CPU-bound; callers poll for status.
  const pipelineStartRoute = u.pathname === '/api/pipeline/repurpose' && req.method === 'POST'
  if (pipelineStartRoute) {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(input => {
      if (!input || typeof input !== 'object') throw new Error('expected a JSON object')
      if (!input.input) throw new Error('input is required')
      if (input.segments == null) throw new Error('segments is required')
      const jobId = newJobId()
      const job = {
        jobId,
        status: 'queued',
        input: input.input,
        segmentsCount: Array.isArray(input.segments) ? input.segments.length : null,
        submittedAt: Date.now(),
        events: [],
      }
      pipelineJobs.set(jobId, job)
      if (pipelineJobs.size > PIPELINE_JOB_LIMIT) {
        const oldest = [...pipelineJobs.entries()].sort((a, b) => a[1].submittedAt - b[1].submittedAt)[0]
        if (oldest) pipelineJobs.delete(oldest[0])
      }
      state.event({ kind: 'pipeline', text: `pipeline repurpose queued → ${path.basename(String(input.input))} (${job.segmentsCount ?? '?'} segments)` })
      // Fire the work without blocking the HTTP response. Failures land on the
      // job record so a later poll surfaces them with the same shape as success.
      runPipelineRepurpose({ input: input.input, segments: input.segments, jobId })
        .then(result => {
          job.status = result.allPassed ? 'completed' : 'completed_with_failures'
          job.result = result
          job.finishedAt = Date.now()
          state.event({ kind: 'pipeline', text: `pipeline repurpose ${job.status} → ${result.segments} shorts` })
        })
        .catch(error => {
          job.status = 'failed'
          job.error = String(error.message || error)
          job.finishedAt = Date.now()
          state.event({ kind: 'pipeline', text: `pipeline repurpose failed → ${job.error}` })
        })
      return sendJson(res, 202, { jobId, status: job.status, submittedAt: job.submittedAt })
    }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  const pipelineStatusRoute = u.pathname.match(/^\/api\/pipeline\/repurpose\/([^/]+)$/)
  if (pipelineStatusRoute && req.method === 'GET') {
    const job = pipelineJobs.get(pipelineStatusRoute[1])
    if (!job) return sendJson(res, 404, { error: 'unknown job' })
    return sendJson(res, 200, job)
  }
  const pipelineVerifyRoute = u.pathname === '/api/pipeline/verify' && req.method === 'POST'
  if (pipelineVerifyRoute) {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(async input => {
      if (!input || !input.path) throw new Error('path is required')
      const result = await runPipelineVerify(input.path)
      return sendJson(res, 200, result)
    }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  const pipelineVariantsRoute = u.pathname === '/api/pipeline/variants' && req.method === 'POST'
  if (pipelineVariantsRoute) {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(async input => {
      if (!input || !input.input) throw new Error('input is required')
      const job = { status: 'pending', submittedAt: Date.now(), input: { input: input.input, count: input.count || 25 } }
      const jobId = newJobId()
      pipelineJobs.set(jobId, { ...job, jobId, kind: 'variants' })
      if (pipelineJobs.size > PIPELINE_JOB_LIMIT) {
        const oldest = [...pipelineJobs.entries()].sort((a, b) => a[1].submittedAt - b[1].submittedAt)[0]
        if (oldest) pipelineJobs.delete(oldest[0])
      }
      sendJson(res, 202, { jobId, status: 'pending' })
      runPipelineVariants({
        input: input.input,
        count: input.count || 25,
        logo: input.logo,
        seed: input.seed,
        jobId,
      }).then(result => {
        pipelineJobs.set(jobId, { ...job, jobId, status: 'complete', result, finishedAt: Date.now() })
        state.event({ kind: 'pipeline', text: `pipeline variants complete → ${result.count} ads` })
      }).catch(error => {
        pipelineJobs.set(jobId, { ...job, jobId, status: 'failed', error: String(error.message || error), finishedAt: Date.now() })
        state.event({ kind: 'pipeline', text: `pipeline variants failed → ${error.message || error}` })
      })
    }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
    return
  }
  const pipelineAssetRoute = u.pathname === '/api/pipeline/asset' && req.method === 'POST'
  if (pipelineAssetRoute) {
    if (rejectForeignOrigin(req)) return sendJson(res, 403, { error: 'origin not allowed' })
    readJson(req).then(async input => {
      if (!input || !input.topic) throw new Error('topic is required')
      const job = { status: 'pending', submittedAt: Date.now(), input: { topic: input.topic } }
      const jobId = newJobId()
      pipelineJobs.set(jobId, { ...job, jobId, kind: 'asset' })
      if (pipelineJobs.size > PIPELINE_JOB_LIMIT) {
        const oldest = [...pipelineJobs.entries()].sort((a, b) => a[1].submittedAt - b[1].submittedAt)[0]
        if (oldest) pipelineJobs.delete(oldest[0])
      }
      sendJson(res, 202, { jobId, status: 'pending' })
      runPipelineAsset({
        topic: input.topic,
        duration: input.duration || 5.0,
        aspect: input.aspect || '9:16',
        allowCloud: !!input.allowCloud,
        auth: input.auth,
        budget: input.budget || 0.10,
        jobId,
      }).then(result => {
        pipelineJobs.set(jobId, { ...job, jobId, status: 'complete', result, finishedAt: Date.now() })
        state.event({ kind: 'pipeline', text: `pipeline asset resolved → ${result.result.source}` })
      }).catch(error => {
        pipelineJobs.set(jobId, { ...job, jobId, status: 'failed', error: String(error.message || error), finishedAt: Date.now() })
        state.event({ kind: 'pipeline', text: `pipeline asset failed → ${error.message || error}` })
      })
    }).catch(error => sendJson(res, 400, { error: String(error.message || error) }))
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
startArtifacts(state)

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
