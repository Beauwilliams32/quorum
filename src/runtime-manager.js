import crypto from 'node:crypto'
import { buildTaskLaunch, executablePath } from './agent-control/adapters.js'
import { EvidenceExecutionEngine } from './agent-control/execution.js'
import { buildTaskPlanInput, runDeclaredCheck, worktreeDigest } from './agent-control/task-evidence.js'
import { createLineParser, closeoutText, redactRuntimeText } from './runtime-events.js'
import { CloudBudget, priceOf } from './cloud-budget.js'
import { DEFAULT_LIMITS } from './standing-jobs.js'
import { publicMission } from './missions.js'

const id = prefix => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
// Set by start() from the run itself; a caller's extra env can never replace them.
const RUN_IDENTITY_ENV = new Set(['QUORUM_AGENT_RUN_ID', 'QUORUM_MISSION_ID', 'QUORUM_TASK_ID', 'QUORUM_AGENT_PACK'])
const clean = value => redactRuntimeText(value).slice(0, 1_200)

export class RuntimeManager {
  constructor({ agentControl, missions, memoryBridge, state = null, spawnImpl = null, executablePathImpl = executablePath, processKillImpl = process.kill.bind(process), now = () => Date.now(), heartbeatMs = null, maxConcurrentCloudAgents = 4, dailyCloudBudgetUsd = DEFAULT_LIMITS.dailyCloudBudgetUsd, budget = null, worktreeDigestImpl = worktreeDigest, declaredCheckImpl = runDeclaredCheck, execution = null, reviewImpl = null } = {}) {
    this.agentControl = agentControl
    this.worktreeDigestImpl = worktreeDigestImpl
    this.declaredCheckImpl = declaredCheckImpl
    // The independent reviewer. Null means no reviewer is wired up, which is
    // reported as an unmeasured criterion rather than as a silent pass.
    this.reviewImpl = reviewImpl
    this.execution = execution || (agentControl?.store ? new EvidenceExecutionEngine({ control: agentControl, clock: now }) : null)
    this.budget = budget || new CloudBudget({ store: agentControl?.store || null, limitUsd: dailyCloudBudgetUsd, now })
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

  async start({ missionId, taskId, runtime = 'codex', role = 'builder', cwd, worktree, branch = '', task = '', packId = null, modelRef = '', env: extraEnv = null } = {}) {
    if (!this.agentControl || !this.missions) throw new Error('runtime manager is missing control dependencies')
    if (!['claude', 'codex'].includes(runtime)) throw new Error('managed runs currently support Claude and Codex only')
    const activeCloud = this.inFlightCloudRuns()
    if (activeCloud >= this.maxConcurrentCloudAgents) throw new Error(`cloud agent concurrency limit reached (${this.maxConcurrentCloudAgents})`)
    // The daily budget was displayed and never consulted. It is now a refusal.
    // Runs are priced at their exit, so concurrently-started runs all read the
    // same pre-spend ledger; the concurrency cap bounds the overshoot and the
    // refusal text says the figure is recorded, not committed.
    const budget = this.budget.check({ inFlightRuns: activeCloud })
    if (!budget.allowed) throw new Error(budget.reason)
    const mission = this.missions.get(missionId)
    if (!mission) throw new Error('unknown mission')
    const missionTask = this.missions.task(missionId, taskId).task
    const root = worktree || cwd
    let recall = ''
    try { recall = await this.memoryBridge?.recall(`${mission.objective}\n${task || missionTask.description || missionTask.title}`) || '' } catch { /* task execution does not depend on memory availability */ }
    const prompt = [task || missionTask.description || missionTask.title, recall ? `\nRelevant long-term memory (bounded index/context):\n${recall}` : ''].filter(Boolean).join('\n')
    const boundedPrompt = prompt.slice(0, 8_000)
    const run = this.agentControl.createRun({ runtime, role, packId, modelRef, repoRoot: cwd, worktree: root, branch, missionId, parentTask: taskId, taskPacket: {
      source: 'mission', missionId, taskId,
      inputDigest: crypto.createHash('sha256').update(prompt).digest('hex'),
      inputChars: boundedPrompt.length, inputBytes: Buffer.byteLength(boundedPrompt), truncated: prompt.length > boundedPrompt.length,
      memoryIncluded: Boolean(recall), memoryBytes: Math.min(Buffer.byteLength(recall), 32_000),
    } })
    const providerModel = String(modelRef || '').startsWith(`${runtime}:`) ? String(modelRef).slice(runtime.length + 1) : String(modelRef || '')
    const plan = buildTaskLaunch({ runtime, role, cwd: root, task: boundedPrompt, model: providerModel === 'auto' ? '' : providerModel, structured: true })
    if (!this.executablePathImpl(plan.command, plan.env) && plan.command === runtime) {
      this.agentControl.cancel(run.runId, { nextOwnerAction: `install or expose ${runtime} in Quorum PATH` })
      throw new Error(`${runtime} executable is not available`) 
    }
    // Measured before the provider is given the worktree, so "did this run
    // change anything?" is a comparison of two readings the cockpit took,
    // not a claim the agent made about itself.
    let beforeWorktree = { measured: false, reason: 'worktree not read', digest: null, changedFiles: [] }
    try { beforeWorktree = this.worktreeDigestImpl(root) } catch (error) { beforeWorktree = { measured: false, reason: clean(`worktree read failed: ${error?.message || error}`), digest: null, changedFiles: [] } }
    const item = { id: id('runtime'), runId: run.runId, missionId, taskId, runtime, role, cwd: root, status: 'starting', phase: 'starting', providerSessionId: null, events: [], startedAt: this.now(), updatedAt: this.now(), child: null, timer: null, cancelRequested: false, output: '', beforeWorktree, verifyCommand: missionTask.verifyCommand || null, providerResult: null, exitCode: null, costUsd: null }
    this.runs.set(run.runId, item)
    const onEvent = event => {
      if (event.sessionId) {
        item.providerSessionId = event.sessionId
        try { this.agentControl.providerSession(run.runId, event.sessionId) } catch { /* session identity is an enhancement, not a reason to stop work */ }
      }
      item.phase = event.phase || event.type
      if (event.text) item.output = `${item.output}\n${event.text}`.slice(-4_000)
      if (event.type === 'started') item.status = 'running'
      // Only a price the provider actually stated. `Number(null) === 0` and 0
      // is finite, so the obvious guard recorded an unpriced claude result as
      // a $0 *priced* run and the ceiling went green over unmeasured spend.
      const price = priceOf(event.costUsd)
      if (price !== null) item.costUsd = price
      if (event.type === 'completed') { item.status = 'completed'; item.providerResult = 'completed' }
      if (event.type === 'failed') { item.status = 'failed'; item.providerResult = 'failed' }
      this.emit(item, event)
      if (event.type === 'started' || event.type === 'assistant' || event.type === 'tool') {
        try { this.agentControl.heartbeat(run.runId, { phase: item.phase }) } catch { /* process exit handles final state */ }
      }
    }
    const parser = createLineParser(runtime, onEvent)
    item.parser = parser
    const env = { ...plan.env, QUORUM_AGENT_RUN_ID: run.runId, QUORUM_MISSION_ID: String(missionId), QUORUM_TASK_ID: String(taskId), QUORUM_AGENT_PACK: String(packId || '') }
    // Callers may add their own QUORUM_* context (HQ passes the cockpit URL and
    // which agent/ticket the run serves, so the agent's `quorum` CLI calls are
    // attributed to it). Only that namespace, only strings, and never one of
    // the run identity keys set above.
    for (const [key, value] of Object.entries(extraEnv || {})) {
      if (/^QUORUM_[A-Z0-9_]{1,40}$/.test(key) && !RUN_IDENTITY_ENV.has(key) && typeof value === 'string' && value) env[key] = value.slice(0, 400)
    }
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
    // Bind the control-plane run to the process that is actually doing its
    // work. Without this the run has no owner whose death can be confirmed,
    // and recovery has nothing to reason about.
    try { this.agentControl.bindProcess(run.runId, child.pid) } catch { /* a process that raced its own exit stays unbound and is abandoned, not recovered */ }
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


  /**
   * Decide whether a finished run actually did its task.
   *
   * The run's own exit code is one input among several, and never the whole
   * answer. An evidence plan is authorized through the control plane, an
   * executor records what the run produced, and an *independent* verifier —
   * the cockpit, not the agent — re-measures the worktree and runs the task's
   * declared check itself before any criterion is allowed to pass.
   *
   * Returns `{ gated, verified, blockers, checks, notMeasured, planId }`.
   * `gated:false` means no evidence could be recorded at all, which is itself
   * a reason not to claim completion.
   */
  async verifyTask(item) {
    const notMeasured = []
    if (!this.execution || !this.agentControl?.store) return { gated: false, verified: false, blockers: ['no evidence store is available to record this run'], checks: [], notMeasured, planId: null }
    const declared = item.verifyCommand || null
    if (!declared) notMeasured.push('declared check: none declared for this task')
    if (!item.beforeWorktree?.measured) notMeasured.push(`worktree effect: ${item.beforeWorktree?.reason || 'not measured'}`)
    const planInput = buildTaskPlanInput({
      missionId: item.missionId, taskId: item.taskId, attempt: 1, role: item.role || 'builder',
      hasDeclaredCheck: Boolean(declared), worktreeMeasured: Boolean(item.beforeWorktree?.measured),
    })
    let after = null
    const readAfter = () => {
      if (after) return after
      try { after = this.worktreeDigestImpl(item.cwd) } catch (error) { after = { measured: false, reason: clean(`worktree read failed: ${error?.message || error}`), digest: null, changedFiles: [] } }
      return after
    }
    let declaredResult = null
    const executor = {
      id: `runtime:${item.runtime}`,
      run: async ({ action }) => {
        if (action.id === 'record-run') return {
          status: item.status, resultState: item.providerResult || 'no-provider-result', exitCode: item.exitCode,
          observed: clean(`provider result ${item.providerResult || 'never reported'}; exit ${item.exitCode ?? 'unknown'}`),
        }
        if (action.id === 'inspect-worktree') {
          const reading = readAfter()
          return { status: reading.measured ? 'read' : 'unreadable', resultState: reading.measured ? 'read' : 'failed', exitCode: reading.measured ? 0 : 1, artifacts: reading.changedFiles, observed: clean(`${reading.changedFiles.length} changed path(s); ${reading.reason}`) }
        }
        declaredResult = await this.declaredCheckImpl(declared, { cwd: item.cwd })
        return {
          status: declaredResult.ran ? 'ran' : 'not-run', resultState: declaredResult.ran ? (declaredResult.exitCode === 0 ? 'passed' : 'failed') : 'failed',
          exitCode: declaredResult.ran ? declaredResult.exitCode : 1,
          observed: clean(`${declaredResult.reason}; output digest ${declaredResult.outputDigest || 'none'}`),
        }
      },
    }
    const readOnly = ['researcher', 'reviewer', 'recovery'].includes(item.role || 'builder')
    const verifier = {
      id: 'quorum-evidence-verifier',
      verify: async ({ criterion, evidence }) => {
        if (criterion.id === 'provider-result') {
          const passed = item.exitCode === 0 && item.providerResult === 'completed'
          return { passed, observed: passed ? `provider reported completion and exited 0` : `provider result was ${item.providerResult || 'never reported'} with exit ${item.exitCode ?? 'unknown'}` }
        }
        if (criterion.id === 'worktree-effect') {
          // Re-read rather than trust the recorded artifacts: the verifier's
          // job is to measure, not to agree.
          const reading = readAfter()
          if (!reading.measured) return { passed: false, observed: `worktree could not be re-read: ${reading.reason}` }
          const changed = reading.digest !== item.beforeWorktree.digest
          if (readOnly) return { passed: !changed, observed: changed ? 'a read-only run modified the worktree' : 'read-only run left the worktree unchanged' }
          return { passed: changed, observed: changed ? `worktree changed; ${reading.changedFiles.length} path(s) differ from the pre-run reading` : 'the run exited cleanly but the worktree is byte-identical to its pre-run digest' }
        }
        const check = declaredResult
        if (!check?.ran) return { passed: false, observed: `declared check did not run: ${check?.reason || 'no result'}` }
        return { passed: check.exitCode === 0, observed: `${check.command} exited ${check.exitCode}${check.timedOut ? ' (timed out)' : ''}` }
      },
    }
    let plan
    try {
      const created = this.execution.createPlan(item.runId, planInput)
      plan = await this.execution.execute(created.id, { executor, verifier })
    } catch (error) {
      return { gated: false, verified: false, blockers: [clean(`evidence gate could not run: ${error?.message || error}`)], checks: [], notMeasured, planId: null }
    }
    const verifications = plan.verificationIds.map(verificationId => this.agentControl.store.get('verifications', verificationId)).filter(Boolean)
    const checks = verifications.map(record => `${record.criterionId}: ${record.passed ? 'passed' : 'failed'} — ${record.observed}`)
    const blockers = (plan.rework || []).map(entry => clean(`${entry.criterionId || 'criterion'}: ${entry.reason}`)).slice(0, 20)
    return { gated: true, verified: plan.status === 'completed', blockers, checks, notMeasured, planId: plan.id, plan }
  }

  /**
   * Independent review of a run that has already satisfied the evidence gate.
   *
   * Evidence answers "did this run do something real?". A reviewer answers
   * "was it the right thing?", and only a human-equivalent reader can. The
   * review therefore runs *after* the evidence gate and *before* the task is
   * allowed to say completed — a reject or a no-decision blocks.
   *
   * Returns `{ requested, approved, decision, reasoning, note }`. `requested:
   * false` with a `note` is the honest answer when there is no reviewer to
   * ask; it is recorded as "not measured", never as an approval.
   */
  async review(item, evidence) {
    // Evidence has already blocked this run; there is nothing for a reviewer
    // to approve, and spending a cloud run to confirm a block is waste.
    if (!evidence.verified) return { requested: false, approved: false, decision: null, reasoning: '', note: null }
    // A read-only run changes nothing, so there is no work to review.
    if (['researcher', 'reviewer', 'recovery'].includes(item.role || 'builder')) return { requested: false, approved: true, decision: null, reasoning: '', note: null }
    if (!this.reviewImpl) return { requested: false, approved: true, decision: null, reasoning: '', note: 'independent review: no reviewer is configured on this cockpit' }
    try {
      const result = await this.reviewImpl({
        runId: item.runId, missionId: item.missionId, taskId: item.taskId,
        cwd: item.cwd, worktree: item.cwd, runtime: item.runtime, role: item.role,
      })
      const decision = ['approve', 'reject', 'no-decision'].includes(result?.decision) ? result.decision : 'no-decision'
      return { requested: true, approved: decision === 'approve', decision, reasoning: clean(result?.reasoning || ''), reviewerRunId: result?.reviewerRunId || null, note: null }
    } catch (error) {
      // A reviewer that crashed did not approve anything.
      return { requested: true, approved: false, decision: 'no-decision', reasoning: clean(`independent review could not run: ${error?.message || error}`), note: null }
    }
  }

  publicItem(item) { return { id: item.id, runId: item.runId, missionId: item.missionId, taskId: item.taskId, runtime: item.runtime, status: item.status, phase: item.phase, providerSessionId: item.providerSessionId, cwd: item.cwd, startedAt: item.startedAt, updatedAt: item.updatedAt, costUsd: item.costUsd ?? null, events: item.events.slice(-30) } }

  /**
   * Record a cloud run this manager did not spawn — today, the independent
   * reviewer, which server.js runs directly through `verification-run.js`.
   * It is a real cloud invocation, so leaving it out of the ledger would make
   * the ceiling quietly narrower than the spend it claims to cover. A codex
   * review reports no price, so it lands as an *unpriced* run and is reported
   * as such rather than as free.
   */
  recordCloudSpend({ runId, runtime, costUsd = null, missionId = null, taskId = null } = {}) {
    try { return this.budget.record({ runId, runtime, costUsd, missionId, taskId }) } catch { return null }
  }

  /** Managed cloud runs that have started and not yet been priced. */
  inFlightCloudRuns() {
    return [...this.runs.values()].filter(item => !item.finished && ['starting', 'running', 'paused'].includes(item.status) && ['claude', 'codex'].includes(item.runtime)).length
  }

  /** What the daily cloud ceiling currently knows, including what it cannot price. */
  budgetStatus() { return this.budget.check({ inFlightRuns: this.inFlightCloudRuns() }) }

  stopTimer(item) { if (item.timer) clearInterval(item.timer); item.timer = null }

  async finish(item, code, signal, error = '') {
    if (item.finished) return
    item.finished = true; this.stopTimer(item)
    const parser = item.parser
    if (parser) parser.flush()
    const exited = !item.cancelRequested && !error && code === 0
    item.exitCode = Number.isInteger(code) ? code : null
    // Recorded whether or not the provider priced the run: an unpriced run is
    // a known blind spot in the ceiling, not an absent one.
    try { this.budget.record({ runId: item.runId, runtime: item.runtime, costUsd: item.costUsd, missionId: item.missionId, taskId: item.taskId }) } catch { /* the ledger must not block a closeout */ }
    const mission = this.missions.get(item.missionId)
    const task = mission?.tasks.find(t => t.id === item.taskId)

    // A zero exit is the *entry* condition for verification, not a result.
    // Only a run that exited cleanly is worth gathering evidence about; the
    // evidence then decides whether the task is complete.
    const evidence = exited ? await this.verifyTask(item) : { gated: false, verified: false, blockers: [], checks: [], notMeasured: [], planId: null }
    // Evidence, then an independent reviewer. Both have to say yes before a
    // task is allowed to claim it is done.
    const review = item.cancelRequested ? { requested: false, approved: false, decision: null, reasoning: '', note: null } : await this.review(item, evidence)
    const successful = exited && evidence.verified && (!review.requested || review.approved)
    item.status = item.cancelRequested ? 'cancelled' : successful ? 'completed' : exited ? 'unverified' : 'failed'
    item.phase = 'finished'
    item.evidence = { planId: evidence.planId, verified: evidence.verified, checks: evidence.checks, notMeasured: evidence.notMeasured, review: { requested: review.requested, decision: review.decision || null } }
    const processBlocker = error || (!exited && !item.cancelRequested ? `process exit ${code ?? signal ?? 'unknown'}` : '')
    const evidenceBlockers = exited && !evidence.verified ? (evidence.blockers.length ? evidence.blockers : ['the run exited cleanly but no acceptance criterion could be verified']) : []
    const reviewBlockers = review.requested && !review.approved ? [clean(`independent review ${review.decision === 'reject' ? 'rejected' : 'returned no decision'}: ${review.reasoning || 'no reasoning recorded'}`)] : []
    const blockers = [processBlocker, ...evidenceBlockers, ...reviewBlockers].filter(Boolean).slice(0, 20)
    const blocker = blockers[0] || ''
    const reviewLines = review.requested
      ? [clean(`independent-review: ${review.decision} — ${review.reasoning || 'no reasoning recorded'}`)]
      : review.note ? [`not measured — ${review.note}`] : []
    const verification = [`exit:${code ?? signal ?? 'unknown'}`, ...evidence.checks, ...reviewLines, ...evidence.notMeasured.map(entry => `not measured — ${entry}`)].slice(0, 20)
    const closeout = closeoutText({ missionTitle: mission?.title, taskTitle: task?.title, status: item.status, runtime: item.runtime, providerSessionId: item.providerSessionId, checks: verification, blocker })
    try { this.agentControl.checkpoint(item.runId, { reason: blocker ? 'failure' : 'process-exit', phase: 'finished', blockers, verification }) } catch { /* preserve closeout even if a process raced cancellation */ }
    try { this.agentControl.close(item.runId, { disposition: item.cancelRequested ? 'cancelled' : successful ? 'completed' : 'blocked', blockers, verification, nextOwnerAction: blocker ? `inspect run ${item.runId} and retry from its checkpoint` : '', execution: evidence.planId ? { planId: evidence.planId, evidenceIds: evidence.plan?.evidenceIds || [], verificationIds: evidence.plan?.verificationIds || [], authorizationIds: evidence.plan?.authorizationIds || [] } : null }) } catch { /* already closed by operator */ }
    // "blocked" rather than "completed" is the whole point: a task nobody
    // verified is a task nobody can claim is done.
    const taskStatus = successful ? 'completed' : item.cancelRequested ? 'cancelled' : exited ? 'blocked' : 'failed'
    try { if (task && task.status !== 'cancelled') this.missions.setTask(item.missionId, item.taskId, { status: taskStatus, error: blocker || null, verification, completedAt: new Date(this.now()).toISOString() }) } catch { /* mission state is durable but must not crash the supervisor */ }
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
