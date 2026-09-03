import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8')
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8')

test('Command exposes a live, keyboard-addressable operator console', () => {
  for (const id of ['operator-console-title', 'operator-tabs', 'operator-surface', 'operator-refresh']) {
    assert.match(html, new RegExp(`id=["']${id}["']`))
  }
  for (const tab of ['attention', 'agents', 'workspaces', 'tools', 'activity']) {
    assert.match(html, new RegExp(`data-operator-tab=["']${tab}["']`))
  }
  assert.match(app, /setAttribute\('aria-selected'/)
})

test('Operator console consumes bounded registries and keeps guarded actions', () => {
  for (const route of ['/api/workspaces', '/api/tools', '/api/mcp', '/api/agent-control/doctor']) {
    assert.ok(app.includes(`'${route}'`), `missing ${route}`)
  }
  assert.match(app, /pending-approval/)
  assert.match(app, /data-console-approve/)
  assert.match(app, /data-console-terminal/)
  assert.doesNotMatch(app, /sk-[A-Za-z0-9]{8,}/)
})

test('Mission templates create dependency-aware task graphs', () => {
  for (const template of ['build', 'audit', 'single']) {
    assert.match(html, new RegExp(`name=["']mission-template["'] value=["']${template}["']`))
  }
  assert.match(app, /dependsOn: \['discover'\]/)
  assert.match(app, /dependsOn: \['build'\]/)
  assert.match(app, /dependsOn: \['inspect'\]/)
})

test('Deck limits visible room nodes and links overflow to the workspace index', () => {
  assert.match(app, /visibleRooms = rankedRooms\.slice\(0, Math\.min\(16/)
  assert.match(app, /data-deck-more/)
  assert.match(css, /\.deck-more/)
})
