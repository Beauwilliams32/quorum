// Scratch directories a test creates are the test's to remove. Before
// 2026-09-23 most suites left theirs in the temp directory on every run (one
// machine had ~40,000 quorum-* entries), and on a buyer's machine that is their
// disk. Suites now make them with scratchDir() from test/helpers/scratch.mjs,
// whose import also fails a file that leaves anything behind. That check runs
// inside each suite during the normal run, so nothing here re-runs the suite:
// this file holds every suite to the helper, and proves the check itself fails
// when it should.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defer, scratchDir } from './helpers/scratch.mjs'

const here = fileURLToPath(import.meta.url)
const testDir = path.dirname(here)
const helper = pathToFileURL(path.join(testDir, 'helpers', 'scratch.mjs')).href
const suites = fs.readdirSync(testDir).filter(name => name.endsWith('.test.mjs') && name !== path.basename(here))
const source = name => fs.readFileSync(path.join(testDir, name), 'utf8')

test('every suite makes its scratch directories through the helper', () => {
  const direct = suites.filter(name => /mkdtemp/.test(source(name)))
  assert.deepEqual(direct, [], 'use scratchDir(t, prefix) from ./helpers/scratch.mjs, which removes the directory and checks for leftovers')
  const unchecked = suites.filter(name => /tmpdir\(/.test(source(name)) && !source(name).includes("from './helpers/scratch.mjs'"))
  assert.deepEqual(unchecked, [], 'a suite that uses the temp directory must import ./helpers/scratch.mjs')
})

test('teardown runs last-registered first, so a writer stops before its directory goes', async t => {
  const order = []
  await t.test('inner', inner => {
    defer(inner, () => order.push('directory removed'))
    defer(inner, () => order.push('writer closed'))
  })
  assert.deepEqual(order, ['writer closed', 'directory removed'])
})

// Run one throwaway test file under `node --test` against a private temp
// directory, the way `npm test` runs a suite.
function runFixture(t, name, body) {
  const dir = scratchDir(t, 'quorum-hygiene-fixture-')
  const tmp = scratchDir(t, 'quorum-hygiene-tmp-')
  const file = path.join(dir, `${name}.test.mjs`)
  fs.writeFileSync(file, [
    "import test from 'node:test'",
    "import fs from 'node:fs'",
    "import os from 'node:os'",
    "import path from 'node:path'",
    `import { defer, scratchDir } from ${JSON.stringify(helper)}`,
    body,
  ].join('\n'))
  const env = { ...process.env, TMPDIR: tmp }
  delete env.NODE_TEST_CONTEXT // run as a top-level runner, not as a child of this one
  const r = spawnSync(process.execPath, ['--test', file], { env, encoding: 'utf8', timeout: 30_000 })
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, left: fs.readdirSync(tmp) }
}

test('a suite that cleans up passes, and leaves the temp directory empty', t => {
  const r = runFixture(t, 'clean', `test('uses a scratch dir', t => {
    const dir = scratchDir(t, 'quorum-clean-')
    fs.writeFileSync(path.join(dir, 'state.json'), '{}')
    defer(t, () => fs.writeFileSync(path.join(dir, 'closed'), 'a writer flushing on close'))
  })`)
  assert.equal(r.status, 0, r.output)
  assert.deepEqual(r.left, [])
})

test('a suite that leaves a directory behind fails and names it, and the leftover is still removed', t => {
  const r = runFixture(t, 'leaky', `test('forgets its scratch dir', () => {
    fs.mkdirSync(path.join(os.tmpdir(), 'quorum-leaky-dir'))
  })`)
  assert.notEqual(r.status, 0, r.output)
  assert.match(r.output, /left 1 scratch entry in the temp directory: quorum-leaky-dir/)
  assert.deepEqual(r.left, [], 'the check removes what it found, so a failing run does not accumulate either')
})

test('a directory written back by an exit hook after its test removed it is caught', t => {
  // The agent-control store flushes every open store from an exit hook, and
  // its flush re-creates a removed directory. The check has to run after that.
  const r = runFixture(t, 'late-writer', `test('an open writer outlives its directory', t => {
    const dir = scratchDir(t, 'quorum-late-')
    process.on('exit', () => fs.mkdirSync(dir, { recursive: true }))
  })`)
  assert.notEqual(r.status, 0, r.output)
  assert.match(r.output, /left 1 scratch entry in the temp directory: quorum-late-/)
  assert.deepEqual(r.left, [])
})
