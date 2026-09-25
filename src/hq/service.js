// Quorum HQ — run an AI company from a chat room.
//
// Two ideas, one system of record:
//
//   THE COMPANY (after Paperclip): agents are employees with a title, a
//   manager, a harness, a monthly budget and a heartbeat. Work is a ticket
//   that traces up to a goal and down to a run. You are the board: spending,
//   hiring and pausing are your calls, and every mutation lands in a
//   hash-chained activity log.
//
//   THE ROOM (after Buzz): agents are members of channels, not bots. An
//   @mention hands an agent work; the agent's result comes back into the
//   thread under its own signed identity; a channel can be bound to a project
//   and a branch so the evidence and the review live next to the conversation.
//
// Nothing here executes work itself. A ticket becomes a Quorum mission and a
// managed run through the existing runtime manager, so the evidence gate, the
// independent reviewer, the lease/heartbeat plane and the daily cloud ceiling
// all still decide what "done" means. HQ owns who does what and why; the
// runtime owns whether it actually happened.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HqStore, signedPart } from './store.js'
import { Keyring, canonical, sha256 } from './identity.js'
import { AGENT_ID, APPROVAL_ID, CHANNEL_ID, COMMANDS, GOAL_ID, ROUTINE_ID, clip, clipBlock, formatEvery, parseCommand, parseEvery, parseMentions, parseSearch, parseTicketRef, slugify, ticketTitleFrom } from './parse.js'
import { publicAvatar, validateAvatar } from './avatars.js'
import { DEFAULT_CHANNELS, TEMPLATES, publicTemplates } from './templates.js'
import { budgetFor, budgetLine, monthKey } from './budget.js'
import { buildWorkPrompt, verifyText } from './prompt.js'
import { READ_ONLY_ROLES } from '../agent-control/adapters.js'

export const STRUCTURED_RUNTIMES = ['claude', 'codex']
// Harnesses whose runs report their own price. Only these can run without
// asking: a cap that cannot see a run's cost is not a cap.
export const PRICED_RUNTIMES = ['claude']
export const TICKET_STATUSES = ['backlog', 'todo', 'in_progress', 'blocked', 'done', 'cancelled']
export const PRIORITIES = ['low', 'normal', 'high', 'urgent']
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 }
const TERMINAL_TASK = ['completed', 'blocked', 'failed', 'cancelled']
// Refusals that clear on their own: another run finishing, the 24h window
// rolling. The ticket stays in the queue instead of being marked blocked.
const TRANSIENT_DISPATCH = /concurrency limit|daily cloud budget|claimed path is already owned/i
const RUNTIME_ID = /^[a-z][a-z0-9-]{0,31}$/
// How long after a run finishes its spend is still looked for: the ledger
// entry for the reviewer's run can land after the task is marked terminal.
const LATE_SPEND_MS = 10 * 60_000

export const BOARD = Object.freeze({ kind: 'board', id: 'board' })
export const SYSTEM = Object.freeze({ kind: 'system', id: 'system' })

export class HqError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

const isoNow = now => new Date(now).toISOString()
const rid = prefix => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
const money = value => `$${Number(value || 0).toFixed(2)}`

function numberIn(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export class Hq {
  constructor({
    dir,
    missions = null,
    runtimeManager = null,
    agentControl = null,
    rooms = () => [],
    runtimes = () => [],
    resolvePack = null,
    validateVerify = null,
    cli = 'quorum',
    baseUrl = '',
    now = () => Date.now(),
    onChange = null,
    roundtable = null,
  } = {}) {
    if (!dir) throw new Error('Hq needs a data directory')
    this.store = new HqStore({ dir })
    this.keyring = new Keyring(path.join(this.store.dir, 'keys'))
    this.missions = missions
    this.runtimeManager = runtimeManager
    this.agentControl = agentControl
    this.rooms = rooms
    this.runtimes = runtimes
    this.resolvePack = resolvePack || (id => ({ id, role: 'builder', defaultModel: 'sonnet' }))
    this.validateVerify = validateVerify
    this.cli = cli
    this.baseUrl = baseUrl
    this.now = now
    this.onChange = onChange
    // { estimate({ participants, model }), start({ topic, participants, model, roomId }) }
    this.roundtable = roundtable
    this.queue = Promise.resolve()
    this.publishPending = false
    this.reconcilePending = false
    this.refreshTimer = null
    // Tickets whose dispatch is between checkout and a started run. A checkout
    // with no run that is NOT in here was interrupted (see reconcile()).
    this.dispatching = new Set()
    // The last error posted to #ops, so a failure that repeats every beat is
    // said once (see #reportError).
    this.lastError = null
    this.errorCount = 0
    // Tickets whose start was refused by something only the runtime could
    // see, with how often and when to try again. In memory on purpose: a
    // restart is a fair moment to try once more.
    this.backoff = new Map()
    // Searches read the whole history; they run one at a time.
    this.searchChain = Promise.resolve()
    // A wakeup that was mid-flight when the process died never finished;
    // handling one is idempotent (a pending approval is found, not duplicated),
    // so it goes back in the queue rather than sitting in "processing" forever.
    let requeued = false
    for (const wakeup of this.data.wakeups) if (wakeup.status === 'processing') { wakeup.status = 'queued'; requeued = true }
    if (requeued) this.store.save()
  }

  get data() { return this.store.data }
  ready() { return Boolean(this.data.company) }

  // ── plumbing ────────────────────────────────────────────────────────────

  #save() { this.store.save() }

  #changed() {
    if (!this.onChange || this.publishPending) return
    this.publishPending = true
    setImmediate(() => {
      this.publishPending = false
      try { this.onChange(this.snapshot()) } catch { /* a broken observer must not break HQ */ }
    })
  }

  #commit(actor, action, target, detail) {
    this.#save()
    this.store.appendActivity({ actor, action, target, detail })
    this.#changed()
  }

  #identity(actor) {
    if (actor.kind === 'agent') return `agent:${actor.id}`
    return actor.kind === 'system' ? 'system' : 'board'
  }

  #ensureIdentity(identity) {
    const key = this.keyring.ensure(identity)
    if (this.data.identities[identity] !== key) { this.data.identities[identity] = key; this.#save() }
    return key
  }

  #post(channelId, { author = SYSTEM, text = '', card = null, threadId = null, mentions = [] } = {}) {
    const identity = this.#identity(author)
    this.#ensureIdentity(identity)
    const message = {
      id: rid('m'),
      channelId,
      threadId: threadId || null,
      author: { kind: author.kind, id: author.id },
      text: clipBlock(text, 4000),
      card: card || null,
      mentions: [...mentions],
      at: isoNow(this.now()),
    }
    // Sign exactly the projection verify() checks, so the two can never disagree.
    message.sig = this.keyring.sign(identity, signedPart(message))
    this.store.appendMessage(message)
    this.#changed()
    return message
  }

  #notice(channelId, text, { threadId = null, level = 'info' } = {}) {
    return this.#post(channelId, { text, threadId, card: { type: 'notice', level } })
  }

  #opsChannel() { return this.data.channels.ops ? 'ops' : 'general' }

  #requireReady() { if (!this.ready()) throw new HqError('HQ is not set up yet — run `quorum hq init` or open the HQ view', 409) }

  #requireBoard(actor, what) {
    if (actor.kind !== 'board') throw new HqError(`${what} is the board's decision, not ${actor.kind === 'agent' ? `${actor.id}'s` : 'the system\'s'}`, 403)
  }

  // Every lookup validates the id's shape and then asks for an OWN key, so an
  // id like "__proto__" or "constructor" is simply unknown.
  #agent(id, { allowTerminated = false } = {}) {
    const key = String(id || '').toLowerCase()
    const agent = AGENT_ID.test(key) && Object.hasOwn(this.data.agents, key) ? this.data.agents[key] : null
    if (!agent) throw new HqError(`unknown agent: ${clip(id, 40)}`, 404)
    if (!allowTerminated && agent.status === 'terminated') throw new HqError(`${agent.name} was terminated`, 409)
    return agent
  }

  #ticket(id) {
    const key = /^T-?\d{1,6}$/i.test(String(id || '').trim()) ? parseTicketRef(id) : null
    const ticket = key && Object.hasOwn(this.data.tickets, key) ? this.data.tickets[key] : null
    if (!ticket && key && Number(key.slice(2)) <= (this.data.counters.ticket || 0)) throw new HqError(`${key} is no longer in the working set — a routine's closed tickets move to archive/tickets.jsonl after a day; its thread is still searchable`, 404)
    if (!ticket) throw new HqError(`unknown ticket: ${clip(id, 40)}`, 404)
    return ticket
  }

  /** An agent id from an id, a name or a name's slug — terminated agents included. */
  #agentFor(handle) {
    const key = String(handle || '').toLowerCase().replace(/^@/, '')
    if (!key) return null
    if (AGENT_ID.test(key) && Object.hasOwn(this.data.agents, key)) return key
    for (const agent of Object.values(this.data.agents)) if (agent.name.toLowerCase() === key || slugify(agent.name) === key) return agent.id
    return null
  }

  #channel(id) {
    const key = String(id || '').replace(/^#/, '').toLowerCase()
    if (!CHANNEL_ID.test(key)) throw new HqError(`unknown channel: #${clip(key, 40)}`, 404)
    if (Object.hasOwn(this.data.channels, key)) return this.data.channels[key]
    if (key.startsWith('dm-')) return this.ensureDm(key.slice(3))
    throw new HqError(`unknown channel: #${key}`, 404)
  }

  #approval(id) {
    const key = String(id || '').toUpperCase()
    const approval = APPROVAL_ID.test(key) && Object.hasOwn(this.data.approvals, key) ? this.data.approvals[key] : null
    if (!approval) throw new HqError(`unknown approval: ${clip(id, 40)}`, 404)
    return approval
  }

  #goal(id) {
    const key = String(id || '').toUpperCase()
    const goal = GOAL_ID.test(key) && Object.hasOwn(this.data.goals, key) ? this.data.goals[key] : null
    if (!goal) throw new HqError(`unknown goal: ${clip(id, 40)}`, 404)
    return goal
  }

  #routine(id) {
    const key = String(id || '').toUpperCase()
    const routine = ROUTINE_ID.test(key) && Object.hasOwn(this.data.routines, key) ? this.data.routines[key] : null
    if (!routine) throw new HqError(`unknown routine: ${clip(id, 40)}`, 404)
    return routine
  }

  #nextId(kind, prefix) {
    this.data.counters[kind] = (this.data.counters[kind] || 0) + 1
    return `${prefix}-${this.data.counters[kind]}`
  }

  /** Every agent that reports, directly or not, to `agentId`. */
  subtree(agentId) {
    const out = new Set()
    const walk = id => {
      for (const agent of Object.values(this.data.agents)) {
        if (agent.reportsTo === id && !out.has(agent.id)) { out.add(agent.id); walk(agent.id) }
      }
    }
    walk(agentId)
    return out
  }

  #canAssign(actor, assigneeId) {
    if (actor.kind !== 'agent') return true
    return assigneeId === actor.id || this.subtree(actor.id).has(assigneeId)
  }

  #handles() {
    const map = new Map()
    for (const agent of Object.values(this.data.agents)) {
      if (agent.status === 'terminated') continue
      map.set(agent.id, agent.id)
      map.set(agent.name.toLowerCase(), agent.id)
      const slug = slugify(agent.name)
      if (slug) map.set(slug, agent.id)
    }
    return map
  }

  #runtimeInfo(id) {
    const list = (() => { try { return this.runtimes() || [] } catch { return [] } })()
    const entry = list.find(item => item.id === id)
    return { id, structured: STRUCTURED_RUNTIMES.includes(id), known: Boolean(entry), available: entry ? entry.available !== false : null, label: entry?.label || id }
  }

  #roomList() { try { return this.rooms() || [] } catch { return [] } }

  #roomIdOrNull(value) {
    if (!value) return null
    const id = String(value)
    if (!this.#roomList().some(room => room.id === id)) throw new HqError(`unknown project room: ${clip(id, 60)}`)
    return id
  }

  // ── company ─────────────────────────────────────────────────────────────

  init({ name, mission = '', template = 'studio', roomId = null, force = false } = {}, actor = BOARD) {
    this.#requireBoard(actor, 'Founding the company')
    if (this.ready()) throw new HqError(`HQ is already set up as ${this.data.company.name}`, 409)
    // An unreadable hq.json was moved aside at load. Founding a new company
    // over it is a decision, not a default.
    const corrupt = this.store.corrupt
    if (corrupt && !corrupt.kept) throw new HqError(`the saved company in ${this.store.file} could not be read (${corrupt.error}) and could not be moved aside — move it yourself before founding a new one`, 409)
    if (corrupt && force !== true) throw new HqError(`the saved company could not be read (${corrupt.error}); it was kept at ${corrupt.file}. Repair it and restart Quorum, or found a new company anyway with --force`, 409)
    const companyName = clip(name, 80)
    if (!companyName) throw new HqError('a company name is required')
    const shape = TEMPLATES[template]
    if (!shape) throw new HqError(`unknown template: ${template} (try ${Object.keys(TEMPLATES).join(', ')})`)
    if (roomId && !this.#roomList().some(room => room.id === roomId)) throw new HqError(`unknown project room: ${roomId}`)
    // Founding over an unreadable company starts the logs afresh; the old
    // ones move to archive/ whole, so its history stays readable and
    // verifiable without appearing in the new company's channels.
    const archived = corrupt ? this.store.archiveLogs(`before-${isoNow(this.now()).replace(/[:.]/g, '-')}`) : null
    for (const identity of ['board', 'system']) this.#ensureIdentity(identity)
    this.data.company = { name: companyName, mission: clip(mission, 600), template, roomId: roomId || null, createdAt: isoNow(this.now()) }
    for (const id of shape.channels) {
      const preset = DEFAULT_CHANNELS[id]
      this.data.channels[id] = { id, name: preset.name, topic: preset.topic, kind: 'channel', roomId: null, branch: null, goalId: null, agentId: null, createdAt: isoNow(this.now()) }
    }
    this.#commit(actor, 'company.founded', companyName, `template ${template}${corrupt ? ` · founded over an unreadable hq.json kept at ${corrupt.file}${archived?.moved.length ? `; its logs are in ${archived.dir}` : ''}` : ''}`)
    this.#post('general', {
      text: `Welcome to ${companyName}.${this.data.company.mission ? ` Mission: ${this.data.company.mission}` : ''} @mention an agent to hand them work, or type /help.`,
      card: { type: 'notice', level: 'info' },
    })
    for (const preset of shape.agents) this.hire({ ...preset, budget: { monthlyUsd: preset.budgetUsd } }, actor)
    return this.snapshot()
  }

  updateCompany(patch = {}, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Changing the company')
    const company = this.data.company
    // Every update validates the whole patch before applying any of it, so a
    // refused field never leaves the ones before it half-applied in memory.
    const next = {}
    if (patch.name !== undefined) { next.name = clip(patch.name, 80); if (!next.name) throw new HqError('a company name is required') }
    if (patch.mission !== undefined) next.mission = clip(patch.mission, 600)
    if (patch.roomId !== undefined) next.roomId = this.#roomIdOrNull(patch.roomId)
    Object.assign(company, next)
    this.#commit(actor, 'company.updated', company.name, Object.keys(next).join(', '))
    return company
  }

  // ── agents ──────────────────────────────────────────────────────────────

  #agentFields(input, existing = null) {
    const name = input.name !== undefined ? clip(input.name, 40) : existing?.name
    if (!name) throw new HqError('an agent needs a name')
    const title = input.title !== undefined ? clip(input.title, 60) : existing?.title
    if (!title) throw new HqError('an agent needs a title')
    let pack
    try { pack = this.resolvePack(input.packId ?? existing?.packId ?? 'builder') } catch (error) { throw new HqError(error.message) }
    const runtime = String(input.runtime ?? existing?.runtime ?? 'claude').toLowerCase()
    if (!RUNTIME_ID.test(runtime)) throw new HqError(`invalid runtime id: ${runtime}`)
    const defaultModel = runtime === 'claude' ? `claude:${pack.defaultModel || 'sonnet'}` : `${runtime}:auto`
    const modelRef = clip(input.modelRef ?? (input.runtime !== undefined && input.runtime !== existing?.runtime ? defaultModel : existing?.modelRef) ?? defaultModel, 160) || defaultModel
    const roomId = input.roomId !== undefined ? this.#roomIdOrNull(input.roomId) : existing?.roomId ?? null
    const monthlyUsd = numberIn(input.budget?.monthlyUsd ?? input.budgetUsd ?? existing?.budget?.monthlyUsd, 0, 100_000, 10)
    const warnPct = numberIn(input.budget?.warnPct ?? existing?.budget?.warnPct, 1, 100, 80)
    const heartbeatIn = input.heartbeat ?? {}
    const heartbeat = {
      enabled: heartbeatIn.enabled !== undefined ? heartbeatIn.enabled === true : existing?.heartbeat?.enabled === true,
      everyMinutes: Math.round(numberIn(heartbeatIn.everyMinutes ?? existing?.heartbeat?.everyMinutes, 5, 1440, 60)),
      nextAt: existing?.heartbeat?.nextAt ?? null,
      lastAt: existing?.heartbeat?.lastAt ?? null,
    }
    const autonomy = String(input.autonomy ?? existing?.autonomy ?? 'supervised')
    if (!['supervised', 'autonomous'].includes(autonomy)) throw new HqError('autonomy is supervised or autonomous')
    // Autonomy is spending without asking, bounded only by the cap. A harness
    // that reports no price would spend where the cap cannot see it.
    if (autonomy === 'autonomous' && !PRICED_RUNTIMES.includes(runtime)) throw new HqError(`${runtime} runs report no price, so a monthly cap cannot see what an autonomous ${runtime} agent spends — keep it supervised`)
    if (autonomy === 'autonomous' && monthlyUsd <= 0) throw new HqError('an autonomous agent needs a monthly budget cap — its runs start without asking you first')
    return {
      name, title, packId: pack.id, role: pack.role || 'builder', runtime, modelRef, roomId,
      instructions: input.instructions !== undefined ? clipBlock(input.instructions, 2000) : existing?.instructions || '',
      budget: { monthlyUsd, warnPct, warnedMonth: existing?.budget?.warnedMonth ?? null },
      heartbeat, autonomy,
    }
  }

  hire(input = {}, actor = BOARD) {
    this.#requireReady()
    const id = String(input.id || slugify(input.name) || '').toLowerCase()
    if (!AGENT_ID.test(id)) throw new HqError(`agent id must be 2–32 lowercase letters, digits or dashes: ${id || '(empty)'}`)
    if (['board', 'system', 'here', 'all', 'everyone'].includes(id)) throw new HqError(`${id} is reserved`)
    if (this.data.agents[id]) throw new HqError(`agent id ${id} is taken${this.data.agents[id].status === 'terminated' ? ' (by a terminated agent — ids are never reused, so their signed history stays theirs)' : ''}`, 409)
    const reportsTo = input.reportsTo ? String(input.reportsTo).toLowerCase() : null
    if (reportsTo) this.#agent(reportsTo)
    // An agent can propose a hire; only the board can make one. A proposal is
    // always supervised with its heartbeat off: autonomy and a schedule are
    // the board's to grant after the hire, never riders inside one.
    const proposing = actor.kind === 'agent'
    const fields = this.#agentFields(proposing ? { ...input, autonomy: 'supervised', heartbeat: { enabled: false } } : input)

    if (proposing) {
      if (reportsTo !== actor.id && !(reportsTo && this.subtree(actor.id).has(reportsTo))) throw new HqError(`${actor.id} can only propose hires into their own team`, 403)
      // Only what the summary shows is kept, so what the board approves is
      // exactly what gets hired.
      const proposal = {
        id, name: fields.name, title: fields.title, packId: fields.packId, runtime: fields.runtime, modelRef: fields.modelRef,
        roomId: fields.roomId, reportsTo, budget: { monthlyUsd: fields.budget.monthlyUsd }, instructions: fields.instructions,
        avatar: validateAvatar(input.avatar, id, { packId: fields.packId, title: fields.title }),
      }
      // The pack decides the harness sandbox, so it is named with what it
      // allows. The brief goes into every run the hire makes; the summary
      // gives its length and opening, and the inbox shows it in full.
      const brief = fields.instructions
      const summary = [
        `${actor.id} proposes hiring ${fields.name} (@${id}) as ${fields.title}, reporting to ${this.data.agents[reportsTo]?.name || reportsTo}`,
        `${fields.packId} pack (${READ_ONLY_ROLES.includes(fields.role) ? 'read-only' : 'can write'})`,
        `${fields.runtime} · ${clip(fields.modelRef, 40)}`,
        `${money(fields.budget.monthlyUsd)}/mo cap`,
        fields.roomId ? `room ${fields.roomId}` : 'no room of its own',
        'supervised, heartbeat off',
        brief ? `brief of ${brief.length} chars: “${clip(brief, 48)}”` : 'no brief',
      ].join(' · ')
      return { approval: this.#requestApproval({ kind: 'hire', agentId: actor.id, summary, proposal, channelId: this.#opsChannel() }, actor) }
    }

    this.#requireBoard(actor, 'Hiring')
    const agent = {
      id, ...fields, reportsTo,
      avatar: validateAvatar(input.avatar, id, { packId: fields.packId, title: fields.title }),
      status: 'active', pausedReason: null,
      createdAt: isoNow(this.now()), updatedAt: isoNow(this.now()),
    }
    if (agent.heartbeat.enabled) agent.heartbeat.nextAt = this.now() + agent.heartbeat.everyMinutes * 60_000
    this.data.agents[id] = agent
    this.#ensureIdentity(`agent:${id}`)
    this.ensureDm(id, { quiet: true })
    const manager = reportsTo ? this.data.agents[reportsTo] : null
    this.#commit(actor, 'agent.hired', id, `${agent.title} · ${agent.runtime} · reports to ${manager?.name || 'the board'}`)
    this.#post('general', {
      text: `Hired ${agent.name} as ${agent.title}, reporting to ${manager?.name || 'the board'} · ${agent.runtime} · ${agent.budget.monthlyUsd > 0 ? `${money(agent.budget.monthlyUsd)}/mo cap` : 'no monthly cap'} · ${agent.autonomy}`,
      card: { type: 'agent', event: 'hired', agentId: id },
    })
    return { agent: this.#publicAgent(agent) }
  }

  updateAgent(id, patch = {}, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Changing an agent')
    const agent = this.#agent(id)
    let reportsTo = agent.reportsTo
    if (patch.reportsTo !== undefined) {
      reportsTo = patch.reportsTo ? String(patch.reportsTo).toLowerCase() : null
      if (reportsTo) {
        this.#agent(reportsTo)
        if (reportsTo === agent.id || this.subtree(agent.id).has(reportsTo)) throw new HqError(`${agent.name} cannot report to ${reportsTo}: that would make a loop in the org chart`)
      }
    }
    const fields = this.#agentFields(patch, agent)
    const avatar = patch.avatar !== undefined ? validateAvatar(patch.avatar, agent.id, { packId: fields.packId, title: fields.title }) : agent.avatar
    const wasEnabled = agent.heartbeat.enabled
    Object.assign(agent, fields, { reportsTo, avatar })
    if (agent.heartbeat.enabled && (!wasEnabled || !agent.heartbeat.nextAt)) agent.heartbeat.nextAt = this.now() + agent.heartbeat.everyMinutes * 60_000
    if (!agent.heartbeat.enabled) agent.heartbeat.nextAt = null
    agent.updatedAt = isoNow(this.now())
    this.#commit(actor, 'agent.updated', agent.id, Object.keys(patch).join(', '))
    if (this.#resumeIfUnderCap(agent, 'the monthly cap now covers this month’s spend')) void this.processQueue()
    return { agent: this.#publicAgent(agent) }
  }

  /** A budget pause lifts by itself once the agent is back under its cap: a raised cap, or a new month. */
  #resumeIfUnderCap(agent, why) {
    if (agent.status !== 'paused' || agent.pausedReason !== 'budget') return false
    const budget = this.budget(agent.id)
    if (budget.state === 'over') return false
    agent.status = 'active'
    agent.pausedReason = null
    agent.pausedAt = null
    agent.updatedAt = isoNow(this.now())
    if (agent.heartbeat.enabled) agent.heartbeat.nextAt = this.now() + agent.heartbeat.everyMinutes * 60_000
    this.#commit(SYSTEM, 'agent.resumed', agent.id, why)
    this.#post(this.#opsChannel(), { text: `${agent.name} is back to work: ${why} (${budgetLine(budget)}).`, card: { type: 'agent', event: 'resumed', agentId: agent.id } })
    if (this.readyTickets(agent.id).length) this.#enqueue(agent.id, 'resumed')
    return true
  }

  pause(id, actor = BOARD, reason = 'board') {
    this.#requireReady()
    if (actor.kind === 'agent') this.#requireBoard(actor, 'Pausing an agent')
    const agent = this.#agent(id)
    if (agent.status === 'paused') {
      // A board pause outranks a budget pause: it must not be lifted by the
      // cap being raised or the month turning over.
      if (reason === 'board' && agent.pausedReason !== 'board') {
        agent.pausedReason = 'board'
        agent.updatedAt = isoNow(this.now())
        this.#commit(actor, 'agent.paused', agent.id, 'board (was paused for budget)')
      }
      return { agent: this.#publicAgent(agent) }
    }
    agent.status = 'paused'
    agent.pausedReason = reason
    agent.pausedAt = isoNow(this.now())
    agent.updatedAt = agent.pausedAt
    for (const wakeup of this.data.wakeups) if (wakeup.agentId === agent.id && wakeup.status === 'queued') { wakeup.status = 'cancelled'; wakeup.result = `${agent.name} paused` }
    this.#settleWhere(approval => approval.agentId === agent.id && approval.kind === 'dispatch', 'expired', `${agent.name} was paused`, actor)
    this.#commit(actor, 'agent.paused', agent.id, reason)
    this.#post(this.#opsChannel(), { text: reason === 'budget' ? `${agent.name} is paused: monthly budget reached (${budgetLine(this.budget(agent.id))}). Raise the cap or wait for ${this.budget(agent.id).resetsAt.slice(0, 10)}.` : `${agent.name} is paused by the board. Queued wakeups were cancelled; a run already in flight keeps going.`, card: { type: 'agent', event: 'paused', agentId: agent.id, reason } })
    return { agent: this.#publicAgent(agent) }
  }

  resume(id, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Resuming an agent')
    const agent = this.#agent(id)
    if (agent.status !== 'paused') return { agent: this.#publicAgent(agent) }
    const budget = this.budget(agent.id)
    if (budget.state === 'over') throw new HqError(`${agent.name} is over budget (${budgetLine(budget)}) — raise the monthly cap first`, 409)
    agent.status = 'active'
    agent.pausedReason = null
    agent.pausedAt = null
    agent.updatedAt = isoNow(this.now())
    if (agent.heartbeat.enabled) agent.heartbeat.nextAt = this.now() + agent.heartbeat.everyMinutes * 60_000
    this.#commit(actor, 'agent.resumed', agent.id, '')
    this.#post(this.#opsChannel(), { text: `${agent.name} is back to work.`, card: { type: 'agent', event: 'resumed', agentId: agent.id } })
    // Pausing cancelled the queued wakeups; waiting work is picked back up.
    if (this.readyTickets(agent.id).length) { this.#enqueue(agent.id, 'resumed'); void this.processQueue() }
    return { agent: this.#publicAgent(agent) }
  }

  /** Terminated agents stay on record — their id, key and signed history are kept forever. */
  terminate(id, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Terminating an agent')
    const agent = this.#agent(id)
    const live = Object.values(this.data.tickets).find(ticket => ticket.checkout?.agentId === agent.id)
    if (live) throw new HqError(`${agent.name} is mid-run on ${live.id} — cancel that run first`, 409)
    agent.status = 'terminated'
    agent.pausedReason = null
    agent.updatedAt = isoNow(this.now())
    for (const report of Object.values(this.data.agents)) if (report.reportsTo === agent.id) report.reportsTo = agent.reportsTo
    const released = []
    for (const ticket of Object.values(this.data.tickets)) {
      if (ticket.assigneeId === agent.id && !['done', 'cancelled'].includes(ticket.status)) {
        ticket.assigneeId = null
        ticket.status = 'backlog'
        ticket.updatedAt = isoNow(this.now())
        released.push(ticket.id)
      }
    }
    for (const wakeup of this.data.wakeups) if (wakeup.agentId === agent.id && wakeup.status === 'queued') { wakeup.status = 'cancelled'; wakeup.result = `${agent.name} terminated` }
    this.#settleWhere(approval => approval.agentId === agent.id, 'expired', `${agent.name} was terminated`, actor)
    const paused = []
    for (const routine of Object.values(this.data.routines)) {
      if (routine.assigneeId !== agent.id || routine.status !== 'active') continue
      Object.assign(routine, { status: 'paused', pausedReason: 'agent terminated', updatedAt: isoNow(this.now()) })
      paused.push(routine.id)
    }
    this.#commit(actor, 'agent.terminated', agent.id, [released.length ? `released ${released.join(', ')}` : '', paused.length ? `paused ${paused.join(', ')}` : ''].filter(Boolean).join('; '))
    this.#post('general', { text: `${agent.name} (${agent.title}) was terminated. Their history and signatures are kept.${released.length ? ` Back in the backlog: ${released.join(', ')}.` : ''}${paused.length ? ` Paused until someone else takes them: ${paused.join(', ')} (quorum routine edit <R-n> --assign <agent>).` : ''}`, card: { type: 'agent', event: 'terminated', agentId: agent.id } })
    return { agent: this.#publicAgent(agent), released }
  }

  // ── goals ───────────────────────────────────────────────────────────────

  addGoal({ title, description = '', ownerId = null } = {}, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Setting company goals')
    const text = clip(title, 160)
    if (!text) throw new HqError('a goal needs a title')
    const owner = ownerId ? this.#agent(ownerId).id : null
    const goal = { id: this.#nextId('goal', 'G'), title: text, description: clipBlock(description, 1500), ownerId: owner, status: 'active', createdAt: isoNow(this.now()), updatedAt: isoNow(this.now()) }
    this.data.goals[goal.id] = goal
    this.#commit(actor, 'goal.created', goal.id, goal.title)
    this.#post('general', { author: actor, text: `New goal ${goal.id}: ${goal.title}`, card: { type: 'goal', event: 'created', goalId: goal.id } })
    return { goal }
  }

  updateGoal(id, patch = {}, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Changing company goals')
    const goal = this.#goal(id)
    const next = {}
    if (patch.title !== undefined) { next.title = clip(patch.title, 160); if (!next.title) throw new HqError('a goal needs a title') }
    if (patch.description !== undefined) next.description = clipBlock(patch.description, 1500)
    if (patch.ownerId !== undefined) next.ownerId = patch.ownerId ? this.#agent(patch.ownerId).id : null
    if (patch.status !== undefined) {
      if (!['active', 'achieved', 'dropped'].includes(patch.status)) throw new HqError('goal status is active, achieved or dropped')
      next.status = patch.status
    }
    Object.assign(goal, next, { updatedAt: isoNow(this.now()) })
    this.#commit(actor, 'goal.updated', goal.id, Object.keys(next).join(', '))
    return { goal }
  }

  // ── routines ────────────────────────────────────────────────────────────
  //
  // Recurring work: every N minutes a routine opens a ticket for its agent.
  // A routine never runs anything itself — the ticket it opens is asked
  // about (or, for an autonomous agent, started inside its cap) like any
  // other. While the last ticket it opened is still open, a due routine
  // skips its turn instead of stacking up copies of the same work.

  #routineFields(input, existing = null) {
    const title = input.title !== undefined ? clip(input.title, 140) : existing?.title
    if (!title) throw new HqError('a routine needs a title')
    const assigneeId = input.assigneeId !== undefined ? this.#agent(input.assigneeId).id : existing?.assigneeId
    if (!assigneeId) throw new HqError('a routine needs an agent to hand its tickets to')
    const everyInput = input.every ?? input.everyMinutes
    const everyMinutes = everyInput !== undefined ? parseEvery(everyInput) : existing?.everyMinutes
    if (!everyMinutes) throw new HqError(`a routine runs every 15m to 30d — try 1h, 1d or 1w, not ${clip(everyInput ?? 'nothing', 20)}`)
    const channelId = input.channelId !== undefined ? (input.channelId ? this.#channel(input.channelId).id : 'general') : existing?.channelId || 'general'
    const priority = input.priority !== undefined ? input.priority : existing?.priority || 'normal'
    if (!PRIORITIES.includes(priority)) throw new HqError(`priority is ${PRIORITIES.join(', ')}`)
    return {
      title, assigneeId, everyMinutes, channelId, priority,
      body: input.body !== undefined ? clipBlock(input.body, 4000) : existing?.body || '',
      verifyCommand: input.verifyCommand !== undefined ? this.#verifyCommand(input.verifyCommand) : existing?.verifyCommand || null,
    }
  }

  addRoutine(input = {}, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Setting up a routine')
    const fields = this.#routineFields(input)
    const at = isoNow(this.now())
    const routine = { id: this.#nextId('routine', 'R'), ...fields, status: 'active', nextAt: this.now() + fields.everyMinutes * 60_000, lastAt: null, lastTicketId: null, skippedFor: null, fired: 0, skipped: 0, createdBy: { kind: actor.kind, id: actor.id }, createdAt: at, updatedAt: at }
    this.data.routines[routine.id] = routine
    this.#commit(actor, 'routine.created', routine.id, `${routine.title} → ${routine.assigneeId} every ${formatEvery(routine.everyMinutes)}`)
    const agent = this.data.agents[routine.assigneeId]
    this.#notice(routine.channelId, `Routine ${routine.id}: every ${formatEvery(routine.everyMinutes)}, a ticket “${routine.title}” opens for @${routine.assigneeId}. The first one opens ${new Date(routine.nextAt).toISOString().slice(0, 16).replace('T', ' ')} UTC. ${agent?.autonomy === 'autonomous' ? `${agent.name} is autonomous, so each one can start inside their monthly cap.` : `${agent?.name || routine.assigneeId} asks you before each run.`}`)
    return { routine: this.#publicRoutine(routine) }
  }

  updateRoutine(id, patch = {}, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Changing a routine')
    const routine = this.#routine(id)
    if (routine.status === 'retired') throw new HqError(`${routine.id} is retired`, 409)
    const fields = this.#routineFields(patch, routine)
    const rescheduled = fields.everyMinutes !== routine.everyMinutes
    Object.assign(routine, fields, { updatedAt: isoNow(this.now()) })
    if (rescheduled) routine.nextAt = this.now() + routine.everyMinutes * 60_000
    this.#commit(actor, 'routine.updated', routine.id, Object.keys(patch).join(', '))
    return { routine: this.#publicRoutine(routine) }
  }

  /** `pause`, `resume` or `retire`. A retired routine is kept, with its history; it never fires again. */
  setRoutineStatus(id, action, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Changing a routine')
    const routine = this.#routine(id)
    const next = { pause: 'paused', resume: 'active', retire: 'retired' }[action]
    if (!next) throw new HqError('pause, resume or retire')
    if (routine.status === 'retired') throw new HqError(`${routine.id} is retired`, 409)
    // Resuming a running routine must not move its schedule.
    if (routine.status === next) return { routine: this.#publicRoutine(routine) }
    if (next === 'active' && this.data.agents[routine.assigneeId]?.status === 'terminated') throw new HqError(`${routine.id}'s agent was terminated — hand it to someone else first (quorum routine edit ${routine.id} --assign <agent>)`, 409)
    routine.status = next
    routine.pausedReason = next === 'paused' ? 'board' : null
    if (next === 'active') routine.nextAt = this.now() + routine.everyMinutes * 60_000
    routine.updatedAt = isoNow(this.now())
    this.#commit(actor, `routine.${action === 'retire' ? 'retired' : next === 'active' ? 'resumed' : 'paused'}`, routine.id, '')
    return { routine: this.#publicRoutine(routine) }
  }

  /** Fire a routine now, out of schedule. The same rules apply: an open last ticket means no new one. */
  runRoutine(id, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Running a routine')
    const routine = this.#routine(id)
    if (routine.status !== 'active') throw new HqError(`${routine.id} is ${routine.status}`, 409)
    const result = this.#fireRoutine(routine, this.now(), actor, { manual: true })
    void this.processQueue()
    return { routine: this.#publicRoutine(routine), ...result }
  }

  #fireRoutine(routine, now, actor = SYSTEM, { manual = false } = {}) {
    // A scheduled turn is used up whether it opens a ticket or skips — and it
    // is used up first, so a turn that throws is not retried every beat. A
    // manual run is extra: the schedule stays where it was.
    if (!manual) routine.nextAt = now + routine.everyMinutes * 60_000
    const agent = this.data.agents[routine.assigneeId]
    if (!agent || agent.status === 'terminated') {
      routine.status = 'paused'
      routine.pausedReason = 'agent terminated'
      this.#commit(SYSTEM, 'routine.paused', routine.id, `${routine.assigneeId} was terminated`)
      this.#notice(routine.channelId, `Routine ${routine.id} is paused: @${routine.assigneeId} was terminated. Hand it to someone else to resume it.`, { level: 'warn' })
      return { skipped: 'agent terminated' }
    }
    const last = routine.lastTicketId ? this.data.tickets[routine.lastTicketId] : null
    if (last && !['done', 'cancelled'].includes(last.status)) {
      routine.skipped += 1
      this.store.appendActivity({ actor: SYSTEM, action: 'routine.skipped', target: routine.id, detail: `${last.id} from its last run is still ${last.status}` })
      // Said once per open ticket, not on every beat it stays open.
      if (routine.skippedFor !== last.id) {
        routine.skippedFor = last.id
        this.#notice(routine.channelId, `Routine ${routine.id} skipped its turn: ${last.id} from its last run is still ${last.status.replace('_', ' ')}. It opens a new ticket once that one is closed.`, { threadId: last.id })
      }
      this.#save(); this.#changed()
      return { skipped: `${last.id} is still ${last.status}` }
    }
    const stamp = new Date(now).toISOString().slice(0, 10)
    const { ticket } = this.createTicket({ title: `${routine.title} · ${stamp}`, body: routine.body || routine.title, channelId: routine.channelId, assigneeId: routine.assigneeId, priority: routine.priority, verifyCommand: routine.verifyCommand || undefined }, SYSTEM, { wake: true, routine })
    this.#commit(actor, 'routine.fired', routine.id, `${ticket.id} for ${routine.assigneeId}${manual ? ' (run now)' : ''}`)
    this.#retainRoutineTickets(routine)
    return { ticket: this.#publicTicket(this.data.tickets[ticket.id]) }
  }

  /**
   * A routine can open a ticket every 15 minutes for years, and hq.json is
   * rewritten on every save. A routine's closed tickets beyond its newest 50
   * move to archive/tickets.jsonl — kept, never deleted, their threads still
   * in messages.jsonl for search — once they are a day old and nothing open
   * waits on them.
   */
  #retainRoutineTickets(routine) {
    const KEEP = 50
    const DAY = 24 * 60 * 60_000
    const now = this.now()
    const closed = Object.values(this.data.tickets).filter(ticket => ticket.routineId === routine.id && ['done', 'cancelled'].includes(ticket.status) && !ticket.checkout)
    if (closed.length <= KEEP) return 0
    const waitedOn = new Set(Object.values(this.data.tickets).filter(ticket => !['done', 'cancelled'].includes(ticket.status)).flatMap(ticket => ticket.blockedBy || []))
    const asked = new Set(Object.values(this.data.approvals).filter(item => item.status === 'pending').map(item => item.ticketId))
    const old = closed.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2))).slice(0, closed.length - KEEP)
      .filter(ticket => now - Date.parse(ticket.closedAt || ticket.updatedAt) > DAY && !waitedOn.has(ticket.id) && !asked.has(ticket.id) && ticket.id !== routine.lastTicketId)
    if (!old.length) return 0
    this.store.archiveRecords('tickets', old)
    for (const ticket of old) delete this.data.tickets[ticket.id]
    this.#commit(SYSTEM, 'routine.archived', routine.id, `${old.length} closed ticket(s) moved to archive/tickets.jsonl`)
    return old.length
  }

  #publicRoutine(routine) {
    const last = routine.lastTicketId ? this.data.tickets[routine.lastTicketId] : null
    return { ...routine, every: formatEvery(routine.everyMinutes), lastTicketStatus: last?.status || null, verifyCommand: routine.verifyCommand ? { ...routine.verifyCommand } : null }
  }

  // ── tickets ─────────────────────────────────────────────────────────────

  #validBlockers(list, selfId = null) {
    const ids = [...new Set((Array.isArray(list) ? list : String(list || '').split(',')).map(item => parseTicketRef(item)).filter(Boolean))]
    for (const blocker of ids) {
      if (blocker === selfId) throw new HqError('a ticket cannot block itself')
      if (!this.data.tickets[blocker]) throw new HqError(`unknown blocking ticket: ${blocker}`)
    }
    if (selfId) {
      const seen = new Set()
      const reaches = id => {
        if (id === selfId) return true
        if (seen.has(id)) return false
        seen.add(id)
        return (this.data.tickets[id]?.blockedBy || []).some(reaches)
      }
      if (ids.some(reaches)) throw new HqError(`that would make ${selfId} wait on itself`)
    }
    return ids.slice(0, 20)
  }

  /**
   * The check Quorum runs itself to decide the ticket is done. A string is
   * split on whitespace — never handed to a shell — and then held to the same
   * rules as a mission task's verifyCommand.
   */
  #verifyCommand(value) {
    if (value === undefined || value === null || value === '') return null
    let input = value
    if (typeof value === 'string') {
      const parts = value.trim().split(/\s+/).filter(Boolean)
      input = { command: parts[0] || '', args: parts.slice(1) }
    }
    if (!this.validateVerify) return input
    const result = this.validateVerify(input)
    if (!result.value) throw new HqError(`verify command refused: ${(result.errors || []).join('; ') || 'not a plain command'}`)
    return result.value
  }

  createTicket(input = {}, actor = BOARD, { wake = true, quiet = false, routine = null } = {}) {
    this.#requireReady()
    const title = clip(input.title, 160)
    if (!title) throw new HqError('a ticket needs a title')
    const assigneeId = input.assigneeId ? String(input.assigneeId).toLowerCase() : null
    if (assigneeId) {
      const assignee = this.#agent(assigneeId)
      if (!this.#canAssign(actor, assignee.id)) throw new HqError(`${actor.id} can only hand work to themselves or their reports, not ${assignee.name}`, 403)
    }
    const goalId = input.goalId ? this.#goal(input.goalId).id : null
    const channelId = input.channelId ? this.#channel(input.channelId).id : 'general'
    const channel = this.data.channels[channelId]
    const priority = PRIORITIES.includes(input.priority) ? input.priority : 'normal'
    const roomId = this.#roomIdOrNull(input.roomId)
    const ticket = {
      id: this.#nextId('ticket', 'T'),
      title,
      body: clipBlock(input.body || '', 4000),
      goalId,
      channelId,
      assigneeId,
      status: assigneeId ? 'todo' : 'backlog',
      priority,
      blockedBy: this.#validBlockers(input.blockedBy),
      checkout: null,
      runs: [],
      verifyCommand: this.#verifyCommand(input.verifyCommand),
      roomId,
      branch: clip(input.branch || channel?.branch || '', 180) || null,
      verified: false,
      routineId: routine?.id || null,
      createdBy: { kind: actor.kind, id: actor.id },
      createdAt: isoNow(this.now()),
      updatedAt: isoNow(this.now()),
      closedAt: null,
    }
    this.data.tickets[ticket.id] = ticket
    // A routine's link to its ticket is written in the same save as the
    // ticket, so a failure after this point can never leave an open ticket
    // the routine does not know about — and so open a second one.
    if (routine) Object.assign(routine, { lastTicketId: ticket.id, lastAt: this.now(), skippedFor: null, fired: routine.fired + 1, updatedAt: isoNow(this.now()) })
    this.#commit(actor, 'ticket.created', ticket.id, `${ticket.title}${assigneeId ? ` → ${assigneeId}` : ''}${routine ? ` · routine ${routine.id}` : ''}`)
    // The wakeup is what gets the work done; it is queued before the
    // announcement, so a failed post cannot strand the ticket unassigned.
    if (assigneeId && wake) this.#enqueue(assigneeId, 'assignment', ticket.id)
    if (!quiet) {
      const assignee = assigneeId ? this.data.agents[assigneeId] : null
      this.#post(channelId, {
        author: actor.kind === 'agent' ? actor : SYSTEM,
        threadId: ticket.id,
        text: `${ticket.id} opened${assignee ? ` for @${assignee.id}` : ''}: ${ticket.title}`,
        card: { type: 'ticket', event: 'opened', ticketId: ticket.id },
        mentions: assignee ? [assignee.id] : [],
      })
    }
    if (wake) void this.processQueue()
    return { ticket: this.#publicTicket(ticket) }
  }

  updateTicket(id, patch = {}, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Editing a ticket')
    const ticket = this.#ticket(id)
    const next = {}
    if (patch.title !== undefined) { next.title = clip(patch.title, 160); if (!next.title) throw new HqError('a ticket needs a title') }
    if (patch.body !== undefined) next.body = clipBlock(patch.body, 4000)
    if (patch.priority !== undefined) { if (!PRIORITIES.includes(patch.priority)) throw new HqError(`priority is ${PRIORITIES.join(', ')}`); next.priority = patch.priority }
    if (patch.goalId !== undefined) next.goalId = patch.goalId ? this.#goal(patch.goalId).id : null
    if (patch.blockedBy !== undefined) next.blockedBy = this.#validBlockers(patch.blockedBy, ticket.id)
    if (patch.verifyCommand !== undefined) next.verifyCommand = this.#verifyCommand(patch.verifyCommand)
    if (patch.roomId !== undefined) next.roomId = this.#roomIdOrNull(patch.roomId)
    if (patch.branch !== undefined) next.branch = clip(patch.branch, 180) || null
    if (patch.status !== undefined) {
      // in_progress means a real run holds the ticket. Only a dispatch sets it.
      if (!['backlog', 'todo', 'blocked', 'cancelled'].includes(patch.status)) throw new HqError('set backlog, todo, blocked or cancelled here — done comes from `close`, in_progress only from a real run')
      if (ticket.checkout) throw new HqError(`${ticket.id} is checked out by a run — cancel the run first`, 409)
      next.status = patch.status
    }
    Object.assign(ticket, next, { updatedAt: isoNow(this.now()) })
    if (next.status !== undefined && next.status !== 'todo') this.#expireApprovals(ticket.id, `${ticket.id} moved to ${next.status}`, actor)
    this.#commit(actor, 'ticket.updated', ticket.id, Object.keys(next).join(', '))
    if (next.status === 'todo' && ticket.assigneeId) { this.#enqueue(ticket.assigneeId, 'status', ticket.id); void this.processQueue() }
    return { ticket: this.#publicTicket(ticket) }
  }

  assign(id, agentId, actor = BOARD) {
    this.#requireReady()
    const ticket = this.#ticket(id)
    const agent = this.#agent(agentId)
    if (!this.#canAssign(actor, agent.id)) throw new HqError(`${actor.id} can only hand work to themselves or their reports, not ${agent.name}`, 403)
    if (actor.kind === 'agent') {
      // Choosing the assignee is not enough: the ticket must be the agent's to
      // hand on — one it opened, or one held inside its own branch of the org.
      const opened = ticket.createdBy?.kind === 'agent' && ticket.createdBy.id === actor.id
      const held = Boolean(ticket.assigneeId) && (ticket.assigneeId === actor.id || this.subtree(actor.id).has(ticket.assigneeId))
      if (!opened && !held) throw new HqError(`${actor.id} can only reassign tickets they opened or that sit with their own team, not ${ticket.id}`, 403)
      const asked = Object.values(this.data.approvals).find(item => item.ticketId === ticket.id && item.status === 'pending')
      if (asked) throw new HqError(`${ticket.id} has an ask waiting on the board (${asked.id}) — only the board can reassign it now`, 409)
    }
    if (ticket.checkout) throw new HqError(`${ticket.id} is checked out by ${ticket.checkout.agentId}'s run`, 409)
    if (['done', 'cancelled'].includes(ticket.status)) throw new HqError(`${ticket.id} is ${ticket.status} — reopen it first`, 409)
    if (ticket.assigneeId && ticket.assigneeId !== agent.id) this.#expireApprovals(ticket.id, `${ticket.id} was reassigned to ${agent.id}`, actor)
    ticket.assigneeId = agent.id
    if (ticket.status === 'backlog') ticket.status = 'todo'
    ticket.updatedAt = isoNow(this.now())
    this.#commit(actor, 'ticket.assigned', ticket.id, agent.id)
    this.#post(ticket.channelId, { author: actor.kind === 'agent' ? actor : SYSTEM, threadId: ticket.id, text: `${ticket.id} assigned to @${agent.id}`, card: { type: 'ticket', event: 'assigned', ticketId: ticket.id }, mentions: [agent.id] })
    this.#enqueue(agent.id, 'assignment', ticket.id)
    void this.processQueue()
    return { ticket: this.#publicTicket(ticket) }
  }

  /** A board close is recorded as unverified: no run's evidence decided it. */
  close(id, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Closing a ticket')
    const ticket = this.#ticket(id)
    if (ticket.checkout) throw new HqError(`${ticket.id} is checked out by a run — cancel the run first`, 409)
    ticket.status = 'done'
    ticket.verified = false
    ticket.closedAt = isoNow(this.now())
    ticket.updatedAt = ticket.closedAt
    this.#expireApprovals(ticket.id, `${ticket.id} was closed`, actor)
    this.#commit(actor, 'ticket.closed', ticket.id, 'closed by the board, not verified by a run')
    this.#post(ticket.channelId, { threadId: ticket.id, text: `${ticket.id} closed by the board (not verified by a run).`, card: { type: 'ticket', event: 'closed', ticketId: ticket.id } })
    this.#unblockDependents(ticket.id)
    void this.processQueue()
    return { ticket: this.#publicTicket(ticket) }
  }

  reopen(id, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Reopening a ticket')
    const ticket = this.#ticket(id)
    if (!['done', 'cancelled', 'blocked', 'backlog'].includes(ticket.status)) return { ticket: this.#publicTicket(ticket) }
    ticket.status = ticket.assigneeId ? 'todo' : 'backlog'
    ticket.verified = false
    ticket.closedAt = null
    ticket.updatedAt = isoNow(this.now())
    this.#commit(actor, 'ticket.reopened', ticket.id, '')
    this.#post(ticket.channelId, { threadId: ticket.id, text: `${ticket.id} reopened.`, card: { type: 'ticket', event: 'reopened', ticketId: ticket.id } })
    if (ticket.assigneeId) { this.#enqueue(ticket.assigneeId, 'reopened', ticket.id); void this.processQueue() }
    return { ticket: this.#publicTicket(ticket) }
  }

  cancelRun(id, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Cancelling a run')
    const ticket = this.#ticket(id)
    const runId = ticket.checkout?.runId
    if (!runId) throw new HqError(`${ticket.id} has no run in flight`, 409)
    if (!this.runtimeManager) throw new HqError('no runtime manager is attached', 503)
    const run = this.runtimeManager.cancel(runId)
    this.store.appendActivity({ actor, action: 'ticket.run-cancelled', target: ticket.id, detail: runId })
    return { ticket: this.#publicTicket(ticket), run }
  }

  /** A pending ask about this ticket no longer describes it: close it out instead of letting it start the wrong run. */
  #expireApprovals(ticketId, reason, actor = SYSTEM) {
    return this.#settleWhere(approval => approval.ticketId === ticketId, 'superseded', reason, actor)
  }

  #blockersDone(ticket) { return (ticket.blockedBy || []).every(id => this.data.tickets[id]?.status === 'done') }

  /** The agent's tickets that could start now, most urgent first. */
  readyTickets(agentId) {
    return Object.values(this.data.tickets)
      .filter(ticket => ticket.assigneeId === agentId && ticket.status === 'todo' && !ticket.checkout && this.#blockersDone(ticket))
      .sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || (Number(a.id.slice(2)) - Number(b.id.slice(2))))
  }

  #unblockDependents(ticketId) {
    for (const ticket of Object.values(this.data.tickets)) {
      if (!ticket.blockedBy?.includes(ticketId) || ticket.status !== 'todo' || !ticket.assigneeId) continue
      if (this.#blockersDone(ticket)) this.#enqueue(ticket.assigneeId, 'unblocked', ticket.id)
    }
  }

  // ── channels and messages ───────────────────────────────────────────────

  createChannel({ name, topic = '', roomId = null, branch = null, goalId = null } = {}, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Creating a channel')
    const id = slugify(String(name || '').replace(/^#/, '')) || String(name || '').replace(/^#/, '').toLowerCase()
    if (!CHANNEL_ID.test(id) || id.startsWith('dm-')) throw new HqError(`channel names are 1–40 lowercase letters, digits or dashes: ${name}`)
    if (this.data.channels[id]) throw new HqError(`#${id} already exists`, 409)
    const room = this.#roomIdOrNull(roomId)
    if (branch && !room) throw new HqError('a branch room needs a project room too')
    const goal = goalId ? this.#goal(goalId).id : null
    const channel = { id, name: id, topic: clip(topic, 200), kind: branch ? 'branch' : goal ? 'goal' : 'channel', roomId: room, branch: clip(branch || '', 180) || null, goalId: goal, agentId: null, createdAt: isoNow(this.now()) }
    this.data.channels[id] = channel
    this.#commit(actor, 'channel.created', id, channel.branch ? `branch ${channel.branch} in ${channel.roomId}` : channel.topic)
    // HQ never switches a checkout's branch. The notice says so, so nobody
    // assumes a run here is isolated on its own branch.
    this.#notice(id, channel.branch ? `#${id} is the room for branch ${channel.branch}. Tickets opened here carry that branch name and run in ${channel.roomId}'s checkout as it is — HQ does not switch branches, so check out ${channel.branch} there first. Evidence and review land in each ticket's thread.` : `#${id} created.${channel.topic ? ` ${channel.topic}` : ''}`)
    return { channel }
  }

  ensureDm(agentId, { quiet = false } = {}) {
    const agent = this.#agent(agentId, { allowTerminated: true })
    const id = `dm-${agent.id}`
    if (!this.data.channels[id]) {
      this.data.channels[id] = { id, name: agent.name, topic: `Direct line to ${agent.name}. Anything you write here is addressed to them.`, kind: 'dm', roomId: null, branch: null, goalId: null, agentId: agent.id, createdAt: isoNow(this.now()) }
      this.#save()
      if (!quiet) this.#changed()
    }
    return this.data.channels[id]
  }

  /**
   * Post a message. An @mention of an agent (or anything written in an
   * agent's DM) outside a thread becomes a ticket for that agent; inside a
   * ticket thread it is a comment that wakes the assignee. Slash commands run
   * after the message itself is recorded, so the log shows what was asked.
   */
  post({ channelId = 'general', threadId = null, text } = {}, actor = BOARD) {
    this.#requireReady()
    const channel = this.#channel(channelId)
    const body = clipBlock(text, 4000)
    if (!body) throw new HqError('a message needs text')
    const ticket = threadId ? this.#ticket(threadId) : null
    const command = parseCommand(body)
    const mentions = parseMentions(body, this.#handles())
    const message = this.#post(channel.id, { author: actor, text: body, threadId: ticket?.id || null, mentions })
    this.store.appendActivity({ actor, action: 'message.posted', target: `#${channel.id}${ticket ? `/${ticket.id}` : ''}`, detail: clip(body, 120) })

    if (command) return { message, result: this.#runCommand(command, { channel, ticket, actor, mentions }) }

    const tickets = []
    const notes = []
    if (ticket) {
      // A reply addresses the assignee when it @mentions them, or when the
      // board writes in the assignee's DM without naming anyone else.
      const assignee = ticket.assigneeId
      const addressed = Boolean(assignee) && (mentions.includes(assignee) || (actor.kind === 'board' && mentions.length === 0 && channel.kind === 'dm' && channel.agentId === assignee))
      if (addressed && actor.kind === 'board') {
        if (ticket.status === 'blocked') {
          // A blocked ticket is waiting on an answer; the board's reply is it.
          ticket.status = 'todo'
          ticket.updatedAt = isoNow(this.now())
          this.#commit(actor, 'ticket.unblocked', ticket.id, 'unblocked by a reply')
          notes.push(`${ticket.id} is back in @${assignee}'s queue.`)
        } else if (['done', 'cancelled', 'backlog'].includes(ticket.status)) {
          // Finished or parked work is not restarted by a comment: that would
          // spend money on the strength of a remark. It takes a reopen.
          notes.push(`${ticket.id} is ${ticket.status}, so nothing was started. Your reply is in the thread — reopen ${ticket.id} to hand it back to @${assignee}.`)
        } else if (ticket.status === 'in_progress') {
          notes.push(`@${assignee} is mid-run on ${ticket.id}. The run already has its brief; your reply reaches them on their next pass.`)
        }
      }
      if (addressed && ticket.status === 'todo' && this.data.agents[assignee]?.status === 'active') this.#enqueue(assignee, 'comment', ticket.id)
    } else {
      const addressed = [...mentions]
      if (channel.kind === 'dm' && channel.agentId && actor.kind === 'board' && !addressed.includes(channel.agentId)) addressed.unshift(channel.agentId)
      for (const agentId of addressed) {
        const agent = this.data.agents[agentId]
        if (!agent || agent.status === 'terminated') continue
        if (actor.kind === 'agent' && agentId === actor.id) continue
        if (!this.#canAssign(actor, agentId)) { notes.push(`${actor.id} can only hand work to their reports — @${agentId} was not given a ticket.`); continue }
        const title = ticketTitleFrom(body) || `Request from ${actor.kind === 'board' ? 'the board' : actor.id}`
        const created = this.createTicket({ title, body, channelId: channel.id, assigneeId: agentId }, actor, { wake: true })
        tickets.push(created.ticket)
        if (agent.status === 'paused') notes.push(`${agent.name} is paused — ${created.ticket.id} waits until they resume.`)
      }
    }
    for (const note of notes) this.#notice(channel.id, note, { threadId: ticket?.id || null })
    this.#save()
    void this.processQueue()
    return { message, tickets }
  }

  #runCommand(command, { channel, ticket, actor, mentions }) {
    const fail = error => { this.#notice(channel.id, error.message || String(error), { threadId: ticket?.id || null, level: 'error' }); return { ok: false, error: error.message || String(error) } }
    try {
      if (!command.known) throw new HqError(`unknown command /${command.name} — try /help`)
      if (command.name === 'help') {
        const lines = Object.values(COMMANDS).map(item => `${item.usage} — ${item.summary}`)
        this.#post(channel.id, { text: `Commands:\n${lines.join('\n')}\n@agent <request> — open a ticket for that agent and wake them`, card: { type: 'help' }, threadId: ticket?.id || null })
        return { ok: true }
      }
      if (command.name === 'ticket') return { ok: true, ...this.createTicket({ title: command.rest, body: command.rest, channelId: channel.id, assigneeId: mentions[0] || null }, actor) }
      if (command.name === 'goal') return { ok: true, ...this.addGoal({ title: command.rest }, actor) }
      if (command.name === 'assign') {
        const ticketId = parseTicketRef(command.rest) || ticket?.id
        if (!ticketId || !mentions[0]) throw new HqError('usage: /assign T-<n> @agent')
        return { ok: true, ...this.assign(ticketId, mentions[0], actor) }
      }
      if (command.name === 'wake') {
        if (!mentions[0]) throw new HqError('usage: /wake @agent')
        this.#requireBoard(actor, 'Waking an agent')
        const wakeup = this.#enqueue(mentions[0], 'board', ticket?.id || null)
        void this.processQueue()
        this.#notice(channel.id, wakeup ? `Woke @${mentions[0]}.` : `@${mentions[0]} is not active.`, { threadId: ticket?.id || null })
        return { ok: Boolean(wakeup), wakeup }
      }
      if (command.name === 'close') {
        const ticketId = parseTicketRef(command.rest) || ticket?.id
        if (!ticketId) throw new HqError('usage: /close T-<n>')
        return { ok: true, ...this.close(ticketId, actor) }
      }
      if (command.name === 'convene') return { ok: true, ...this.proposeConvene({ channelId: channel.id, question: command.rest }, actor) }
      if (command.name === 'routine') {
        const match = command.rest.match(/^(\S+)\s+([\s\S]+)$/)
        if (!match || !mentions[0]) throw new HqError('usage: /routine <every> @agent <title> — for example /routine 1d @scout check the dependency advisories')
        const title = ticketTitleFrom(match[2])
        if (!title) throw new HqError('a routine needs a title after the @mention')
        return { ok: true, ...this.addRoutine({ title, body: match[2], assigneeId: mentions[0], every: match[1], channelId: channel.id }, actor) }
      }
      throw new HqError(`/${command.name} is not wired up`)
    } catch (error) { return fail(error) }
  }

  messages(channelId, { limit = 100, threadId, before } = {}) {
    this.#requireReady()
    const channel = this.#channel(channelId)
    return { channel: this.#publicChannel(channel), messages: this.store.messages(channel.id, { limit, threadId, before }).map(publicMessage) }
  }

  ticketDetail(id) {
    this.#requireReady()
    const ticket = this.#ticket(id)
    return {
      ticket: this.#publicTicket(ticket),
      thread: this.store.thread(ticket.id).map(publicMessage),
      approvals: Object.values(this.data.approvals).filter(item => item.ticketId === ticket.id),
      mission: ticket.checkout?.missionId || ticket.runs.at(-1)?.missionId || null,
    }
  }

  // ── approvals ───────────────────────────────────────────────────────────

  #requestApproval({ kind, agentId, ticketId = null, summary, proposal = null, plan = null, channelId }, actor = SYSTEM) {
    const approval = { id: this.#nextId('approval', 'A'), kind, agentId, ticketId, summary: clip(summary, 300), proposal, plan, planHash: plan ? this.#planHash(plan) : null, status: 'pending', requestedBy: { kind: actor.kind, id: actor.id }, createdAt: isoNow(this.now()), resolvedAt: null, resolvedBy: null, reason: null }
    this.data.approvals[approval.id] = approval
    this.#commit(actor, 'approval.requested', approval.id, approval.summary)
    const ticket = ticketId ? this.data.tickets[ticketId] : null
    // The approval card is said by whoever wants something: the proposing
    // agent, or the agent asking to start work. The board answers it.
    const author = actor.kind === 'agent' ? actor : kind === 'dispatch' && this.data.agents[agentId] ? { kind: 'agent', id: agentId } : SYSTEM
    this.#post(ticket?.channelId || channelId || this.#opsChannel(), {
      author,
      threadId: ticket?.id || null,
      text: approval.summary,
      card: { type: 'approval', approvalId: approval.id, kind },
    })
    return approval
  }

  /**
   * Approving says yes to the run the ask described, not to whatever the
   * ticket has become since. The plan is re-derived now; if the assignee, the
   * workspace, the harness, the model, the check or the ticket's text moved,
   * the ask is superseded and a fresh one follows. Nothing is logged as
   * approved until a run has actually started.
   */
  async approve(id, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Approving')
    const approval = this.#approval(id)
    if (approval.status !== 'pending') throw new HqError(`${approval.id} is already ${approval.status}`, 409)
    if (approval.kind === 'hire') return this.#approveHire(approval, actor)
    const ticket = this.#ticket(approval.ticketId)
    const agent = this.#agent(approval.agentId)
    // Every way out below that starts nothing settles the ask with its own
    // log entry and lets the agent's next ready ticket have its turn.
    const retire = (status, reason, message) => {
      this.#settle(approval, status, reason, actor)
      this.#save(); this.#changed()
      this.#nudge(agent.id)
      return new HqError(message || `${approval.id} ${status}: ${approval.reason}. Nothing was started.`, 409)
    }
    if (ticket.assigneeId !== agent.id) throw retire('superseded', `${ticket.id} is now assigned to ${ticket.assigneeId || 'nobody'}`, `${approval.id} no longer applies: ${ticket.id} is now assigned to ${ticket.assigneeId || 'nobody'}. Nothing was started.`)
    const readiness = this.dispatchReadiness(ticket, agent)
    if (!readiness.ok) {
      // A busy workspace, the concurrency cap or the daily ceiling clears by
      // itself: the ask stays open for the board to approve again.
      if (readiness.transient) throw new HqError(`not yet: ${readiness.reason} — ${approval.id} stays open`, 409)
      // Neither is a verdict on the work: a prerequisite still open, or a
      // spent budget. The ask no longer applies as it stands, and the ticket
      // stays where it is, to be asked about again once that changes.
      if (['blockers', 'over-budget', 'agent-inactive', 'status'].includes(readiness.code)) {
        // Settled first, so the pause below finds nothing left to expire and
        // the ask is logged once, for the reason it did not start.
        const error = retire('superseded', readiness.reason, `${approval.id} cannot start now: ${readiness.reason}. Nothing was started; ${ticket.id} stays ${ticket.status.replace('_', ' ')}.`)
        if (readiness.code === 'over-budget' && agent.status === 'active') this.pause(agent.id, SYSTEM, 'budget')
        throw error
      }
      // Anything else — no workspace, no harness — will not clear by itself.
      this.#settle(approval, 'failed', readiness.reason, actor)
      if (ticket.status === 'todo') this.#block(ticket, agent, readiness.reason)
      else { this.#save(); this.#changed() }
      this.#nudge(agent.id)
      throw new HqError(`${approval.id} cannot start: ${readiness.reason}`, 409)
    }
    const plan = this.#plan(ticket, agent, readiness)
    if (!approval.planHash || this.#planHash(plan) !== approval.planHash) {
      // An ask saved before asks carried a plan cannot be checked, so it is
      // never trusted to start anything: it is replaced by one that can.
      const why = approval.plan ? `the run changed since the ask: ${this.#planChanges(approval.plan, plan).join(', ') || 'its plan'}` : 'the ask predates plan checks, so what it approved cannot be confirmed'
      // The same work, with its new plan, goes back to the board as a new ask.
      throw retire('superseded', why, `${approval.id} no longer matches ${ticket.id} — ${why}. Nothing was started; a fresh ask follows.`)
    }
    // Settled before the first await, so a second approve, a deny or a pause
    // that lands mid-start finds a resolved ask instead of racing this one.
    Object.assign(approval, { status: 'approved', resolvedAt: isoNow(this.now()), resolvedBy: actor.id })
    try {
      const result = await this.#dispatch(ticket, agent, { approvedBy: approval.id })
      this.#commit(actor, 'approval.approved', approval.id, `${approval.summary} → run ${result.run.runId}`)
      return { approval, ...result }
    } catch (error) {
      const reason = clip(error?.message || error, 300)
      if (TRANSIENT_DISPATCH.test(reason)) {
        // Only an ask that still describes the ticket goes back to pending:
        // the agent may have been paused, or the ticket moved, while the run
        // was starting — and a pause could not expire an ask marked approved.
        if (this.data.agents[agent.id]?.status === 'active' && ticket.assigneeId === agent.id && ticket.status === 'todo') {
          Object.assign(approval, { status: 'pending', resolvedAt: null, resolvedBy: null })
          this.#save(); this.#changed()
          throw new HqError(`not yet: ${reason} — ${approval.id} stays open`, 409)
        }
        const moved = this.data.agents[agent.id]?.status !== 'active' ? `${agent.name} was ${this.data.agents[agent.id]?.status || 'removed'} while it started` : `${ticket.id} changed while it started`
        throw retire('expired', `${reason}; ${moved}`, `${approval.id} did not start (${reason}) and no longer applies: ${moved}.`)
      }
      this.#settle(approval, 'failed', reason, actor)
      this.#save(); this.#changed()
      this.#nudge(agent.id)
      throw error
    }
  }

  #approveHire(approval, actor) {
    try {
      const { agent } = this.hire({ ...approval.proposal }, BOARD)
      Object.assign(approval, { status: 'approved', resolvedAt: isoNow(this.now()), resolvedBy: actor.id })
      this.#commit(actor, 'approval.approved', approval.id, approval.summary)
      return { approval, agent }
    } catch (error) {
      this.#settle(approval, 'failed', error.message, actor)
      this.#save(); this.#changed()
      throw error
    }
  }

  /** Resolve one pending ask without starting anything, with its own log entry. */
  #settle(approval, status, reason, actor = SYSTEM) {
    Object.assign(approval, { status, reason: clip(reason, 300) || null, resolvedAt: isoNow(this.now()), resolvedBy: actor.id })
    this.store.appendActivity({ actor, action: `approval.${status}`, target: approval.id, detail: approval.reason || '' })
  }

  /** Settle every pending ask that `match` picks. The caller saves. */
  #settleWhere(match, status, reason, actor = SYSTEM) {
    const askers = new Set()
    for (const approval of Object.values(this.data.approvals)) {
      if (approval.status !== 'pending' || !match(approval)) continue
      this.#settle(approval, status, reason, actor)
      if (approval.kind === 'dispatch') askers.add(approval.agentId)
    }
    for (const agentId of askers) this.#nudge(agentId)
    return askers.size
  }

  /**
   * An agent has one ask open at a time. When that ask is settled without a
   * run, its next ready ticket gets its turn now rather than at the next
   * unrelated event.
   */
  #nudge(agentId) {
    if (this.data.agents[agentId]?.status !== 'active' || !this.readyTickets(agentId).length) return
    this.#enqueue(agentId, 'next')
    void this.processQueue()
  }

  deny(id, reason = '', actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Denying')
    const approval = this.#approval(id)
    if (approval.status !== 'pending') throw new HqError(`${approval.id} is already ${approval.status}`, 409)
    approval.status = 'denied'
    approval.reason = clip(reason, 300) || null
    approval.resolvedAt = isoNow(this.now())
    approval.resolvedBy = actor.id
    const ticket = approval.ticketId ? this.data.tickets[approval.ticketId] : null
    // "Not now": the ticket leaves the ready queue until someone moves it back,
    // so the next heartbeat does not ask the same question again.
    if (ticket && approval.kind === 'dispatch' && ticket.status === 'todo') { ticket.status = 'backlog'; ticket.updatedAt = isoNow(this.now()) }
    this.#commit(actor, 'approval.denied', approval.id, approval.reason || '')
    if (approval.kind === 'dispatch') this.#nudge(approval.agentId)
    this.#post(ticket?.channelId || this.#opsChannel(), { threadId: ticket?.id || null, text: `${approval.id} denied${approval.reason ? `: ${approval.reason}` : ''}.${ticket ? ` ${ticket.id} is back in the backlog.` : ''}`, card: { type: 'approval', approvalId: approval.id, kind: approval.kind } })
    return { approval }
  }

  // ── wakeups, heartbeats and dispatch ────────────────────────────────────

  /** Queue a wakeup, coalescing with one already queued for the same agent. */
  #enqueue(agentId, source, ticketId = null) {
    const agent = this.data.agents[agentId]
    if (!agent || agent.status !== 'active') return null
    const queued = this.data.wakeups.find(item => item.agentId === agentId && item.status === 'queued')
    if (queued) {
      if (!queued.sources.includes(source)) queued.sources.push(source)
      if (ticketId && !queued.ticketId) queued.ticketId = ticketId
      this.#save(); this.#changed()
      return queued
    }
    const wakeup = { id: rid('w'), agentId, sources: [source], ticketId, status: 'queued', result: null, at: isoNow(this.now()), doneAt: null }
    this.data.wakeups.push(wakeup)
    this.#save(); this.#changed()
    return wakeup
  }

  async wake(agentId, { ticketId = null } = {}, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Waking an agent')
    const agent = this.#agent(agentId)
    if (agent.status !== 'active') throw new HqError(`${agent.name} is ${agent.status}${agent.pausedReason ? ` (${agent.pausedReason})` : ''}`, 409)
    if (ticketId) this.#ticket(ticketId)
    const wakeup = this.#enqueue(agent.id, 'board', ticketId ? this.#ticket(ticketId).id : null)
    this.store.appendActivity({ actor, action: 'agent.woken', target: agent.id, detail: ticketId || '' })
    await this.processQueue()
    return { wakeup: this.data.wakeups.find(item => item.id === wakeup.id) || wakeup }
  }

  /** One scheduler beat: fire due heartbeats, retry waiting work, fold finished runs back in, drain the queue. */
  async tick(now = this.now()) {
    if (!this.ready()) return
    // The beat runs on a timer that nothing awaits. A failure is reported in
    // #ops — once per distinct failure — and never escapes as a rejection.
    try {
      let changed = false
      for (const agent of Object.values(this.data.agents)) {
        if (agent.status === 'paused' && agent.pausedReason === 'budget') {
          const pausedIn = agent.pausedAt ? monthKey(Date.parse(agent.pausedAt)) : null
          this.#resumeIfUnderCap(agent, pausedIn && pausedIn !== monthKey(now) ? 'a new budget month began' : 'it is back under its monthly cap')
        }
        if (agent.status !== 'active' || !agent.heartbeat?.enabled) continue
        const every = agent.heartbeat.everyMinutes * 60_000
        if (!agent.heartbeat.nextAt) { agent.heartbeat.nextAt = now + every; changed = true; continue }
        if (agent.heartbeat.nextAt > now) continue
        changed = true
        agent.heartbeat.lastAt = now
        agent.heartbeat.nextAt = now + every
        this.store.appendActivity({ actor: SYSTEM, action: 'agent.heartbeat', target: agent.id, detail: `next in ${agent.heartbeat.everyMinutes}m` })
        this.#enqueue(agent.id, 'heartbeat')
      }
      // Finished runs are folded in first, so a routine sees its last ticket
      // as done and a waiting ticket sees its workspace free on this beat.
      this.reconcile()
      // Routines that are due open their tickets (or skip their turn while
      // the last one is still open).
      for (const routine of Object.values(this.data.routines)) {
        if (routine.status !== 'active' || !(Number(routine.nextAt) <= now)) continue
        // One routine failing must not cost the others, or the rest of the
        // beat, their turn.
        try { this.#fireRoutine(routine, now) } catch (error) { this.#reportError(`Routine ${routine.id} could not fire`, error) }
      }
      // Work that was waiting on something that clears by itself — a busy
      // workspace, the concurrency cap, the daily ceiling — is retried as soon
      // as it could start, and not before.
      for (const ticket of Object.values(this.data.tickets)) {
        if (!ticket.waiting) continue
        const agent = ticket.assigneeId ? this.data.agents[ticket.assigneeId] : null
        if (ticket.status !== 'todo' || ticket.checkout || !agent) { delete ticket.waiting; changed = true; continue }
        if (agent.status !== 'active' || Number(this.backoff.get(ticket.id)?.retryAt) > now) continue
        const readiness = this.dispatchReadiness(ticket, agent)
        if (readiness.ok || !readiness.transient) {
          // Startable now, or refused for a reason that will not clear by
          // itself: the wakeup either asks for it or says why it cannot start.
          delete ticket.waiting
          changed = true
          this.#enqueue(agent.id, 'ready', ticket.id)
        } else if (ticket.waiting.reason !== readiness.reason) {
          ticket.waiting = { ...ticket.waiting, reason: readiness.reason }
          changed = true
        }
      }
      if (changed) { this.#save(); this.#changed() }
      this.#lateSpend()
      const errors = this.errorCount
      await this.processQueue()
      // A beat that reported nothing clears the memory of the last error, so
      // a failure that comes back later is said again — but one that repeats
      // every beat is said once.
      if (this.errorCount === errors) this.lastError = null
    } catch (error) {
      this.#reportError('HQ heartbeat error', error)
    }
  }

  #reportError(what, error) {
    this.errorCount = (this.errorCount || 0) + 1
    const message = `${what}: ${clip(error?.message || error, 300)}`
    if (this.lastError === message) return
    this.lastError = message
    try { this.#notice(this.#opsChannel(), message, { level: 'error' }) } catch { /* nothing left to tell */ }
  }

  /** Resolves once queued wakeups, reconciles and publishes have settled. */
  async idle() {
    for (let i = 0; i < 5; i += 1) {
      await this.queue
      await new Promise(resolve => setImmediate(resolve))
    }
    await this.queue
  }

  processQueue() {
    this.queue = this.queue.then(() => this.#drain()).catch(error => this.#reportError('HQ scheduler error', error))
    return this.queue
  }

  async #drain() {
    if (!this.ready()) return
    for (;;) {
      const wakeup = this.data.wakeups.find(item => item.status === 'queued')
      if (!wakeup) return
      wakeup.status = 'processing'
      let outcome
      try { outcome = await this.#handleWakeup(wakeup) } catch (error) { outcome = { status: 'failed', result: clip(error?.message || error, 300) } }
      wakeup.status = outcome.status
      wakeup.result = outcome.result
      wakeup.doneAt = isoNow(this.now())
      this.#save(); this.#changed()
    }
  }

  async #handleWakeup(wakeup) {
    const agent = this.data.agents[wakeup.agentId]
    if (!agent || agent.status !== 'active') return { status: 'skipped', result: `${agent?.name || wakeup.agentId} is not active` }
    const budget = this.budget(agent.id)
    if (budget.state === 'over') { this.pause(agent.id, SYSTEM, 'budget'); return { status: 'skipped', result: `over budget: ${budgetLine(budget)}` } }
    const busy = Object.values(this.data.tickets).find(ticket => ticket.checkout?.agentId === agent.id)
    if (busy) return { status: 'skipped', result: `busy with ${busy.id}` }
    const ready = this.readyTickets(agent.id)
    const wanted = wakeup.ticketId ? ready.find(item => item.id === wakeup.ticketId) : null
    const order = wanted ? [wanted, ...ready.filter(item => item !== wanted)] : ready
    if (!order.length) return { status: 'done', result: 'nothing ready' }
    const outcomes = []
    for (const ticket of order) {
      if (Number(this.backoff.get(ticket.id)?.retryAt) > this.now()) { outcomes.push(`${ticket.id} waiting to retry: ${ticket.waiting?.reason || 'refused by the runtime'}`); continue }
      // One ask per agent at a time: the board answers it before the next.
      const pending = Object.values(this.data.approvals).find(item => item.agentId === agent.id && item.kind === 'dispatch' && item.status === 'pending')
      if (pending) return { status: 'done', result: `awaiting approval ${pending.id}` }
      const readiness = this.dispatchReadiness(ticket, agent)
      if (!readiness.ok) {
        if (readiness.transient) {
          // Clears by itself: no ask, no mission, no notice. tick() retries it.
          if (ticket.waiting?.reason !== readiness.reason) { ticket.waiting = { reason: readiness.reason, since: ticket.waiting?.since || isoNow(this.now()) }; this.#save(); this.#changed() }
          outcomes.push(`${ticket.id} waiting: ${readiness.reason}`)
        } else {
          this.#block(ticket, agent, readiness.reason)
          outcomes.push(`${ticket.id} blocked: ${readiness.reason}`)
        }
        continue
      }
      if (agent.autonomy !== 'autonomous') {
        const plan = this.#plan(ticket, agent, readiness)
        const approval = this.#requestApproval({
          kind: 'dispatch', agentId: agent.id, ticketId: ticket.id, channelId: ticket.channelId, plan,
          summary: `${agent.name} wants to start ${ticket.id} on ${agent.runtime} in ${readiness.room.label}${plan.branch ? ` (${plan.branch})` : ''} · model ${clip(agent.modelRef, 40)}${plan.verify ? ` · checked by ${clip(plan.verify, 60)}` : ''}. Budget: ${budgetLine(budget)}. Cost is recorded when the run exits.`,
        })
        return { status: 'done', result: `approval requested ${approval.id}` }
      }
      try {
        const { run } = await this.#dispatch(ticket, agent, { approvedBy: 'autonomous' })
        return { status: 'done', result: `dispatched ${ticket.id} → run ${run.runId}` }
      } catch (error) {
        return { status: 'done', result: `dispatch failed: ${clip(error.message, 200)}` }
      }
    }
    return { status: 'done', result: clip(outcomes.join('; '), 300) }
  }

  #block(ticket, agent, reason) {
    ticket.status = 'blocked'
    delete ticket.waiting
    ticket.updatedAt = isoNow(this.now())
    this.#commit(SYSTEM, 'ticket.blocked', ticket.id, reason)
    this.#post(ticket.channelId, { author: { kind: 'agent', id: agent.id }, threadId: ticket.id, text: `I can't start ${ticket.id}: ${reason}`, card: { type: 'ticket', event: 'blocked', ticketId: ticket.id } })
  }

  /** Whether two paths are the same checkout, or one sits inside the other. */
  #sameTree(a, b) {
    if (!a || !b) return false
    const x = path.resolve(a)
    const y = path.resolve(b)
    return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep)
  }

  /**
   * Whether `ticket` could run for `agent` right now, and where. Never spends
   * anything. A refusal marked `transient` clears by itself (another run
   * finishing, the 24h window rolling): the work waits instead of blocking.
   * `code` says which kind of refusal it is, for callers that treat them
   * differently.
   */
  dispatchReadiness(ticket, agent) {
    const no = (code, reason, transient = false) => ({ ok: false, code, reason, transient })
    if (agent.status !== 'active') return no('agent-inactive', `${agent.name} is ${agent.status}`)
    if (!['todo', 'blocked'].includes(ticket.status)) return no('status', `${ticket.id} is ${ticket.status.replace('_', ' ')} — only a to-do or blocked ticket can start`)
    if (ticket.checkout) return no('checked-out', `${ticket.id} is already checked out by ${ticket.checkout.agentId}`, true)
    if (!this.#blockersDone(ticket)) return no('blockers', `waiting on ${ticket.blockedBy.filter(id => this.data.tickets[id]?.status !== 'done').join(', ')}`)
    const runtime = this.#runtimeInfo(agent.runtime)
    if (!runtime.structured) return no('runtime', `${agent.runtime} has no structured non-interactive adapter; HQ runs need ${STRUCTURED_RUNTIMES.join(' or ')}`)
    if (runtime.available === false) return no('runtime', `${agent.runtime} is not installed or not on Quorum's PATH`)
    if (!this.missions || !this.runtimeManager) return no('runtime', 'no runtime manager is attached to HQ')
    let pack
    try { pack = this.resolvePack(agent.packId) } catch (error) { return no('pack', `${agent.name}'s job pack ${agent.packId} is not available: ${clip(error.message, 120)}`) }
    const channel = this.data.channels[ticket.channelId]
    const roomId = ticket.roomId || channel?.roomId || agent.roomId || this.data.company?.roomId || null
    if (!roomId) return no('workspace', 'no workspace: set a project room on the ticket, its channel, the agent, or the company')
    const room = this.#roomList().find(item => item.id === roomId)
    if (!room) return no('workspace', `workspace ${roomId} is not a known project room`)
    try { if (!fs.statSync(room.cwd).isDirectory()) return no('workspace', `workspace ${room.label} is not a directory`) } catch { return no('workspace', `workspace ${room.label} does not exist on disk`) }
    const budget = this.budget(agent.id)
    if (budget.state === 'over') return no('over-budget', `${agent.name} is over budget: ${budgetLine(budget)}`)
    const busy = Object.values(this.data.tickets).find(item => item !== ticket && item.checkout?.agentId === agent.id)
    if (busy) return no('agent-busy', `${agent.name} is busy with ${busy.id}`, true)
    // One run per checkout: two agents editing the same files at once would
    // each see the other's half-finished work in their evidence.
    const sharing = Object.values(this.data.tickets).find(item => item !== ticket && item.checkout && this.#sameTree(item.checkout.cwd || this.#roomList().find(r => r.id === item.checkout.roomId)?.cwd, room.cwd))
    if (sharing) return no('workspace-busy', `${room.label} is in use by ${sharing.id} — one run per workspace`, true)
    const live = [...(this.runtimeManager.runs?.values?.() || [])].find(item => !item.finished && this.#sameTree(item.cwd, room.cwd))
    if (live) return no('workspace-busy', `${room.label} is in use by run ${live.runId} — one run per workspace`, true)
    // Anything else holding the checkout — an operator's agent session, a
    // mission run outside HQ — holds an agent-control claim on it, and the
    // runtime refuses a second claim. Checked here so HQ waits for it
    // instead of trying, failing and trying again.
    const claim = this.#claimOn(room.cwd)
    if (claim) return no('workspace-busy', `${room.label} is claimed by run ${claim.runId} (an agent session or another run) — one run per workspace`, true)
    const inFlight = (() => { try { return this.runtimeManager.inFlightCloudRuns?.() } catch { return null } })()
    const cap = Number(this.runtimeManager.maxConcurrentCloudAgents)
    if (Number.isFinite(inFlight) && Number.isFinite(cap) && inFlight >= cap) return no('concurrency', `cloud agent concurrency limit reached (${cap})`, true)
    const ceiling = (() => { try { return this.runtimeManager.budgetStatus?.() } catch { return null } })()
    if (ceiling && ceiling.allowed === false) return no('ceiling', ceiling.reason || 'daily cloud budget reached', true)
    return { ok: true, transient: false, room, runtime, pack, branch: ticket.branch || channel?.branch || room.branch || '' }
  }

  /** A live agent-control claim overlapping `cwd`: the same test the runtime's `createRun` refuses on. */
  #claimOn(cwd) {
    const claims = (() => { try { return this.agentControl?.store?.list?.('claims') || [] } catch { return [] } })()
    const now = this.now()
    return claims.find(claim => ['active', 'recovery-pending'].includes(claim.status) && Number(claim.leaseExpiresAt) > now && this.#sameTree(claim.path, cwd)) || null
  }

  /**
   * The run an ask describes: where it runs, on what, checked how, and a
   * digest of the brief. An approval starts a run only while this matches.
   */
  #plan(ticket, agent, readiness) {
    return {
      ticketId: ticket.id,
      agentId: agent.id,
      roomId: readiness.room.id,
      cwd: readiness.room.cwd,
      branch: readiness.branch || null,
      runtime: agent.runtime,
      modelRef: agent.modelRef,
      packId: readiness.pack.id,
      role: readiness.pack.role || agent.role,
      verify: verifyText(ticket.verifyCommand) || null,
      brief: sha256(canonical({ title: ticket.title, body: ticket.body, goalId: ticket.goalId || null, blockedBy: ticket.blockedBy || [] })).slice(0, 16),
      instructions: sha256(canonical({ instructions: agent.instructions || '' })).slice(0, 16),
    }
  }

  #planHash(plan) { return sha256(canonical(plan)).slice(0, 16) }

  #planChanges(before, after) {
    const names = { agentId: 'assignee', roomId: 'workspace', cwd: 'workspace path', branch: 'branch', runtime: 'harness', modelRef: 'model', packId: 'job pack', role: 'sandbox', verify: 'verify command', brief: 'ticket text', instructions: 'agent brief' }
    return Object.keys(names).filter(key => (before?.[key] ?? null) !== (after[key] ?? null)).map(key => names[key])
  }

  async #dispatch(ticket, agent, { approvedBy }) {
    const readiness = this.dispatchReadiness(ticket, agent)
    if (!readiness.ok) throw new HqError(readiness.reason, 409)
    const pack = readiness.pack
    // Checkout before the first await: a second dispatch of the same ticket,
    // from any path, now sees it taken. `dispatching` tells reconcile() this
    // checkout is mid-start rather than left behind by a crash.
    ticket.checkout = { agentId: agent.id, at: isoNow(this.now()), runId: null, missionId: null, taskId: 'work', roomId: readiness.room.id, cwd: readiness.room.cwd, approvedBy }
    delete ticket.waiting
    ticket.updatedAt = ticket.checkout.at
    this.dispatching.add(ticket.id)
    try {
      this.#save(); this.#changed()
      const attempt = ticket.runs.length + 1
      let mission
      try {
        mission = this.missions.create({
          title: `${ticket.id} · ${ticket.title}${attempt > 1 ? ` (attempt ${attempt})` : ''}`,
          objective: ticket.body || ticket.title,
          workspace: readiness.room.cwd,
          branch: readiness.branch || null,
          tasks: [{ id: 'work', title: ticket.title, description: ticket.body || ticket.title, agentId: agent.id, runtimeId: agent.runtime, modelRef: agent.modelRef, packId: pack.id, roomId: readiness.room.id, verifyCommand: ticket.verifyCommand || undefined }],
        })
      } catch (error) {
        ticket.checkout = null; this.#save(); this.#changed()
        throw new HqError(`could not create the mission: ${error.message}`)
      }
      // Durable before the run starts, so a restart from here on can find the
      // mission and settle it instead of leaving it pending forever.
      ticket.checkout.missionId = mission.id
      this.#save()
      const manager = agent.reportsTo ? this.data.agents[agent.reportsTo] : null
      const reports = Object.values(this.data.agents).filter(item => item.reportsTo === agent.id && item.status !== 'terminated')
      const prompt = buildWorkPrompt({
        company: this.data.company, agent, manager, reports,
        goal: ticket.goalId ? this.data.goals[ticket.goalId] : null,
        ticket, thread: this.store.thread(ticket.id).map(publicMessage),
        blockers: (ticket.blockedBy || []).map(id => this.data.tickets[id]).filter(Boolean),
        cli: this.cli,
      })
      let started
      try {
        started = await this.runtimeManager.start({
          missionId: mission.id, taskId: 'work', runtime: agent.runtime, role: pack.role || agent.role,
          cwd: readiness.room.cwd, worktree: readiness.room.cwd, branch: readiness.branch,
          task: prompt, packId: pack.id, modelRef: agent.modelRef,
          env: { QUORUM_URL: this.baseUrl, QUORUM_HQ_AGENT: agent.id, QUORUM_HQ_TICKET: ticket.id },
        })
      } catch (error) {
        const reason = clip(error?.message || error, 300)
        const transient = TRANSIENT_DISPATCH.test(reason)
        ticket.checkout = null
        ticket.status = transient ? 'todo' : 'blocked'
        // A refusal only the runtime could see is retried with a growing
        // pause (30 s, 1, 2, 4… up to 15 min), and said in the thread once.
        const attempts = transient ? (this.backoff.get(ticket.id)?.attempts || 0) + 1 : 0
        if (transient) {
          const retryAt = this.now() + Math.min(15 * 60_000, 30_000 * 2 ** (attempts - 1))
          this.backoff.set(ticket.id, { attempts, retryAt })
          ticket.waiting = { reason, since: isoNow(this.now()), retryAt }
        }
        ticket.updatedAt = isoNow(this.now())
        this.#closeMission(mission.id, 'work', 'cancelled', reason)
        this.#commit(SYSTEM, 'ticket.dispatch-failed', ticket.id, reason)
        if (!transient || attempts === 1) this.#post(ticket.channelId, { threadId: ticket.id, text: `${agent.name} could not start ${ticket.id}: ${reason}${transient ? ' — it waits in the queue and is retried once it can start.' : ''}`, card: { type: 'notice', level: transient ? 'warn' : 'error' } })
        else this.#save()
        throw new HqError(reason, 409)
      }
      const runId = started?.run?.runId || started?.runtimeRun?.runId
      this.backoff.delete(ticket.id)
      ticket.checkout.runId = runId
      ticket.status = 'in_progress'
      ticket.updatedAt = isoNow(this.now())
      ticket.runs.push({ runId, missionId: mission.id, agentId: agent.id, attempt, runtime: agent.runtime, modelRef: agent.modelRef, startedAt: ticket.updatedAt, finishedAt: null, status: 'running', costUsd: null, priced: null, approvedBy })
      if (ticket.runs.length > 20) ticket.runs.splice(0, ticket.runs.length - 20)
      this.#commit(approvedBy === 'autonomous' ? SYSTEM : BOARD, 'ticket.dispatched', ticket.id, `${agent.id} · ${agent.runtime} · run ${runId} · ${approvedBy}`)
      this.#post(ticket.channelId, {
        author: { kind: 'agent', id: agent.id }, threadId: ticket.id,
        text: `Picking up ${ticket.id} — running on ${agent.runtime} in ${readiness.room.label}${readiness.branch ? ` (${readiness.branch})` : ''}.`,
        card: { type: 'run', event: 'started', ticketId: ticket.id, runId, missionId: mission.id, runtime: agent.runtime },
      })
      return { ticket: this.#publicTicket(ticket), run: { runId, missionId: mission.id } }
    } finally {
      this.dispatching.delete(ticket.id)
    }
  }

  /** Settle a mission whose run never happened. The thread is the record; this is bookkeeping. */
  #closeMission(missionId, taskId, status, reason) {
    try {
      const task = this.missions.get(missionId)?.tasks.find(item => item.id === taskId)
      if (task && !TERMINAL_TASK.includes(task.status)) this.missions.setTask(missionId, taskId, { status, error: reason })
      this.missions.update(missionId, { status: 'cancelled' })
    } catch { /* the mission record is secondary to telling the truth in the thread */ }
  }

  /**
   * Board-initiated dispatch. Without `confirm: true` it only previews. A
   * confirm must carry the preview's `planHash` back as `expect`, so the run
   * that starts is the one that was shown: a changed plan is refused, not run.
   */
  async dispatch(id, { confirm = false, expect = null } = {}, actor = BOARD) {
    this.#requireReady(); this.#requireBoard(actor, 'Starting a run')
    const ticket = this.#ticket(id)
    if (!ticket.assigneeId) throw new HqError(`${ticket.id} has no assignee`, 409)
    const agent = this.#agent(ticket.assigneeId)
    const readiness = this.dispatchReadiness(ticket, agent)
    const plan = readiness.ok ? this.#plan(ticket, agent, readiness) : null
    const preview = {
      ticketId: ticket.id, agentId: agent.id, runtime: agent.runtime, modelRef: agent.modelRef,
      room: readiness.room ? { id: readiness.room.id, label: readiness.room.label } : null, branch: readiness.branch || null,
      verify: verifyText(ticket.verifyCommand) || null,
      ready: readiness.ok, reason: readiness.ok ? null : readiness.reason, transient: Boolean(readiness.transient),
      budget: this.budget(agent.id), dailyCeiling: this.runtimeManager?.budgetStatus?.()?.reason || null,
      planHash: plan ? this.#planHash(plan) : null,
      note: 'A managed run spends real money; its cost is recorded when it exits.',
    }
    if (confirm !== true) return { requiresConfirmation: true, preview }
    if (!readiness.ok) throw new HqError(readiness.reason, 409)
    if (!expect) throw new HqError(`starting ${ticket.id} needs the preview's planHash as \`expect\` — preview it first`, 409)
    if (expect !== preview.planHash) throw new HqError(`${ticket.id}'s run changed since it was previewed — preview it again before starting it`, 409)
    this.#settleWhere(approval => approval.ticketId === ticket.id, 'superseded', 'the board started the run directly', actor)
    return this.#dispatch(ticket, agent, { approvedBy: 'board' })
  }

  /**
   * Re-publish at most once a second. Runtime events arrive several times a
   * second during a run; presence only needs to keep up with a person reading.
   */
  refresh() {
    if (!this.onChange || this.refreshTimer) return
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.#changed() }, 1000)
    this.refreshTimer.unref?.()
  }

  scheduleReconcile() {
    if (this.reconcilePending) return
    this.reconcilePending = true
    setImmediate(() => { this.reconcilePending = false; try { this.reconcile() } catch { /* retried on the next tick */ } })
  }

  /** Fold finished (or lost) runs back into their tickets. Safe to call any time. */
  reconcile() {
    if (!this.ready() || !this.missions) return 0
    let folded = 0
    for (const ticket of Object.values(this.data.tickets)) {
      const checkout = ticket.checkout
      if (!checkout) continue
      if (!checkout.runId) {
        if (this.dispatching.has(ticket.id)) continue
        folded += 1
        if (!this.#recoverDispatch(ticket)) continue
      }
      if (!checkout.missionId) continue
      const live = this.runtimeManager?.runs?.get?.(checkout.runId) || null
      const task = this.missions.get(checkout.missionId)?.tasks.find(item => item.id === checkout.taskId) || null
      if (task && TERMINAL_TASK.includes(task.status)) { this.#finishRun(ticket, task, null); folded += 1; continue }
      if (!live) {
        this.#finishRun(ticket, task, 'the run is no longer tracked — Quorum restarted while it was running')
        folded += 1
      }
    }
    return folded
  }

  /**
   * A checkout with no run and no start in progress was interrupted: Quorum
   * stopped between claiming the ticket and recording its run. If the runtime
   * created a run for the mission, it is adopted and settled like any other
   * (returns true). If not, nothing ran: the mission is closed and the ticket
   * goes back in the queue (returns false).
   */
  #recoverDispatch(ticket) {
    const checkout = ticket.checkout
    const runs = (() => { try { return this.agentControl?.store?.list('runs') || [] } catch { return [] } })()
    // The worker's run is the first one made for the mission; anything later
    // (an independent review) is not the run this checkout was waiting for.
    const run = checkout.missionId ? runs.filter(item => item.missionId === checkout.missionId && item.parentTask === checkout.taskId).sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))[0] : null
    if (run) {
      checkout.runId = run.runId
      ticket.status = 'in_progress'
      ticket.updatedAt = isoNow(this.now())
      ticket.runs.push({ runId: run.runId, missionId: checkout.missionId, agentId: checkout.agentId, attempt: ticket.runs.length + 1, runtime: run.runtime, modelRef: run.modelRef || null, startedAt: checkout.at, finishedAt: null, status: 'running', costUsd: null, priced: null, approvedBy: checkout.approvedBy || null })
      this.#commit(SYSTEM, 'ticket.run-adopted', ticket.id, `run ${run.runId} found for a start that was interrupted`)
      return true
    }
    if (checkout.missionId) this.#closeMission(checkout.missionId, checkout.taskId, 'cancelled', 'the start was interrupted before a run began')
    ticket.checkout = null
    ticket.status = 'todo'
    ticket.updatedAt = isoNow(this.now())
    this.#commit(SYSTEM, 'ticket.dispatch-interrupted', ticket.id, 'Quorum stopped before the run began; nothing ran')
    this.#notice(ticket.channelId, `${ticket.id}'s start was interrupted: Quorum stopped before the run began, so nothing ran. It is back in the queue.`, { threadId: ticket.id, level: 'warn' })
    if (ticket.assigneeId) { this.#enqueue(ticket.assigneeId, 'recovered', ticket.id); void this.processQueue() }
    return false
  }

  /**
   * Spend the ledger records after a run was folded in still reaches its
   * agent: the independent review's entry can land late, and a run cancelled
   * from the Missions view is terminal before its cost is written. Every run
   * that finished inside the window is looked at, not only the latest one —
   * a ticket can be retried within minutes.
   */
  #lateSpend() {
    const now = this.now()
    let found = 0
    for (const ticket of Object.values(this.data.tickets)) {
      for (const run of ticket.runs || []) {
        if (!run.finishedAt || !run.missionId || now - Date.parse(run.finishedAt) > LATE_SPEND_MS) continue
        const spend = this.#attributeSpend(ticket, run.missionId, run.agentId || ticket.assigneeId)
        if (!spend.priced && !spend.unpriced) continue
        found += 1
        if (spend.costUsd !== null) run.costUsd = Math.round(((run.costUsd || 0) + spend.costUsd) * 10_000) / 10_000
        run.priced = Boolean(run.priced) || spend.priced > 0
        this.store.appendActivity({ actor: SYSTEM, action: 'ticket.spend-late', target: ticket.id, detail: `${spend.costUsd !== null ? money(spend.costUsd) : 'no price'}${spend.unpriced ? ` · ${spend.unpriced} unpriced` : ''} recorded after run ${run.runId} finished` })
      }
    }
    if (found) { this.#save(); this.#changed() }
    return found
  }

  #resultText(runId) {
    const events = (() => { try { return this.runtimeManager?.events?.(runId) || [] } catch { return [] } })()
    const own = events.filter(event => event.phase !== 'finished' && event.text)
    // The provider's own terminal event says what the run amounted to — a
    // `completed` summary or a `failed` explanation. Failing that, its last
    // assistant message. Never the closeout the runtime writes afterwards.
    const pick = [...own].reverse().find(event => event.type === 'completed' || event.type === 'failed') || [...own].reverse().find(event => event.type === 'assistant')
    return pick?.text || ''
  }

  #attributeSpend(ticket, missionId, agentId) {
    const seen = new Set(this.data.spend.map(entry => entry.id))
    const entries = (() => { try { return this.agentControl?.store?.list('spend') || [] } catch { return [] } })()
    const fresh = entries.filter(entry => entry.missionId === missionId && !seen.has(entry.id))
    for (const entry of fresh) this.data.spend.push({ id: entry.id, agentId, ticketId: ticket.id, runId: entry.runId, runtime: entry.runtime, costUsd: entry.costUsd ?? null, priced: entry.priced === true, at: Number(entry.at) || this.now() })
    const priced = fresh.filter(entry => entry.priced === true)
    return { costUsd: priced.length ? Math.round(priced.reduce((sum, entry) => sum + Number(entry.costUsd || 0), 0) * 10_000) / 10_000 : null, priced: priced.length, unpriced: fresh.length - priced.length }
  }

  #finishRun(ticket, task, lostReason) {
    const checkout = ticket.checkout
    const agent = this.data.agents[checkout.agentId]
    const status = lostReason ? 'failed' : task.status
    // A cancelled run parks the ticket: "stop" must not turn into the agent
    // asking to start the same work again on its next wakeup.
    const next = status === 'completed' ? 'done' : status === 'cancelled' ? 'backlog' : 'blocked'
    const spend = this.#attributeSpend(ticket, checkout.missionId, checkout.agentId)
    const run = ticket.runs.find(item => item.runId === checkout.runId)
    if (run) Object.assign(run, { finishedAt: isoNow(this.now()), status, costUsd: spend.costUsd, priced: spend.priced > 0 })
    if (lostReason) {
      try { if (task && !TERMINAL_TASK.includes(task.status)) this.missions.setTask(checkout.missionId, checkout.taskId, { status: 'failed', error: lostReason }) } catch { /* mission bookkeeping is best effort here */ }
    }
    ticket.checkout = null
    delete ticket.waiting
    ticket.status = next
    ticket.verified = next === 'done'
    ticket.updatedAt = isoNow(this.now())
    if (next === 'done') ticket.closedAt = ticket.updatedAt
    const error = lostReason || task?.error || ''
    this.#commit(SYSTEM, 'ticket.run-finished', ticket.id, `${status}${error ? `: ${error}` : ''}`)

    const said = this.#resultText(checkout.runId)
    const reply = status === 'completed'
      ? said || `Done with ${ticket.id}. The evidence gate passed.`
      : status === 'cancelled' ? `Stopped work on ${ticket.id} — the run was cancelled. It stays in the backlog until someone moves it back to todo.`
        : said ? `${said}\n\nI didn't get ${ticket.id} over the line: ${clip(error || 'the evidence gate did not pass', 400)}` : `I didn't finish ${ticket.id}: ${clip(error || 'the evidence gate did not pass', 400)}`
    if (agent) this.#post(ticket.channelId, { author: { kind: 'agent', id: agent.id }, threadId: ticket.id, text: reply })
    this.#post(ticket.channelId, {
      threadId: ticket.id,
      text: `${ticket.id} → ${next}${next === 'done' ? ' (verified by the evidence gate)' : ''} · ${spend.costUsd !== null ? money(spend.costUsd) : 'cost not reported'}${spend.unpriced ? ` · ${spend.unpriced} unpriced run(s)` : ''}`,
      card: { type: 'run', event: 'finished', ticketId: ticket.id, runId: checkout.runId, missionId: checkout.missionId, status, ticketStatus: next, checks: (task?.verification || []).slice(0, 8), error: error ? clip(error, 400) : null, costUsd: spend.costUsd, unpriced: spend.unpriced },
    })

    if (agent) {
      const budget = this.budget(agent.id)
      const month = monthKey(this.now())
      if (budget.state === 'over' && agent.status === 'active') this.pause(agent.id, SYSTEM, 'budget')
      else if (budget.state === 'warn' && agent.budget.warnedMonth !== month) {
        agent.budget.warnedMonth = month
        this.#save()
        this.#post(this.#opsChannel(), { text: `${agent.name} has used ${budget.pct}% of this month's budget: ${budgetLine(budget)}.`, card: { type: 'budget', event: 'warn', agentId: agent.id } })
      }
      if (agent.status === 'active' && this.readyTickets(agent.id).length) this.#enqueue(agent.id, 'continuation')
    }
    if (next === 'done') this.#unblockDependents(ticket.id)
    this.#save(); this.#changed()
    void this.processQueue()
  }

  // ── roundtables ─────────────────────────────────────────────────────────

  #conveneSeats(participants) {
    const seats = (Array.isArray(participants) ? participants : String(participants || '').split(',')).map(item => String(item).trim().toLowerCase()).filter(Boolean)
    return seats.length ? [...new Set(seats)].slice(0, 5) : ['vex', 'bolt']
  }

  proposeConvene({ channelId = 'general', question, participants, model = 'claude:sonnet' } = {}, actor = BOARD) {
    this.#requireReady()
    const channel = this.#channel(channelId)
    const topic = clip(question, 500)
    if (!topic) throw new HqError('usage: /convene <question>')
    if (!this.roundtable) throw new HqError('roundtables are not available here', 503)
    const seats = this.#conveneSeats(participants)
    const estimate = this.roundtable.estimate({ participants: seats, model })
    const preview = { channelId: channel.id, question: topic, participants: seats, model, roomId: channel.roomId || this.data.company.roomId || null, ...estimate }
    this.#post(channel.id, {
      author: actor.kind === 'agent' ? actor : SYSTEM,
      text: `Roundtable proposed: “${topic}” — ${seats.join(', ')} · ${estimate.turns} turns · ${estimate.local ? 'local, no API cost' : `est. ~${money(estimate.estimateUsd)}`}. Nothing runs until the board convenes it.`,
      card: { type: 'convene', event: 'proposed', ...preview },
    })
    return { preview }
  }

  convene({ channelId = 'general', question, participants, model = 'claude:sonnet', confirm = false } = {}, actor = BOARD) {
    this.#requireReady()
    // Only a literal `true` spends: "yes", 1 or a stray query flag is a preview.
    if (confirm !== true) return { requiresConfirmation: true, ...this.proposeConvene({ channelId, question, participants, model }, actor) }
    this.#requireBoard(actor, 'Convening a roundtable')
    if (!this.roundtable) throw new HqError('roundtables are not available here', 503)
    const channel = this.#channel(channelId)
    const topic = clip(question, 500)
    if (!topic) throw new HqError('a roundtable needs a question')
    const seats = this.#conveneSeats(participants)
    const debate = this.roundtable.start({ topic, participants: seats, model, roomId: channel.roomId || this.data.company.roomId || null })
    this.data.roundtables[debate.id] = channel.id
    this.#commit(actor, 'roundtable.convened', debate.id, topic)
    this.#post(channel.id, { text: `Roundtable convened: “${topic}” — ${seats.join(', ')}. Opening statements are written blind; the verdict will land here.`, card: { type: 'convene', event: 'started', debateId: debate.id, question: topic, participants: seats, model } })
    return { debate: { id: debate.id, topic } }
  }

  roundtableDone(debate) {
    const channelId = this.data.roundtables?.[debate?.id]
    if (!channelId || !this.ready()) return false
    const verdict = (debate.turns || []).filter(turn => turn.phase === 'verdict' && !turn.failed).pop()
    const body = verdict?.body ? clipBlock(verdict.body, 1500) : debate.cancelled ? 'Cancelled before a verdict.' : debate.error ? `Failed: ${clip(debate.error, 300)}` : 'No verdict was recorded.'
    const card = { type: 'convene', event: 'verdict', debateId: debate.id, question: clip(debate.topic, 500), participants: debate.participants || [], costUsd: Number(debate.costUsd || 0), cancelled: Boolean(debate.cancelled), error: debate.error ? clip(debate.error, 300) : null }
    const targets = new Set([channelId])
    if (this.data.channels.decisions) targets.add('decisions')
    for (const target of targets) this.#post(target, { text: `Verdict on “${clip(debate.topic, 200)}”:\n${body}`, card })
    this.store.appendActivity({ actor: SYSTEM, action: 'roundtable.finished', target: debate.id, detail: `${money(debate.costUsd)}${debate.cancelled ? ' · cancelled' : ''}` })
    delete this.data.roundtables[debate.id]
    this.#save()
    return true
  }

  // ── actors ──────────────────────────────────────────────────────────────

  /**
   * Resolve the `x-quorum-run` header a CLI sends from inside a managed run.
   * A request that names a run is that run's agent — or refused. It is never
   * quietly upgraded to the board.
   */
  actorForRun(runId) {
    const id = String(runId || '')
    if (!id) return BOARD
    const ticket = Object.values(this.data.tickets).find(item => item.checkout?.runId === id)
    const live = this.runtimeManager?.runs?.get?.(id)
    if (!ticket || !live || live.finished) throw new HqError(`run ${id} is not a live HQ run`, 403)
    return { kind: 'agent', id: ticket.checkout.agentId, runId: id }
  }

  // ── projections ─────────────────────────────────────────────────────────

  budget(agentId) {
    const agent = this.data.agents[agentId]
    return agent ? budgetFor(agent, this.data.spend, this.now()) : null
  }

  presence(agent) {
    if (agent.status === 'terminated') return { state: 'offline' }
    if (agent.status === 'paused') return { state: 'paused', reason: agent.pausedReason || 'board' }
    const live = Object.values(this.data.tickets).find(ticket => ticket.checkout?.agentId === agent.id)
    if (live) {
      const run = live.checkout.runId ? this.runtimeManager?.runs?.get?.(live.checkout.runId) : null
      return { state: 'working', ticketId: live.id, runId: live.checkout.runId, phase: run?.phase || 'starting', since: live.checkout.at }
    }
    const waiting = Object.values(this.data.approvals).find(item => item.agentId === agent.id && item.status === 'pending' && item.kind === 'dispatch')
    if (waiting) return { state: 'waiting', approvalId: waiting.id, ticketId: waiting.ticketId }
    if (this.data.wakeups.some(item => item.agentId === agent.id && ['queued', 'processing'].includes(item.status))) return { state: 'queued' }
    return { state: 'idle' }
  }

  #publicAgent(agent) {
    const runtime = this.#runtimeInfo(agent.runtime)
    const open = Object.values(this.data.tickets).filter(ticket => ticket.assigneeId === agent.id && !['done', 'cancelled'].includes(ticket.status))
    return {
      id: agent.id, name: agent.name, title: agent.title, packId: agent.packId, role: agent.role,
      runtime: agent.runtime, runtimeLabel: runtime.label, runtimeAvailable: runtime.available, dispatchable: runtime.structured && runtime.available !== false,
      // Whether this harness reports a price per run — and so can be trusted to run without asking.
      priced: PRICED_RUNTIMES.includes(agent.runtime),
      modelRef: agent.modelRef, reportsTo: agent.reportsTo, roomId: agent.roomId, instructions: agent.instructions,
      avatar: publicAvatar(agent.avatar),
      budget: this.budget(agent.id),
      heartbeat: { enabled: agent.heartbeat.enabled, everyMinutes: agent.heartbeat.everyMinutes, nextAt: agent.heartbeat.nextAt, lastAt: agent.heartbeat.lastAt },
      autonomy: agent.autonomy, status: agent.status, pausedReason: agent.pausedReason,
      presence: this.presence(agent),
      openTickets: open.length,
      reports: Object.values(this.data.agents).filter(item => item.reportsTo === agent.id && item.status !== 'terminated').map(item => item.id),
      createdAt: agent.createdAt,
    }
  }

  #publicTicket(ticket) {
    return { ...ticket, blockedBy: [...(ticket.blockedBy || [])], runs: (ticket.runs || []).map(run => ({ ...run })), ready: ticket.status === 'todo' && !ticket.checkout && this.#blockersDone(ticket), checkout: ticket.checkout ? { ...ticket.checkout } : null }
  }

  #publicChannel(channel) {
    const stats = this.store.channelStats(channel.id)
    return { ...channel, messageCount: stats.count, lastAt: stats.lastAt }
  }

  /** The org chart as a tree rooted at the board. Terminated agents are left out. */
  org() {
    const agents = Object.values(this.data.agents).filter(agent => agent.status !== 'terminated')
    const node = agent => ({ ...this.#publicAgent(agent), children: agents.filter(item => item.reportsTo === agent.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(node) })
    return { board: { id: 'board', name: 'The board', title: 'You' }, children: agents.filter(agent => !agent.reportsTo || !this.data.agents[agent.reportsTo] || this.data.agents[agent.reportsTo].status === 'terminated').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(node) }
  }

  budgets() {
    const agents = Object.values(this.data.agents).filter(agent => agent.status !== 'terminated').map(agent => ({ id: agent.id, name: agent.name, title: agent.title, runtime: agent.runtime, status: agent.status, budget: this.budget(agent.id) }))
    const total = agents.reduce((acc, item) => ({ spentUsd: acc.spentUsd + item.budget.spentUsd, limitUsd: acc.limitUsd + item.budget.limitUsd, unpricedRuns: acc.unpricedRuns + item.budget.unpricedRuns }), { spentUsd: 0, limitUsd: 0, unpricedRuns: 0 })
    return { month: monthKey(this.now()), agents, total: { spentUsd: Math.round(total.spentUsd * 100) / 100, limitUsd: Math.round(total.limitUsd * 100) / 100, unpricedRuns: total.unpricedRuns }, dailyCeiling: this.runtimeManager?.budgetStatus?.() || null }
  }

  activity(limit = 40) { return this.store.recentActivity(limit) }

  /**
   * Search every message ever posted (not only the recent window) and the
   * tickets. Words and "phrases" must all appear; `in:#channel` and
   * `from:@agent` (or `from:board`, `from:system`) narrow it. Read-only.
   */
  async search(query, { limit = 50 } = {}) {
    this.#requireReady()
    const parsed = parseSearch(query)
    if (!parsed.terms.length && !parsed.channel && !parsed.author) throw new HqError('search for a word, a "phrase", in:#channel or from:@agent')
    // Every term must appear; a search that cannot honour them all says so.
    if (parsed.terms.length > 12) throw new HqError(`search for at most 12 words or phrases at once — this has ${parsed.terms.length}`)
    const empty = note => ({ query: parsed, messages: [], tickets: [], scanned: 0, note })
    let channelId = null
    if (parsed.channel) {
      if (!CHANNEL_ID.test(parsed.channel) || !Object.hasOwn(this.data.channels, parsed.channel)) return empty(`there is no #${clip(parsed.channel, 40)}`)
      channelId = parsed.channel
    }
    // An agent's id, name or slug is checked before the words that mean the
    // board or the system, so an agent called "me" is still findable.
    let author = null
    if (parsed.author) {
      const agentId = this.#agentFor(parsed.author)
      author = agentId ? { kind: 'agent', id: agentId } : ['board', 'me', 'you'].includes(parsed.author) ? { kind: 'board' } : ['system', 'quorum'].includes(parsed.author) ? { kind: 'system' } : null
      if (!author) return empty(`nobody here is called ${clip(parsed.author, 40)}`)
    }
    const byAuthor = who => !author || (who?.kind === author.kind && (author.kind !== 'agent' || who.id === author.id))
    // A ticket id matches whole, so T-1 does not also find T-10 to T-19.
    const matchers = parsed.terms.map(term => /^t-\d{1,6}$/.test(term) ? (pattern => text => pattern.test(text))(new RegExp(`\\b${term}\\b`)) : text => text.includes(term))
    const matches = text => matchers.every(match => match(text))
    const words = message => `${message.text || ''} ${message.threadId || ''} ${message.card?.ticketId || ''}`.toLowerCase()
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 200))
    // One history scan at a time, however many searches arrive together.
    const scan = () => this.store.search(message => (!channelId || message.channelId === channelId) && byAuthor(message.author) && matches(words(message)), { limit: bounded })
    const pending = this.searchChain.then(scan, scan)
    this.searchChain = pending.catch(() => {})
    const { messages, scanned } = await pending
    const tickets = Object.values(this.data.tickets)
      .filter(ticket => (!channelId || ticket.channelId === channelId) && byAuthor(ticket.createdBy) && matches(`${ticket.id} ${ticket.title} ${ticket.body}`.toLowerCase()))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 20)
      .map(ticket => this.#publicTicket(ticket))
    return { query: parsed, messages: messages.map(publicMessage), tickets, scanned }
  }

  verify() { return this.store.verify() }

  snapshot({ messagesPerChannel = 40 } = {}) {
    const ts = this.now()
    if (!this.ready()) return { ready: false, templates: publicTemplates(), rooms: this.#roomList().map(room => ({ id: room.id, label: room.label })), corrupt: this.store.corrupt ? { ...this.store.corrupt } : null, ts }
    const agents = Object.values(this.data.agents).map(agent => this.#publicAgent(agent))
    const tickets = Object.values(this.data.tickets).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 400).map(ticket => this.#publicTicket(ticket))
    const channels = Object.values(this.data.channels).map(channel => this.#publicChannel(channel))
    const messages = channels.flatMap(channel => this.store.messages(channel.id, { limit: messagesPerChannel }).map(publicMessage))
    const approvals = Object.values(this.data.approvals)
    const goals = Object.values(this.data.goals).map(goal => {
      const mine = Object.values(this.data.tickets).filter(ticket => ticket.goalId === goal.id && ticket.status !== 'cancelled')
      return { ...goal, progress: { done: mine.filter(ticket => ticket.status === 'done').length, total: mine.length } }
    })
    const active = agents.filter(agent => agent.status !== 'terminated')
    const budgets = this.budgets()
    const allRoutines = Object.values(this.data.routines)
    const routines = [...allRoutines.filter(item => item.status !== 'retired'), ...allRoutines.filter(item => item.status === 'retired').slice(-10)].map(item => this.#publicRoutine(item))
    return {
      ready: true,
      company: { ...this.data.company },
      agents, tickets, channels, messages, goals, routines,
      approvals: [...approvals.filter(item => item.status === 'pending'), ...approvals.filter(item => item.status !== 'pending').sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt))).slice(0, 20)],
      wakeups: [...this.data.wakeups.filter(item => ['queued', 'processing'].includes(item.status)), ...this.data.wakeups.filter(item => !['queued', 'processing'].includes(item.status)).slice(-15).reverse()],
      activity: this.store.recentActivity(30).slice().reverse().map(entry => ({ id: `a${entry.seq}`, ...entry })),
      rooms: this.#roomList().map(room => ({ id: room.id, label: room.label })),
      runtimes: STRUCTURED_RUNTIMES.map(id => this.#runtimeInfo(id)),
      totals: {
        agents: active.length,
        working: active.filter(agent => agent.presence.state === 'working').length,
        waiting: active.filter(agent => agent.presence.state === 'waiting').length,
        paused: active.filter(agent => agent.status === 'paused').length,
        openTickets: tickets.filter(ticket => !['done', 'cancelled'].includes(ticket.status)).length,
        pendingApprovals: approvals.filter(item => item.status === 'pending').length,
        spentUsd: budgets.total.spentUsd, limitUsd: budgets.total.limitUsd, unpricedRuns: budgets.total.unpricedRuns, month: budgets.month,
      },
      ts,
    }
  }
}

/** A message as clients see it: everything but the raw signature. */
export function publicMessage(message) {
  const { sig, ...rest } = message
  return { ...rest, signed: Boolean(sig) }
}
