import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { byAttr, elements } from './helpers/markup.mjs'
import { ROOT, readCss, parseCss, rulesFor } from './helpers/stylesheet.mjs'

// The Shipped Artifacts card lists the published Claude artifacts catalogued in
// the CLAUDE workspace (docs/artifacts/claude-artifacts.json). It rides the
// existing artifact index instead of a new route, so the contract to protect is:
// two mount points (Board + Command), read-only fetches against the artifact
// API, links that open in a new tab without a referrer, and a script that parses.
//
// 2026-09-22: the mount count used to be `html.match(/<div class="card"
// data-claude-artifacts>/g).length`, which counts a literal string and breaks
// the moment the card gains a class. It now counts elements carrying the
// attribute, which is what the panel script actually selects on.

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
const styleRules = parseCss(readCss('public/style.css'))

function section(id) {
  const start = html.indexOf(`<main id="${id}"`)
  assert.ok(start >= 0, `${id} exists`)
  const end = html.indexOf('</main>', start)
  return html.slice(start, end)
}

function panelScript() {
  const match = html.match(/<script type="module">\n\/\/ Shipped Claude artifacts[\s\S]*?<\/script>/)
  assert.ok(match, 'inline panel module is present')
  return match[0].replace(/^<script type="module">/, '').replace(/<\/script>$/, '')
}

test('Board and Command each mount one Shipped Artifacts card', () => {
  const mounts = byAttr(html, 'data-claude-artifacts')
  assert.equal(mounts.length, 2, 'exactly two mount points')
  assert.ok(mounts.every(el => el.classes.has('card')), 'each mount is a card')
  assert.equal(byAttr(section('view-board'), 'data-claude-artifacts').length, 1)
  assert.equal(byAttr(section('view-command'), 'data-claude-artifacts').length, 1)

  // The three regions the script writes into must exist inside each mount and
  // be styled, or the card renders as unstyled text.
  for (const cls of ['claude-artifacts-count', 'claude-artifacts-list', 'claude-artifacts-foot']) {
    const found = elements(html).filter(el => el.classes.has(cls))
    assert.equal(found.length, 2, `${cls} is present in both mounts`)
    assert.ok(rulesFor(styleRules, `.${cls}`).length > 0, `.${cls} is styled`)
  }
})

test('the panel reads the catalog through the artifact index and never mutates', () => {
  const code = panelScript()
  assert.ok(code.includes('/api/artifacts/search?q='), 'locates the manifest via search')
  assert.ok(code.includes('/api/artifacts/${encodeURIComponent(entry.id)}'), 'reads the manifest via the preview route')
  assert.ok(code.includes('docs/artifacts/claude-artifacts.json'), 'names the workspace manifest')
  assert.ok(code.includes("String(entry.path || '')"), 'matches the manifest on its absolute path, not the root-relative one')
  assert.doesNotMatch(code, /method:\s*['"](POST|PUT|PATCH|DELETE)/i)
  assert.match(code, /rel="noopener noreferrer"/)
  assert.match(code, /target="_blank"/)
})

test('the inline panel module parses as JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(panelScript(), { filename: 'claude-artifacts-panel.inline.js' }))
})
