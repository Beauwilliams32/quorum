// Quorum HQ — the company and the room, without spending anything.
//
// Org chart, goals, tickets, channels, @mentions, slash commands, the signed
// message log and the hash-chained activity log. Every HQ here runs against
// scratch storage and a fake runtime manager (see helpers/hq.mjs); the
// execution path has its own suite in hq-execution.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeHq, byTitle, lastMessage } from './helpers/hq.mjs'
import { scratchDir } from './helpers/scratch.mjs'
import { BOARD, HqError, publicMessage } from '../src/hq/service.js'
import { formatEvery, parseCommand, parseEvery, parseMentions, parseSearch, parseTicketRef, slugify, ticketTitleFrom } from '../src/hq/parse.js'
import { Keyring, canonical, verifySignature } from '../src/hq/identity.js'
import { budgetFor, monthKey } from '../src/hq/budget.js'
import { buildWorkPrompt } from '../src/hq/prompt.js'
import { validateAvatar } from '../src/hq/avatars.js'

const rejects = (fn, pattern, status) => assert.throws(fn, error => error instanceof HqError && pattern.test(error.message) && (status === undefined || error.status === status))

test('parsing: mentions resolve only known agents, commands are recognised or reported', () => {
  const known = new Map([['codey', 'codey'], ['scout', 'scout'], ['pixel', 'pixel']])
  assert.deepEqual(parseMentions('@Codey fix it, then @scout and @codey again; email me@host.com @nobody', known), ['codey', 'scout'])
  assert.deepEqual(parseCommand('/ticket  Fix the flaky test'), { name: 'ticket', rest: 'Fix the flaky test', known: true })
  assert.equal(parseCommand('/frobnicate now').known, false)
  assert.equal(parseCommand('not a command'), null)
  assert.equal(parseTicketRef('see t12 and T-3'), 'T-12')
  assert.equal(slugify('Codey Two!'), 'codey-two')
  assert.equal(slugify('42'), '')
  assert.equal(ticketTitleFrom('@codey fix the flaky auth test. It fails on CI about once a day.'), 'fix the flaky auth test.')
})

test('identity: canonical JSON is key-order independent and signatures catch any edit', t => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: undefined }] }), canonical({ a: [2, { d: 3 }], b: 1 }))
  const keys = new Keyring(path.join(scratchDir(t, 'quorum-hq-keys-'), 'keys'))
  const publicKey = keys.ensure('agent:codey')
  assert.equal(keys.ensure('agent:codey'), publicKey, 'a key is created once and reused')
  const payload = { id: 'm1', text: 'shipped it' }
  const sig = keys.sign('agent:codey', payload)
  assert.equal(verifySignature(publicKey, payload, sig), true)
  assert.equal(verifySignature(publicKey, { ...payload, text: 'shipped it!' }, sig), false)
  assert.equal(verifySignature(keys.ensure('agent:scout'), payload, sig), false, 'another agent cannot vouch for it')
  const mode = fs.statSync(keys.file('agent:codey')).mode & 0o777
  assert.equal(mode, 0o600, 'private keys are owner-only')
  assert.throws(() => keys.ensure('agent:../../etc'), /invalid identity/)
})

test('init founds a company from a template: channels, an org chart, and nobody working', t => {
  const { hq } = makeHq(t)
  assert.equal(hq.snapshot().ready, false)
  hq.init({ name: 'Acme Robotics', mission: 'Ship the best local agent cockpit', template: 'studio', roomId: 'app' })
  const snap = hq.snapshot()
  assert.equal(snap.ready, true)
  assert.equal(snap.company.name, 'Acme Robotics')
  assert.deepEqual(snap.channels.filter(c => c.kind === 'channel').map(c => c.id).sort(), ['decisions', 'general', 'ops'])
  assert.equal(snap.channels.filter(c => c.kind === 'dm').length, 6, 'every hire gets a DM channel')
  assert.deepEqual(snap.agents.map(a => a.presence.state), Array(6).fill('idle'))
  assert.ok(snap.agents.every(a => a.autonomy === 'supervised' && a.heartbeat.enabled === false && a.budget.limitUsd > 0))
  const org = hq.org()
  assert.deepEqual(org.children.map(n => n.id), ['atlas'])
  const codey = org.children[0].children.find(n => n.id === 'codey')
  assert.deepEqual(codey.children.map(n => n.id), ['sentry', 'milo'])
  rejects(() => hq.init({ name: 'Again' }), /already set up/, 409)
})

test('hiring is validated, ids are never reused, and the org chart cannot loop', t => {
  const { hq } = makeHq(t)
  hq.init({ name: 'Acme', template: 'blank' })
  rejects(() => hq.hire({ name: '!!', title: 'x' }), /agent id/)
  rejects(() => hq.hire({ id: 'board', name: 'Board', title: 'x' }), /reserved/)
  rejects(() => hq.hire({ name: 'Rex', title: 'Engineer', packId: 'nope' }), /unknown agent pack/)
  rejects(() => hq.hire({ name: 'Rex', title: 'Engineer', reportsTo: 'ghost' }), /unknown agent/, 404)
  rejects(() => hq.hire({ name: 'Rex', title: 'Engineer', autonomy: 'autonomous', budgetUsd: 0 }), /needs a monthly budget cap/)
  hq.hire({ name: 'Lead', title: 'Lead', packId: 'builder', runtime: 'codex' })
  hq.hire({ name: 'Dev', title: 'Developer', reportsTo: 'lead' })
  rejects(() => hq.hire({ name: 'Dev', title: 'Again' }), /taken/, 409)
  rejects(() => hq.updateAgent('lead', { reportsTo: 'dev' }), /loop/)
  assert.equal(hq.snapshot().agents.find(a => a.id === 'lead').modelRef, 'codex:auto')
  hq.terminate('dev')
  rejects(() => hq.hire({ name: 'Dev', title: 'Developer' }), /never reused/, 409)
})

test('an agent can only hand work down its own branch of the org chart', t => {
  const { hq } = makeHq(t)
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  const codey = { kind: 'agent', id: 'codey' }
  const { ticket } = hq.createTicket({ title: 'Regression sweep', assigneeId: 'sentry' }, codey)
  assert.equal(ticket.assigneeId, 'sentry')
  rejects(() => hq.createTicket({ title: 'Write the launch post', assigneeId: 'pixel' }, codey), /only hand work/, 403)
  rejects(() => hq.addGoal({ title: 'Take over' }, codey), /board's decision/, 403)
  rejects(() => hq.close(ticket.id, codey), /board's decision/, 403)
})

test('tickets: blockers gate readiness, priority orders the queue, and in_progress is never set by hand', t => {
  const { hq } = makeHq(t, { withRuntime: false })
  hq.init({ name: 'Acme', template: 'solo' })
  const a = hq.createTicket({ title: 'Design the schema', assigneeId: 'codey' }, BOARD, { wake: false }).ticket
  const b = hq.createTicket({ title: 'Build the API', assigneeId: 'codey', blockedBy: [a.id] }, BOARD, { wake: false }).ticket
  const c = hq.createTicket({ title: 'Hotfix login', assigneeId: 'codey', priority: 'urgent' }, BOARD, { wake: false }).ticket
  assert.deepEqual(hq.readyTickets('codey').map(item => item.id), [c.id, a.id], 'urgent first; the blocked ticket waits')
  rejects(() => hq.updateTicket(a.id, { blockedBy: [b.id] }), /wait on itself/)
  rejects(() => hq.updateTicket(a.id, { status: 'in_progress' }), /only from a real run/)
  rejects(() => hq.createTicket({ title: 'x', verifyCommand: 'rm -rf / ; echo' }), /verify command refused/)
  const verified = hq.createTicket({ title: 'Has a check', verifyCommand: 'npm test' }, BOARD, { wake: false }).ticket
  assert.deepEqual(verified.verifyCommand.args, ['test'], 'a verify string is split into a program and arguments, never a shell line')
  hq.close(a.id)
  assert.equal(hq.data.tickets[a.id].verified, false, 'a board close is recorded as unverified')
  assert.deepEqual(hq.readyTickets('codey').map(item => item.id), [c.id, b.id])
  hq.reopen(a.id)
  assert.equal(hq.data.tickets[a.id].status, 'todo')
})

test('an @mention hands an agent a ticket; a DM needs no mention; a thread reply wakes the assignee', async t => {
  const { hq } = makeHq(t)
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  const { message, tickets } = hq.post({ channelId: 'general', text: '@codey fix the flaky auth test. It fails on CI about once a day.' })
  assert.deepEqual(message.mentions, ['codey'])
  assert.equal(tickets.length, 1)
  const ticket = hq.data.tickets[tickets[0].id]
  assert.equal(ticket.assigneeId, 'codey')
  assert.equal(ticket.title, 'fix the flaky auth test.')
  assert.equal(ticket.channelId, 'general')
  await hq.idle()
  const approval = Object.values(hq.data.approvals).find(item => item.ticketId === ticket.id)
  assert.equal(approval?.status, 'pending', 'a supervised agent asks before its first run')
  assert.equal(hq.snapshot().agents.find(a => a.id === 'codey').presence.state, 'waiting')

  const dm = hq.post({ channelId: 'dm-pixel', text: 'tighten the empty state copy on the missions view' })
  assert.equal(dm.tickets[0].assigneeId, 'pixel')

  hq.post({ channelId: 'general', text: 'thanks @scout, nothing for you yet' , threadId: null })
  const scoutTickets = Object.values(hq.data.tickets).filter(item => item.assigneeId === 'scout')
  assert.equal(scoutTickets.length, 1, 'outside a thread every mention is a hand-off — that is the contract')

  hq.deny(approval.id, 'not today')
  assert.equal(hq.data.tickets[ticket.id].status, 'backlog')
  hq.updateTicket(ticket.id, { status: 'todo' })
  hq.post({ channelId: 'general', threadId: ticket.id, text: '@codey the failure only happens with TZ=UTC' })
  const wake = hq.data.wakeups.find(item => item.agentId === 'codey' && item.sources.includes('comment'))
  assert.ok(wake || Object.values(hq.data.approvals).some(item => item.ticketId === ticket.id && item.status === 'pending'), 'the comment woke the assignee')
})

test('slash commands run after the message is recorded, and a bad one says why in the channel', t => {
  const { hq } = makeHq(t, { withRuntime: false })
  hq.init({ name: 'Acme', template: 'solo' })
  hq.post({ channelId: 'general', text: '/goal Launch the public beta' })
  assert.equal(Object.values(hq.data.goals)[0].title, 'Launch the public beta')
  hq.post({ channelId: 'general', text: '/ticket Write the changelog' })
  const ticket = byTitle(hq, 'Write the changelog')
  assert.equal(ticket.status, 'backlog')
  hq.post({ channelId: 'general', text: `/assign ${ticket.id} @codey` })
  assert.equal(hq.data.tickets[ticket.id].assigneeId, 'codey')
  hq.post({ channelId: 'general', text: '/frobnicate' })
  assert.match(lastMessage(hq, 'general').text, /unknown command \/frobnicate/)
  hq.post({ channelId: 'general', text: '/help' })
  assert.match(lastMessage(hq, 'general').text, /\/convene <question>/)
  const texts = hq.store.messages('general', { limit: 500 }).map(m => m.text)
  assert.ok(texts.includes('/frobnicate'), 'the command itself is in the log')
})

test('every message is signed by its author, and editing the log is detected', t => {
  const { hq } = makeHq(t, { withRuntime: false })
  hq.init({ name: 'Acme', template: 'solo' })
  hq.post({ channelId: 'general', text: 'hello team' })
  hq.post({ channelId: 'general', text: 'agent speaking' }, { kind: 'agent', id: 'codey' })
  assert.equal(hq.verify().ok, true)
  const snap = hq.snapshot()
  assert.ok(snap.messages.every(m => m.signed === true && !('sig' in m)), 'clients see that a message is signed, not the signature')

  const file = hq.store.messagesFile
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  const at = lines.findIndex(line => line.includes('"agent speaking"'))
  const forged = JSON.parse(lines[at])
  forged.text = 'agent speaking — and approving my own budget'
  lines[at] = JSON.stringify(forged)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  const report = hq.verify()
  assert.equal(report.ok, false)
  assert.deepEqual(report.messages.failed, [forged.id])
})

test('the activity log is a hash chain: one edited entry breaks it at that entry', t => {
  const { hq } = makeHq(t, { withRuntime: false })
  hq.init({ name: 'Acme', template: 'solo' })
  hq.addGoal({ title: 'Ship' })
  hq.createTicket({ title: 'One' }, BOARD, { wake: false })
  assert.equal(hq.verify().activity.brokenAt, null)
  const file = hq.store.activityFile
  const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  entries[2].detail = 'rewritten history'
  fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  assert.equal(hq.verify().activity.brokenAt, entries[2].seq)
  fs.appendFileSync(file, '{"torn": ')
  assert.equal(hq.verify().activity.torn, 1, 'a torn last line is reported, not silently absorbed')
})

test('state survives a restart: the same dir reloads the company, counters and history', t => {
  const { hq, build } = makeHq(t, { withRuntime: false })
  hq.init({ name: 'Acme', template: 'solo' })
  hq.createTicket({ title: 'Persist me', assigneeId: 'codey' }, BOARD, { wake: false })
  hq.post({ channelId: 'general', text: 'before the restart' })
  const again = build()
  assert.equal(again.data.company.name, 'Acme')
  assert.ok(byTitle(again, 'Persist me'))
  assert.equal(again.createTicket({ title: 'Next' }, BOARD, { wake: false }).ticket.id, 'T-2')
  assert.ok(again.store.messages('general', { limit: 50 }).some(m => m.text === 'before the restart'))
  assert.equal(again.verify().ok, true)
})

test('terminating keeps the record, re-parents the reports and releases open tickets', t => {
  const { hq } = makeHq(t, { withRuntime: false })
  hq.init({ name: 'Acme', template: 'studio' })
  const ticket = hq.createTicket({ title: 'Release notes', assigneeId: 'milo' }, BOARD, { wake: false }).ticket
  const { released } = hq.terminate('milo')
  assert.deepEqual(released, [ticket.id])
  assert.equal(hq.data.agents.milo.status, 'terminated')
  assert.equal(hq.data.tickets[ticket.id].assigneeId, null)
  hq.terminate('codey')
  assert.equal(hq.data.agents.sentry.reportsTo, 'atlas', "codey's report now reports to codey's manager")
  assert.equal(hq.snapshot().agents.find(a => a.id === 'codey').presence.state, 'offline')
})

test('budgets: priced spend this month counts, unpriced runs are named, other months do not count', () => {
  const now = Date.UTC(2026, 8, 20)
  const agent = { id: 'codey', budget: { monthlyUsd: 10, warnPct: 80 } }
  const spend = [
    { agentId: 'codey', costUsd: 6.5, priced: true, at: Date.UTC(2026, 8, 2) },
    { agentId: 'codey', costUsd: 2, priced: true, at: Date.UTC(2026, 8, 19) },
    { agentId: 'codey', costUsd: null, priced: false, at: Date.UTC(2026, 8, 19) },
    { agentId: 'codey', costUsd: 50, priced: true, at: Date.UTC(2026, 7, 30) },
    { agentId: 'scout', costUsd: 50, priced: true, at: Date.UTC(2026, 8, 19) },
  ]
  const status = budgetFor(agent, spend, now)
  assert.equal(status.spentUsd, 8.5)
  assert.equal(status.state, 'warn')
  assert.equal(status.unpricedRuns, 1)
  assert.equal(status.month, monthKey(now))
  assert.equal(budgetFor({ ...agent, budget: { monthlyUsd: 8 } }, spend, now).state, 'over')
  assert.equal(budgetFor({ ...agent, budget: { monthlyUsd: 0 } }, spend, now).state, 'uncapped')
})

test('the work prompt carries role, goal, ticket and thread — bounded, with how to report back', () => {
  const prompt = buildWorkPrompt({
    company: { name: 'Acme', mission: 'Ship it' },
    agent: { name: 'Codey', title: 'Lead Engineer', instructions: 'Run the gates.' },
    manager: { name: 'Atlas', title: 'Chief of Staff' },
    reports: [{ id: 'sentry', title: 'QA Engineer' }],
    goal: { id: 'G-1', title: 'Beta', description: 'Public beta by Friday' },
    ticket: { id: 'T-9', priority: 'high', title: 'Fix login', body: 'x'.repeat(20_000), verifyCommand: { command: 'npm', args: ['test'] } },
    thread: [{ author: { kind: 'board' }, text: 'it only fails in UTC' }],
    cli: 'node /opt/quorum/bin/quorum',
  })
  assert.ok(prompt.length <= 7_500)
  for (const needle of ['You are Codey, Lead Engineer at Acme.', 'You report to Atlas', 'goal G-1', 'Ticket T-9 (high priority): Fix login', 'npm test', 'board: it only fails in UTC', 'node /opt/quorum/bin/quorum say T-9', '--assign <id>', 'sentry (QA Engineer)'])
    assert.ok(prompt.includes(needle), `prompt should include ${needle}`)
})

test('avatars: only known parts survive, anything else falls back to a deterministic look', () => {
  const clean = validateAvatar({ palette: 'rose', visor: 'curve', crest: '<script>', prop: 'brush' }, 'pixel')
  assert.equal(clean.palette, 'rose')
  assert.notEqual(clean.crest, '<script>')
  assert.deepEqual(validateAvatar(null, 'pixel'), validateAvatar({}, 'pixel'))
})

test('the snapshot is what the dashboard and CLI need, with no signature material', t => {
  const { hq } = makeHq(t, { withRuntime: false })
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  hq.addGoal({ title: 'Beta' })
  const snap = hq.snapshot()
  for (const key of ['company', 'agents', 'tickets', 'channels', 'messages', 'goals', 'approvals', 'wakeups', 'activity', 'rooms', 'runtimes', 'totals'])
    assert.ok(key in snap, `snapshot has ${key}`)
  assert.equal(snap.totals.agents, 6)
  assert.equal(snap.goals[0].progress.total, 0)
  assert.ok(snap.agents[0].avatar.palette.body.startsWith('#'))
  assert.ok(!JSON.stringify(snap).includes('PRIVATE KEY'))
  assert.deepEqual(publicMessage({ id: 'm', sig: 'abc', text: 'x' }), { id: 'm', text: 'x', signed: true })
})

// ── hardening (review findings) ─────────────────────────────────────────────

test('keyed state has no prototype: "constructor" is an ordinary id and "__proto__" reaches nothing', t => {
  const { hq, build } = makeHq(t)
  hq.init({ name: 'Acme', template: 'blank', roomId: 'app' })
  hq.hire({ id: 'constructor', name: 'Con', title: 'Builder' })
  assert.equal(hq.data.agents.constructor.name, 'Con', 'an id that names an Object.prototype key is just an id')
  rejects(() => hq.ticketDetail('__proto__'), /unknown ticket/, 404)
  rejects(() => hq.updateGoal('constructor', { title: 'x' }), /unknown goal/, 404)
  rejects(() => hq.deny('toString'), /unknown approval/, 404)
  rejects(() => hq.messages('hasownproperty'), /unknown channel/, 404)
  const reborn = build()
  for (const key of ['agents', 'tickets', 'goals', 'channels', 'approvals', 'identities', 'roundtables']) assert.equal(Object.getPrototypeOf(reborn.data[key]), null, `${key} reloads without a prototype`)
  assert.equal(reborn.data.agents.constructor.name, 'Con')
})

test('an unreadable hq.json is kept byte for byte, and founding over it takes an explicit force', t => {
  const { hq, build } = makeHq(t)
  hq.init({ name: 'Acme', template: 'solo', roomId: 'app' })
  const torn = '{"company": {"name": "Acme"'
  fs.writeFileSync(hq.store.file, torn)
  const reborn = build()
  assert.equal(reborn.ready(), false)
  const { corrupt } = reborn.snapshot()
  assert.equal(corrupt.kept, true)
  assert.match(corrupt.file, /hq\.json\.corrupt-/)
  assert.equal(fs.readFileSync(corrupt.file, 'utf8'), torn, 'the unreadable company is kept exactly as found')
  rejects(() => reborn.init({ name: 'Acme Two', template: 'blank' }), /could not be read[\s\S]*--force/, 409)
  rejects(() => reborn.init({ name: 'Acme Two', template: 'blank', force: 'true' }), /--force/, 409)
  assert.equal(fs.existsSync(reborn.store.file), false, 'nothing was written in its place')
  reborn.init({ name: 'Acme Two', template: 'blank', force: true })
  assert.equal(reborn.data.company.name, 'Acme Two')
  assert.match(reborn.activity(10).filter(entry => entry.action === 'company.founded').at(-1).detail, /founded over an unreadable hq\.json kept at/)
  assert.equal(reborn.verify().corrupt.file, corrupt.file, 'verify keeps saying so')
})

test('a torn last line is cut back and kept, so the next append cannot glue onto it', t => {
  const { hq, build } = makeHq(t)
  hq.init({ name: 'Acme', template: 'solo', roomId: 'app' })
  hq.post({ channelId: 'general', text: 'before the crash' })
  fs.appendFileSync(hq.store.messagesFile, '{"id":"m-torn","text":"half a mess')
  fs.appendFileSync(hq.store.activityFile, '{"seq":999,"act')
  const reborn = build()
  reborn.post({ channelId: 'general', text: 'after the crash' })
  const report = reborn.verify()
  assert.equal(report.ok, true, 'every signature and the chain still verify')
  assert.deepEqual(report.recovered.map(item => item.file).sort(), ['activity.jsonl', 'messages.jsonl'])
  for (const item of report.recovered) assert.ok(fs.readFileSync(item.keptAt, 'utf8').length > 0, 'the fragment is kept in archive/')
  assert.deepEqual(reborn.store.messages('general', { limit: 50 }).slice(-2).map(m => m.text), ['before the crash', 'after the crash'])
})

test('ids are never reused: counters rise to the highest id the logs have named', t => {
  const { hq, build } = makeHq(t)
  hq.init({ name: 'Acme', template: 'solo', roomId: 'app' })
  hq.createTicket({ title: 'One' }, BOARD, { wake: false })
  hq.createTicket({ title: 'Two' }, BOARD, { wake: false })
  hq.addGoal({ title: 'Grow' })
  // An older hq.json (a restored backup, say) whose counters fell behind.
  const saved = JSON.parse(fs.readFileSync(hq.store.file, 'utf8'))
  saved.counters = { ticket: 0, goal: 0, approval: 0, message: 0 }
  fs.writeFileSync(hq.store.file, JSON.stringify(saved))
  const reborn = build()
  assert.equal(reborn.createTicket({ title: 'Three' }, BOARD, { wake: false }).ticket.id, 'T-3')
  assert.equal(reborn.addGoal({ title: 'Keep' }).goal.id, 'G-2')
})

test('a refused field leaves the whole update unapplied', t => {
  const { hq } = makeHq(t)
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  rejects(() => hq.updateCompany({ name: 'Renamed', roomId: 'nowhere' }), /unknown project room/)
  assert.equal(hq.data.company.name, 'Acme')
  rejects(() => hq.updateAgent('codey', { reportsTo: 'scout', autonomy: 'autonomous' }), /report no price/)
  assert.equal(hq.data.agents.codey.reportsTo, 'atlas', 'the valid half of the patch did not land either')
  const { ticket } = hq.createTicket({ title: 'Keep me' }, BOARD, { wake: false })
  rejects(() => hq.updateTicket(ticket.id, { title: 'Changed', goalId: 'G-99' }), /unknown goal/)
  assert.equal(hq.data.tickets[ticket.id].title, 'Keep me')
  const { goal } = hq.addGoal({ title: 'Grow' })
  rejects(() => hq.updateGoal(goal.id, { title: 'Shrink', status: 'someday' }), /goal status/)
  assert.equal(hq.data.goals[goal.id].title, 'Grow')
})

test('autonomy is only for a harness that prices its runs', t => {
  const { hq } = makeHq(t)
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  rejects(() => hq.updateAgent('codey', { autonomy: 'autonomous' }), /codex runs report no price/)
  rejects(() => hq.hire({ name: 'Rex', title: 'Engineer', runtime: 'codex', autonomy: 'autonomous', budgetUsd: 5 }), /report no price/)
  hq.updateAgent('pixel', { autonomy: 'autonomous' })
  rejects(() => hq.updateAgent('pixel', { runtime: 'codex' }), /report no price/)
  assert.equal(hq.data.agents.pixel.runtime, 'claude', 'switching an autonomous agent to an unpriced harness is refused')
  hq.updateAgent('pixel', { runtime: 'codex', autonomy: 'supervised' })
  assert.equal(hq.data.agents.pixel.runtime, 'codex')
  const agents = hq.snapshot().agents
  assert.equal(agents.find(a => a.id === 'pixel').priced, false)
  assert.equal(agents.find(a => a.id === 'scout').priced, true)
})

test('an agent hands on only tickets that are its to hand on, and never one the board is deciding', async t => {
  const { hq } = makeHq(t)
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  await hq.idle()
  const codey = { kind: 'agent', id: 'codey' }
  const pixels = hq.createTicket({ title: 'Design the empty state', assigneeId: 'pixel' }, BOARD, { wake: false }).ticket
  rejects(() => hq.assign(pixels.id, 'sentry', codey), /only reassign tickets they opened or that sit with their own team/, 403)
  const loose = hq.createTicket({ title: 'Loose end' }, BOARD, { wake: false }).ticket
  rejects(() => hq.assign(loose.id, 'codey', codey), /only reassign tickets/, 403)
  const own = hq.createTicket({ title: 'Regression pass' }, codey, { wake: false }).ticket
  assert.equal(hq.assign(own.id, 'sentry', codey).ticket.assigneeId, 'sentry', 'a ticket Codey opened can go to its report')
  const asked = hq.createTicket({ title: 'Cut a release', assigneeId: 'milo' }).ticket
  await hq.idle()
  assert.ok(Object.values(hq.data.approvals).some(a => a.ticketId === asked.id && a.status === 'pending'))
  rejects(() => hq.assign(asked.id, 'sentry', codey), /ask waiting on the board/, 409)
  assert.equal(hq.data.tickets[asked.id].assigneeId, 'milo')
})

test('a reply restarts only a blocked ticket; finished or parked work needs a reopen', async t => {
  const { hq } = makeHq(t)
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  await hq.idle()
  const done = hq.createTicket({ title: 'Ship it', assigneeId: 'codey' }, BOARD, { wake: false }).ticket
  hq.close(done.id)
  hq.post({ channelId: 'general', threadId: done.id, text: '@codey one more tweak' })
  await hq.idle()
  assert.equal(hq.data.tickets[done.id].status, 'done', 'a remark does not restart paid work')
  assert.equal(Object.values(hq.data.approvals).filter(a => a.ticketId === done.id).length, 0)
  assert.match(lastMessage(hq, 'general', m => m.threadId === done.id).text, /is done, so nothing was started[\s\S]*reopen/)

  const parked = hq.createTicket({ title: 'Later', assigneeId: 'pixel' }, BOARD, { wake: false }).ticket
  hq.updateTicket(parked.id, { status: 'backlog' })
  hq.post({ channelId: 'general', threadId: parked.id, text: '@pixel thoughts?' })
  await hq.idle()
  assert.equal(hq.data.tickets[parked.id].status, 'backlog')
  assert.equal(Object.values(hq.data.approvals).filter(a => a.ticketId === parked.id).length, 0)

  const stuck = hq.createTicket({ title: 'Stuck', assigneeId: 'scout' }, BOARD, { wake: false }).ticket
  hq.updateTicket(stuck.id, { status: 'blocked' })
  hq.post({ channelId: 'general', threadId: stuck.id, text: '@scout use the staging key' })
  await hq.idle()
  assert.equal(hq.data.tickets[stuck.id].status, 'todo', 'an answer is what a blocked ticket waits for')
  assert.ok(Object.values(hq.data.approvals).some(a => a.ticketId === stuck.id && a.status === 'pending'), 'and the assignee asks to try again')
  assert.ok(hq.activity(50).some(entry => entry.action === 'ticket.unblocked' && entry.target === stuck.id))
})

test('a branch room says plainly that HQ does not switch branches', t => {
  const { hq } = makeHq(t)
  hq.init({ name: 'Acme', template: 'blank', roomId: 'app' })
  hq.createChannel({ name: 'auth-rewrite', roomId: 'app', branch: 'feat/auth' })
  assert.match(lastMessage(hq, 'auth-rewrite').text, /HQ does not switch branches, so check out feat\/auth there first/)
})

test('the work prompt offers CLI callbacks only as an extra when the harness can run commands', () => {
  const text = buildWorkPrompt({ company: { name: 'Acme' }, agent: { name: 'Codey', title: 'Engineer' }, ticket: { id: 'T-1', title: 'Fix it', priority: 'normal' }, reports: [{ id: 'sentry', title: 'QA' }] })
  assert.match(text, /Finish with a short summary[\s\S]*always arrives/)
  assert.match(text, /If your harness lets you run shell commands, you can also post an update/)
  assert.match(text, /If you can run shell commands, hand follow-up work/)
})

test('the guard over an unreadable company survives restarts, and founding over it archives the old logs', t => {
  const { hq, build } = makeHq(t)
  hq.init({ name: 'Acme', template: 'solo', roomId: 'app' })
  hq.post({ channelId: 'general', text: 'from the old company' })
  fs.writeFileSync(hq.store.file, '{"company": ')
  build()
  const again = build()
  assert.equal(again.snapshot().corrupt?.earlier, true, 'a second restart still knows a company was kept aside')
  rejects(() => again.init({ name: 'Acme Two', template: 'blank' }), /--force/, 409)
  again.init({ name: 'Acme Two', template: 'blank', force: true })
  assert.ok(!again.store.messages('general', { limit: 50 }).some(m => m.text === 'from the old company'), 'the new company starts with its own history')
  const archive = fs.readdirSync(path.join(again.store.dir, 'archive')).find(name => name.startsWith('before-'))
  assert.ok(archive)
  assert.match(fs.readFileSync(path.join(again.store.dir, 'archive', archive, 'messages.jsonl'), 'utf8'), /from the old company/, 'the old history is kept, not deleted')
  assert.equal(again.verify().ok, true, 'the new logs verify on their own')
  assert.equal(build().snapshot().ready, true, 'and once founded, the guard is gone')
})

// ── routines and search ─────────────────────────────────────────────────────

test('schedules and searches parse strictly', () => {
  assert.deepEqual(['30m', '6h', '1d', '2w', 'daily', 'weekly', 90, '1.5h'].map(parseEvery), [30, 360, 1440, 20160, 1440, 10080, 90, 90])
  for (const bad of ['10m', '31d', '1x', '', 'soon', -60, null]) assert.equal(parseEvery(bad), null, `${bad} is refused`)
  assert.deepEqual([15, 60, 90, 1440, 4320, 10080].map(formatEvery), ['15m', '1h', '90m', '1d', '3d', '1w'])
  assert.deepEqual(parseSearch('flaky "auth test" in:#General from:@Codey'), { terms: ['flaky', 'auth test'], channel: 'general', author: 'codey' })
  assert.deepEqual(parseSearch('\x1b[2Jhello').terms, ['[2jhello'], 'control characters never reach a search')
})

test('a routine opens a ticket on schedule, never piles up, and is kept when retired', async t => {
  let clock = Date.UTC(2026, 8, 25, 9)
  const { hq, build } = makeHq(t, { now: () => clock })
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  await hq.idle()
  rejects(() => hq.addRoutine({ title: 'x', assigneeId: 'scout', every: '1d' }, { kind: 'agent', id: 'atlas' }), /board's decision/, 403)
  rejects(() => hq.addRoutine({ title: 'x', assigneeId: 'scout', every: '5m' }), /every 15m to 30d/)
  rejects(() => hq.addRoutine({ title: 'x', assigneeId: 'nobody', every: '1d' }), /unknown agent/, 404)
  const { routine } = hq.addRoutine({ title: 'Dependency audit', assigneeId: 'scout', every: '1d', priority: 'high' })
  assert.equal(routine.id, 'R-1')
  assert.equal(routine.every, '1d')
  assert.match(lastMessage(hq, 'general').text, /Routine R-1: every 1d[\s\S]*Scout asks you before each run/)

  await hq.tick(clock + 60_000)
  assert.equal(Object.keys(hq.data.tickets).length, 0, 'nothing before it is due')
  clock += 24 * 60 * 60_000
  await hq.tick(clock)
  await hq.idle()
  const first = hq.data.tickets[hq.data.routines['R-1'].lastTicketId]
  assert.equal(first.title, 'Dependency audit · 2026-09-26')
  assert.equal(first.assigneeId, 'scout')
  assert.equal(first.priority, 'high')
  assert.equal(first.routineId, 'R-1')
  assert.ok(Object.values(hq.data.approvals).some(a => a.ticketId === first.id && a.status === 'pending'), 'the run still asks first')

  clock += 24 * 60 * 60_000
  await hq.tick(clock)
  clock += 24 * 60 * 60_000
  await hq.tick(clock)
  assert.equal(Object.keys(hq.data.tickets).length, 1, 'no second ticket while the first is open')
  assert.equal(hq.data.routines['R-1'].skipped, 2)
  assert.equal(hq.store.messages('general', { limit: 500 }).filter(m => /skipped its turn/.test(m.text)).length, 1, 'said once, not every beat')

  hq.close(first.id)
  assert.equal(hq.runRoutine('R-1').ticket.routineId, 'R-1', 'run now fires out of schedule')
  hq.setRoutineStatus('R-1', 'pause')
  clock += 3 * 24 * 60 * 60_000
  await hq.tick(clock)
  assert.equal(hq.data.routines['R-1'].fired, 2, 'a paused routine does not fire')
  hq.setRoutineStatus('R-1', 'retire')
  rejects(() => hq.setRoutineStatus('R-1', 'resume'), /retired/, 409)
  rejects(() => hq.updateRoutine('R-1', { title: 'x' }), /retired/, 409)
  assert.equal(hq.snapshot().routines.find(r => r.id === 'R-1').status, 'retired', 'kept, not deleted')
  assert.equal(build().addRoutine({ title: 'Next', assigneeId: 'scout', every: '1w' }).routine.id, 'R-2', 'ids are never reused')
})

test('a routine follows its agent: paused when they are terminated, and `/routine` makes one from chat', async t => {
  const { hq } = makeHq(t)
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  await hq.idle()
  hq.post({ channelId: 'general', text: '/routine 1w @pixel review the empty states' })
  const routine = Object.values(hq.data.routines)[0]
  assert.equal(routine.assigneeId, 'pixel')
  assert.equal(routine.everyMinutes, 10080)
  assert.equal(routine.title, 'review the empty states')
  hq.post({ channelId: 'general', text: '/routine whenever @pixel something' })
  assert.match(lastMessage(hq, 'general').text, /every 15m to 30d/)
  rejects(() => hq.updateRoutine(routine.id, { title: 'Renamed', every: '1m' }), /every 15m to 30d/)
  assert.equal(hq.data.routines[routine.id].title, 'review the empty states', 'a refused field leaves the routine as it was')
  hq.terminate('pixel')
  assert.equal(hq.data.routines[routine.id].status, 'paused')
  assert.equal(hq.data.routines[routine.id].pausedReason, 'agent terminated')
  assert.match(lastMessage(hq, 'general').text, /Paused until someone else takes them: R-1/)
  rejects(() => hq.setRoutineStatus(routine.id, 'resume'), /terminated — hand it to someone else/, 409)
  hq.updateRoutine(routine.id, { assigneeId: 'scout' })
  assert.equal(hq.setRoutineStatus(routine.id, 'resume').routine.status, 'active')
})

test('search reads the whole history, not only what is in memory, and narrows by channel and author', async t => {
  const { hq } = makeHq(t)
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  await hq.idle()
  hq.post({ channelId: 'general', text: 'the flaky auth test is back' })
  for (let i = 0; i < 510; i += 1) hq.post({ channelId: 'general', text: `filler ${i}` })
  assert.ok(!hq.store.messages('general', { limit: 500 }).some(m => /flaky auth/.test(m.text)), 'the first message has left the in-memory window')
  const found = await hq.search('FLAKY "auth test"')
  assert.equal(found.messages.length, 1, 'but search still finds it on disk')
  assert.equal(found.messages[0].signed, true)
  assert.equal(found.messages[0].sig, undefined, 'no signature material in results')
  assert.ok(found.scanned > 500)
  const { ticket } = hq.createTicket({ title: 'Fix the flaky auth test', assigneeId: 'codey' }, BOARD, { wake: false })
  assert.deepEqual((await hq.search('flaky')).tickets.map(item => item.id), [ticket.id])
  hq.post({ channelId: 'ops', text: 'budget check for the flaky suite' })
  assert.equal((await hq.search('flaky in:#ops')).messages.length, 1)
  assert.equal((await hq.search('flaky from:board')).messages.length, 2)
  assert.equal((await hq.search('flaky from:@codey')).messages.length, 0)
  assert.match((await hq.search('flaky in:#nowhere')).note, /no #nowhere/)
  assert.equal((await hq.search('filler', { limit: 3 })).messages.length, 3, 'bounded to the newest matches')
  await assert.rejects(hq.search('   '), /search for a word/)
})

// ── routines and search: third review ───────────────────────────────────────

test('search says when it cannot honour every word, and finds agents by id, name or slug before the words for board and system', async t => {
  const { hq } = makeHq(t)
  hq.init({ name: 'Acme', template: 'blank', roomId: 'app' })
  await assert.rejects(hq.search('a b c d e f g h i j k l m'), /at most 12 words or phrases at once — this has 13/)
  hq.hire({ id: 'me', name: 'Me', title: 'Assistant' })
  hq.hire({ id: 'cx', name: 'Codex Prime', title: 'Engineer' })
  hq.post({ channelId: 'general', text: 'status from the me agent' }, { kind: 'agent', id: 'me' })
  hq.post({ channelId: 'general', text: 'rotated the signing key' }, { kind: 'agent', id: 'cx' })
  hq.post({ channelId: 'general', text: 'status from the board' })
  assert.deepEqual((await hq.search('from:@me status')).messages.map(m => m.author.id), ['me'], 'an agent called "me" is still findable')
  assert.equal((await hq.search('from:board status')).messages.length, 1)
  assert.equal((await hq.search('from:@codex-prime')).messages.length, 1, 'by the slug chat uses')
  assert.equal((await hq.search('from:"Codex Prime" signing')).messages.length, 1, 'by the name, quoted')
  assert.match((await hq.search('from:@ghost')).note, /nobody here is called ghost/)
})

test('search matches ticket ids whole and filters tickets by who opened them', async t => {
  const { hq } = makeHq(t)
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  await hq.idle()
  for (let i = 1; i <= 12; i += 1) hq.createTicket({ title: `Chore ${i}` }, BOARD, { wake: false })
  const codeys = hq.createTicket({ title: 'Chore from codey' }, { kind: 'agent', id: 'codey' }, { wake: false }).ticket
  assert.deepEqual((await hq.search('t-1')).tickets.map(ticket => ticket.id), ['T-1'], 'T-1 does not also find T-10 to T-12')
  assert.deepEqual((await hq.search('chore from:@codey')).tickets.map(ticket => ticket.id), [codeys.id])
  assert.equal((await hq.search('chore from:board')).tickets.length, 12)
})

test('a manual run or a resume never moves a routine\'s schedule', async t => {
  let clock = Date.UTC(2026, 8, 25, 9)
  const { hq } = makeHq(t, { now: () => clock })
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  await hq.idle()
  hq.addRoutine({ title: 'Weekly review', assigneeId: 'pixel', every: '1w' })
  const scheduled = hq.data.routines['R-1'].nextAt
  clock += 60 * 60_000
  hq.runRoutine('R-1')
  hq.runRoutine('R-1')
  assert.equal(hq.data.routines['R-1'].skipped, 1)
  assert.equal(hq.data.routines['R-1'].nextAt, scheduled, 'a run now, opened or skipped, leaves the schedule')
  hq.setRoutineStatus('R-1', 'resume')
  assert.equal(hq.data.routines['R-1'].nextAt, scheduled, 'resuming a running routine is not a reschedule')
})

test('a routine whose announcement fails still owns its ticket, woke its agent, and never opens a second', async t => {
  let clock = Date.UTC(2026, 8, 25, 9)
  const { hq } = makeHq(t, { now: () => clock })
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  await hq.idle()
  hq.addRoutine({ title: 'Audit A', assigneeId: 'scout', every: '1h' })
  hq.addRoutine({ title: 'Audit B', assigneeId: 'pixel', every: '1h' })
  const append = hq.store.appendMessage.bind(hq.store)
  let failed = false
  hq.store.appendMessage = message => {
    if (!failed && message.card?.type === 'ticket' && message.card.event === 'opened') { failed = true; throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) }
    return append(message)
  }
  clock += 60 * 60_000
  await hq.tick(clock)
  await hq.idle()
  const first = hq.data.tickets[hq.data.routines['R-1'].lastTicketId]
  assert.equal(first.routineId, 'R-1', 'the link was saved with the ticket')
  assert.ok(Object.values(hq.data.approvals).some(a => a.ticketId === first.id), 'its agent was woken and asked')
  assert.equal(hq.data.routines['R-2'].fired, 1, 'the other routine still had its turn in the same beat')
  assert.ok(hq.store.messages('ops', { limit: 50 }).some(m => /Routine R-1 could not fire: ENOSPC/.test(m.text)))
  clock += 60 * 60_000
  await hq.tick(clock)
  assert.equal(Object.values(hq.data.tickets).filter(t2 => t2.routineId === 'R-1').length, 1, 'no second ticket while the first is open')
})

test('a routine keeps its newest 50 closed tickets in hq.json and archives the rest, whole', async t => {
  let clock = Date.UTC(2026, 8, 1, 9)
  const { hq } = makeHq(t, { now: () => clock })
  hq.init({ name: 'Acme', template: 'studio', roomId: 'app' })
  await hq.idle()
  hq.addRoutine({ title: 'Heartbeat check', assigneeId: 'scout', every: '1h' })
  for (let i = 0; i < 55; i += 1) {
    clock += 60 * 60_000
    const { ticket } = hq.runRoutine('R-1')
    hq.close(ticket.id)
  }
  clock += 2 * 24 * 60 * 60_000
  const { ticket: last } = hq.runRoutine('R-1')
  const kept = Object.values(hq.data.tickets).filter(ticket => ticket.routineId === 'R-1')
  assert.equal(kept.filter(ticket => ticket.status === 'done').length, 50)
  assert.ok(kept.some(ticket => ticket.id === last.id), 'the open one stays')
  const archived = fs.readFileSync(path.join(hq.store.dir, 'archive', 'tickets.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(archived.map(ticket => ticket.id), ['T-1', 'T-2', 'T-3', 'T-4', 'T-5'], 'the oldest move out, nothing is deleted')
  assert.throws(() => hq.ticketDetail('T-1'), /no longer in the working set[\s\S]*archive\/tickets\.jsonl/)
  assert.equal((await hq.search('heartbeat check t-1')).messages.length > 0, true, 'its thread is still searchable')
})
