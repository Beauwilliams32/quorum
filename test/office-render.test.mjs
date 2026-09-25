import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { byClass, stubDocument, stubNode } from './helpers/markup.mjs'
import { ROOT } from './helpers/stylesheet.mjs'

/* `writeIfChanged` remembers the markup it last wrote, on the element, so a
 * collector tick that moves nothing costs no innerHTML parse and no handler
 * re-wire. Its own comment states the condition that makes that safe: the
 * renderer must be the container's ONLY writer, or the remembered markup goes
 * stale under someone else's innerHTML and the guard starts skipping writes
 * that were needed.
 *
 * renderOffice's loading-state early return was the one place that broke it. */

const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')

function slice(from, to, what) {
  const start = app.indexOf(from)
  const end = app.indexOf(to, start + 1)
  assert.ok(start > 0 && end > start, `${what} not found in public/app.js`)
  return app.slice(start, end)
}

function loadOffice(S) {
  const escLine = app.match(/^const esc = .*$/m)
  const guard = slice('function writeIfChanged(', '\n/* ── websocket', 'writeIfChanged')
  const office = slice('function renderOffice() {', '/* ── steering: drag a character', 'renderOffice')
  assert.ok(escLine, 'esc helper not found in public/app.js')

  const { $, nodes } = stubDocument({ 'office-floor': stubNode() })
  const doc = { querySelector: () => null }
  const factory = new Function(
    '$', 'S', 'document', 'drawRoom', 'selectRoom', 'wireRoomDrop',
    `${escLine[0]}\n${guard}\n${office}\nreturn { renderOffice }`)
  const api = factory($, S, doc, () => '<svg></svg>', () => {}, () => {})
  return { ...api, nodes, grid: () => nodes.get('rooms-grid').innerHTML, desks: () => nodes.get('team-desks').innerHTML }
}

const projects = {
  team: [{ id: 'claude', label: 'Claude', alive: true, count: 2 }],
  rooms: [{ id: 'quorum', label: 'quorum', cwd: '/w/quorum', summary: 'two sessions', agents: ['claude'], active: true, sessionCount: 2 }],
  config: { discovered: 1, exists: true, path: '~/.quorum/config.json', roots: ['~/code'] },
}

test('the office floor comes back after a tick with no projects', () => {
  // `handlers.snapshot` does `S.projects = wire.projects || null`, so a
  // reconnect whose snapshot has no projects puts the Office into its loading
  // state. That branch used to write innerHTML directly, past the guard, which
  // left `__quorumHtml` holding the previous room markup — so the next tick
  // with an unchanged room set compared equal, skipped the write, and the
  // Office sat on "loading rooms…" indefinitely.
  const S = { projects, selectedRoom: null, debate: null }
  const office = loadOffice(S)

  office.renderOffice()
  assert.equal(byClass(office.grid(), 'room').length, 1, 'the room is on the floor')
  assert.equal(byClass(office.desks(), 'desk').length, 1, 'and the team is at its desks')

  S.projects = null
  office.renderOffice()
  assert.match(office.grid(), /loading rooms/)
  assert.match(office.desks(), /loading team/)

  // The same rooms arrive again, byte-identical to what was on screen before.
  S.projects = projects
  office.renderOffice()
  assert.equal(byClass(office.grid(), 'room').length, 1, 'the floor is repainted, not left on the placeholder')
  assert.equal(byClass(office.desks(), 'desk').length, 1, 'and so is the team')
})

test('an unchanged floor is still not rewritten', () => {
  // The guard has to keep earning its keep: this is the win the loading-state
  // fix must not undo.
  const S = { projects, selectedRoom: null, debate: null }
  const office = loadOffice(S)
  office.renderOffice()
  const grid = office.nodes.get('rooms-grid')
  let writes = 0
  const first = grid.innerHTML
  Object.defineProperty(grid, 'innerHTML', {
    get: () => first,
    set: () => { writes += 1 },
    configurable: true,
  })
  office.renderOffice()
  office.renderOffice()
  assert.equal(writes, 0, 'nothing moved, so nothing was parsed or re-wired')
})
