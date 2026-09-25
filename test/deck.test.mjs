import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { byAttr, byClass, elements, stubDocument, stubNode, text } from './helpers/markup.mjs'
import { ROOT, readCss, parseCss, declared, declares } from './helpers/stylesheet.mjs'

/* Deck = the 3D command room. Until 2026-09-22 this file asserted that
 * public/app.js CONTAINED the strings `function renderDeck()`, `S.projects
 * ?.rooms`, `selectSession(` and that public/style.css CONTAINED `perspective:`
 * — none of which proves the deck renders anything, and all of which break on a
 * restyle. It now runs the real renderer against stub state and asserts on the
 * elements it produces, and reads the stylesheet as parsed rules. */

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
const styleRules = parseCss(readCss('public/style.css'))

/* Lift the deck renderers out of app.js — which is one browser script with no
 * module boundary — and drive them against stubs, the same approach as
 * chat-send.test.mjs and composio-render.test.mjs. */
function loadDeck(S, { ws = { readyState: 1 } } = {}) {
  const start = app.indexOf('function renderDeck() {')
  const end = app.indexOf('/* ── runtimes + models come from config')
  assert.ok(start > 0 && end > start, 'deck section not found in public/app.js')
  const section = app.slice(start, end)
  const writeIfChangedSrc = (() => {
  const at = app.indexOf('function writeIfChanged(')
  assert.ok(at > 0, 'writeIfChanged not found in public/app.js')
  return app.slice(at, app.indexOf('\n}\n', at) + 3)
})()
const esc = app.match(/^const esc = .*$/m)
  const gb = app.match(/^const gb = .*$/m)
  const row = app.match(/^const row = .*$/m)
  assert.ok(esc && gb && row, 'esc/gb/row helpers not found in public/app.js')

  const { $, nodes } = stubDocument({ drawer: stubNode() })
  const calls = { city: [], sent: [], views: [], sessions: [], chats: [], focused: [], running: [], cityControls: 0 }

  // three.js now arrives through a dynamic import the first time the Deck is
  // opened, so the deck talks to the city module through `withCity` rather
  // than a static binding. The stub stands in for a module that has loaded.
  const factory = new Function(
    '$', 'S', 'ws', 'send', 'setView', 'selectSession', 'selectChat',
    'withCity', 'renderCityControls', 'selectCityEntity', 'fetch',
    `${esc[0]}\n${gb[0]}\n${row[0]}\n${writeIfChangedSrc}\n${section}\n` +
    'return { renderDeck, renderDeckDetail, renderDeckSessions, selectDeckProject, selectDeckAgent }')

  const api = factory(
    $, S, ws,
    message => calls.sent.push(message),
    view => calls.views.push(view),
    (...args) => calls.sessions.push(args),
    id => calls.chats.push(id),
    fn => fn({
      updateAgentCity: (model, options) => calls.city.push({ model, options }),
      focusCityEntity: id => calls.focused.push(id),
      setCityRunning: on => calls.running.push(on),
    }),
    () => { calls.cityControls++ },
    () => {},
    async () => ({ ok: true, json: async () => ({}) }))

  return { ...api, $, nodes, calls }
}

const room = (id, extra = {}) => ({ id, label: id.toUpperCase(), cwd: `/w/${id}`, active: false, agents: [], ...extra })
const agent = (sessionId, extra = {}) => ({ sessionId, name: `agent-${sessionId}`, projectId: 'portal', status: 'idle', ...extra })

function state(overrides = {}) {
  return {
    projects: { rooms: [room('portal', { active: true, agents: ['claude'] }), room('nil')] },
    agents: { agents: [agent('a1'), agent('a2', { status: 'busy' })] },
    sessions: { cards: [{ file: '/s/1.jsonl', agent: 'claude', cwd: '/w/portal', projectId: 'portal', active: true, summary: 'shipping' }] },
    system: { freeMB: 4096, load: 1.2, totalMB: 24576 },
    processes: { procs: [] },
    memory: null,
    terms: new Map(),
    deckSelection: { kind: null, id: null },
    ...overrides,
  }
}

test('Deck view exposes the 3D command-room surfaces', () => {
  for (const id of ['view-deck', 'deck-space', 'deck-nodes', 'deck-detail', 'deck-sessions']) {
    assert.match(html, new RegExp(`id=["']${id}["']`))
  }
  assert.match(html, /data-view=["']deck["']/)
})

test('renderDeck turns live state into addressable project and agent nodes', () => {
  const S = state()
  const deck = loadDeck(S)
  deck.renderDeck()

  const markup = deck.$('deck-nodes').innerHTML
  const projects = byClass(markup, 'deck-node', 'project')
  const agents = byClass(markup, 'deck-node', 'agent')
  assert.equal(projects.length, 2, 'one node per room')
  assert.equal(agents.length, 2, 'one node per agent')

  // Every node carries the identity the click handler reads back.
  assert.deepEqual(projects.map(n => n.dataset.id).sort(), ['nil', 'portal'])
  assert.deepEqual(projects.map(n => n.dataset.kind), ['project', 'project'])
  assert.deepEqual(agents.map(n => n.dataset.id).sort(), ['a1', 'a2'])
  assert.ok(projects.every(n => n.attrs.tabindex === '0'), 'nodes are keyboard reachable')

  // Position is data, not decoration: the 3D placement rides custom properties.
  for (const node of [...projects, ...agents]) {
    for (const prop of ['--x', '--y', '--z']) {
      const length = node.styleProps[prop] || ''
      assert.match(length, /px$/, `${prop} is a length`)
      assert.ok(Number.isFinite(Number.parseFloat(length)), `${prop} is a number`)
    }
  }

  // Live state reaches the node as a class, and its label as text.
  assert.ok(byClass(markup, 'deck-node', 'project', 'active').some(n => n.dataset.id === 'portal'))
  assert.ok(byClass(markup, 'deck-node', 'agent', 'busy').some(n => n.dataset.id === 'a2'))
  assert.match(text(markup), /PORTAL/)
})

test('the deck feeds the 3D city the same model it draws nodes from', () => {
  const S = state()
  const deck = loadDeck(S)
  deck.renderDeck()

  assert.equal(deck.calls.city.length, 1)
  const model = deck.calls.city[0].model
  assert.equal(model.buildings.length, 2)
  assert.equal(model.characters.length, 2)
  assert.equal(typeof deck.calls.city[0].options.onSelect, 'function')
  assert.equal(deck.calls.cityControls, 1)

  // The readouts are live numbers, not placeholders.
  assert.match(deck.$('deck-count').textContent, /2 rooms · 2 agents/)
  assert.match(deck.$('deck-connection').textContent, /CONNECTED/)
  const stats = byClass(deck.$('deck-stats').innerHTML, 'deck-stat')
  assert.equal(stats.length, 7)
  assert.match(text(deck.$('deck-stats').innerHTML), /rooms/)
})

test('a disconnected socket says so rather than showing a live link', () => {
  const S = state()
  const deck = loadDeck(S, { ws: { readyState: 3 } })
  deck.renderDeck()
  assert.match(deck.$('deck-connection').textContent, /RECONNECTING/)
  assert.match(text(deck.$('deck-stats').innerHTML), /wait/)
})

test('Deck actions are wired to the CLI and the transcript, not just rendered', () => {
  const S = state()
  const deck = loadDeck(S)
  deck.renderDeck()

  // Selecting a project opens its detail panel with the seat buttons.
  deck.selectDeckProject('portal')
  assert.deepEqual(S.deckSelection, { kind: 'project', id: 'portal' })
  const actions = deck.$('deck-actions').innerHTML
  const seats = byAttr(actions, 'data-deck-action', 'seat')
  assert.ok(seats.length >= 2, 'the detail panel offers agent seats')
  assert.deepEqual(seats.map(s => s.dataset.profile).sort(), ['claude', 'codex'])

  // A seat button spawns a real PTY for that room.
  const button = stubNode({ dataset: { deckAction: 'seat', profile: 'claude' } })
  deck.$('deck-actions').querySelectorAll = () => [button]
  deck.renderDeckDetail()
  button.onclick()
  const create = deck.calls.sent.find(m => m.type === 'pty.create')
  assert.ok(create, 'a seat button sends pty.create')
  assert.equal(create.profile, 'claude')
  assert.equal(create.cwd, '/w/portal')

  // Selecting an agent routes to the chat composer.
  deck.selectDeckAgent('a1')
  assert.deepEqual(deck.calls.chats, ['a1'])
})

test('deck sessions are clickable and carry the identifiers the radar needs', () => {
  const S = state()
  const deck = loadDeck(S)
  const item = stubNode({ dataset: { file: '/s/1.jsonl', agent: 'claude', cwd: '/w/portal' } })
  deck.$('deck-sessions').querySelectorAll = () => [item]
  deck.renderDeckSessions()

  const rendered = byClass(deck.$('deck-sessions').innerHTML, 'deck-session')
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].dataset.file, '/s/1.jsonl')
  assert.equal(deck.$('deck-session-count').textContent, '1')

  item.ondblclick()
  assert.deepEqual(deck.calls.sessions.at(-1), ['/s/1.jsonl', 'claude', '/w/portal'])
  assert.deepEqual(deck.calls.views.at(-1), 'radar')
})

test('Deck styling is genuinely 3D and remains interactive', () => {
  assert.ok(declared(styleRules, '#deck-space', 'perspective').length > 0, 'the stage has depth')
  assert.ok(declared(styleRules, '#deck-nodes', 'transform-style').includes('preserve-3d'))
  assert.ok(declares(styleRules, '.deck-node', 'transform'), 'nodes are positioned in 3D')
  assert.ok(declares(styleRules, '.deck-node', 'cursor'), 'nodes read as clickable')
  assert.ok(declares(styleRules, '.deck-node:hover', 'transform'), 'hover has a response')

  // Nothing in the deck may hardcode a colour — see test/style.test.mjs for the
  // whole-sheet rule; this is the local guard for the surfaces above.
  for (const selector of ['#deck-space', '.deck-node', '.deck-node:hover', '.deck-node.selected']) {
    for (const [, value] of styleRules.filter(r => r.selectors.includes(selector)).flatMap(r => r.declarations)) {
      assert.doesNotMatch(value, /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/, `${selector} uses tokens`)
    }
  }
})

test('every element the deck renderer writes into exists in the shipped markup', () => {
  // The renderer addresses nodes by id. If the markup drops one, the deck
  // silently half-renders — so the two sides are checked against each other.
  const start = app.indexOf('function renderDeck() {')
  const end = app.indexOf('/* ── runtimes + models come from config')
  const ids = new Set([...app.slice(start, end).matchAll(/\$\('([a-z0-9-]+)'\)/g)].map(m => m[1]))
  assert.ok(ids.size >= 8, 'the deck addresses a real set of elements')
  const declaredIds = new Set(elements(html).map(el => el.attrs.id).filter(Boolean))
  const missing = [...ids].filter(id => id !== 'drawer' && !declaredIds.has(id))
  assert.deepEqual(missing, [], 'renderDeck writes into elements that do not exist')
})

/* The deck is fed by nine collector keys — system every 2s, processes every
 * 2.5s, projects and agents every 2s, city every ~5s — and each one used to
 * rebuild the whole node field with innerHTML and re-wire every handler in it,
 * whether or not a single character of the markup had changed. */
test('an unchanged deck is not rebuilt, and a changed one still is', () => {
  const S = state()
  const deck = loadDeck(S)

  deck.renderDeck()
  const nodes = deck.$('deck-nodes')
  const first = nodes.innerHTML
  assert.ok(byClass(first, 'deck-node').length > 0, 'the first render draws the field')

  let writes = 0
  let current = first
  Object.defineProperty(nodes, 'innerHTML', {
    get: () => current,
    set: value => { writes += 1; current = value },
  })

  for (let i = 0; i < 12; i++) deck.renderDeck()
  assert.equal(writes, 0, 'twelve ticks with nothing new wrote no markup')
  assert.equal(nodes.innerHTML, first, 'and the field is still there')

  // A room going active is a real change and must land.
  S.projects.rooms[1].active = true
  deck.renderDeck()
  assert.equal(writes, 1, 'a real change is written exactly once')
  assert.equal(byClass(nodes.innerHTML, 'deck-node', 'project', 'active').length, 2)
})
