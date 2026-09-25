// The HQ half of the `quorum` CLI, end to end: the real server.js on a
// scratch HOME and an OS-assigned port (never 4747), and the real bin/quorum
// spawned against it. Nothing here can start a paid run — no agent in this
// company has a workspace, so every hand-off stops at "I can't start" — and
// that refusal is itself asserted, because saying why is the contract.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defer, scratchDir, stopChild } from './helpers/scratch.mjs'
import { fit, formatInbox, formatMessages, formatOrg, renderTopFrame, safe, safeDeep, visibleLength, wrap } from '../src/hq/format.js'
import { parseArgs } from '../src/hq/cli.js'
import pty from 'node-pty'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin', 'quorum')
const home = scratchDir(test, 'quorum-hq-cli-home-')

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})

let base
let child
test.before(async () => {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, HOME: home, PORT: String(port), AGENT_CONTROL_STATE_DIR: path.join(home, 'agent-control'), QUORUM_MISSIONS_PATH: path.join(home, 'missions.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000)
    child.stdout.on('data', data => { if (String(data).includes(`:${port}`)) { clearTimeout(timer); resolve() } })
    child.on('exit', code => reject(new Error(`server exited ${code}`)))
  })
})
defer(test, () => stopChild(child))

const quorum = (args, env = {}) => new Promise((resolve, reject) => {
  const run = spawn(process.execPath, [cli, ...args], { env: { ...process.env, HOME: home, QUORUM_URL: base, NO_COLOR: '1', QUORUM_AGENT_RUN_ID: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const timer = setTimeout(() => { run.kill('SIGKILL'); reject(new Error(`quorum ${args.join(' ')} timed out`)) }, 30_000)
  run.stdout.on('data', data => { stdout += data })
  run.stderr.on('data', data => { stderr += data })
  run.on('error', reject)
  run.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
})
const ok = r => { assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}${r.stdout}`); return r.stdout }
const json = r => JSON.parse(ok(r))

async function until(check, what) {
  for (let i = 0; i < 40; i += 1) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('before founding, `quorum hq` says how to found the company', async () => {
  assert.match(ok(await quorum(['hq'])), /not founded yet[\s\S]*quorum hq init/)
  assert.equal(json(await quorum(['hq', '--json'])).ready, false)
  const top = await quorum(['top', '--once'])
  assert.match(top.stdout, /HQ is not set up on this cockpit yet/)
})

test('`quorum hq init` founds it; `org` draws the chart and `team` lists everyone', async () => {
  const founded = ok(await quorum(['hq', 'init', 'Acme Robotics', '--mission', 'Ship the cockpit', '--template', 'studio']))
  assert.match(founded, /QUORUM HQ\s+Acme Robotics/)
  assert.match(founded, /Dashboard: http:\/\/127\.0\.0\.1:\d+\/\?view=hq/)
  const org = ok(await quorum(['org'])).split('\n')
  assert.match(org[0], /^The board/)
  assert.match(org[1], /^└─ Atlas · Chief of Staff · claude/)
  assert.ok(org.some(line => /│  ├─ Sentry · QA Engineer/.test(line)), 'reports nest under their manager')
  assert.equal(json(await quorum(['team', '--json'])).agents.length, 6)
  assert.equal((await quorum(['hq', 'init', 'Again'])).status, 1, 'a company is founded once')
})

test('`quorum say` hands work out with an @mention, and the agent says why it cannot start', async () => {
  const said = ok(await quorum(['say', '#general', '@scout map every place a session is created']))
  assert.match(said, /T-1 opened for @scout: map every place a session is created/)
  const ticket = await until(async () => {
    const { tickets } = json(await quorum(['ticket', 'list', '--json']))
    return tickets.find(item => item.id === 'T-1' && item.status === 'blocked')
  }, 'T-1 to be refused')
  assert.equal(ticket.assigneeId, 'scout')
  const detail = json(await quorum(['ticket', 'show', 'T-1', '--json']))
  assert.ok(detail.thread.some(message => message.author.kind === 'agent' && /I can't start T-1/.test(message.text)))
  const start = await quorum(['ticket', 'start', 'T-1'])
  assert.equal(start.status, 1)
  assert.match(start.stdout, /cannot start:/)
  const forced = await quorum(['ticket', 'start', 'T-1', '--yes'])
  assert.equal(forced.status, 1, '--yes confirms only a plan that can start')
  assert.match(forced.stdout, /cannot start:/)
  assert.doesNotMatch(forced.stdout, /started — run/)
  assert.match(ok(await quorum(['chat', 'T-1'])), /Scout\s+I can't start T-1: /)
})

test('tickets, goals, channels and hires from the terminal', async () => {
  assert.match(ok(await quorum(['goal', 'add', 'Public beta', '--description', 'A buyer finishes a ticket'])), /G-1 Public beta/)
  assert.match(ok(await quorum(['ticket', 'new', 'Write the changelog', '--goal', 'G-1', '--priority', 'high', '--verify', 'npm test'])), /T-2 opened: Write the changelog/)
  const t2 = json(await quorum(['ticket', 'show', 'T-2', '--json'])).ticket
  assert.equal(t2.goalId, 'G-1')
  assert.deepEqual(t2.verifyCommand.args, ['test'])
  assert.match(ok(await quorum(['channel', 'new', 'feat-auth', '--topic', 'Auth rewrite'])), /#feat-auth created/)
  assert.match(ok(await quorum(['hire', 'Nova', '--title', 'Content Lead', '--runtime', 'claude', '--reports-to', 'atlas', '--budget', '12'])), /Hired Nova \(nova\) as Content Lead · claude · \$12\.00\/mo · supervised/)
  const refused = await quorum(['terminate', 'nova'])
  assert.equal(refused.status, 1)
  assert.match(refused.stdout, /Re-run with --yes/)
  assert.match(ok(await quorum(['terminate', 'nova', '--yes'])), /Nova terminated/)
  assert.match(ok(await quorum(['convene', '#general', 'Should runs default to supervised?'])), /8 turns[\s\S]*Re-run with --yes/)
  assert.equal((await quorum(['ticket', 'assign', 'T-2'])).status, 2, 'a missing argument is a usage error')
  const missing = await quorum(['ticket', 'show', 'T-99'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /unknown ticket: T-99/)
})

test('routines and search from the terminal', async () => {
  assert.match(ok(await quorum(['routine', 'add', 'Dependency audit', '--assign', '@scout', '--every', '1d'])), /R-1\s+active\s+every 1d\s+@scout\s+Dependency audit/)
  const tooOften = await quorum(['routine', 'add', 'Spam', '--assign', 'scout', '--every', '5m'])
  assert.equal(tooOften.status, 1)
  assert.match(tooOften.stderr, /every 15m to 30d/)
  assert.equal(json(await quorum(['routine', 'list', '--json'])).routines[0].every, '1d')
  assert.match(ok(await quorum(['routine', 'run', 'R-1'])), /R-1 opened T-\d+ for @scout\./)
  assert.match(ok(await quorum(['routine', 'run', 'R-1'])), /R-1 skipped its turn: T-\d+ is still/)
  assert.match(ok(await quorum(['routine', 'pause', 'R-1'])), /R-1 is paused\./)
  const found = ok(await quorum(['search', 'session', 'is', 'created']))
  assert.match(found, /TICKETS \(1\)[\s\S]*T-1[\s\S]*MESSAGES/)
  assert.match(found, /#general \S+ \S+ You: @scout map every place a session is created/)
  const phrase = json(await quorum(['search', 'session is created', '--json']))
  assert.deepEqual(phrase.query.terms, ['session is created'], 'an argument with spaces stays one phrase')
  assert.equal((await quorum(['search'])).status, 2)
})

test('a routine is handed over from the terminal, a quoted search keeps its filter, and search answers only this cockpit', async () => {
  assert.match(ok(await quorum(['routine', 'edit', 'R-1', '--assign', 'pixel', '--every', '1w'])), /R-1\s+paused\s+every 1w\s+@pixel/)
  assert.equal((await quorum(['routine', 'edit', 'R-1'])).status, 2, 'an edit with nothing to change is a usage error')
  const filtered = json(await quorum(['search', 'session in:#general', '--json']))
  assert.deepEqual(filtered.query, { terms: ['session'], channel: 'general', author: null }, 'a filter inside a quoted argument still filters')
  const get = headers => new Promise((resolve, reject) => {
    http.get(`${base}/api/hq/search?q=session`, { headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) }).on('error', reject)
  })
  assert.equal(await get({}), 200, 'the CLI and other clients outside a browser')
  assert.equal(await get({ 'sec-fetch-site': 'same-origin' }), 200, 'the cockpit\'s own dashboard')
  assert.equal(await get({ 'sec-fetch-site': 'cross-site' }), 403, 'a page on another site cannot make it scan the history')
  assert.equal(await get({ origin: 'https://evil.example' }), 403)
})

test('a write that names a run acts as that run — and one that is not live is refused, not run as the board', async () => {
  const refused = await quorum(['say', '#general', 'hello from a run'], { QUORUM_AGENT_RUN_ID: 'run-not-live' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /run run-not-live is not a live HQ run/)
  assert.equal(json(await quorum(['hq', '--json'], { QUORUM_AGENT_RUN_ID: 'run-not-live' })).ready, true, 'reads are the same for everyone')
})

test('inbox, budget, activity and the signed log', async () => {
  assert.match(ok(await quorum(['inbox'])), /APPROVALS \(\d+\)[\s\S]*BLOCKED \(\d+\)/)
  const budget = json(await quorum(['budget', '--json']))
  assert.ok(budget.agents.length >= 6)
  assert.ok(budget.dailyCeiling && typeof budget.dailyCeiling.reason === 'string')
  assert.match(ok(await quorum(['activity', '--limit', '5'])), /#\d+/)
  assert.match(ok(await quorum(['hq', 'verify'])), /✓ log intact — \d+ signed messages verified/)
})

test('`quorum top --once` renders one full frame of the live dashboard', async () => {
  const frame = ok(await quorum(['top', '--once'])).replace(/\n$/, '').split('\n')
  assert.equal(frame.length, 32, 'exactly one screen of rows when stdout is not a terminal')
  assert.match(frame[0], /QUORUM HQ\s+Acme Robotics/)
  assert.ok(frame.some(line => /^TEAM\s+│ INBOX/.test(line)))
  assert.ok(frame.some(line => /Scout · Research Lead/.test(line)))
  assert.match(frame.at(-1), /q quit/)
  assert.ok(frame.every(line => [...line].length === frame[0].length), 'every row is the same width')
})

test('interactive `quorum top` takes the screen, animates, and gives the terminal back on q', async () => {
  const term = pty.spawn(process.execPath, [cli, 'top', '--interval', '1'], {
    name: 'xterm-256color', cols: 120, rows: 34, cwd: root,
    env: { ...process.env, HOME: home, QUORUM_URL: base, QUORUM_AGENT_RUN_ID: '' },
  })
  let output = ''
  term.onData(data => { output += data })
  const exited = new Promise(resolve => term.onExit(resolve))
  await until(async () => (output.match(/\x1b\[H/g) || []).length >= 3, 'three frames')
  term.write('q')
  const { exitCode } = await exited
  assert.equal(exitCode, 0)
  assert.ok(output.includes('\x1b[?1049h'), 'the alternate screen was entered')
  assert.ok(output.includes('\x1b[?1049l') && output.includes('\x1b[?25h'), 'the screen and the cursor were given back')
  assert.match(output, /QUORUM HQ/)
})

// ── the terminal renderer on its own ─────────────────────────────────────

test('wrapping never drops a word longer than the line, and fitting counts visible columns only', () => {
  const url = `https://example.com/${'x'.repeat(70)}`
  const lines = wrap(`see ${url} for details`, 30)
  assert.equal(lines.join('').replace(/\s/g, ''), `see${url}fordetails`, 'every character survives the wrap')
  assert.ok(lines.every(line => line.length <= 30))
  const coloured = `\x1b[36mcyan\x1b[0m text`
  assert.equal(visibleLength(fit(coloured, 20)), 20)
  assert.equal(visibleLength(fit(coloured, 6)), 6)
  assert.match(fit(coloured, 6), /…\x1b\[0m$/, 'a cut through colour still resets it')
})

test('`quorum top` frames: unreachable is said plainly, and the spinner turns only for a live run', () => {
  const down = renderTopFrame(null, null, { width: 80, height: 20, now: 0 }).split('\n')
  assert.equal(down.length, 20)
  assert.ok(down.some(line => /Cannot reach the Quorum cockpit/.test(line)))
  const agent = state => ({ id: 'codey', name: 'Codey', title: 'Engineer', runtime: 'codex', status: 'active', createdAt: '1', dispatchable: true, presence: state, budget: { state: 'ok', pct: 10, spentUsd: 1, limitUsd: 10, unpricedRuns: 0 } })
  const company = presence => ({ ready: true, company: { name: 'Acme' }, agents: [agent(presence)], tickets: [], approvals: [], messages: [], totals: { agents: 1, working: presence.state === 'working' ? 1 : 0, waiting: 0, openTickets: 0, spentUsd: 1, limitUsd: 10, month: '2026-09' } })
  const frames = presence => [0, 1].map(tick => renderTopFrame(company(presence), { status: 'ok', readiness: { cockpit: 'ready' } }, { width: 100, height: 24, tick, now: 0 }))
  const [idleA, idleB] = frames({ state: 'idle' })
  assert.equal(idleA, idleB, 'nothing moves when nobody is working')
  const [workA, workB] = frames({ state: 'working', ticketId: 'T-1', phase: 'tool' })
  assert.notEqual(workA, workB, 'a live run animates')
  assert.match(workA, /working T-1 · tool/)
})

test('stored text reaches the terminal as text: control sequences are stripped before printing', () => {
  const hostile = 'Evil\x1b]52;c;cm0gLXJmIH4=\x07\x1b[2J\x1b[1;1Happroved by the board\x9b31m\r\nnext\tline\x7f'
  assert.equal(safe(hostile), 'Evil]52;c;cm0gLXJmIH4=[2J[1;1Happroved by the board31m\nnext\tline')
  assert.deepEqual(safeDeep({ a: [hostile], b: { c: 1, d: null } }).a[0], safe(hostile))
  const agent = { id: 'evil', name: hostile, title: hostile, runtime: 'claude', status: 'active', createdAt: '1', dispatchable: true, presence: { state: 'idle' }, budget: { state: 'ok', pct: 0, spentUsd: 0, limitUsd: 1, unpricedRuns: 0 } }
  const hq = { ready: true, company: { name: hostile }, agents: [agent], tickets: [{ id: 'T-1', title: hostile, status: 'todo', priority: 'normal' }], approvals: [{ id: 'A-1', status: 'pending', summary: hostile }], messages: [{ id: 'm1', channelId: 'general', author: { kind: 'agent', id: 'evil' }, text: hostile, at: '2026-09-25T10:00:00Z' }], totals: { agents: 1, working: 0, waiting: 0, openTickets: 1, spentUsd: 0, limitUsd: 1, month: '2026-09' } }
  const frame = renderTopFrame(hq, { status: 'ok', readiness: { cockpit: 'ready' } }, { width: 120, height: 30, now: 0 })
  assert.doesNotMatch(frame, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/, 'no control character survives into the frame')
  assert.doesNotMatch(formatMessages(hq.messages, hq).join('\n'), /[\x1b\x07\x9b]/)
  assert.doesNotMatch(formatOrg(safeDeep(hq)).join('\n'), /[\x1b\x07\x9b]/)
})

test('--force is a flag, never a value-taking option', () => {
  const { flags, positional } = parseArgs(['hq', 'init', 'Acme', '--force', '--template', 'solo'])
  assert.equal(flags.force, true)
  assert.equal(flags.template, 'solo')
  assert.deepEqual(positional, ['hq', 'init', 'Acme'])
})

test('`quorum inbox` prints a hire proposal\'s whole brief, since every run it makes carries it', () => {
  const brief = `${'Cite files before editing. '.repeat(8)}\nFINAL LINE: never push to main.`
  const lines = formatInbox({ approvals: [{ id: 'A-4', kind: 'hire', status: 'pending', summary: 'codey proposes hiring Ava', proposal: { instructions: brief } }], tickets: [], agents: [] })
  const out = lines.join('\n')
  assert.match(out, /brief \(\d+ chars\):/)
  assert.match(out, /FINAL LINE: never push to main\./, 'the end of a long brief is printed, not cut')
  assert.ok(lines.every(line => visibleLength(line) <= 100), 'wrapped to the terminal')
})
