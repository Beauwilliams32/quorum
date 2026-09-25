import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { byAttr, byClass, elements, stubDocument, stubNode } from './helpers/markup.mjs'
import { ROOT, readCss, parseCss, declared, declares, rulesFor } from './helpers/stylesheet.mjs'

/* The Command view's live control surface. This file used to assert that
 * public/app.js CONTAINED `setAttribute('aria-selected'` and `dependsOn:
 * ['discover']`, and that public/style.css CONTAINED `.deck-more` — string
 * matches that a comment would satisfy and a restyle would break. It now runs
 * the tab wiring, the mission-template builder and the deck overflow against
 * stubs, and reads the markup and the stylesheet as parsed structures. */

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
const styleRules = parseCss(readCss('public/style.css'))

const TABS = ['attention', 'agents', 'workspaces', 'tools', 'activity']

function slice(from, to) {
  const start = app.indexOf(from)
  const end = app.indexOf(to, start)
  assert.ok(start > 0 && end > start, `could not locate ${from} in public/app.js`)
  return app.slice(start, end)
}

test('the operator console ships as a real tablist, not styled divs', () => {
  const console_ = html.slice(html.indexOf('class="operator-console"'), html.indexOf('</section>', html.indexOf('class="operator-console"')))
  for (const id of ['operator-console-title', 'operator-tabs', 'operator-surface', 'operator-refresh']) {
    assert.ok(elements(html).some(el => el.attrs.id === id), `${id} exists`)
  }
  const tabs = byAttr(console_, 'data-operator-tab')
  assert.deepEqual(tabs.map(t => t.dataset.operatorTab), TABS)
  assert.ok(tabs.every(t => t.tag === 'button' && t.attrs.role === 'tab'), 'each tab is a button with role=tab')

  const list = elements(console_).find(el => el.attrs.id === 'operator-tabs')
  assert.equal(list.attrs.role, 'tablist')
  assert.ok(list.attrs['aria-label'], 'the tablist is labelled')
  const refresh = elements(console_).find(el => el.attrs.id === 'operator-refresh')
  assert.ok(refresh.attrs['aria-label'], 'the icon-only refresh control is labelled')
})

test('selecting a tab moves aria-selected and repaints the surface', () => {
  // Drive the real renderer. With the registry still loading it wires the tabs
  // and returns, which is exactly the code path under test.
  const src = slice('function renderOperatorConsole() {', 'function connectionRecord(')
  const S = { operatorTab: 'attention', operatorRegistry: null, operatorLoading: true }
  const { $ } = stubDocument()
  const buttons = TABS.map(name => stubNode({ dataset: { operatorTab: name } }))
  $('operator-tabs').querySelectorAll = () => buttons

  const hydrated = []
  const render = new Function('$', 'S', 'esc', 'hydrateOperatorRegistry',
    `${src}\nreturn renderOperatorConsole`)($, S, x => x, force => hydrated.push(force))

  render()
  assert.deepEqual(buttons.map(b => b.getAttribute('aria-selected')), ['true', 'false', 'false', 'false', 'false'])
  assert.ok(buttons[0].classList.contains('on'))
  assert.match($('operator-surface').innerHTML, /reading local registries/)

  // Clicking a tab is what changes the selection — no separate router.
  buttons[2].onclick()
  assert.equal(S.operatorTab, 'workspaces')
  assert.deepEqual(buttons.map(b => b.getAttribute('aria-selected')), ['false', 'false', 'true', 'false', 'false'])

  // The refresh control is wired once and forces a re-read.
  $('operator-refresh').onclick()
  assert.deepEqual(hydrated, [true])
})

test('the console reads bounded local registries and keeps guarded actions', async () => {
  // Run the hydrator against a stub fetch and record what it actually asks
  // for. A route named in a comment, or in a dead string, cannot pass this —
  // the earlier version of this assertion matched the route anywhere in
  // app.js, which is the weak check it claimed to have replaced.
  const hydrateSrc = slice('async function hydrateOperatorRegistry(', '\nfunction registryRow(')
  const requested = []
  const S = { operatorLoading: false, operatorRegistry: null }
  const hydrate = new Function('S', 'fetch', 'renderOperatorConsole', `${hydrateSrc}\nreturn hydrateOperatorRegistry`)(
    S,
    url => { requested.push(url); return Promise.resolve({ ok: true, status: 200, json: async () => ({ from: url }) }) },
    () => {})

  await hydrate()
  assert.deepEqual(requested, ['/api/workspaces', '/api/tools', '/api/mcp', '/api/agent-control/doctor'],
    'the console reads exactly these four local routes')
  assert.deepEqual(Object.keys(S.operatorRegistry).sort(), ['checkedAt', 'doctor', 'mcp', 'tools', 'workspaces'])
  // The payloads land under the names the renderer reads, in order.
  assert.equal(S.operatorRegistry.workspaces.from, '/api/workspaces')
  assert.equal(S.operatorRegistry.doctor.from, '/api/agent-control/doctor')
  assert.equal(S.operatorLoading, false, 'the loading flag is always cleared')

  // Cached until something asks for a refresh: the console is a local read,
  // not a poll.
  await hydrate()
  assert.equal(requested.length, 4, 'a second call without force does not re-read')
  await hydrate(true)
  assert.equal(requested.length, 8, 'force re-reads every route')

  // A failing registry becomes a reported error, never a half-filled console.
  const failing = { operatorLoading: false, operatorRegistry: null }
  const hydrateFail = new Function('S', 'fetch', 'renderOperatorConsole', `${hydrateSrc}\nreturn hydrateOperatorRegistry`)(
    failing,
    () => Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'registry down' }) }),
    () => {})
  await hydrateFail()
  assert.equal(failing.operatorRegistry.error, 'registry down')
  assert.equal(failing.operatorRegistry.workspaces, undefined)
  assert.equal(failing.operatorLoading, false)

  const src = slice('function renderOperatorConsole() {', 'function connectionRecord(')
  assert.match(src, /pending-approval/, 'the console surfaces pending approvals')
  assert.match(src, /data-console-approve/, 'approval is an explicit control')
  assert.match(src, /data-console-terminal/, 'a terminal can be opened from the console')
  // No credential ever reaches the browser bundle.
  assert.doesNotMatch(app, /sk-[A-Za-z0-9]{8,}/)
})

test('the command readiness line states what was measured and is coloured by it', () => {
  // This line used to end with a hardcoded "· no secrets exposed" and was
  // painted green by the stylesheet whatever the numbers were, so it read
  // healthy at 0/6 runtimes ready. Both halves are asserted here: the text
  // carries no unmeasured claim, and the colour follows the count.
  const src = slice('function commandReadiness(catalog, rooms) {', '\nfunction renderCommand() {')
  const readiness = new Function(`${src}\nreturn { commandReadiness, READINESS_COLOR }`)()
  const runtime = available => ({ available })
  const room = id => ({ id })

  const all = readiness.commandReadiness({ runtimes: [runtime(true), runtime(true)] }, [room('a')])
  assert.equal(all.text, '2/2 runtimes ready · 1 discovered rooms')
  assert.equal(all.tone, 'ready')

  const some = readiness.commandReadiness({ runtimes: [runtime(true), runtime(false)] }, [])
  assert.equal(some.tone, 'partial', 'a partial catalog is not healthy')

  const none = readiness.commandReadiness({ runtimes: [runtime(false), runtime(false)] }, [])
  assert.equal(none.tone, 'down', 'nothing ready is not green')
  assert.equal(none.text, '0/2 runtimes ready · 0 discovered rooms')

  assert.equal(readiness.commandReadiness({ runtimes: [] }, []).tone, 'unknown')
  assert.equal(readiness.commandReadiness(undefined, []).tone, 'unknown')

  // Each tone maps to a token, and only "ready" may be the healthy one.
  assert.deepEqual(readiness.READINESS_COLOR, {
    ready: 'var(--ok)', partial: 'var(--warn)', down: 'var(--error)', unknown: 'var(--muted)',
  })

  // No unmeasured claim survives anywhere in the rendered line.
  for (const result of [all, some, none]) assert.doesNotMatch(result.text, /no secrets exposed/)
  assert.doesNotMatch(app, /no secrets exposed/)

  // The stylesheet must not re-assert health underneath the measured colour —
  // on either line, since #deck-connection is coloured inline from the socket
  // state the same way.
  for (const selector of ['.command-connection', '#deck-connection']) {
    const values = declared(styleRules, selector, 'color')
    assert.ok(values.length > 0, `${selector} has a resting colour`)
    for (const value of values) {
      assert.doesNotMatch(value, /--ok\b|--green\b/, `${selector}: the resting colour is not a health signal`)
    }
  }
})

test('mission templates build the dependency-aware graphs the form advertises', () => {
  for (const template of ['build', 'audit', 'single']) {
    const input = byAttr(html, 'name', 'mission-template').find(el => el.attrs.value === template)
    assert.ok(input, `${template} is offered in the form`)
    assert.equal(input.attrs.type, 'radio')
  }

  // Run the real submit handler once per template and inspect the task graph it
  // posts, instead of matching `dependsOn: ['discover']` in the source.
  const src = slice('function renderMissions() {', 'async function previewMissionTask(')
  const graphs = {}
  for (const template of ['build', 'audit', 'single']) {
    const S = { missions: { missions: [] }, missionSelection: null, runtimeRuns: null }
    const { $ } = stubDocument()
    const form = stubNode({ querySelector: () => ({ value: template }) })
    $('mission-form')
    const nodes = { 'mission-form': form }
    const lookup = id => nodes[id] || $(id)
    for (const id of ['mission-title', 'mission-objective', 'mission-task', 'mission-room', 'mission-runtime']) lookup(id).value = ''
    lookup('mission-title').value = 'Ship the theme'
    lookup('mission-objective').value = 'One token system'
    lookup('mission-task').value = 'Survey the palettes'

    const posted = []
    const render = new Function('$', 'S', 'esc', 'postJson', 'renderMissionForm', 'missionProgress',
      `${src}\nreturn renderMissions`)(
      lookup, S, x => x,
      async (url, body) => { posted.push({ url, body }); return { mission: { id: 'm1' } } },
      () => {}, () => 0)

    render()
    assert.equal(typeof form.onsubmit, 'function', 'the create form is wired')
    // Node's test runner awaits the returned promise.
    graphs[template] = form.onsubmit({ preventDefault() {} }).then(() => posted[0])
  }

  return Promise.all(Object.entries(graphs).map(async ([template, pending]) => {
    const post = await pending
    assert.equal(post.url, '/api/missions')
    assert.equal(post.body.title, 'Ship the theme')
    const tasks = post.body.tasks
    const ids = tasks.map(t => t.id)
    const deps = Object.fromEntries(tasks.map(t => [t.id, t.dependsOn || []]))

    if (template === 'single') {
      assert.deepEqual(ids, ['execute'])
      assert.deepEqual(deps.execute, [])
    } else if (template === 'audit') {
      assert.deepEqual(ids, ['inspect', 'verify'])
      assert.deepEqual(deps.verify, ['inspect'])
    } else {
      assert.deepEqual(ids, ['discover', 'build', 'verify'])
      assert.deepEqual(deps.build, ['discover'])
      assert.deepEqual(deps.verify, ['build'])
    }
    // Every dependency names a task in the same graph — a graph that waits on a
    // task that was never created never dispatches.
    for (const [id, on] of Object.entries(deps)) {
      for (const dep of on) assert.ok(ids.includes(dep), `${id} waits on unknown task ${dep}`)
    }
  }))
})

test('Deck limits visible room nodes and links overflow to the workspace index', () => {
  // Twenty rooms, sixteen nodes, one honest "4 more rooms" escape hatch.
  const src = app.slice(app.indexOf('function renderDeck() {'), app.indexOf('/* ── runtimes + models come from config'))
  const rooms = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, label: `P${i}`, cwd: `/w/${i}`, active: false, agents: [] }))
  const S = {
    projects: { rooms }, agents: { agents: [] }, sessions: { cards: [] }, system: {},
    processes: { procs: [] }, memory: null, terms: new Map(), deckSelection: { kind: null, id: null },
  }
  const { $ } = stubDocument({ drawer: stubNode() })
  const views = []
  const writeIfChangedSrc = (() => {
  const at = app.indexOf('function writeIfChanged(')
  assert.ok(at > 0, 'writeIfChanged not found in public/app.js')
  return app.slice(at, app.indexOf('\n}\n', at) + 3)
})()
const esc = app.match(/^const esc = .*$/m)[0]
  const gb = app.match(/^const gb = .*$/m)[0]
  const row = app.match(/^const row = .*$/m)[0]
  // The 3D city arrives through a dynamic import now, so the deck reaches it
  // via `withCity` rather than a static binding.
  const render = new Function('$', 'S', 'ws', 'send', 'setView', 'selectSession', 'selectChat',
    'withCity', 'renderCityControls', 'selectCityEntity', 'fetch',
    `${esc}\n${gb}\n${row}\n${writeIfChangedSrc}\n${src}\nreturn renderDeck`)(
    $, S, { readyState: 1 }, () => {}, view => views.push(view), () => {}, () => {},
    fn => fn({ updateAgentCity: () => {}, focusCityEntity: () => {}, setCityRunning: () => {} }),
    () => {}, () => {}, async () => ({}))

  render()
  const markup = $('deck-nodes').innerHTML
  assert.equal(byClass(markup, 'deck-node', 'project').length, 16, 'the deck caps visible rooms')
  const more = byAttr(markup, 'data-deck-more')
  assert.equal(more.length, 1)
  assert.match(more[0].attrs.class, /deck-more/)
  assert.ok(markup.includes('4 more rooms'), 'the overflow count is the real remainder')

  // The overflow control is styled and routes to the workspace index.
  assert.ok(rulesFor(styleRules, '.deck-more').length > 0, '.deck-more is styled')
  assert.ok(declares(styleRules, '.deck-more', 'position'))
})
