import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeConnections } from '../src/collectors/composio.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')

// public/app.js is a plain browser script with no module boundary, so lift the
// three pieces the Composio card is built from and run them against stub nodes.
function loadRenderComposio(S) {
  const escSrc = APP.match(/^const esc = .*$/m)
  const rowSrc = APP.match(/^const row = .*$/m)
  assert.ok(escSrc && rowSrc, 'esc/row helpers not found in public/app.js')
  const start = APP.indexOf('function renderComposio() {')
  assert.notEqual(start, -1, 'renderComposio not found in public/app.js')
  const end = APP.indexOf('\n}\n', start)
  const fnSrc = APP.slice(start, end + 2)

  const nodes = { 'composio-summary': { textContent: '', innerHTML: '' }, 'composio-card': { innerHTML: '' } }
  const $ = (id) => nodes[id]
  const factory = new Function('$', 'S', `${escSrc[0]}\n${rowSrc[0]}\n${fnSrc}\nreturn renderComposio`)
  return { render: factory($, S), nodes }
}

// Toolkit names are keys of the `composio connections list` payload — external
// data. They must reach the DOM as text, never as markup.
test('renderComposio escapes toolkit names from the connections payload', () => {
  const hostile = 'gmail<img src=x onerror=alert(1)>'
  // Two connections on the toolkit so it lands in both the ambiguous row and
  // the per-status row.
  const connections = summarizeConnections({
    [hostile]: [
      { status: 'ACTIVE', word_id: 'aaa' },
      { status: 'ACTIVE', word_id: 'bbb' },
    ],
  })
  assert.deepEqual(connections.ambiguous, [hostile])

  const S = { composio: { cliPresent: true, toolDefs: 0, connections } }
  const { render, nodes } = loadRenderComposio(S)
  render()

  const html = nodes['composio-card'].innerHTML
  assert.match(html, /ambiguous/)
  assert.match(html, /active/)
  assert.ok(!html.includes('<img'), 'toolkit name rendered as live markup')
  assert.equal(html.split('&lt;img src=x onerror=alert(1)&gt;').length - 1, 2)
})
