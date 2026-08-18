import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverProjects, slug } from '../src/config.js'
import { resolveProjectId } from '../src/collectors/projects.js'

// A fake workspace on disk — this is the "someone who isn't Beau" test. The
// floor has to populate from nothing but a directory of repos.
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-ws-'))
  const mk = (name, marker) => {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    if (marker) {
      if (marker.endsWith('/')) fs.mkdirSync(path.join(dir, marker.slice(0, -1)), { recursive: true })
      else fs.writeFileSync(path.join(dir, marker), '{}')
    }
    return dir
  }
  return { root, mk }
}

test('discovery finds directories with project markers and skips the rest', () => {
  const { root, mk } = makeWorkspace()
  mk('billing-api', 'package.json')
  mk('infra', '.git/')
  mk('rusty', 'Cargo.toml')
  mk('just-photos', null)               // no marker → not a project
  mk('node_modules', 'package.json')    // always skipped by name
  fs.mkdirSync(path.join(root, '.hidden-repo'))

  const found = discoverProjects([root])
  const ids = found.map(p => p.id).sort()
  assert.deepEqual(ids, ['billing-api', 'infra', 'rusty'])
  assert.ok(found.every(p => p.discovered), 'discovered entries are marked')
})

test('discovered projects get readable labels, not raw folder names', () => {
  const { root, mk } = makeWorkspace()
  mk('my-cool_project', 'package.json')
  const found = discoverProjects([root])
  assert.equal(found[0].label, 'My Cool Project')
})

test('an unreadable root is skipped rather than fatal', () => {
  assert.doesNotThrow(() => discoverProjects(['/nonexistent/nowhere']))
  assert.deepEqual(discoverProjects(['/nonexistent/nowhere']), [])
})

test('slug normalizes arbitrary names into stable ids', () => {
  assert.equal(slug('My Cool Project!'), 'my-cool-project')
  assert.equal(slug('---'), 'project')
  assert.equal(slug('UPPER_case.name'), 'upper-case-name')
})

// The whole point of discovery: a session running inside a discovered project
// must land in that project's room.
test('a discovered project wins cwd resolution over the catch-all', () => {
  const { root, mk } = makeWorkspace()
  const dir = mk('billing-api', 'package.json')
  const catalog = [
    ...discoverProjects([root]),
    { id: 'ws-root', label: 'Workspace', pathPrefix: root, catchAll: true },
  ]
  assert.equal(resolveProjectId(path.join(dir, 'src'), catalog), 'billing-api')
  assert.equal(resolveProjectId(path.join(root, 'just-photos'), catalog), 'ws-root')
})
