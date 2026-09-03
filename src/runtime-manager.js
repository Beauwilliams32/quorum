import crypto from 'node:crypto'
import { buildTaskLaunch, executablePath } from './agent-control/adapters.js'
import { createLineParser, closeoutText, redactRuntimeText } from './runtime-events.js'
import { publicMission } from './missions.js'

const id = prefix => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
const clean = value => redactRuntimeText(value).slice(0, 1_200)

export class RuntimeManager {
  constructor({ agentControl, missions, memoryBridge, state = null, spawnImpl = null, executablePathImpl = executablePath, processKillImpl = process.kill.bind(process), now = () => Date.now(), heartbeatMs = null, maxConcurrentCloudAgents = 4 } = {}) {
    this.agentControl = agentControl
    this.missions = missions
    this.memoryBridge = memoryBridge
    this.state = state
    this.spawnImpl = spawnImpl
    this.executablePathImpl = executablePathImpl
    this.processKillImpl = processKillImpl
    this.now = now
    this.heartbeatMs = heartbeatMs
    this.maxConcurrentCloudAgents = maxConcurrentCloudAgents
    this.runs = new Map()
  }

  snapshot() {
    const live = [...this.runs.values()].map(item => ({
      id: item.id, runId: item.runId, missionId: item.missionId, taskId: item.taskId,
      runtime: item.runtime, status: item.status, phase: item.phase, providerSessionId: item.providerSessionId || null,
      cwd: item.cwd, startedAt: item.startedAt, updatedAt: item.updatedAt, events: item.events.slice(-30),
    }))
    const seen = new Set(live.map(item => item.runId))
    const durable = (this.agentControl?.store?.list('runs') || []).filter(run => run.parentTask && ['claude', 'codex'].includes(run.runtime) && !seen.has(run.runId)).map(run => ({
      id: run.runId, runId: run.runId, missionId: run.missionId || null, taskId: run.parentTask, runtime: run.runtime, status: run.status, phase: run.phase,
      providerSessionId: run.providerSessionId || null, cwd: run.worktree, startedAt: run.createdAt, updatedAt: run.updatedAt,
      events: this.events(run.runId).slice(-30),
    }))
    return [...live, ...durable].sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
  }

  events(runId) {
    const live = this.runs.get(String(runId))?.events
    if (live?.length) return live.slice(-100)
    return (this.agentControl?.store?.list('runtimeEvents') || []).filter(event => event.runId === String(runId)).slice(-100)
  }

  emit(item, event) {
    const record = { id: id('event'), at: new Date(this.now()).toISOString(), runId: item.runId, missionId: item.missionId, taskId: item.taskId, ...event }
    item.events.push(record)
    item.events = item.events.slice(-100)
    item.updatedAt = this.now()
    try { this.agentControl?.store?.append('runtimeEvents', record) } catch { /* telemetry persistence must not stop a provider */ }
    if (this.state) this.state.broadcast({ type: 'runtime.event', event: { runId: item.runId, ...record } })
    if (this.state) this.state.update('runtimeRuns', { runs: this.snapshot(), ts: Date.now() })
    return record
  }

  refreshMissionState() {
    if (this.state) this.state.update('missions', { missions: this.missions.list().map(publicMission), ts: Date.now() })
  }

  async start({ missionId, taskId, runtime = 'codex', role = 'builder', cwd, worktree, branch = '', task = '', packId = null, modelRef = '' } = {}) {
    if (!this.agentControl || !this.missions) throw new Error('runtime manager is missing control dependencies')
    if (!['claude', 'codex'].includes(runtime)) throw new Error('managed runs currently support Claude and Codex only')
    const activeCloud = [...this.runs.values()].filter(item => !item.finished && ['starting', 'running', 'paused'].includes(item.status) && ['claude', 'codex'].includes(item.runtime)).length
    if (activeCloud >= this.maxConcurrentCloudAgents) throw new Error(`cloud agent concurrency limit reached (${this.maxConcurrentCloudAgents})`)
    const mission = this.missions.get(missionId)
    if (!mission) throw new Error('unknown mission')
    const missionTask = this.missions.task(missionId, taskId).task
    const root = worktree || cwd
    const run = this.agentControl.createRun({ runtime, role, packId, modelRef, repoRoot: cwd, worktree: root, branch, missionId, parentTask: taskId })
    let recall = ''
    try { recall = await this.memoryBridge?.recall(`${mission.objective}\n${task || missionTask.description || missionTask.title}`) || '' } catch { /* task execution does not depend on memory availability */ }
    const prompt = [task || missionTask.description || missionTask.title, recall ? `\nRelevant long-term memory (bounded index/context):\n${recall}` : ''].filter(Boolean).join('\n')
    const providerModel = String(modelRef || '').startsWith(`${runtime}:`) ? String(modelRef).slice(runtime.length + 1) : String(modelRef || '')
    const plan = buildTaskLaunch({ runtime, role, cwd: root, task: prompt, model: providerModel === 'auto' ? '' : providerModel, structured: true })
    if (!this.executablePathImpl(plan.command, plan.env) && plan.command === runtime) {
      this.agentControl.cancel(run.runId, { nextOwnerAction: `install or expose ${runtime} in Quorum PATH` })
      throw new Error(`${runtime} executable is not available`) 
    }
    const item = { id: id('runtime'), runId: run.runId, missionId, taskId, runtime, cwd: root, status: 'starting', phase: 'starting', providerSessionId: null, events: [], startedAt: this.now(), updatedAt: this.now(), child: null, timer: null, cancelRequested: false, output: '' }
    this.runs.set(run.runId, item)
    const onEvent = event => {
      if (event.sessionId) {
        item.providerSessionId = event.sessionId
        try { this.agentControl.providerSession(run.runId, event.sessionId) } catch { /* session identity is an enhancement, not a reason to stop work */ }
      }
      item.phase = event.phase || event.type
      if (event.text) item.output = `${item.output}\n${event.text}`.slice(-4_000)
      if (event.type === 'started') item.status = 'running'
      if (event.type === 'completed') item.status = 'completed'
      if (event.type === 'failed') item.status = 'failed'
      this.emit(item, event)
      if (event.type === 'started' || event.type === 'assistant' || event.type === 'tool') {
        try { this.agentControl.heartbeat(run.runId, { phase: item.phase }) } catch { /* process exit handles final state */ }
      }
    }
    const parser = createLineParser(runtime, onEvent)
    item.parser = parser
    const env = { ...plan.env, QUORUM_AGENT_RUN_ID: run.runId, QUORUM_MISSION_ID: String(missionId), QUORUM_TASK_ID: String(taskId), QUORUM_AGENT_PACK: String(packId || '') }
    for (const key of Object.keys(env)) if (key.startsWith('CLAUDE')) delete env[key]
    const spawn = this.spawnImpl || ((command, args, options) => import('node:child_process').then(({ spawn: launch }) => launch(command, args, options)))
    let child
    try {
      child = await spawn(plan.command, plan.args, { cwd: plan.cwd, env, detached: process.platform !== 'win32', stdio: [plan.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const message = clean(error?.message || error)
      item.status = 'failed'; item.phase = 'spawn-failed'; item.finished = true
      try { this.agentControl.close(run.runId, { disposition: 'blocked', blockers: [message], nextOwnerAction: `repair ${runtime} launch availability and retry` }) } catch { /* preserve the original spawn error */ }
      try { this.missions.setTask(missionId, taskId, { status: 'failed', error: message, completedAt: new Date(this.now()).toISOString() }); this.refreshMissionState() } catch { /* durable state is best effort after a failed spawn */ }
      this.emit(item, { type: 'failed', phase: 'spawn-failed', text: message })
      throw error
    }
    item.child = child
    item.status = 'running'
    this.missions.setTask(missionId, taskId, { status: 'working', worktree: root, branch, startedAt: new Date(this.now()).toISOString() })
    this.missions.event(missionId, 'TASK_STARTED', `${missionTask.title} → managed ${runtime}`)
    this.refreshMissionState()
    this.emit(item, { type: 'started', phase: 'running', text: '' })
    child.stdout?.on('data', data => parser.push(data))
    child.stderr?.on('data', data => parser.push(data))
    if (plan.input && child.stdin) { child.stdin.write(plan.input); child.stdin.end() }
    const heartbeatMs = this.heartbeatMs || Math.max(5_000, (this.agentControl.policy.lease?.heartbeatSeconds || 120) * 1_000)
    item.timer = setInterval(() => {
      try { this.agentControl.heartbeat(run.runId, { phase: item.phase }); this.emit(item, { type: 'heartbeat', phase: item.phase, text: '' }) } catch { this.stopTimer(item) }
    }, heartbeatMs)
    child.once('error', error => this.finish(item, 1, null, clean(error.message || error)))
    child.once('exit', (code, signal) => this.finish(item, code, signal, ''))
    return { run: this.agentControl.getRun(run.runId), runtimeRun: this.publicItem(item) }
  }

  publicItem(item) { return { id: item.id, runId: item.runId, missionId: item.missionId, taskId: item.taskId, runtime: item.runtime, status: item.status, phase: item.phase, providerSessionId: item.providerSessionId, cwd: item.cwd, startedAt: item.startedAt, updatedAt: item.updatedAt, events: item.events.slice(-30) } }

  stopTimer(item) { if (item.timer) clearInterval(item.timer); item.timer = null }

  async finish(item, code, signal, error = '') {
    if (item.finished) return
    item.finished = true; this.stopTimer(item)
    const parser = item.parser
    if (parser) parser.flush()
    const successful = !item.cancelRequested && !error && code === 0
    item.status = item.cancelRequested ? 'cancelled' : successful ? 'completed' : 'failed'
    item.phase = 'finished'
    const mission = this.missions.get(item.missionId)
    const task = mission?.tasks.find(t => t.id === item.taskId)
    const blocker = error || (!successful && !item.cancelRequested ? `process exit ${code ?? signal ?? 'unknown'}` : '')
    const closeout = closeoutText({ missionTitle: mission?.title, taskTitle: task?.title, status: item.status, runtime: item.runtime, providerSessionId: item.providerSessionId, blocker })
    try { this.agentControl.checkpoint(item.runId, { reason: blocker ? 'failure' : 'process-exit', phase: 'finished', blockers: blocker ? [blocker] : [], verification: [`exit:${code ?? signal ?? 'unknown'}`] }) } catch { /* preserve closeout even if a process raced cancellation */ }
    try { this.agentControl.close(item.runId, { disposition: item.cancelRequested ? 'cancelled' : successful ? 'completed' : 'blocked', blockers: blocker ? [blocker] : [], nextOwnerAction: blocker ? `inspect run ${item.runId} and retry from its checkpoint` : '' }) } catch { /* already closed by operator */ }
    try { if (task && task.status !== 'cancelled') this.missions.setTask(item.missionId, item.taskId, { status: successful ? 'completed' : item.cancelRequested ? 'cancelled' : 'failed', error: blocker || null, completedAt: new Date(this.now()).toISOString() }) } catch { /* mission state is durable but must not crash the supervisor */ }
    try { this.missions.event(item.missionId, 'TASK_FINISHED', `${task?.title || item.taskId} → ${item.status}`) } catch { /* best effort */ }
    this.refreshMissionState()
    try { await this.memoryBridge?.captureCloseout({ sessionId: item.providerSessionId, closeout, cwd: item.cwd }) } catch { /* optional integration */ }
    try { if (mission && task) this.memoryBridge?.writeMissionNote({ mission: this.missions.get(item.missionId), task: this.missions.get(item.missionId)?.tasks.find(t => t.id === item.taskId), run: this.agentControl.getRun(item.runId), closeout }) } catch { /* optional integration */ }
    this.emit(item, { type: item.status, phase: 'finished', text: blocker || closeout.slice(0, 500) })
    if (this.state) this.state.update('runtimeRuns', { runs: this.snapshot(), ts: Date.now() })
  }

  signal(item, signal) {
    const pid = Number(item.child?.pid)
    if (!pid) return false
    if (process.platform !== 'win32') {
      try { this.processKillImpl(-pid, signal); return true } catch { /* fall back to the direct child */ }
    }
    try { return item.child.kill(signal) } catch { return false }
  }

  pause(runId) { const item = this.runs.get(String(runId)); if (!item?.child?.pid) throw new Error('managed run is not available'); this.signal(item, 'SIGSTOP'); item.status = 'paused'; item.phase = 'paused'; this.emit(item, { type: 'paused', phase: 'paused', text: '' }); return this.publicItem(item) }
  resume(runId) { const item = this.runs.get(String(runId)); if (!item?.child?.pid) throw new Error('managed run is not available'); this.signal(item, 'SIGCONT'); item.status = 'running'; item.phase = 'running'; this.emit(item, { type: 'resumed', phase: 'running', text: '' }); return this.publicItem(item) }
  cancel(runId) { const item = this.runs.get(String(runId)); if (!item) throw new Error('unknown managed run'); item.cancelRequested = true; if (item.child) this.signal(item, 'SIGTERM'); else this.agentControl.cancel(runId); return this.publicItem(item) }

  cancelMission(missionId) {
    for (const item of this.runs.values()) if (item.missionId === String(missionId) && !item.finished) this.cancel(item.runId)
  }
}
