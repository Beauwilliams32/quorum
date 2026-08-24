// scripts/build-open-core.mjs is the only thing standing between the private
// Pro personas and the public repo. Run it for real into a scratch directory
// and assert the allow-list and leak guard behave.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'build-open-core.mjs')

function build(out) {
  return spawnSync(process.execPath, [script, '--out', out], { cwd: root, encoding: 'utf8' })
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e)
    if (fs.statSync(p).isDirectory()) walk(p, acc)
    else acc.push(path.relative(dir, p) && p)
  }
  return acc
}

test('open-core build copies the allow-list and excludes every Pro file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-oc-'))
  const out = path.join(tmp, 'public-tree')
  const r = build(out)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /verified: no Pro personas/)

  const files = walk(out).map(p => path.relative(out, p))
  // Things that must be there
  for (const must of ['server.js', 'package.json', 'CLAUDE.md', 'src/cast.js', 'src/licence.js', 'public/app.js'])
    assert.ok(files.includes(must), `missing ${must}`)
  // Things that must never be there
  for (const never of ['src/cast-pro.js', 'scripts/issue-licence.mjs', 'scripts/build-open-core.mjs'])
    assert.ok(!files.includes(never), `leaked ${never}`)
  assert.ok(!files.some(f => f.startsWith('docs/pro/')), 'docs/pro leaked')
  assert.ok(!files.includes('docs/ARCHITECTURE.md'), 'internal architecture leaked')
  assert.ok(!files.includes('docs/product-backlog.md'), 'internal backlog leaked')
  assert.ok(!files.some(f => f.startsWith('docs/trident/')), 'docs/trident is not on the allow-list')
  assert.ok(!files.some(f => f.startsWith('docs/course/')), 'docs/course is not on the allow-list')
  assert.ok(!files.some(f => f.includes('node_modules')))

  // The private CLAUDE.md is replaced, not copied
  const claudeMd = fs.readFileSync(path.join(out, 'CLAUDE.md'), 'utf8')
  assert.doesNotMatch(claudeMd, /PRIVATE Pro repo/)
  assert.match(claudeMd, /Loopback only/)

  // package.json is made publishable and its check script no longer references Pro files
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'))
  assert.equal(pkg.private, undefined)
  assert.equal(pkg.license, 'MIT')
  assert.match(pkg.repository.url, /Beauwilliams32\/quorum/)
  assert.doesNotMatch(pkg.scripts.check, /cast-pro/)
  assert.match(pkg.scripts.check, /node --check server\.js/)

  // .gitignore gains the second guard
  const ignore = fs.readFileSync(path.join(out, '.gitignore'), 'utf8')
  assert.match(ignore, /src\/cast-pro\.js/)
  assert.match(ignore, /scripts\/issue-licence\.mjs/)
  assert.match(ignore, /docs\/pro\//)
})

test('open-core build refuses to overwrite an existing output directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-oc-'))
  const out = path.join(tmp, 'exists')
  fs.mkdirSync(out)
  fs.writeFileSync(path.join(out, 'keep.txt'), 'do not clobber')
  const r = build(out)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /refusing to overwrite/)
  assert.equal(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'do not clobber')
  assert.ok(!fs.existsSync(path.join(out, 'server.js')))
})
