// A Quorum HQ wired to fakes where money would be spent, and to the real
// MissionStore everywhere else. The fake runtime manager records what HQ asked
// it to start and lets a test finish a run the way the real one does: by
// setting the mission task's terminal status and leaving provider events
// behind. Nothing here spawns a provider.
import fs from 'node:fs'
import path from 'node:path'
import { Hq } from '../../src/hq/service.js'
import { MissionStore } from '../../src/missions.js'
import { AGENT_PACKS } from '../../src/agents/packs.js'
import { validateVerifyCommand } from '../../src/validate.js'
import { defer, scratchDir } from './scratch.mjs'

export class FakeRuntime {
  constructor(missions) {
    this.missions = missions
    this.runs = new Map()
    this.started = []
    this.cancelled = []
    this.failWith = null
  }

  async start(args) {
    if (this.failWith) throw new Error(this.failWith)
    const runId = `run-${this.started.length + 1}`
    this.started.push({ ...args, runId })
    this.runs.set(runId, { runId, missionId: args.missionId, taskId: args.taskId, finished: false, phase: 'running', events: [] })
    this.missions.setTask(args.missionId, args.taskId, { status: 'working' })
    return { run: { runId }, runtimeRun: { runId } }
  }

  /** End a run the way RuntimeManager#finish does: provider events first, then the task's terminal status. */
  finish(runId, { status = 'completed', text = 'Fixed it and ran the tests.', error = null, verification = ['exit:0'] } = {}) {
    const item = this.runs.get(runId)
    if (!item) throw new Error(`no fake run ${runId}`)
    item.finished = true
    item.events.push({ type: 'assistant', phase: 'assistant', text: 'working on it' })
    // A blocked run is one the provider finished and the evidence gate did
    // not accept, so the provider's own event still says `completed`.
    const provider = ['completed', 'blocked'].includes(status) ? 'completed' : status === 'failed' ? 'failed' : null
    if (text && provider) item.events.push({ type: provider, phase: 'success', text })
    this.missions.setTask(item.missionId, item.taskId, { status, error, verification, completedAt: new Date().toISOString() })
    // RuntimeManager emits one last event carrying the closeout, after the
    // task status. HQ must not mistake it for the agent's own words.
    item.events.push({ type: status, phase: 'finished', text: 'Quorum mission: closeout text' })
  }

  events(runId) { return this.runs.get(runId)?.events || [] }
  cancel(runId) { this.cancelled.push(runId); return { runId, status: 'cancelling' } }
  budgetStatus() { return { allowed: true, reason: '$0.00 of $25.00 recorded in the last 24h.' } }
}

export function resolvePack(id) {
  const pack = AGENT_PACKS.find(item => item.id === String(id || ''))
  if (!pack) throw new Error(`unknown agent pack: ${id}`)
  return pack
}

/**
 * A fresh HQ on scratch storage. Options: `runtimes` (catalog rows),
 * `withRuntime` (false leaves HQ without a runtime manager), `now`, `roundtable`,
 * `agentControl` (a real manager, where a test needs claims or runs).
 */
export function makeHq(t, options = {}) {
  const dir = scratchDir(t, 'quorum-hq-')
  const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(workspace)
  const missions = options.missions || new MissionStore(path.join(dir, 'missions.json'))
  const runtime = options.withRuntime === false ? null : options.runtime || new FakeRuntime(missions)
  const spend = options.spend || []
  const agentControl = options.agentControl || { store: { list: kind => (kind === 'spend' ? spend : []) } }
  const rooms = options.rooms || [{ id: 'app', label: 'App', cwd: workspace, branch: 'main' }]
  const build = (extra = {}) => new Hq({
    dir: options.hqDir || path.join(dir, 'hq'),
    missions,
    runtimeManager: runtime,
    agentControl,
    rooms: () => rooms,
    runtimes: () => options.runtimes || [{ id: 'claude', label: 'claude', available: true }, { id: 'codex', label: 'codex', available: true }],
    resolvePack,
    validateVerify: validateVerifyCommand,
    cli: 'quorum',
    baseUrl: 'http://127.0.0.1:9',
    now: options.now || (() => Date.now()),
    roundtable: options.roundtable || null,
    ...extra,
  })
  const hq = build()
  // Queued wakeups and reconciles write to the scratch dir; they must settle
  // before it is removed (defer runs last-registered first).
  defer(t, () => hq.idle())
  return { hq, dir, workspace, missions, runtime, spend, rooms, build }
}

export const byTitle = (hq, title) => Object.values(hq.data.tickets).find(ticket => ticket.title === title)
export const lastMessage = (hq, channelId, predicate = () => true) => hq.store.messages(channelId, { limit: 500 }).filter(predicate).at(-1)
