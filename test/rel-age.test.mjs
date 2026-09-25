import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { elements, stubDocument, stubNode } from './helpers/markup.mjs'
import { ROOT } from './helpers/stylesheet.mjs'

/* Relative ages ("3m", "2h ago") are a pure function of the wall clock. Until
 * 2026-09-22 the only thing that re-ran them was the render storm — every
 * collector tick re-ran every renderer — and the performance pass removed that
 * storm: `State#publish` sends nothing at all when a key's payload is
 * byte-identical, and a transcript that has stopped being written keeps the
 * same `mtimeMs` forever. The labels froze, and a cockpit that says "1m" for a
 * session that went quiet four minutes ago is claiming to be fresher than it
 * is.
 *
 * These tests drive the real helpers and the real renderers, the same way
 * test/deck.test.mjs and test/state-transport.test.mjs lift sections out of
 * public/app.js — there is no module boundary in a no-build browser script. */

const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')

function slice(from, to, what) {
  const start = app.indexOf(from)
  const end = app.indexOf(to, start + 1)
  assert.ok(start > 0 && end > start, `${what} not found in public/app.js`)
  return app.slice(start, end)
}

/** A live element the ticker can rewrite, counting the writes it really makes. */
function liveElement(el) {
  let textContent = ''
  const node = {
    tag: el.tag,
    attrs: el.attrs,
    dataset: el.dataset,
    writes: 0,
    get textContent() { return textContent },
    set textContent(value) { textContent = value; node.writes += 1 },
  }
  return node
}

/**
 * Lift the age-label block and run it against a stub clock, a stub document
 * and a stub `setInterval`, so nothing here leaves a live timer behind — CI is
 * Linux and the suite must not depend on a timer staying alive.
 */
function loadAges() {
  const block = slice('/* ── age labels that stay honest', 'function writeIfChanged(', 'the age-label block')
  const escLine = app.match(/^const esc = .*$/m)
  const relSrc = slice('const rel = ms => {', '\nconst gb =', 'the rel() helper')
  assert.ok(escLine, 'esc helper not found in public/app.js')

  let clock = Date.parse('2026-09-22T12:00:00.000Z')
  class StubDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])) }
    static now() { return clock }
  }

  let live = []
  const doc = { querySelectorAll: selector => (selector === '[data-rel]' ? live : []) }
  const timers = []
  const factory = new Function(
    'Date', 'document', 'setInterval',
    `${escLine[0]}\n${relSrc}\n${block}\nreturn { relLabel, relTick, rel, REL_TICK_MS }`)
  const api = factory(StubDate, doc, (fn, ms) => { timers.push({ fn, ms }); return timers.length })

  return {
    ...api,
    timers,
    now: () => clock,
    advance: ms => { clock += ms },
    /** Mount every `[data-rel]` element in some rendered markup as live DOM. */
    mount(...markup) {
      live = []
      for (const html of markup) {
        for (const el of elements(html)) {
          if (!('data-rel' in el.attrs)) continue
          const node = liveElement(el)
          // The text the renderer itself wrote between the tags.
          const at = html.indexOf('>', el.index) + 1
          node.textContent = html.slice(at, html.indexOf('</', at))
          node.writes = 0
          live.push(node)
        }
      }
      return live
    },
    get live() { return live },
  }
}

/* ── the helpers ───────────────────────────────────────── */

test('an age label carries the absolute instant, not only the text it rendered', () => {
  const ages = loadAges()
  const html = ages.relLabel(ages.now() - 90_000, { cls: 'sess-time' })
  const [el] = elements(html)
  assert.equal(el.dataset.rel, String(ages.now() - 90_000), 'the epoch is on the element, so it can be re-read later')
  assert.ok(el.attrs.datetime, 'the machine-readable instant is published too')
  assert.ok(el.attrs.title.length > 0, 'the absolute timestamp is one hover away')
  assert.match(html, />1m</, 'and it still reads as a relative age')
})

test('a ticker is installed and repaints at least twice a minute', () => {
  const ages = loadAges()
  assert.equal(ages.timers.length, 1, 'exactly one ticker')
  assert.equal(ages.timers[0].fn, ages.relTick, 'and it is the age repaint')
  assert.ok(ages.timers[0].ms > 0 && ages.timers[0].ms <= 30_000,
    `a ${ages.timers[0].ms}ms tick lets a label overstate freshness for too long`)
})

test('the ticker writes only when the rendered age actually moved', () => {
  const ages = loadAges()
  const [el] = ages.mount(ages.relLabel(ages.now() - 4 * 3600_000))
  assert.equal(el.textContent, '4h')
  ages.advance(1000)
  ages.relTick()
  assert.equal(el.writes, 0, 'a label reading "4h" costs nothing until the hour turns')
  ages.advance(3600_000)
  ages.relTick()
  assert.equal(el.textContent, '5h')
  assert.equal(el.writes, 1, 'one text write, not a re-render')
})

/* ── the surfaces the blocker named ────────────────────── */

function renderSurfaces(ages, S) {
  const { $, nodes } = stubDocument({ 'room-spawn-actions': stubNode() })
  const rowLine = app.match(/^const row = .*$/m)
  const escLine = app.match(/^const esc = .*$/m)
  const sessions = slice('function renderSessions() {', 'function selectSession(', 'renderSessions')
  const roomDetail = slice('function renderRoomDetail() {', '// Delegated, not bound per button', 'renderRoomDetail')
  const services = slice('function renderServices() {', 'function renderProcs()', 'renderServices')
  const factory = new Function(
    '$', 'S', 'relLabel', 'selectSession', 'comfyDl',
    `${escLine[0]}\n${rowLine[0]}\n${sessions}\n${roomDetail}\n${services}\n` +
    'return { renderSessions, renderRoomDetail, renderServices }')
  const api = factory($, S, ages.relLabel, () => {}, () => false)
  return { ...api, nodes, $ }
}

const sessionCard = (at, projectId) => ({
  file: `/t/${at}.jsonl`, id: 'abc12345', agent: 'claude', cwd: '/w/quorum',
  summary: 'a session that has gone quiet', mtimeMs: at, active: false, projectId,
})

test('every age the radar and the office render can be ticked', () => {
  const ages = loadAges()
  const at = ages.now() - 200_000
  const S = {
    sessions: { cards: [sessionCard(at, 'quorum')] },
    projects: { rooms: [{ id: 'quorum', label: 'quorum', cwd: '/w/quorum', sessionCount: 1, agents: ['claude'], active: true }] },
    selectedRoom: 'quorum',
    services: { auth: { claude: { cli: true, configured: true }, codex: { cli: true, configured: true, mode: 'apikey', lastRefresh: new Date(at).toISOString() } } },
    processes: { procs: [] },
  }
  const surfaces = renderSurfaces(ages, S)
  surfaces.renderSessions()
  surfaces.renderRoomDetail()
  surfaces.renderServices()

  for (const [id, expected] of [['sessions-list', '3m'], ['room-sessions', '3m'], ['auth-card', '3m ago']]) {
    const html = surfaces.nodes.get(id).innerHTML
    const tickable = elements(html).filter(el => 'data-rel' in el.attrs)
    assert.equal(tickable.length, 1, `#${id} renders exactly one tickable age (got ${tickable.length})`)
    assert.equal(tickable[0].dataset.rel, String(at), `#${id} publishes the instant it is ageing from`)
    assert.ok(html.includes(`>${expected}<`), `#${id} still reads "${expected}"`)
  }
})

test('a session whose transcript stopped being written still ages on screen', () => {
  // The reviewer's reproduction, as a test: a frozen session, no further server
  // message, the label sampled minutes later. Before the ticker existed this
  // read "0s" forever; the honest answer is "4m".
  const ages = loadAges()
  const frozen = ages.now()
  const S = { sessions: { cards: [sessionCard(frozen, 'quorum')] } }
  const surfaces = renderSurfaces(ages, S)
  surfaces.renderSessions()
  const html = surfaces.nodes.get('sessions-list').innerHTML
  assert.ok(html.includes('>0s<'), 'rendered fresh')

  const [el] = ages.mount(html)
  // Four minutes and eighteen seconds pass. `State#publish` sends nothing,
  // because the payload is byte-identical — so no renderer runs at all.
  for (let elapsed = 0; elapsed < 258_000; elapsed += 10_000) {
    ages.advance(10_000)
    ages.relTick()
  }
  assert.equal(el.textContent, '4m', `the label froze at "${el.textContent}" and overstated freshness`)
})

test('a services refresh timestamp ages too, suffix and all', () => {
  const ages = loadAges()
  const at = ages.now() - 30_000
  const S = {
    services: { auth: { codex: { cli: true, configured: true, mode: 'apikey', lastRefresh: new Date(at).toISOString() } } },
    processes: { procs: [] },
  }
  const surfaces = renderSurfaces(ages, S)
  surfaces.renderServices()
  const [el] = ages.mount(surfaces.nodes.get('auth-card').innerHTML)
  assert.equal(el.textContent, '30s ago')
  ages.advance(3 * 60_000)
  ages.relTick()
  assert.equal(el.textContent, '3m ago', 'the suffix survives the repaint')
})
