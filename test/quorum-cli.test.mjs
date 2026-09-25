// The buyer-facing `quorum` CLI. install.sh symlinks bin/quorum onto the
// buyer's PATH and its last line tells them to run `quorum status`, yet until
// 2026-09-22 nothing in the suite ever spawned it: the FEATURE-MAP row read
// "partial — manual CLI smoke". This boots the real server.js on a scratch
// HOME and an OS-assigned port (never 4747, the owner's live cockpit) and
// drives the real CLI against it, so nothing here reads or writes ~/.quorum.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defer, scratchDir, stopChild } from './helpers/scratch.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin', 'quorum')
const home = scratchDir(test, 'quorum-cli-home-')

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

let base
let child
test.before(async () => {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      AGENT_CONTROL_STATE_DIR: path.join(home, 'agent-control'),
      QUORUM_MISSIONS_PATH: path.join(home, 'missions.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000)
    child.stdout.on('data', data => { if (String(data).includes(`:${port}`)) { clearTimeout(timer); resolve() } })
    child.on('exit', code => reject(new Error(`server exited ${code}`)))
  })
})
// Registered after HOME, so it runs first: the server has exited before its
// HOME is removed. Removing the directory under a live server lets it write
// the files straight back.
defer(test, () => stopChild(child))

// Asynchronous on purpose: a synchronous spawn would stall this process while
// the server's stdout pipe fills, and a full pipe blocks the server itself.
const quorum = (args, url = base) => new Promise((resolve, reject) => {
  const run = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, HOME: home, QUORUM_URL: url },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const timer = setTimeout(() => { run.kill('SIGKILL'); reject(new Error(`quorum ${args.join(' ')} timed out`)) }, 30_000)
  run.stdout.on('data', data => { stdout += data })
  run.stderr.on('data', data => { stderr += data })
  run.on('error', reject)
  run.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
})
const json = r => {
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

test('`quorum status` prints the /health readiness document as JSON', async () => {
  const health = json(await quorum(['status']))
  assert.ok(['ok', 'degraded'].includes(health.status))
  assert.equal(health.readiness.cockpit, 'ready')
  assert.equal(typeof health.uptimeMs, 'number')
})

test('no command at all means status, which is what install.sh tells a buyer to run', async () => {
  assert.equal(json(await quorum([])).readiness.cockpit, 'ready')
})

test('`quorum dashboard` names the cockpit URL it is pointed at', async () => {
  assert.deepEqual(json(await quorum(['dashboard'])), { url: base })
})

test('read commands return the shapes the cockpit serves', async () => {
  assert.ok(Array.isArray(json(await quorum(['agents'])).agents))
  assert.deepEqual(json(await quorum(['mission', 'list'])).missions, [])
  assert.ok(Array.isArray(json(await quorum(['logs']))))
  assert.ok(Array.isArray(json(await quorum(['tools'])).tools))
  assert.ok(Array.isArray(json(await quorum(['mcp', 'list'])).servers))
  assert.ok(Array.isArray(json(await quorum(['workspace', 'list'])).workspaces))
  assert.ok(Array.isArray(json(await quorum(['runtime', 'list'])).runs))
  assert.equal(typeof json(await quorum(['memory', 'status'])).claudeMem, 'object')
  const search = json(await quorum(['artifacts', 'nothing-matches-this']))
  assert.equal(search.query, 'nothing-matches-this')
  assert.ok(Array.isArray(search.results))
})

test('a mission created from the CLI can be shown and stopped, and lands only in the scratch store', async () => {
  const created = json(await quorum(['mission', 'create', 'CLI test', 'prove', 'the', 'round', 'trip'])).mission
  assert.equal(created.title, 'CLI test')
  assert.equal(created.objective, 'prove the round trip')
  const shown = json(await quorum(['mission', 'show', created.id]))
  assert.equal(JSON.stringify(shown).includes(created.id), true)
  json(await quorum(['mission', 'stop', created.id]))
  const listed = json(await quorum(['mission', 'list'])).missions.find(mission => mission.id === created.id)
  assert.equal(listed?.status, 'cancelled')
  assert.ok(fs.readFileSync(path.join(home, 'missions.json'), 'utf8').includes(created.id))
})

test('an unknown mission or agent is an error exit, not a quiet success', async () => {
  const mission = await quorum(['mission', 'show', 'mission-that-does-not-exist'])
  assert.equal(mission.status, 1)
  assert.match(mission.stderr, /^quorum: /)

  const agent = await quorum(['agent', 'show', 'agent-that-does-not-exist'])
  assert.equal(agent.status, 1)
  assert.deepEqual(JSON.parse(agent.stdout), { error: 'unknown agent' })
})

test('an unknown command prints the usage line and exits 2', async () => {
  const r = await quorum(['definitely-not-a-command'])
  assert.equal(r.status, 2)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /^Usage: quorum start \| status \|/)
})

test('a command missing its required flags explains itself and exits 1', async () => {
  const r = await quorum(['pipeline', 'repurpose'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Usage: quorum pipeline repurpose --input PATH --segments JSON/)
})

test('no cockpit listening is exit 1 with a message, not a stack trace', async () => {
  const closed = await freePort()
  const r = await quorum(['status'], `http://127.0.0.1:${closed}`)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /^quorum: /)
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace')
})
