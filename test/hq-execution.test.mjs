// Quorum HQ — how a ticket becomes a real run and how the run's outcome comes
// back. Dispatch goes through a real MissionStore and a fake runtime manager
// that finishes runs the way RuntimeManager#finish does (task status first,
// then a closeout event), so HQ is held to the same completion contract as a
// mission: the evidence gate decides "done", never the agent's say-so.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeHq, FakeRuntime, lastMessage } from './helpers/hq.mjs'
import { AgentControlManager } from '../src/agent-control/manager.js'
import { AgentControlStore } from '../src/agent-control/store.js'
import { RuntimeManager } from '../src/runtime-manager.js'
import { defer } from './helpers/scratch.mjs'
import { scratchDir } from './helpers/scratch.mjs'
import { BOARD, HqError } from '../src/hq/service.js'
import { MissionStore } from '../src/missions.js'

const rejects = async (promise, pattern, status) => assert.rejects(promise, error => error instanceof HqError && pattern.test(error.message) && (status === undefined || error.status === status))
const pendingFor = (hq, ticketId) => Object.values(hq.data.approvals).find(item => item.ticketId === ticketId && item.status === 'pending')

async function studio(t, options) {
  const fixture = makeHq(t, options)
  fixture.hq.init({ name: 'Acme', mission: 'Ship the cockpit', template: 'studio', roomId: 'app' })
  await fixture.hq.idle()
  return fixture
}

test('supervised: a mention asks first; approval starts one structured run with the brief and the agent env', async t => {
  const { hq, runtime, workspace, missions } = await studio(t)
  const { tickets } = hq.post({ channelId: 'general', text: '@codey fix the flaky auth test' })
  await hq.idle()
  const ticketId = tickets[0].id
  const approval = pendingFor(hq, ticketId)
  assert.ok(approval, 'nothing starts until the board says so')
  assert.equal(runtime.started.length, 0)
  assert.match(approval.summary, /Codey wants to start T-\d+ on codex in App/)

  const result = await hq.approve(approval.id)
  assert.equal(result.run.runId, 'run-1')
  const call = runtime.started[0]
  assert.equal(call.runtime, 'codex')
  assert.equal(call.role, 'builder')
  assert.equal(call.taskId, 'work')
  assert.equal(call.cwd, workspace)
  assert.equal(call.env.QUORUM_HQ_AGENT, 'codey')
  assert.equal(call.env.QUORUM_HQ_TICKET, ticketId)
  assert.match(call.task, /Ticket T-\d+ \(normal priority\): fix the flaky auth test/)
  assert.match(call.task, /Company mission: Ship the cockpit/)
  assert.equal(missions.get(call.missionId).tasks[0].status, 'working')

  const ticket = hq.data.tickets[ticketId]
  assert.equal(ticket.status, 'in_progress')
  assert.equal(ticket.checkout.runId, 'run-1')
  assert.equal(hq.snapshot().agents.find(a => a.id === 'codey').presence.state, 'working')
  assert.match(lastMessage(hq, 'general', m => m.threadId === ticketId).text, /Picking up T-\d+ — running on codex in App/)
  await rejects(hq.approve(approval.id), /already approved/, 409)
})

test('a verified run closes the ticket with the agent\'s own words, its cost, and a signed reply', async t => {
  const spend = []
  const { hq, runtime } = await studio(t, { spend })
  const { ticket } = hq.createTicket({ title: 'Add a health check', assigneeId: 'codey' })
  await hq.idle()
  await hq.approve(pendingFor(hq, ticket.id).id)
  const missionId = hq.data.tickets[ticket.id].checkout.missionId
  spend.push({ id: 'spend-1', runId: 'run-1', runtime: 'codex', missionId, costUsd: 1.25, priced: true, at: Date.now() })
  spend.push({ id: 'spend-2', runId: 'review-1', runtime: 'codex', missionId, costUsd: null, priced: false, at: Date.now() })
  runtime.finish('run-1', { status: 'completed', text: 'Added /health with a test; npm test passes.', verification: ['exit:0', 'provider-result: passed'] })
  assert.equal(hq.reconcile(), 1)
  await hq.idle()

  const done = hq.data.tickets[ticket.id]
  assert.equal(done.status, 'done')
  assert.equal(done.verified, true, 'done here means the evidence gate passed')
  assert.equal(done.checkout, null)
  assert.equal(done.runs[0].costUsd, 1.25)
  const thread = hq.store.thread(ticket.id)
  const reply = thread.find(m => m.author.kind === 'agent' && m.author.id === 'codey' && /Added \/health/.test(m.text))
  assert.ok(reply, 'the agent reports in its own voice')
  assert.ok(!thread.some(m => /closeout text/.test(m.text)), 'the runtime closeout is not passed off as the agent speaking')
  const card = thread.find(m => m.card?.type === 'run' && m.card.event === 'finished')
  assert.equal(card.card.ticketStatus, 'done')
  assert.equal(card.card.unpriced, 1)
  assert.deepEqual(hq.budget('codey'), { ...hq.budget('codey'), spentUsd: 1.25, pricedRuns: 1, unpricedRuns: 1 })
  assert.equal(hq.verify().ok, true)
})

test('an unverified run leaves the ticket blocked with the reason, and a thread reply sends it back', async t => {
  const { hq, runtime } = await studio(t)
  const { ticket } = hq.createTicket({ title: 'Refactor the store', assigneeId: 'codey' })
  await hq.idle()
  await hq.approve(pendingFor(hq, ticket.id).id)
  runtime.finish('run-1', { status: 'blocked', text: 'Refactored, but I could not run the tests.', error: 'worktree-effect: the run exited cleanly but the worktree is byte-identical' })
  hq.reconcile()
  await hq.idle()
  assert.equal(hq.data.tickets[ticket.id].status, 'blocked')
  const reply = lastMessage(hq, 'general', m => m.threadId === ticket.id && m.author.kind === 'agent' && m.card === null)
  assert.match(reply.text, /could not run the tests[\s\S]*didn't get T-\d+ over the line: worktree-effect/)

  hq.post({ channelId: 'general', threadId: ticket.id, text: '@codey the tests need NODE_ENV=test' })
  await hq.idle()
  assert.equal(hq.data.tickets[ticket.id].status, 'todo', 'the comment reopened it')
  assert.ok(pendingFor(hq, ticket.id), 'and the assignee asked to try again')
})

test('autonomous agents start without asking — inside their budget — and the budget is a hard stop', async t => {
  const spend = []
  const { hq, runtime } = await studio(t, { spend })
  // Autonomy needs a harness that prices its runs; Sentry moves to claude for it.
  hq.updateAgent('sentry', { runtime: 'claude', autonomy: 'autonomous', budget: { monthlyUsd: 2 } })
  const first = hq.createTicket({ title: 'Smoke test login', assigneeId: 'sentry' }).ticket
  const second = hq.createTicket({ title: 'Smoke test signup', assigneeId: 'sentry' }).ticket
  await hq.idle()
  assert.equal(runtime.started.length, 1, 'no approval needed, one run at a time')
  assert.equal(pendingFor(hq, first.id), undefined)
  const missionId = hq.data.tickets[first.id].checkout.missionId
  spend.push({ id: 'spend-a', runId: 'run-1', runtime: 'claude', missionId, costUsd: 2.4, priced: true, at: Date.now() })
  runtime.finish('run-1', { status: 'completed' })
  hq.reconcile()
  await hq.idle()

  const sentry = hq.data.agents.sentry
  assert.equal(sentry.status, 'paused')
  assert.equal(sentry.pausedReason, 'budget')
  assert.equal(runtime.started.length, 1, 'the next ticket did not start once the cap was reached')
  assert.equal(hq.data.tickets[second.id].status, 'todo')
  assert.match(lastMessage(hq, 'ops').text, /Sentry is paused: monthly budget reached \(\$2\.40 of \$2\.00/)
  assert.throws(() => hq.resume('sentry'), /over budget/)
  hq.updateAgent('sentry', { budget: { monthlyUsd: 10 } })
  assert.equal(hq.data.agents.sentry.status, 'active', 'raising the cap lifts a budget pause by itself')
  assert.match(lastMessage(hq, 'ops').text, /Sentry is back to work: the monthly cap now covers/)
  await hq.idle()
  assert.equal(runtime.started.length, 2, 'the waiting ticket started without anyone waking Sentry')
})

test('heartbeats wake an agent on its schedule, coalesce with queued wakeups, and do nothing when nothing is ready', async t => {
  let clock = Date.UTC(2026, 8, 25, 12)
  const { hq } = await studio(t, { now: () => clock })
  hq.updateAgent('scout', { heartbeat: { enabled: true, everyMinutes: 30 } })
  const nextAt = hq.data.agents.scout.heartbeat.nextAt
  assert.equal(nextAt, clock + 30 * 60_000)
  await hq.tick(clock + 10 * 60_000)
  assert.equal(hq.data.wakeups.filter(w => w.agentId === 'scout').length, 0, 'not due yet')
  clock += 31 * 60_000
  await hq.tick(clock)
  await hq.idle()
  const beat = hq.data.wakeups.find(w => w.agentId === 'scout' && w.sources.includes('heartbeat'))
  assert.equal(beat.result, 'nothing ready')
  assert.equal(hq.data.agents.scout.heartbeat.nextAt, clock + 30 * 60_000)

  hq.createTicket({ title: 'Map the auth code', assigneeId: 'scout' }, BOARD, { wake: false })
  hq.createTicket({ title: 'Map the billing code', assigneeId: 'scout' }, BOARD, { wake: false })
  clock += 31 * 60_000
  await hq.tick(clock)
  await hq.idle()
  const approvals = Object.values(hq.data.approvals).filter(a => a.agentId === 'scout' && a.status === 'pending')
  assert.equal(approvals.length, 1, 'one wakeup, one ask — the second ticket waits its turn')
})

test('two hand-offs before the queue drains are one wakeup with both reasons', async t => {
  const { hq } = await studio(t)
  hq.createTicket({ title: 'First', assigneeId: 'pixel' })
  hq.createTicket({ title: 'Second', assigneeId: 'pixel' })
  const queued = hq.data.wakeups.filter(w => w.agentId === 'pixel' && w.status === 'queued')
  assert.equal(queued.length, 1)
  assert.deepEqual(queued[0].sources, ['assignment'])
  await hq.idle()
})

test('work that cannot run says why: a harness with no structured adapter, a missing workspace', async t => {
  const { hq } = await studio(t)
  hq.hire({ name: 'Gem', title: 'Researcher', packId: 'scout', runtime: 'gemini' })
  const one = hq.post({ channelId: 'general', text: '@gem compare the three queue libraries' }).tickets[0]
  await hq.idle()
  assert.equal(hq.data.tickets[one.id].status, 'blocked')
  assert.match(lastMessage(hq, 'general', m => m.threadId === one.id).text, /gemini has no structured non-interactive adapter/)

  hq.updateCompany({ roomId: null })
  const two = hq.createTicket({ title: 'Somewhere', assigneeId: 'scout' }).ticket
  await hq.idle()
  assert.equal(hq.data.tickets[two.id].status, 'blocked')
  assert.match(lastMessage(hq, 'general', m => m.threadId === two.id).text, /no workspace/)
})

test('a dispatch the runtime refuses for capacity stays queued; one it refuses outright is blocked', async t => {
  const { hq, runtime, missions } = await studio(t)
  runtime.failWith = 'cloud agent concurrency limit reached (4)'
  const { ticket } = hq.createTicket({ title: 'Busy day', assigneeId: 'codey' })
  await hq.idle()
  const ask = pendingFor(hq, ticket.id)
  await rejects(hq.approve(ask.id), /not yet: cloud agent concurrency limit[\s\S]*stays open/, 409)
  const after = hq.data.tickets[ticket.id]
  assert.equal(after.status, 'todo')
  assert.equal(after.checkout, null)
  assert.match(after.waiting.reason, /concurrency limit/, 'the ticket says what it waits on')
  assert.equal(hq.data.approvals[ask.id].status, 'pending', 'capacity is not a verdict: the ask stays open')
  assert.ok(!hq.activity(50).some(entry => entry.action === 'approval.approved'), 'nothing is logged as approved until a run starts')
  const cancelled = missions.list().find(m => m.title.startsWith(ticket.id))
  assert.equal(cancelled.status, 'cancelled', 'the mission it created is closed, not left dangling')

  runtime.failWith = 'codex executable is not available'
  await rejects(hq.approve(ask.id), /not available/)
  assert.equal(hq.data.approvals[ask.id].status, 'failed')
  assert.equal(hq.data.tickets[ticket.id].status, 'blocked')
  assert.ok(hq.activity(50).some(entry => entry.action === 'approval.failed' && entry.target === ask.id))
})

test('a run that vanished across a restart is reported as lost, not left in progress forever', async t => {
  const { hq, missions, dir } = await studio(t)
  const { ticket } = hq.createTicket({ title: 'Long job', assigneeId: 'codey' })
  await hq.idle()
  await hq.approve(pendingFor(hq, ticket.id).id)
  // A new process: same HQ dir and mission store, but a runtime manager that
  // never saw run-1 — exactly what a restart looks like.
  const reborn = makeHq(t, { missions, runtime: new FakeRuntime(missions), hqDir: path.join(dir, 'hq') }).hq
  assert.equal(reborn.data.tickets[ticket.id].status, 'in_progress')
  reborn.reconcile()
  await reborn.idle()
  assert.equal(reborn.data.tickets[ticket.id].status, 'blocked')
  assert.match(lastMessage(reborn, 'general', m => m.threadId === ticket.id && m.author.kind === 'agent').text, /Quorum restarted while it was running/)
})

test('a request from inside a run acts as that agent — never as the board', async t => {
  const { hq } = await studio(t)
  const { ticket } = hq.createTicket({ title: 'Ship the API', assigneeId: 'codey' })
  await hq.idle()
  await hq.approve(pendingFor(hq, ticket.id).id)
  const actor = hq.actorForRun('run-1')
  assert.deepEqual(actor, { kind: 'agent', id: 'codey', runId: 'run-1' })
  const delegated = hq.createTicket({ title: 'Regression pass on the API', assigneeId: 'sentry' }, actor).ticket
  assert.equal(delegated.createdBy.id, 'codey')
  await rejects(hq.approve('A-1', actor), /board's decision/, 403)
  assert.throws(() => hq.actorForRun('run-404'), /not a live HQ run/)
  assert.equal(hq.actorForRun(''), BOARD, 'no run header means the operator')
})

test('an agent can propose a hire into its own team; only the board can make it', async t => {
  const { hq } = await studio(t)
  const codey = { kind: 'agent', id: 'codey' }
  const { approval } = hq.hire({ name: 'Rook', title: 'Performance Engineer', packId: 'builder', runtime: 'codex', reportsTo: 'codey', budgetUsd: 5 }, codey)
  assert.equal(approval.kind, 'hire')
  assert.equal(hq.data.agents.rook, undefined)
  assert.throws(() => hq.hire({ name: 'Mole', title: 'Spy', reportsTo: 'pixel' }, codey), /own team/)
  const result = await hq.approve(approval.id)
  assert.equal(result.agent.reportsTo, 'codey')
  assert.equal(hq.data.agents.rook.status, 'active')
})

test('/convene shows turns and cost first; a convened table posts its verdict to the channel and #decisions', async t => {
  const started = []
  const roundtable = {
    estimate: ({ participants }) => ({ turns: 2 + participants.length * 3, estimateUsd: (2 + participants.length * 3) * 0.08, available: true, local: false, label: 'Claude · sonnet' }),
    start: options => { started.push(options); return { id: 'rt-1' } },
  }
  const { hq } = await studio(t, { roundtable })
  hq.post({ channelId: 'general', text: '/convene Should retries be automatic?' })
  const proposal = lastMessage(hq, 'general', m => m.card?.type === 'convene')
  assert.equal(proposal.card.turns, 8)
  assert.equal(started.length, 0, 'proposing spends nothing')
  const preview = hq.convene({ channelId: 'general', question: 'Should retries be automatic?' })
  assert.equal(preview.requiresConfirmation, true)
  assert.throws(() => hq.convene({ channelId: 'general', question: 'x', confirm: true }, { kind: 'agent', id: 'codey' }), /board's decision/)
  hq.convene({ channelId: 'general', question: 'Should retries be automatic?', participants: 'vex,bolt,sable', confirm: true })
  assert.deepEqual(started[0].participants, ['vex', 'bolt', 'sable'])
  assert.equal(started[0].roomId, 'app')
  const posted = hq.roundtableDone({ id: 'rt-1', topic: 'Should retries be automatic?', participants: ['vex', 'bolt', 'sable'], costUsd: 0.64, turns: [{ phase: 'verdict', body: 'Surface failures; retry only idempotent posts.' }] })
  assert.equal(posted, true)
  for (const channel of ['general', 'decisions']) assert.match(lastMessage(hq, channel).text, /Surface failures; retry only idempotent posts/)
  assert.equal(hq.roundtableDone({ id: 'rt-unknown', turns: [] }), false)
})

test('cancelling a run goes through the runtime manager and parks the ticket instead of restarting it', async t => {
  const { hq, runtime } = await studio(t)
  const { ticket } = hq.createTicket({ title: 'Big refactor', assigneeId: 'codey' })
  await hq.idle()
  await hq.approve(pendingFor(hq, ticket.id).id)
  assert.throws(() => hq.terminate('codey'), /mid-run on T-\d+ — cancel that run first/)
  hq.cancelRun(ticket.id)
  assert.deepEqual(runtime.cancelled, ['run-1'])
  runtime.finish('run-1', { status: 'cancelled', text: '' })
  hq.reconcile()
  await hq.idle()
  assert.equal(hq.data.tickets[ticket.id].status, 'backlog')
  assert.equal(pendingFor(hq, ticket.id), undefined, 'the agent does not ask to start the work it was just stopped on')
  assert.match(lastMessage(hq, 'general', m => m.threadId === ticket.id && m.author.kind === 'agent').text, /the run was cancelled/)
  hq.terminate('codey')
  assert.equal(hq.data.agents.codey.status, 'terminated', 'once the run is gone the agent can be let go')
})

test('blocked-by chains release in order: finishing the prerequisite wakes the next assignee', async t => {
  const { hq, runtime } = await studio(t)
  hq.updateAgent('scout', { autonomy: 'autonomous' })
  hq.updateAgent('codey', { runtime: 'claude', autonomy: 'autonomous' })
  const research = hq.createTicket({ title: 'Research', assigneeId: 'scout' }).ticket
  const build = hq.createTicket({ title: 'Build', assigneeId: 'codey', blockedBy: [research.id] }).ticket
  await hq.idle()
  assert.deepEqual(runtime.started.map(call => call.env.QUORUM_HQ_TICKET), [research.id])
  runtime.finish('run-1', { status: 'completed', text: 'Findings in docs/research.md' })
  hq.reconcile()
  await hq.idle()
  assert.deepEqual(runtime.started.map(call => call.env.QUORUM_HQ_TICKET), [research.id, build.id])
  assert.match(runtime.started[1].task, /Resolved prerequisites: T-\d+ Research/)
})

test('a real MissionStore on disk records each attempt as its own mission', async t => {
  const missions = new MissionStore(path.join(scratchDir(t, 'quorum-hq-missions-'), 'missions.json'))
  const { hq, runtime } = await studio(t, { missions, runtime: new FakeRuntime(missions) })
  const { ticket } = hq.createTicket({ title: 'Try twice', assigneeId: 'codey' })
  await hq.idle()
  await hq.approve(pendingFor(hq, ticket.id).id)
  runtime.finish('run-1', { status: 'failed', text: '', error: 'process exit 1' })
  hq.reconcile()
  hq.reopen(ticket.id)
  await hq.idle()
  await hq.approve(pendingFor(hq, ticket.id).id)
  const titles = missions.list().map(m => m.title).filter(title => title.startsWith(ticket.id)).sort()
  assert.deepEqual(titles, [`${ticket.id} · Try twice`, `${ticket.id} · Try twice (attempt 2)`])
})

test('an ask that no longer describes its ticket can never start a run', async t => {
  const { hq, runtime } = await studio(t)
  const reassigned = hq.createTicket({ title: 'Profile the API', assigneeId: 'codey' }).ticket
  await hq.idle()
  const stale = pendingFor(hq, reassigned.id)
  hq.assign(reassigned.id, 'pixel')
  assert.equal(hq.data.approvals[stale.id].status, 'superseded', "reassigning retires codey's ask")
  await rejects(hq.approve(stale.id), /already superseded/, 409)

  const closed = hq.createTicket({ title: 'Tidy the README', assigneeId: 'scout' }).ticket
  await hq.idle()
  const ask = pendingFor(hq, closed.id)
  hq.close(closed.id)
  await rejects(hq.approve(ask.id), /already superseded/, 409)
  assert.equal(runtime.started.length, 0, 'nothing ran for either ticket')
  assert.equal(hq.dispatchReadiness(hq.data.tickets[closed.id], hq.data.agents.scout).ok, false, 'a done ticket is not startable')
})

test('a wakeup caught mid-flight by a crash goes back in the queue on restart', async t => {
  const { hq, build } = await studio(t)
  hq.createTicket({ title: 'Survive a crash', assigneeId: 'scout' }, BOARD, { wake: false })
  hq.data.wakeups.push({ id: 'w-crashed', agentId: 'scout', sources: ['heartbeat'], ticketId: null, status: 'processing', result: null, at: new Date().toISOString(), doneAt: null })
  hq.store.save()
  const reborn = build()
  assert.equal(reborn.data.wakeups.find(w => w.id === 'w-crashed').status, 'queued')
  await reborn.processQueue()
  await reborn.idle()
  assert.match(reborn.data.wakeups.find(w => w.id === 'w-crashed').result, /approval requested A-\d+/)
})

// ── hardening (review findings) ─────────────────────────────────────────────

test('an approval starts only the run it described: a changed model or brief supersedes it and a fresh ask follows', async t => {
  const { hq, runtime } = await studio(t)
  const { ticket } = hq.createTicket({ title: 'Tune the cache', body: 'Cap it at 64 MB.', assigneeId: 'pixel' })
  await hq.idle()
  const first = pendingFor(hq, ticket.id)
  assert.match(first.summary, /Pixel wants to start T-\d+ on claude in App \(main\) · model claude:sonnet/)
  assert.equal(first.plan.modelRef, 'claude:sonnet')

  hq.updateAgent('pixel', { modelRef: 'claude:opus' })
  await rejects(hq.approve(first.id), /no longer matches[\s\S]*model[\s\S]*Nothing was started; a fresh ask follows/, 409)
  assert.equal(hq.data.approvals[first.id].status, 'superseded')
  assert.ok(hq.activity(50).some(entry => entry.action === 'approval.superseded' && entry.target === first.id))
  await hq.idle()
  const second = pendingFor(hq, ticket.id)
  assert.ok(second && second.id !== first.id, 'the same work comes back as a new ask')
  assert.match(second.summary, /model claude:opus/)

  hq.updateTicket(ticket.id, { body: 'Cap it at 256 MB.' })
  await rejects(hq.approve(second.id), /ticket text/, 409)
  await hq.idle()
  const third = pendingFor(hq, ticket.id)
  const result = await hq.approve(third.id)
  assert.equal(runtime.started.length, 1, 'only the ask that matched started anything')
  assert.match(runtime.started[0].task, /256 MB/)
  const approved = hq.activity(50).filter(entry => entry.action === 'approval.approved')
  assert.deepEqual(approved.map(entry => entry.target), [third.id], 'approved is logged once, for the ask that ran')
  assert.match(approved[0].detail, new RegExp(`run ${result.run.runId}`))
})

test('the board starts a run only with confirm: true and the previewed planHash', async t => {
  const { hq, runtime } = await studio(t)
  const { ticket } = hq.createTicket({ title: 'Direct start', assigneeId: 'pixel' }, BOARD, { wake: false })
  for (const confirm of ['yes', 1, 'true']) {
    const preview = await hq.dispatch(ticket.id, { confirm })
    assert.equal(preview.requiresConfirmation, true, `confirm: ${JSON.stringify(confirm)} only previews`)
  }
  const { preview } = await hq.dispatch(ticket.id)
  assert.match(preview.planHash, /^[0-9a-f]{16}$/)
  await rejects(hq.dispatch(ticket.id, { confirm: true }), /needs the preview's planHash/, 409)
  await rejects(hq.dispatch(ticket.id, { confirm: true, expect: '0000000000000000' }), /changed since it was previewed/, 409)
  hq.updateAgent('pixel', { modelRef: 'claude:opus' })
  await rejects(hq.dispatch(ticket.id, { confirm: true, expect: preview.planHash }), /changed since it was previewed/, 409)
  assert.equal(runtime.started.length, 0)
  const fresh = (await hq.dispatch(ticket.id)).preview
  const started = await hq.dispatch(ticket.id, { confirm: true, expect: fresh.planHash })
  assert.equal(started.run.runId, 'run-1')
  assert.equal(runtime.started[0].modelRef, 'claude:opus')
})

test('/convene spends only on a literal confirm: true', async t => {
  const started = []
  const roundtable = { estimate: () => ({ turns: 8, estimateUsd: 0.64, local: false }), start: options => { started.push(options); return { id: `rt-${started.length}` } } }
  const { hq } = await studio(t, { roundtable })
  for (const confirm of ['true', 1, 'yes']) assert.equal(hq.convene({ question: 'Ship Friday?', confirm }).requiresConfirmation, true)
  assert.equal(started.length, 0)
  hq.convene({ question: 'Ship Friday?', confirm: true })
  assert.equal(started.length, 1)
  assert.equal(Object.getPrototypeOf(hq.data.roundtables), null)
})

test('a hire an agent proposes is always supervised with its heartbeat off, and the ask says what it hires', async t => {
  const { hq } = await studio(t)
  const codey = { kind: 'agent', id: 'codey' }
  const { approval } = hq.hire({ name: 'Rook', title: 'Performance Engineer', runtime: 'claude', modelRef: 'claude:opus', reportsTo: 'codey', budgetUsd: 40, roomId: 'app', autonomy: 'autonomous', heartbeat: { enabled: true, everyMinutes: 5 }, instructions: 'Profile before you optimise.', extra: 'ignored' }, codey)
  assert.equal(approval.proposal.autonomy, undefined)
  assert.equal(approval.proposal.heartbeat, undefined)
  assert.equal(approval.proposal.extra, undefined, 'only what the summary shows is kept')
  assert.match(approval.summary, /Rook \(@rook\) as Performance Engineer, reporting to Codey · builder pack \(can write\) · claude · claude:opus · \$40\.00\/mo cap · room app · supervised, heartbeat off · brief of 28 chars: “Profile before you optimise\.”/)
  const scout = hq.hire({ name: 'Ava', title: 'Research Assistant', packId: 'scout', runtime: 'claude', reportsTo: 'codey', budgetUsd: 5 }, codey).approval
  assert.match(scout.summary, /scout pack \(read-only\)/, 'the sandbox a pack gets is named, so read-only and write proposals never look alike')
  hq.deny(scout.id)
  const { agent } = await hq.approve(approval.id)
  assert.equal(agent.autonomy, 'supervised')
  assert.equal(agent.heartbeat.enabled, false)
  assert.equal(agent.modelRef, 'claude:opus')
})

test('a start in flight is left alone, and one a crash interrupted is settled on restart', async t => {
  const { hq, runtime, missions, build, workspace } = await studio(t)
  let release
  const realStart = runtime.start.bind(runtime)
  runtime.start = async args => { await new Promise(resolve => { release = resolve }); return realStart(args) }
  const slow = hq.createTicket({ title: 'Slow start', assigneeId: 'pixel' }).ticket
  await hq.idle()
  const approving = hq.approve(pendingFor(hq, slow.id).id)
  await new Promise(resolve => setImmediate(resolve))
  const held = hq.data.tickets[slow.id].checkout
  assert.ok(held && held.runId === null && held.missionId, 'claimed, mission created, run not yet recorded')
  assert.equal(JSON.parse(fs.readFileSync(hq.store.file, 'utf8')).tickets[slow.id].checkout.missionId, held.missionId, 'the mission id is on disk before the run starts')
  assert.equal(hq.reconcile(), 0, 'reconcile does not mistake a start in progress for a crash')
  release()
  await approving
  assert.equal(hq.data.tickets[slow.id].status, 'in_progress')

  // A crash between "mission created" and "run recorded", twice over: once
  // before the runtime made a run, once after.
  const interrupted = (agentId, title) => {
    const { ticket } = hq.createTicket({ title, assigneeId: agentId }, BOARD, { wake: false })
    const mission = missions.create({ title: `${ticket.id} · ${title}`, objective: title, workspace, tasks: [{ id: 'work', title, description: title, agentId, runtimeId: 'claude' }] })
    hq.data.tickets[ticket.id].checkout = { agentId, at: new Date().toISOString(), runId: null, missionId: mission.id, taskId: 'work', roomId: 'app', cwd: path.join(workspace, agentId), approvedBy: 'A-99' }
    return { ticket, mission }
  }
  const nothing = interrupted('scout', 'Nothing ran')
  const orphan = interrupted('milo', 'A run was made')
  hq.store.save()
  const runs = [{ runId: 'run-orphan', missionId: orphan.mission.id, parentTask: 'work', runtime: 'claude', modelRef: 'claude:sonnet', createdAt: Date.now() }]
  const reborn = build({ runtimeManager: new FakeRuntime(missions), agentControl: { store: { list: kind => (kind === 'runs' ? runs : []) } } })
  reborn.reconcile()
  await reborn.idle()

  const requeued = reborn.data.tickets[nothing.ticket.id]
  assert.equal(requeued.checkout, null)
  assert.equal(requeued.status, 'todo', 'nothing ran, so it goes back in the queue')
  assert.equal(missions.get(nothing.mission.id).status, 'cancelled', 'its mission is closed, not left pending')
  assert.match(lastMessage(reborn, 'general', m => m.threadId === nothing.ticket.id && m.card?.type === 'notice').text, /start was interrupted[\s\S]*nothing ran/)
  assert.ok(Object.values(reborn.data.approvals).some(a => a.ticketId === nothing.ticket.id && a.status === 'pending'), 'and the board is asked again')

  const adopted = reborn.data.tickets[orphan.ticket.id]
  assert.equal(adopted.checkout, null)
  assert.equal(adopted.status, 'blocked', 'the run the runtime made is adopted, then reported lost like any other')
  assert.equal(adopted.runs.at(-1).runId, 'run-orphan')
  assert.equal(adopted.runs.at(-1).approvedBy, 'A-99')
  assert.ok(reborn.activity(50).some(entry => entry.action === 'ticket.run-adopted' && entry.target === orphan.ticket.id))
})

test('one run per workspace: a second ticket waits quietly, then asks once the room is free', async t => {
  const { hq, runtime, missions } = await studio(t)
  hq.updateAgent('pixel', { autonomy: 'autonomous' })
  const first = hq.createTicket({ title: 'First in the room', assigneeId: 'pixel' }).ticket
  await hq.idle()
  assert.equal(hq.data.tickets[first.id].status, 'in_progress')
  const second = hq.createTicket({ title: 'Second in the room', assigneeId: 'scout' }).ticket
  await hq.idle()
  const waiting = hq.data.tickets[second.id]
  assert.equal(waiting.status, 'todo', 'a busy room is not a reason to block')
  assert.match(waiting.waiting.reason, /App is in use by T-\d+ — one run per workspace/)
  assert.equal(pendingFor(hq, second.id), undefined, 'no ask while it could not start anyway')
  assert.equal(missions.list().filter(m => m.title.startsWith(second.id)).length, 0, 'no mission was created for it')
  assert.ok(!hq.store.thread(second.id).some(m => m.card?.type === 'notice'), 'and no notice was posted')
  const board = { ...hq.dispatchReadiness(waiting, hq.data.agents.scout) }
  assert.equal(board.transient, true)

  runtime.finish('run-1', { status: 'completed' })
  hq.reconcile()
  await hq.idle()
  await hq.tick()
  await hq.idle()
  assert.equal(hq.data.tickets[second.id].waiting, undefined)
  assert.ok(pendingFor(hq, second.id), 'the next beat after the room freed up asks for it')
})

test('the daily ceiling and the concurrency cap make work wait, without a mission or a notice', async t => {
  const { hq, runtime, missions } = await studio(t)
  runtime.budgetStatus = () => ({ allowed: false, reason: 'daily cloud budget reached: $25.00 of $25.00 recorded in the last 24h.' })
  const { ticket } = hq.createTicket({ title: 'Over the ceiling', assigneeId: 'pixel' })
  await hq.idle()
  assert.match(hq.data.tickets[ticket.id].waiting.reason, /daily cloud budget reached/)
  assert.equal(pendingFor(hq, ticket.id), undefined)
  assert.equal(missions.list().length, 0)
  runtime.budgetStatus = () => ({ allowed: true, reason: 'ok' })
  runtime.inFlightCloudRuns = () => 4
  runtime.maxConcurrentCloudAgents = 4
  await hq.tick()
  await hq.idle()
  assert.match(hq.data.tickets[ticket.id].waiting.reason, /concurrency limit reached \(4\)/)
  runtime.inFlightCloudRuns = () => 0
  await hq.tick()
  await hq.idle()
  assert.ok(pendingFor(hq, ticket.id))
})

test('spend the ledger records after a run was folded in still reaches its agent', async t => {
  const spend = []
  const { hq, runtime } = await studio(t, { spend })
  const { ticket } = hq.createTicket({ title: 'Priced late', assigneeId: 'pixel' })
  await hq.idle()
  await hq.approve(pendingFor(hq, ticket.id).id)
  const missionId = hq.data.tickets[ticket.id].checkout.missionId
  spend.push({ id: 'spend-work', runId: 'run-1', runtime: 'claude', missionId, costUsd: 0.5, priced: true, at: Date.now() })
  runtime.finish('run-1', { status: 'completed' })
  hq.reconcile()
  await hq.idle()
  assert.equal(hq.data.tickets[ticket.id].runs[0].costUsd, 0.5)
  spend.push({ id: 'spend-review', runId: 'review-1', runtime: 'claude', missionId, costUsd: 0.25, priced: true, at: Date.now() })
  await hq.tick()
  await hq.idle()
  assert.equal(hq.data.tickets[ticket.id].runs[0].costUsd, 0.75)
  assert.equal(hq.budget('pixel').spentUsd, 0.75)
  assert.ok(hq.activity(50).some(entry => entry.action === 'ticket.spend-late' && entry.target === ticket.id))
  await hq.tick()
  assert.equal(hq.budget('pixel').spentUsd, 0.75, 'an entry is attributed once')
})

test('a budget pause lifts by itself when a new month begins', async t => {
  let clock = Date.UTC(2026, 8, 29, 12)
  const spend = [{ id: 'spend-sep', agentId: 'x', missionId: 'm', costUsd: 1, priced: true, at: clock }]
  const { hq } = await studio(t, { spend, now: () => clock })
  hq.data.spend.push({ id: 'spend-sep', agentId: 'pixel', ticketId: 'T-0', runId: 'run-0', runtime: 'claude', costUsd: 16, priced: true, at: clock })
  hq.pause('pixel', { kind: 'system', id: 'system' }, 'budget')
  await hq.tick(clock)
  assert.equal(hq.data.agents.pixel.status, 'paused', 'still over this month')
  clock = Date.UTC(2026, 9, 1, 0, 5)
  await hq.tick(clock)
  assert.equal(hq.data.agents.pixel.status, 'active')
  assert.match(lastMessage(hq, 'ops').text, /Pixel is back to work: a new budget month began/)
})

test('a reply to a ticket mid-run says it reaches the agent next pass, and wakes nothing', async t => {
  const { hq } = await studio(t)
  const { ticket } = hq.createTicket({ title: 'Long task', assigneeId: 'pixel' })
  await hq.idle()
  await hq.approve(pendingFor(hq, ticket.id).id)
  const before = hq.data.wakeups.length
  hq.post({ channelId: 'general', threadId: ticket.id, text: '@pixel also check dark mode' })
  await hq.idle()
  assert.equal(hq.data.wakeups.length, before)
  assert.match(lastMessage(hq, 'general', m => m.threadId === ticket.id).text, /mid-run on T-\d+[\s\S]*next pass/)
})

test('the heartbeat never rejects, and a repeating failure is reported once', async t => {
  const { hq } = await studio(t)
  hq.reconcile = () => { throw new Error('disk on fire') }
  await hq.tick()
  await hq.tick()
  const reports = hq.store.messages('ops', { limit: 100 }).filter(m => /HQ heartbeat error: disk on fire/.test(m.text))
  assert.equal(reports.length, 1)
})

test('an ask saved before asks carried a plan is never trusted to start a run', async t => {
  const { hq, runtime } = await studio(t)
  const { ticket } = hq.createTicket({ title: 'Legacy ask', assigneeId: 'pixel' })
  await hq.idle()
  const ask = pendingFor(hq, ticket.id)
  delete ask.plan
  delete ask.planHash
  await rejects(hq.approve(ask.id), /predates plan checks[\s\S]*Nothing was started/, 409)
  await hq.idle()
  assert.equal(runtime.started.length, 0)
  assert.ok(pendingFor(hq, ticket.id).planHash, 'the fresh ask carries a plan')
})

test('one ask per agent: denying or retiring it gives the agent\'s next ready ticket its turn', async t => {
  const { hq } = await studio(t)
  const first = hq.createTicket({ title: 'First job', assigneeId: 'pixel', priority: 'high' }).ticket
  const second = hq.createTicket({ title: 'Second job', assigneeId: 'pixel' }).ticket
  const third = hq.createTicket({ title: 'Third job', assigneeId: 'pixel', priority: 'low' }).ticket
  await hq.idle()
  assert.ok(pendingFor(hq, first.id))
  assert.equal(pendingFor(hq, second.id), undefined, 'the second waits for the first ask to be answered')
  hq.deny(pendingFor(hq, first.id).id, 'not now')
  await hq.idle()
  assert.ok(pendingFor(hq, second.id), 'a denial lets the next ticket ask')
  hq.close(second.id)
  await hq.idle()
  assert.ok(pendingFor(hq, third.id), 'so does closing the ticket an ask was about')
})

// ── second review ───────────────────────────────────────────────────────────

test('a workspace claimed outside HQ makes work wait — no mission, notice or retry per beat', async t => {
  const dir = scratchDir(t, 'quorum-hq-claims-')
  const control = new AgentControlManager({ store: new AgentControlStore(path.join(dir, 'ac')) })
  defer(t, () => control.store.close())
  const missions = new MissionStore(path.join(dir, 'missions.json'))
  const runtime = new RuntimeManager({ agentControl: control, missions, memoryBridge: { recall: async () => '' }, executablePathImpl: () => true, spawnImpl: async () => { throw new Error('nothing is spawned in this test') }, heartbeatMs: 60_000 })
  const { hq, workspace } = makeHq(t, { missions, runtime, agentControl: control })
  hq.init({ name: 'Acme', template: 'solo', roomId: 'app' })
  hq.updateAgent('codey', { autonomy: 'autonomous' })
  // What server.js does when the operator opens an agent session in the room.
  const session = control.createRun({ runtime: 'claude', role: 'builder', repoRoot: workspace, worktree: workspace })
  const { ticket } = hq.createTicket({ title: 'Polish the empty state', assigneeId: 'codey' })
  await hq.idle()
  for (let i = 0; i < 5; i += 1) { await hq.tick(); await hq.idle() }
  const held = hq.data.tickets[ticket.id]
  assert.equal(held.status, 'todo')
  assert.match(held.waiting.reason, new RegExp(`claimed by run ${session.runId}`))
  assert.equal(missions.list().filter(m => m.title.startsWith(ticket.id)).length, 0, 'no mission per beat')
  assert.equal(hq.store.thread(ticket.id).filter(m => /could not start/.test(m.text)).length, 0, 'no notice per beat')
  control.close(session.runId, { disposition: 'completed' })
  assert.equal(hq.dispatchReadiness(held, hq.data.agents.codey).ok, true, 'the wait ends when the session lets go')
})

test('a refusal only the runtime can see is retried with a growing pause and said once', async t => {
  let clock = Date.UTC(2026, 8, 25, 12)
  const { hq, runtime, missions } = await studio(t, { now: () => clock })
  hq.updateAgent('pixel', { autonomy: 'autonomous' })
  runtime.failWith = 'claimed path is already owned by run run-elsewhere: /work/app'
  const { ticket } = hq.createTicket({ title: 'Retry politely', assigneeId: 'pixel' })
  await hq.idle()
  const first = hq.data.tickets[ticket.id].waiting
  assert.equal(first.retryAt, clock + 30_000)
  const attempts = () => missions.list().filter(m => m.title.startsWith(ticket.id)).length
  assert.equal(attempts(), 1)
  clock += 15_000
  await hq.tick(clock)
  await hq.idle()
  assert.equal(attempts(), 1, 'not before its retry time')
  clock += 16_000
  await hq.tick(clock)
  await hq.idle()
  assert.equal(attempts(), 2)
  assert.equal(hq.data.tickets[ticket.id].waiting.retryAt, clock + 60_000, 'the pause doubles')
  assert.equal(hq.store.thread(ticket.id).filter(m => /could not start/.test(m.text)).length, 1, 'the thread hears it once')
  runtime.failWith = null
  clock += 61_000
  await hq.tick(clock)
  await hq.idle()
  assert.equal(hq.data.tickets[ticket.id].status, 'in_progress')
})

test('approving an ask whose prerequisite is still open leaves the ticket to be asked about again', async t => {
  const { hq, runtime } = await studio(t)
  const migrate = hq.createTicket({ title: 'Write the migration', assigneeId: 'pixel' }).ticket
  await hq.idle()
  const ask = pendingFor(hq, migrate.id)
  const schema = hq.createTicket({ title: 'Design the schema', assigneeId: 'scout' }, BOARD, { wake: false }).ticket
  hq.updateTicket(migrate.id, { blockedBy: [schema.id] })
  await rejects(hq.approve(ask.id), /cannot start now: waiting on T-\d+[\s\S]*stays todo/, 409)
  assert.equal(hq.data.approvals[ask.id].status, 'superseded')
  assert.equal(hq.data.tickets[migrate.id].status, 'todo', 'a prerequisite is not a failure')
  hq.close(schema.id)
  await hq.idle()
  assert.ok(pendingFor(hq, migrate.id), 'finishing the prerequisite brings the ask back')
  assert.equal(runtime.started.length, 0)
})

test('approving an ask for an agent over its cap pauses the agent and keeps the ticket for later', async t => {
  const { hq } = await studio(t)
  hq.data.spend.push({ id: 's1', agentId: 'pixel', ticketId: 'T-0', runId: 'r0', runtime: 'claude', costUsd: 10, priced: true, at: Date.now() })
  const { ticket } = hq.createTicket({ title: 'Tune the cache', assigneeId: 'pixel' })
  await hq.idle()
  const ask = pendingFor(hq, ticket.id)
  hq.updateAgent('pixel', { budget: { monthlyUsd: 8 } })
  await rejects(hq.approve(ask.id), /over budget/, 409)
  assert.equal(hq.data.tickets[ticket.id].status, 'todo')
  assert.equal(hq.data.agents.pixel.pausedReason, 'budget')
  assert.equal(hq.data.approvals[ask.id].status, 'superseded')
  assert.equal(hq.activity(100).filter(entry => entry.target === ask.id && entry.action !== 'approval.requested').length, 1, 'the ask is settled once, for the reason it did not start')
  hq.updateAgent('pixel', { budget: { monthlyUsd: 50 } })
  await hq.idle()
  assert.equal(hq.data.agents.pixel.status, 'active')
  assert.ok(pendingFor(hq, ticket.id), 'raising the cap brings the ask back')
})

test('an ask that cannot start hands the agent\'s turn to its next ticket', async t => {
  const { hq, runtime } = await studio(t)
  const first = hq.createTicket({ title: 'First', assigneeId: 'pixel', priority: 'high' }).ticket
  const second = hq.createTicket({ title: 'Second', assigneeId: 'pixel' }).ticket
  await hq.idle()
  runtime.failWith = 'claude executable is not available'
  await rejects(hq.approve(pendingFor(hq, first.id).id), /not available/)
  await hq.idle()
  assert.equal(hq.data.tickets[first.id].status, 'blocked')
  assert.ok(pendingFor(hq, second.id), 'the second ticket is asked about now')
})

test('a pause while a run is starting retires the ask if the start then fails', async t => {
  const { hq, runtime } = await studio(t)
  const { ticket } = hq.createTicket({ title: 'Tune the cache', assigneeId: 'pixel' })
  await hq.idle()
  const ask = pendingFor(hq, ticket.id)
  let release
  runtime.start = () => new Promise((_, reject) => { release = () => reject(new Error('claimed path is already owned by run run-pty: /work/app')) })
  const approving = hq.approve(ask.id).catch(error => error.message)
  await new Promise(resolve => setImmediate(resolve))
  hq.pause('pixel')
  release()
  assert.match(await approving, /no longer applies: Pixel was paused while it started/)
  assert.equal(hq.data.approvals[ask.id].status, 'expired')
  assert.equal(hq.data.tickets[ticket.id].status, 'todo')
})

test('a board pause outranks a budget pause: the new month does not lift it', async t => {
  let clock = Date.UTC(2026, 8, 29, 12)
  const { hq } = await studio(t, { now: () => clock })
  hq.data.spend.push({ id: 's1', agentId: 'pixel', ticketId: 'T-0', runId: 'r0', runtime: 'claude', costUsd: 16, priced: true, at: clock })
  hq.pause('pixel', { kind: 'system', id: 'system' }, 'budget')
  hq.pause('pixel')
  assert.equal(hq.data.agents.pixel.pausedReason, 'board')
  clock = Date.UTC(2026, 9, 1, 0, 5)
  await hq.tick(clock)
  assert.equal(hq.data.agents.pixel.status, 'paused')
})

test('late spend is found for every recent run, not only the latest', async t => {
  const spend = []
  const { hq, runtime } = await studio(t, { spend })
  const { ticket } = hq.createTicket({ title: 'Twice', assigneeId: 'pixel' })
  await hq.idle()
  await hq.approve(pendingFor(hq, ticket.id).id)
  const firstMission = hq.data.tickets[ticket.id].checkout.missionId
  runtime.finish('run-1', { status: 'cancelled', text: '' })
  hq.reconcile()
  hq.reopen(ticket.id)
  await hq.idle()
  await hq.approve(pendingFor(hq, ticket.id).id)
  spend.push({ id: 'late-1', runId: 'run-1', runtime: 'claude', missionId: firstMission, costUsd: 5, priced: true, at: Date.now() })
  await hq.tick()
  await hq.idle()
  assert.equal(hq.data.tickets[ticket.id].runs[0].costUsd, 5)
  assert.equal(hq.budget('pixel').spentUsd, 5)
})

test('an ask binds the job pack and the agent\'s brief too', async t => {
  const { hq } = await studio(t)
  const { ticket } = hq.createTicket({ title: 'Review the diff', assigneeId: 'pixel' })
  await hq.idle()
  const ask = pendingFor(hq, ticket.id)
  assert.equal(ask.plan.packId, 'builder')
  hq.updateAgent('pixel', { packId: 'scout' })
  await rejects(hq.approve(ask.id), /job pack, sandbox/, 409)
  await hq.idle()
  const next = pendingFor(hq, ticket.id)
  hq.updateAgent('pixel', { instructions: 'Also push to main when done.' })
  await rejects(hq.approve(next.id), /agent brief/, 409)
})

test('a start interrupted by a crash adopts the worker\'s run, never a later one', async t => {
  const { hq, missions, build, workspace } = await studio(t)
  const { ticket } = hq.createTicket({ title: 'Crashed start', assigneeId: 'pixel' }, BOARD, { wake: false })
  const mission = missions.create({ title: `${ticket.id} · Crashed start`, objective: 'x', workspace, tasks: [{ id: 'work', title: 'x', description: 'x', agentId: 'pixel', runtimeId: 'claude' }] })
  hq.data.tickets[ticket.id].checkout = { agentId: 'pixel', at: new Date().toISOString(), runId: null, missionId: mission.id, taskId: 'work', roomId: 'app', cwd: workspace, approvedBy: 'A-1' }
  hq.store.save()
  const runs = [
    { runId: 'run-review', missionId: mission.id, parentTask: 'work', runtime: 'codex', createdAt: 2000 },
    { runId: 'run-worker', missionId: mission.id, parentTask: 'work', runtime: 'claude', createdAt: 1000 },
  ]
  const reborn = build({ runtimeManager: new FakeRuntime(missions), agentControl: { store: { list: kind => (kind === 'runs' ? runs : []) } } })
  reborn.reconcile()
  await reborn.idle()
  assert.equal(reborn.data.tickets[ticket.id].runs.at(-1).runId, 'run-worker')
})

// ── routines ────────────────────────────────────────────────────────────────

test('a routine on an autonomous agent starts its run on schedule, inside the cap; the next waits for it', async t => {
  let clock = Date.UTC(2026, 8, 25, 9)
  const { hq, runtime } = await studio(t, { now: () => clock })
  hq.updateAgent('pixel', { autonomy: 'autonomous', budget: { monthlyUsd: 5 } })
  hq.addRoutine({ title: 'Visual regression sweep', assigneeId: 'pixel', every: '6h' })
  assert.match(lastMessage(hq, 'general').text, /Pixel is autonomous, so each one can start inside their monthly cap/)
  clock += 6 * 60 * 60_000
  await hq.tick(clock)
  await hq.idle()
  assert.equal(runtime.started.length, 1, 'the routine\'s ticket started without an ask')
  assert.match(runtime.started[0].task, /Visual regression sweep/)
  clock += 6 * 60 * 60_000
  await hq.tick(clock)
  await hq.idle()
  assert.equal(runtime.started.length, 1, 'while that run is going, the routine skips its turn')
  runtime.finish('run-1', { status: 'completed' })
  hq.reconcile()
  clock += 6 * 60 * 60_000
  await hq.tick(clock)
  await hq.idle()
  assert.equal(runtime.started.length, 2, 'once it is done, the next turn runs')
})

test('a routine whose last run just finished fires on the same beat that folds the run in', async t => {
  let clock = Date.UTC(2026, 8, 25, 9)
  const { hq, runtime } = await studio(t, { now: () => clock })
  hq.updateAgent('pixel', { autonomy: 'autonomous', budget: { monthlyUsd: 5 } })
  hq.addRoutine({ title: 'Nightly sweep', assigneeId: 'pixel', every: '1d' })
  clock += 24 * 60 * 60_000
  await hq.tick(clock)
  await hq.idle()
  runtime.finish('run-1', { status: 'completed' })
  clock += 24 * 60 * 60_000
  await hq.tick(clock)
  await hq.idle()
  assert.equal(hq.data.routines['R-1'].fired, 2, 'no skipped day for a run nobody had folded in yet')
})
