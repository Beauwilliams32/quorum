// The HQ view, rendered against a real HQ snapshot.
//
// public/hq.js builds markup from the `hq` state key. These tests found a
// company with the real service (scratch storage, fake runtime), take its
// snapshot, and run the view's builders on it — so the dashboard is held to
// the data the server actually publishes, not to a hand-made stub that could
// drift from it. Assertions are on elements and data attributes (see
// helpers/markup.mjs), never on source text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { byAttr, byClass, elements, stubNode, text } from './helpers/markup.mjs'
import { makeHq } from './helpers/hq.mjs'
import { BOARD } from '../src/hq/service.js'
import {
  activityHtml, agentHtml, avatarHtml, budgetRing, cardRestatesText, channelHeadHtml, formatText, inboxHtml, messagesHtml, onboardingHtml,
  goalsHtml, orgHtml, proposalHtml, pulseHtml, renderHqView, searchHtml, sidebarHtml, suggestions, tabsHtml, ticketHtml, ticketsHtml, typingHtml, ui, wireHq,
} from '../public/hq.js'

async function company(t) {
  const fixture = makeHq(t)
  const { hq } = fixture
  hq.init({ name: 'Acme <Robotics>', mission: 'Ship it', template: 'studio', roomId: 'app' })
  hq.addGoal({ title: 'Public beta' })
  hq.post({ channelId: 'general', text: '@codey fix the <img src=x onerror=alert(1)> login bug' })
  hq.post({ channelId: 'general', text: 'and **bold** `code` for @nobody and T-999' })
  hq.post({ channelId: 'general', text: 'second line from the board' })
  await hq.idle()
  return { ...fixture, snap: () => hq.snapshot() }
}

test('the stream escapes what people type and links only what the company knows', async t => {
  const { snap } = await company(t)
  const hq = snap()
  const html = messagesHtml(hq, { channel: 'general' })
  assert.ok(!/<img/i.test(html), 'typed markup is text, never elements')
  assert.match(text(html), /fix the <img src=x onerror=alert\(1\)> login bug/)
  const mentions = byClass(html, 'hq-mention')
  assert.ok(mentions.some(el => el.dataset.hqAgent === 'codey'))
  assert.ok(!mentions.some(el => el.dataset.hqAgent === 'nobody'), '@nobody is not a member')
  assert.ok(!byAttr(html, 'data-hq-ticket', 'T-999').length, 'an unknown ticket id stays text')
  assert.ok(elements(html).some(el => el.tag === 'b'), 'bold is rendered')
  assert.ok(elements(html).some(el => el.tag === 'code'), 'inline code is rendered')
  assert.ok(byClass(html, 'hq-signed').length > 0, 'signed messages say so')
})

test('consecutive messages from one author group; a ticket card is live and points at the inbox when it waits on you', async t => {
  const { snap } = await company(t)
  const hq = snap()
  const html = messagesHtml(hq, { channel: 'general' })
  const board = byClass(html, 'hq-msg', 'author-board')
  assert.ok(board.some(el => el.classes.has('grouped')), 'the second board line joins the first')
  const card = byClass(html, 'hq-card-ticket')[0]
  assert.ok(card.dataset.hqTicket.startsWith('T-'))
  assert.ok(byClass(html, 'hq-card-waiting').length === 1, 'the pending approval shows as a chip on the ticket')
  const approve = byAttr(html, 'data-hq-approve')
  assert.equal(approve.length, 1, 'approve lives on the approval message itself, once')
  assert.ok(byAttr(html, 'data-hq-deny', approve[0].dataset.hqApprove).length === 1)
})

test('the rail: channels without DMs, the team with presence, and the inbox count when something waits', async t => {
  const { snap } = await company(t)
  const hq = snap()
  const html = sidebarHtml(hq, { channel: 'general', panel: 'org' })
  assert.deepEqual(byAttr(html, 'data-hq-channel').map(el => el.dataset.hqChannel), ['general', 'decisions', 'ops'])
  assert.equal(byAttr(html, 'data-hq-dm').length, 6)
  const codey = byAttr(html, 'data-hq-dm', 'codey')[0]
  assert.ok(codey, 'every teammate is one click from a DM')
  assert.ok(byClass(html, 'hq-avatar', 'presence-waiting').length >= 1, 'codey is waiting on the board')
  assert.ok(byClass(html, 'hq-count', 'attention').length === 1)
  assert.match(text(html), /Acme <Robotics>/, 'the company name is escaped text')
})

/** The markup of the <li> that holds `id`'s node, children included. */
function subtreeOf(html, id) {
  const at = html.indexOf(`data-hq-agent="${id}"`)
  const start = html.lastIndexOf('<li>', at)
  const tags = /<\/?li>/g
  tags.lastIndex = start
  let depth = 0
  for (let match; (match = tags.exec(html));) {
    depth += match[0] === '<li>' ? 1 : -1
    if (depth === 0) return html.slice(start, match.index + match[0].length)
  }
  return ''
}

test('the org chart nests by reportsTo under the board', async t => {
  const { snap } = await company(t)
  const html = orgHtml(snap())
  assert.deepEqual(byClass(html, 'hq-org-node').map(el => el.dataset.hqAgent), ['atlas', 'scout', 'codey', 'sentry', 'milo', 'pixel'])
  const codey = subtreeOf(html, 'codey')
  assert.ok(codey.includes('data-hq-agent="sentry"') && codey.includes('data-hq-agent="milo"'), "codey's reports sit under codey")
  assert.ok(!codey.includes('data-hq-agent="pixel"'), 'pixel reports to atlas, not codey')
  assert.ok(subtreeOf(html, 'atlas').includes('data-hq-agent="pixel"'))
  assert.match(text(html), /The board/)
})

test('budget rings draw the share of the cap and say what they cannot see', () => {
  const half = budgetRing({ state: 'warn', pct: 85, spentUsd: 8.5, limitUsd: 10, unpricedRuns: 2 })
  const arc = byClass(half, 'hq-ring-arc')[0]
  assert.equal(arc.attrs['stroke-dasharray'], '85 100')
  assert.ok(byClass(half, 'hq-ring', 'state-warn').length === 1)
  assert.match(text(half), /2 unpriced run\(s\) not counted/)
  assert.ok(byClass(budgetRing({ state: 'ok', pct: 0, spentUsd: 0, limitUsd: 5 }), 'is-empty').length === 1)
  assert.equal(byClass(budgetRing({ state: 'over', pct: 240 }), 'hq-ring-arc')[0].attrs['stroke-dasharray'], '100 100', 'capped at a full ring')
  assert.match(text(budgetRing({ state: 'uncapped', pct: 0, spentUsd: 3 })), /no cap/)
})

test('an agent profile offers what its status allows', async t => {
  const { hq, snap } = await company(t)
  let html = agentHtml(snap(), { agentId: 'codey' })
  const actions = () => byAttr(html, 'data-hq-action').map(el => el.dataset.hqAction)
  assert.ok(actions().includes('pause') && actions().includes('wake') && !actions().includes('resume'))
  hq.pause('codey')
  html = agentHtml(snap(), { agentId: 'codey' })
  assert.ok(actions().includes('resume') && !actions().includes('pause'))
  hq.terminate('milo')
  html = agentHtml(snap(), { agentId: 'milo' })
  assert.ok(!actions().includes('terminate'), 'a terminated agent cannot be terminated twice')
  assert.equal(byClass(agentHtml(snap(), { agentId: 'codey' }), 'hq-budget-form').length, 1)
})

test('a ticket offers Start run only when nothing holds it; a live run offers Cancel instead', async t => {
  const { hq, snap } = await company(t)
  const ticket = Object.values(hq.data.tickets)[0]
  let html = ticketHtml(snap(), { ticketId: ticket.id })
  let actions = byAttr(html, 'data-hq-action').map(el => el.dataset.hqAction)
  assert.ok(actions.includes('dispatch') && !actions.includes('cancel-run'))
  const approval = Object.values(hq.data.approvals).find(item => item.ticketId === ticket.id)
  await hq.approve(approval.id, BOARD)
  html = ticketHtml(snap(), { ticketId: ticket.id })
  actions = byAttr(html, 'data-hq-action').map(el => el.dataset.hqAction)
  assert.ok(actions.includes('cancel-run') && !actions.includes('dispatch') && !actions.includes('close'))
  assert.ok(byClass(html, 'hq-run').length === 1)
})

test('presence drives the typing line and the pulse — nothing is shown working that is not', async t => {
  const { hq, snap } = await company(t)
  assert.equal(typingHtml(snap(), { channel: 'general' }), '')
  const ticket = Object.values(hq.data.tickets)[0]
  await hq.approve(Object.values(hq.data.approvals).find(item => item.ticketId === ticket.id).id)
  const typing = typingHtml(snap(), { channel: 'general' })
  assert.match(text(typing), /Codey is working on T-\d+/)
  assert.equal(typingHtml(snap(), { channel: 'ops' }), '', 'only in the channel the ticket lives in')
  assert.ok(byClass(pulseHtml(snap()), 'hq-stat', 'live').length === 1)
})

test('the ticket board groups by status and the inbox lists what waits on you', async t => {
  const { snap } = await company(t)
  const board = ticketsHtml(snap())
  assert.ok(byClass(board, 'hq-col', 'status-todo').length === 1)
  assert.ok(byAttr(board, 'data-hq-ticket').length >= 1)
  const inbox = inboxHtml(snap())
  assert.equal(byAttr(inbox, 'data-hq-approve').length, 1)
})

test('the channel header shows a DM as a person and a branch room as a branch', async t => {
  const { hq, snap } = await company(t)
  const dm = channelHeadHtml(snap(), { channel: 'dm-pixel' })
  assert.match(text(dm), /Pixel Product Designer/)
  hq.createChannel({ name: 'feat-auth', roomId: 'app', branch: 'feat/auth' })
  const branch = channelHeadHtml(snap(), { channel: 'feat-auth' })
  assert.ok(byClass(branch, 'hq-chip', 'branch').length === 1)
  assert.match(text(branch), /feat\/auth/)
})

test('founding: templates to pick from, the first chosen, rooms escaped', () => {
  const html = onboardingHtml({ ready: false, templates: [{ id: 'studio', label: 'Studio', summary: 's', agents: [{ name: 'Atlas', title: 'Chief' }] }, { id: 'blank', label: 'Blank', summary: 'b', agents: [] }], rooms: [{ id: 'x', label: '<script>' }] })
  const radios = elements(html).filter(el => el.tag === 'input' && el.attrs.type === 'radio')
  assert.deepEqual(radios.map(el => el.attrs.value), ['studio', 'blank'])
  assert.ok('checked' in radios[0].attrs && !('checked' in radios[1].attrs))
  assert.ok(!/<script>/.test(html))
})

test('the composer suggests teammates for @ and commands for /', async t => {
  const { snap } = await company(t)
  const hq = snap()
  const people = suggestions('ask @co', 7, hq)
  assert.deepEqual(people.map(item => item.insert), ['@codey '])
  const commands = suggestions('/con', 4, hq)
  assert.deepEqual(commands.map(item => item.label), ['/convene'])
  assert.deepEqual(suggestions('plain text', 10, hq), [])
})

test('text formatting: fenced code stays literal, and avatars carry their presence', () => {
  const html = formatText('run this:\n```sh\nnpm test && echo "<ok>"\n```\ndone', new Set(), new Set())
  const pre = elements(html).find(el => el.tag === 'pre')
  assert.ok(pre)
  assert.match(text(html), /npm test && echo "<ok>"/)
  const avatar = avatarHtml({ id: 'a', name: 'A', title: 't', presence: { state: 'working' }, avatar: { palette: { body: '#111111', trim: '#222222', glow: '#333333' }, visor: 'dot', crest: 'spark', prop: 'wrench' } }, 30)
  assert.ok(byClass(avatar, 'hq-avatar', 'presence-working').length === 1)
})

test('a system message keeps its words unless its card says the same thing', async t => {
  const { hq, snap } = await company(t)
  hq.hire({ name: 'Nova', title: 'Content Lead', runtime: 'claude' })
  const html = messagesHtml(snap(), { channel: 'general' })
  assert.match(text(html), /Hired Nova as Content Lead/, 'a hire is announced in words')
  assert.ok(byClass(html, 'hq-card-agent').some(el => el.dataset.hqAgent === 'nova'), 'and introduces the new pet')
  assert.equal(cardRestatesText({ type: 'convene', event: 'verdict' }), false, 'a verdict keeps its body')
  assert.equal(cardRestatesText({ type: 'approval' }), false, 'a denial keeps its reason')
  assert.equal(cardRestatesText({ type: 'ticket', event: 'opened' }), true)
  assert.equal(cardRestatesText({ type: 'ticket', event: 'assigned' }), false, 'who it went to is in the text')
})

// ── hardening (review findings) ─────────────────────────────────────────────

test('the activity panel escapes every value it prints, numbers included', () => {
  const hostile = '<img src=x onerror=alert(1)>'
  const html = activityHtml({ activity: [{ seq: hostile, at: '2026-09-25T10:00:00Z', actor: { kind: 'board' }, action: 'x', target: hostile, detail: hostile }] }, {
    verify: { ok: false, messages: { failed: [1], verified: 0 }, activity: { total: 1, brokenAt: hostile }, recovered: [{ file: hostile, bytes: 3, keptAt: hostile }], corrupt: { file: hostile, error: 'x' } },
  })
  assert.ok(!/<img/i.test(html), 'nothing from the log becomes an element')
  assert.match(text(html), /chain broken at #<img/)
  assert.match(text(html), /recovered a torn last line/)
})

test('autonomy is offered only on a harness that prices its runs', async t => {
  const { snap } = await company(t)
  const codey = agentHtml(snap(), { agentId: 'codey' })
  assert.ok(!byAttr(codey, 'data-hq-action', 'toggle-autonomy').length, 'codex reports no price, so no toggle')
  assert.match(text(codey), /codex runs report no price, so a cap cannot see them/)
  assert.equal(byAttr(agentHtml(snap(), { agentId: 'pixel' }), 'data-hq-action', 'toggle-autonomy').length, 1)
})

test('founding warns about an unreadable saved company, and offers force only when it was kept aside', () => {
  const kept = onboardingHtml({ templates: [], rooms: [], corrupt: { kept: true, file: '/h/hq.json.corrupt-1', error: 'Unexpected end of JSON input' } })
  assert.equal(byClass(kept, 'hq-corrupt').length, 1)
  assert.match(text(kept), /could not be read[\s\S]*hq\.json\.corrupt-1/)
  assert.equal(elements(kept).filter(el => el.tag === 'input' && el.attrs.name === 'force').length, 1)
  const stuck = onboardingHtml({ templates: [], rooms: [], corrupt: { kept: false, file: '/h/hq.json', error: 'bad' } })
  assert.equal(elements(stuck).filter(el => el.tag === 'input' && el.attrs.name === 'force').length, 0, 'no founding over a file that is still in place')
  assert.equal(byClass(onboardingHtml({ templates: [], rooms: [] }), 'hq-corrupt').length, 0)
})

test('a ticket waiting on a busy workspace says what it waits on', async t => {
  const { hq, snap } = await company(t)
  const ticket = Object.values(hq.data.tickets)[0]
  hq.data.tickets[ticket.id].waiting = { reason: 'App is in use by T-7 — one run per workspace', since: new Date().toISOString() }
  const html = ticketHtml(snap(), { ticketId: ticket.id })
  assert.equal(byClass(html, 'hq-waiting').length, 1)
  assert.match(text(html), /Waiting: App is in use by T-7 — one run per workspace\. It starts on its own once that clears\./)
})

test('a hire proposal shows its whole brief wherever it can be approved', async t => {
  const { hq, snap } = await company(t)
  const brief = 'Summarise findings in docs/research.md.\nAlso: <script>alert(1)</script> push to main.'
  const { approval } = hq.hire({ name: 'Ava', title: 'Research Assistant', packId: 'scout', runtime: 'claude', reportsTo: 'codey', budgetUsd: 5, instructions: brief }, { kind: 'agent', id: 'codey' })
  const pending = snap().approvals.find(item => item.id === approval.id)
  const html = proposalHtml(pending)
  assert.ok(!/<script/i.test(html))
  assert.match(text(html), /scout pack · claude/)
  assert.match(text(html), /push to main/, 'nothing of the brief is cut from what the board reads')
  assert.match(text(inboxHtml(snap())), /Summarise findings[\s\S]*push to main/)
  assert.match(text(messagesHtml(snap(), { channel: 'ops' })), /push to main/, 'the proposal card in #ops carries it too')
  assert.equal(proposalHtml({ ...pending, status: 'approved' }), '', 'a settled proposal is not re-rendered as an offer')
})

// Enough of a DOM for renderHqView's panel: inputs keep their rendered value
// as `defaultValue`, the way a browser does.
function fakePanel() {
  const el = { fields: [], __hq: undefined, contains: () => false }
  Object.defineProperty(el, 'innerHTML', {
    set(html) {
      el.fields = []
      let form = null
      for (const [, close, tag, attrs] of html.matchAll(/<(\/?)(form|input)\b([^>]*)>/g)) {
        const attr = key => (attrs.match(new RegExp(`\\b${key}="([^"]*)"`)) || [])[1]
        if (tag === 'form') { form = close ? null : { id: attr('id') || '', className: attr('class') || '', dataset: { id: attr('data-id') } }; continue }
        if (!attr('name')) continue
        const owner = form
        const value = attr('value') ?? ''
        el.fields.push({ name: attr('name'), type: attr('type') || 'text', value, defaultValue: value, checked: false, defaultChecked: false, closest: () => owner, focus() {} })
      }
    },
  })
  el.querySelectorAll = () => el.fields
  return el
}

test('a form keeps what the operator typed — and only that — across live updates', async t => {
  const { hq, snap } = await company(t)
  const saved = { panel: ui.panel, agentId: ui.agentId }
  t.after(() => Object.assign(ui, saved))
  const panel = fakePanel()
  const doc = { getElementById: id => (id === 'hq-panel-body' ? panel : id === 'view-hq' ? { classList: { toggle() {} } } : null) }
  const cap = () => panel.fields.find(field => field.name === 'monthlyUsd')
  Object.assign(ui, { panel: 'agent', agentId: 'pixel' })
  const render = () => renderHqView({ hq: JSON.parse(JSON.stringify(snap())) }, doc)
  render()
  assert.equal(cap().value, '15')
  hq.updateAgent('pixel', { budget: { monthlyUsd: 40 } })
  render()
  assert.equal(cap().value, '40', 'an untouched field shows the cap as it is now, not as it was')
  cap().value = '55'
  hq.updateAgent('pixel', { heartbeat: { enabled: true } })
  render()
  assert.equal(cap().value, '55', 'what the operator is typing survives an update')
})

test('routines sit under goals: one row each, actions by status, the add form offers live agents only', async t => {
  const { hq, snap } = await company(t)
  hq.addRoutine({ title: 'Audit <deps>', assigneeId: 'scout', every: '1d' })
  hq.addRoutine({ title: 'Weekly review', assigneeId: 'pixel', every: '1w' })
  hq.setRoutineStatus('R-2', 'pause')
  hq.terminate('milo')
  const html = goalsHtml(snap())
  assert.equal(byClass(html, 'hq-routine').length, 2)
  assert.ok(!/<deps>/.test(html), 'titles are text')
  const actions = id => byAttr(html, 'data-id', id).map(el => el.dataset.hqAction)
  assert.deepEqual(actions('R-1'), ['routine-run', 'routine-pause', 'routine-retire'])
  assert.deepEqual(actions('R-2'), ['routine-resume', 'routine-retire'])
  const options = elements(html).filter(el => el.tag === 'option' && el.attrs.value && !/^\d/.test(el.attrs.value)).map(el => el.attrs.value)
  assert.ok(options.includes('scout') && !options.includes('milo'), 'a terminated agent is not offered')
  assert.match(text(html), /every 1d[\s\S]*every 1w/)
})

test('search results link each hit to its thread or channel, with the terms marked and everything escaped', () => {
  const hq = { agents: [{ id: 'codey', name: 'Codey' }] }
  const result = {
    query: { terms: ['flaky'] },
    tickets: [{ id: 'T-4', title: 'Fix the flaky <b>auth</b> test', status: 'todo' }],
    messages: [
      { id: 'm1', channelId: 'general', threadId: null, author: { kind: 'board' }, text: 'is the flaky test back?', at: '2026-09-25T10:00:00Z' },
      { id: 'm2', channelId: 'general', threadId: 'T-4', author: { kind: 'agent', id: 'codey' }, text: 'Flaky again <script>x</script>', at: '2026-09-25T11:00:00Z' },
    ],
    scanned: 812,
  }
  const html = searchHtml(hq, { search: { q: 'flaky', result } })
  assert.ok(!/<script|<b>auth/.test(html), 'what people typed stays text')
  assert.equal(elements(html).filter(el => el.tag === 'mark').length, 3)
  const hits = byClass(html, 'hq-search-hit')
  assert.equal(hits[0].dataset.hqTicket, 'T-4', 'newest first, and a thread reply opens its ticket')
  assert.equal(hits[1].dataset.hqChannel, 'general', 'a channel message opens its channel')
  assert.match(text(html), /812 searched/)
  assert.match(text(searchHtml(hq, { search: { q: 'x', error: 'search for a word' } })), /search for a word/)
  assert.match(tabsHtml({ panel: 'search' }), /Search/)
})

test('overlapping search terms mark the longest match whole', () => {
  const html = searchHtml({ agents: [] }, { search: { q: 'auth authentication', result: { query: { terms: ['auth', 'authentication'] }, tickets: [], messages: [{ id: 'm', channelId: 'general', author: { kind: 'board' }, text: 'authentication broke', at: '2026-09-25T10:00:00Z' }] } } })
  assert.match(html, /<mark>authentication<\/mark> broke/)
})

test('a routine whose agent was terminated offers to hand it to someone live', async t => {
  const { hq, snap } = await company(t)
  hq.addRoutine({ title: 'Release notes', assigneeId: 'milo', every: '1w' })
  assert.equal(byClass(goalsHtml(snap()), 'hq-routine-assign').length, 0, 'not while its agent is live')
  hq.terminate('milo')
  const form = byClass(goalsHtml(snap()), 'hq-routine-assign')
  assert.equal(form.length, 1)
  assert.equal(form[0].dataset.id, 'R-1')
  const options = elements(goalsHtml(snap())).filter(el => el.tag === 'option' && el.attrs.value === 'milo')
  assert.equal(options.length, 0, 'the terminated agent is not offered')
})

test('only the newest search fills the panel, however late an older one answers', async t => {
  const saved = { panel: ui.panel, search: ui.search }
  const realFetch = globalThis.fetch
  const realFormData = globalThis.FormData
  t.after(() => { Object.assign(ui, saved); globalThis.fetch = realFetch; globalThis.FormData = realFormData })
  const root = stubNode()
  const box = stubNode({ value: '' })
  const doc = { getElementById: id => (id === 'view-hq' ? root : id === 'hq-search-input' ? box : null) }
  globalThis.FormData = class { entries() { return [][Symbol.iterator]() } }
  const pending = new Map()
  globalThis.fetch = url => new Promise(resolve => {
    const q = new URL(url, 'http://x').searchParams.get('q')
    pending.set(q, () => resolve({ ok: true, json: async () => ({ query: { terms: [q] }, messages: [], tickets: [], scanned: 1 }) }))
  })
  wireHq({ S: { hq: { ready: true } }, rerender: () => {}, setView: () => {}, doc })
  const submit = root.listeners.submit[0]
  const form = { id: 'hq-search', classList: { contains: () => false } }
  box.value = 'alpha'
  const first = submit({ target: form, preventDefault() {} })
  box.value = 'beta'
  const second = submit({ target: form, preventDefault() {} })
  pending.get('beta')()
  await second
  pending.get('alpha')()
  await first
  assert.equal(ui.search.q, 'beta')
})
