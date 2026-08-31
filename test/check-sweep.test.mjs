import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `npm run check` is the documented syntax gate, and it is a hand-maintained
// list of `node --check <file>` invocations. Every time a module is added the
// list has to be extended by hand, and nothing enforced that — so a shipped
// file could carry a hard syntax error while the gate still exited 0.
// (`src/operations.js` was in exactly that state: reachable from the
// `/api/operations` route, never parsed by the gate.) These tests keep the
// sweep and the tree in lockstep so the next new module fails loudly here
// instead of silently escaping the gate.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Directories whose contents ship as part of the cockpit. `archive/` is the
// quarantined Phase-0 Rust/Tauri tree and `portal-gateway/` runs its own
// `npm --prefix portal-gateway run check`, so neither belongs in this sweep.
const SHIPPED = [
  { dir: '.', recurse: false, match: name => name === 'server.js' },
  { dir: 'src', recurse: true, match: name => name.endsWith('.js') },
  { dir: 'public', recurse: false, match: name => name.endsWith('.js') },
  { dir: 'scripts', recurse: false, match: name => name.endsWith('.mjs') },
  { dir: 'bin', recurse: false, match: name => !name.startsWith('.') },
]

function walk(dir, recurse, match, acc = []) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return acc
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir === '.' ? '' : dir, entry.name)
    if (entry.isDirectory()) {
      if (recurse) walk(rel, recurse, match, acc)
    } else if (match(entry.name)) {
      acc.push(rel)
    }
  }
  return acc
}

function shippedFiles() {
  const files = []
  for (const spec of SHIPPED) files.push(...walk(spec.dir, spec.recurse, spec.match))
  return files.sort()
}

function sweptTargets() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  return [...pkg.scripts.check.matchAll(/node --check (\S+)/g)].map(m => m[1])
}

test('every shipped source file is parsed by the npm run check sweep', () => {
  const swept = new Set(sweptTargets())
  const missing = shippedFiles().filter(file => !swept.has(file))
  assert.deepEqual(missing, [], `not covered by "npm run check": ${missing.join(', ')}`)
})

test('the check sweep names no file that has since been moved or renamed', () => {
  const stale = sweptTargets().filter(target => !fs.existsSync(path.join(ROOT, target)))
  assert.deepEqual(stale, [], `"npm run check" parses missing files: ${stale.join(', ')}`)
})

test('the check sweep lists each file exactly once', () => {
  const targets = sweptTargets()
  const dupes = targets.filter((target, i) => targets.indexOf(target) !== i)
  assert.deepEqual([...new Set(dupes)], [])
})
