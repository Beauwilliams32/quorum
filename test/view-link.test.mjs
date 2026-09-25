import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { byClass, elements, stubDocument } from './helpers/markup.mjs'
import { ROOT, readCss, parseCss, rulesFor, declares } from './helpers/stylesheet.mjs'

const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
const styleRules = parseCss(readCss('public/style.css'))

test('requested view is applied before websocket snapshot data arrives', () => {
  const initialView = app.indexOf("view: new URLSearchParams(location.search).get('view')")
  const immediateSet = app.indexOf('setView(S.view)')
  const connect = app.lastIndexOf('\nconnect()')

  assert.ok(initialView >= 0, 'state reads ?view before localStorage fallback')
  assert.ok(immediateSet >= 0, 'initial view is applied immediately')
  assert.ok(connect >= 0, 'websocket connect call exists')
  assert.ok(immediateSet < connect, 'view activation happens before websocket connect/snapshot')
  assert.ok(
    app.includes("!localStorage.getItem('quorum-tour-done') && S.view === 'office'"),
    'first-visit tour does not override linked non-office views'
  )
})

/* Until 2026-09-22 this asserted that public/app.js CONTAINED two exact source
 * lines, which a reformat breaks and a comment satisfies. It now runs the real
 * fan-out — `applyUpdate`, the one place an incoming key turns into renders —
 * and asserts on the state it stored and the renderers it asked for. */
function loadDispatch(view = 'office') {
  const start = app.indexOf('const RENDER_VIEW = {')
  const end = app.indexOf('/* ── view toggle')
  assert.ok(start > 0 && end > start, 'view-scoped rendering block not found in public/app.js')

  const S = { view, feed: [], hist: [], system: null, artifactResults: 'stale' }
  const painted = []
  const names = [...app.matchAll(/\bfunction (render[A-Za-z]+)\(/g)].map(m => m[1])
  const stubs = Object.fromEntries(names.map(name => [name, () => painted.push(name)]))
  const factory = new Function(
    'S', ...names,
    `${app.slice(start, end)}\nreturn { applyUpdate, paint, flushPendingRenders, pendingRenders, RENDER_VIEW, renders: () => renderCount }`)
  return { ...factory(S, ...names.map(name => stubs[name])), S, painted }
}

test('managed runtime state is hydrated and repaints the operational surfaces', () => {
  assert.ok(app.includes('S.runtimeRuns = wire.runtimeRuns || null'), 'the snapshot hydrates managed runtime state')

  // The missions view is where runs are read, so ask from there.
  const dispatch = loadDispatch('missions')
  dispatch.applyUpdate('runtimeRuns', { runs: [{ id: 'r1', status: 'running' }] })
  assert.deepEqual(dispatch.S.runtimeRuns, { runs: [{ id: 'r1', status: 'running' }] })
  assert.deepEqual(dispatch.painted, ['renderMissions', 'renderTopbar'])
})

/* renderDeck and renderOffice used to run several times a second whatever was
 * on screen — full innerHTML rebuilds, and a three.js scene update, behind a
 * display:none. These assert the gate and, just as importantly, that nothing is
 * lost: the hidden view is repainted the moment it is switched to. */
test('a hidden view is not rendered, and is repainted when it is switched to', () => {
  const dispatch = loadDispatch('office')
  dispatch.applyUpdate('city', { buildings: [] })
  assert.deepEqual(dispatch.painted, [], 'the Deck is not rebuilt while the Office is on screen')
  assert.ok(dispatch.pendingRenders.has('renderDeck'), 'the Deck is remembered as owing a repaint')

  dispatch.S.view = 'deck'
  dispatch.flushPendingRenders()
  assert.deepEqual(dispatch.painted, ['renderDeck'], 'switching to the Deck paints it with the state it missed')
  assert.equal(dispatch.pendingRenders.size, 0)
})

test('always-visible chrome is never gated behind a view', () => {
  const dispatch = loadDispatch('memory')
  dispatch.applyUpdate('processes', { procs: [], groups: {} })
  // Topbar yes; the Radar, Office and Deck surfaces the same key also feeds, no.
  assert.deepEqual(dispatch.painted, ['renderTopbar'])
  assert.equal(dispatch.RENDER_VIEW.renderTopbar, undefined, 'the topbar has no view to hide behind')
})

test('an artifacts update clears the stale search result it invalidates, gated or not', () => {
  const dispatch = loadDispatch('office')
  dispatch.applyUpdate('artifacts', { entries: [] })
  assert.equal(dispatch.S.artifactResults, null, 'state is always updated; only the drawing is deferred')
  assert.ok(dispatch.pendingRenders.has('renderMemoryRing'))
})

// The free edition's only upgrade prompt is the locked cast. Before 2026-09-21
// clicking a locked seat rendered prose with no destination, so the funnel
// dead-ended inside the app. Before 2026-09-22 this test asserted on the
// SOURCE of showUpgrade (`assert.match(body, /href="\$\{PRO_URL\}"/)`), which a
// restyle breaks and a comment satisfies; it now runs showUpgrade and inspects
// the anchor it actually renders.
test('a locked seat routes to the upgrade card, which links out to the landing page', () => {
  const clicks = [...app.matchAll(/if \(c\?\.locked\) return showUpgrade\(c\)/g)]
  assert.equal(clicks.length, 2, 'both the crew and the cast picker hand a locked seat to showUpgrade')

  const start = app.indexOf('function showUpgrade(')
  assert.ok(start > 0, 'showUpgrade exists')
  const src = app.slice(start, app.indexOf('\n}\n', start) + 3)
  const escSrc = app.match(/^const esc = .*$/m)[0]
  const urlSrc = app.match(/^const PRO_URL = .*$/m)
  assert.ok(urlSrc, 'the upgrade URL is declared once')

  const { $ } = stubDocument()
  const views = []
  const showUpgrade = new Function('$', 'setView', `${escSrc}\n${urlSrc[0]}\n${src}\nreturn showUpgrade`)($, v => views.push(v))
  showUpgrade({ name: 'Sable', role: 'adversary' })

  const card = $('rt-estimate')
  assert.deepEqual(views, ['table'], 'the card is shown on the roundtable view')
  const links = byClass(card.innerHTML, 'upgrade-link')
  assert.equal(links.length, 1, 'the card renders exactly one destination')
  const link = links[0]
  assert.equal(link.tag, 'a')
  // The funnel has to point at the canonical landing page, not merely at some
  // https URL — a stale or typo'd host still sells nothing.
  const PRO_URL = new Function(`${urlSrc[0]}\nreturn PRO_URL`)()
  assert.match(PRO_URL, /^https:\/\//, 'the destination is an absolute https URL')
  assert.equal(link.attrs.href, PRO_URL, 'the card links to the canonical PRO_URL')
  // A plain external link: new tab, no window.opener handed to the page, and no
  // navigation away from the loopback cockpit.
  assert.equal(link.attrs.target, '_blank')
  assert.equal(link.attrs.rel, 'noopener noreferrer')
  assert.doesNotMatch(src, /fetch\(|location\s*=|location\.href/)
  // Prices live in canon and on the landing page. A number compiled into an
  // installed build goes stale on the buyer's disk with no way to correct it.
  assert.doesNotMatch(card.innerHTML, /\$\d/)
  // The locked seat's identity reaches the card as escaped text, never markup.
  assert.match(card.innerHTML, /Sable/)

  // …and the link is actually styled as one.
  assert.ok(rulesFor(styleRules, '.upgrade-link').length > 0, '.upgrade-link is styled')
  assert.ok(declares(styleRules, '.upgrade-link', 'color'), 'the link is visually distinguishable')
})

test('the upgrade card escapes the seat name it was handed', () => {
  const start = app.indexOf('function showUpgrade(')
  const src = app.slice(start, app.indexOf('\n}\n', start) + 3)
  const escSrc = app.match(/^const esc = .*$/m)[0]
  const urlSrc = app.match(/^const PRO_URL = .*$/m)[0]
  const { $ } = stubDocument()
  const showUpgrade = new Function('$', 'setView', `${escSrc}\n${urlSrc}\n${src}\nreturn showUpgrade`)($, () => {})

  showUpgrade({ name: '<img src=x onerror=alert(1)>', role: 'adversary' })
  const html = $('rt-estimate').innerHTML
  assert.ok(!html.includes('<img'), 'a hostile seat name is rendered as text')
  assert.equal(elements(html).filter(el => el.tag === 'a').length, 1, 'still exactly one anchor')
})
