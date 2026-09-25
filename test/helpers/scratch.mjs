// Scratch directories for tests, and the check that none is left behind.
//
// Before 2026-09-23 most suites created directories with mkdtempSync and never
// removed them: one machine's temp directory held ~40,000 quorum-* entries, and
// these tests ship to buyers, so on their machine that is their disk.
//
// `scratchDir(t, prefix)` makes a directory that is removed when test `t` ends.
// `defer(t, fn)` queues any other teardown on the same test. Teardown runs in
// reverse order of registration, like Go's t.Cleanup: a store opened on a
// scratch dir, or a child whose HOME is one, is closed or stopped (registered
// later, so run first) before its directory is removed. node:test's own
// `t.after` runs hooks first-in first-out, which removes the directory while
// the writer is still live; the writer then puts it straight back.
//
// Importing this module also points this process's temp directory at a
// private directory of its own, inherited by every child it spawns. At exit,
// after every other exit hook has run (the agent-control store flushes open
// stores from one, which re-creates a removed directory), anything still in it
// is named on stderr and the process exits 1, which fails the file under
// `node --test`. The private directory is removed either way, so even a
// failing run does not accumulate.
import { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const own = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-tmpcheck-'))
for (const key of process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR']) process.env[key] = own

let checkScheduled = false
const removeOwn = () => fs.rmSync(own, { recursive: true, force: true })
function check() {
  let left = []
  try { left = fs.readdirSync(own) } catch { /* already gone */ }
  removeOwn()
  if (left.length === 0) return
  process.stderr.write(`test left ${left.length} scratch entr${left.length === 1 ? 'y' : 'ies'} in the temp directory: ${left.sort().join(', ')}\n`)
  process.exitCode = 1
}
// Exit listeners run in registration order, and the store registers its flush
// the first time a test opens one. Registering the check from the file's last
// hook puts it after every such listener.
after(() => { checkScheduled = true; process.on('exit', check) })
// A process that exits before its hooks run (a crash at load) still cleans up.
process.on('exit', () => { if (!checkScheduled) removeOwn() })

const stacks = new WeakMap()

/** Queue `fn` to run when test `t` ends, before anything queued earlier. */
export function defer(t, fn) {
  let stack = stacks.get(t)
  if (!stack) {
    stack = []
    stacks.set(t, stack)
    t.after(async () => { while (stack.length) await stack.pop()() })
  }
  stack.push(fn)
}

/** A fresh directory under the temp directory, removed when test `t` ends. */
export function scratchDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  defer(t, () => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Stop a child process and resolve once it has exited. */
export async function stopChild(child, { signal = 'SIGTERM', graceMs = 5000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill(signal)
  const force = setTimeout(() => child.kill('SIGKILL'), graceMs)
  await exited
  clearTimeout(force)
}
