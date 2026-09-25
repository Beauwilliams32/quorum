// Quorum HQ end to end, at zero cost: a message becomes a ticket, the ticket
// becomes a real managed run, the run's evidence and an independent review
// decide it, and the result comes back into the thread.
//
// Everything is the product — server.js, bin/quorum, the runtime manager, the
// evidence gate, the reviewer, HQ — except the two providers. `claude` and
// `codex` on PATH here are stand-ins written by this test that speak the real
// wire formats (`--output-format stream-json`, `exec --json`): the stand-in
// Claude writes a file into the project and reports a price; the stand-in Codex
// reviews and says APPROVE. No network, no account, no spend.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defer, scratchDir, stopChild } from './helpers/scratch.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin', 'quorum')
const home = scratchDir(test, 'quorum-hq-e2e-home-')
const bin = path.join(home, 'fake-bin')
const project = path.join(home, 'code', 'demo-app')

const FAKE_CLAUDE = `#!${process.execPath}
// Stand-in for \`claude -p <prompt> --output-format stream-json\`.
const fs = require('node:fs')
const args = process.argv.slice(2)
const prompt = args[args.indexOf('-p') + 1] || ''
const ticket = (prompt.match(/Ticket (T-\\d+)/) || [])[1] || 'T-?'
const line = value => process.stdout.write(JSON.stringify(value) + '\\n')
line({ type: 'system', subtype: 'init', session_id: 'fake-session-1' })
line({ type: 'assistant', session_id: 'fake-session-1', message: { content: [{ type: 'text', text: 'Reading the brief for ' + ticket }] } })
fs.writeFileSync('HQ-E2E.md', '# Written by the stand-in agent for ' + ticket + '\\n')
line({ type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session-1', total_cost_usd: 0.0123, result: 'Added HQ-E2E.md for ' + ticket + ' and checked it is tracked by git.' })
`

const FAKE_CODEX = `#!${process.execPath}
// Stand-in for \`codex exec <prompt> --json\` as the independent reviewer.
const line = value => process.stdout.write(JSON.stringify(value) + '\\n')
line({ type: 'thread.started', thread_id: 'fake-thread-1' })
line({ type: 'item.completed', item: { type: 'agent_message', text: 'Reviewed the diff. APPROVE: one focused file, nothing else touched.' } })
line({ type: 'turn.completed' })
`

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})

let base
let child
const env = () => ({ ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, AGENT_CONTROL_STATE_DIR: path.join(home, 'agent-control'), QUORUM_MISSIONS_PATH: path.join(home, 'missions.json'), QUORUM_AGENT_RUN_ID: '' })

test.before(async () => {
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 })
  fs.mkdirSync(project, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'e2e@example.invalid')
  git('config', 'user.name', 'e2e')
  fs.writeFileSync(path.join(project, 'package.json'), '{ "name": "demo-app" }\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')

  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...env(), PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000)
    child.stdout.on('data', data => { if (String(data).includes(`:${port}`)) { clearTimeout(timer); resolve() } })
    child.on('exit', code => reject(new Error(`server exited ${code}`)))
  })
})
defer(test, () => stopChild(child))

const quorum = args => new Promise((resolve, reject) => {
  const run = spawn(process.execPath, [cli, ...args], { env: { ...env(), QUORUM_URL: base, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const timer = setTimeout(() => { run.kill('SIGKILL'); reject(new Error(`quorum ${args.join(' ')} timed out`)) }, 30_000)
  run.stdout.on('data', data => { stdout += data })
  run.stderr.on('data', data => { stderr += data })
  run.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
})
const json = async args => {
  const r = await quorum([...args, '--json'])
  assert.equal(r.status, 0, `quorum ${args.join(' ')}: ${r.stderr}`)
  return JSON.parse(r.stdout)
}
async function until(check, what, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('a mention becomes a verified, reviewed, priced run whose result lands back in the thread', async () => {
  const rooms = await until(async () => {
    const hq = await json(['hq'])
    return hq.rooms.some(room => room.id === 'demo-app') && hq.rooms
  }, 'the project room to be discovered')
  assert.ok(rooms)
  const founded = await quorum(['hq', 'init', 'Acme', '--template', 'solo', '--room', 'demo-app', '--mission', 'Prove the loop'])
  assert.equal(founded.status, 0, founded.stderr)

  const said = await quorum(['say', '#general', '@codey add HQ-E2E.md describing the demo'])
  assert.match(said.stdout, /T-1 opened for @codey/)
  const approval = await until(async () => (await json(['inbox'])).approvals.find(item => item.ticketId === 'T-1'), 'the approval request')
  assert.match(approval.summary, /Codey wants to start T-1 on claude in Demo App/)

  const approved = await quorum(['approve', approval.id])
  assert.equal(approved.status, 0, approved.stderr)
  assert.match(approved.stdout, /T-1 started, run /)

  const detail = await until(async () => {
    const value = await json(['ticket', 'show', 'T-1'])
    return value.ticket.status === 'done' && value
  }, 'T-1 to be done')
  assert.equal(detail.ticket.verified, true, 'done means the evidence gate and the reviewer both passed')
  assert.equal(detail.ticket.checkout, null)
  assert.equal(detail.ticket.runs[0].costUsd, 0.0123, 'the price is the provider’s own')
  const reply = detail.thread.find(message => message.author.kind === 'agent' && message.author.id === 'codey' && /Added HQ-E2E\.md for T-1/.test(message.text))
  assert.ok(reply, 'the agent reports in its own words, from its own run')
  const card = detail.thread.find(message => message.card?.type === 'run' && message.card.event === 'finished')
  assert.equal(card.card.ticketStatus, 'done')
  assert.ok(card.card.checks.some(check => /independent-review: approve/.test(check)), 'the independent review is on the card')
  assert.equal(card.card.unpriced, 1, 'the codex review reported no price and is counted as such')
  assert.ok(fs.existsSync(path.join(project, 'HQ-E2E.md')), 'the work really happened in the project')

  const budget = await json(['budget'])
  const codey = budget.agents.find(agent => agent.id === 'codey')
  assert.equal(codey.budget.spentUsd, 0.01)
  assert.equal(codey.budget.unpricedRuns, 1)
  const mission = (await (await fetch(`${base}/api/missions`)).json()).missions.find(item => item.title.startsWith('T-1'))
  assert.equal(mission.tasks[0].status, 'completed', 'the mission the ticket ran as agrees')

  // The board can also start work directly. `ticket start --yes` previews,
  // then confirms that exact plan by its hash; the agent's own ask for the
  // same ticket is superseded rather than left to start a second run.
  const second = await quorum(['say', '#general', '@codey add a second line to HQ-E2E.md'])
  assert.match(second.stdout, /T-2 opened for @codey/)
  const ask = await until(async () => (await json(['inbox'])).approvals.find(item => item.ticketId === 'T-2'), 'the second ask')
  const started = await quorum(['ticket', 'start', 'T-2', '--yes'])
  assert.equal(started.status, 0, started.stderr)
  assert.match(started.stdout, /T-2 → codey on claude[\s\S]*ready to start[\s\S]*T-2 started — run /)
  const done = await until(async () => {
    const value = await json(['ticket', 'show', 'T-2'])
    return !['todo', 'in_progress'].includes(value.ticket.status) && value
  }, 'T-2 to finish')
  assert.equal(done.ticket.status, 'done', JSON.stringify(done.thread.map(message => message.text).slice(-4)))
  assert.equal(done.ticket.verified, true)
  assert.equal(done.ticket.runs[0].approvedBy, 'board')
  assert.equal(done.approvals.find(item => item.id === ask.id).status, 'superseded')

  const verify = await quorum(['hq', 'verify'])
  assert.equal(verify.status, 0, verify.stdout)
})
