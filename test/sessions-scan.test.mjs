// The sessions collector reads ~/.claude/projects, ~/.claude/jobs and
// ~/.codex/sessions, so it is exercised in a child process with HOME pointed at
// a scratch directory holding synthetic transcripts. Nothing under the real
// home is read or written.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CLAUDE_SESSION = '0123abcd-0000-4000-8000-000000000001'
const BG_SESSION = '9999beef-0000-4000-8000-000000000002'

function fixtureHome() {
  // Force HOME through a symlink so watcher path validation exercises the same
  // canonical-vs-logical path boundary found on macOS (/var -> /private/var).
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-sess-'))
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-sess-alias-'))
  const home = path.join(aliasRoot, 'home-link')
  fs.symlinkSync(realHome, home, 'dir')
  const proj = path.join(home, '.claude', 'projects', '-Users-someone-work')
  fs.mkdirSync(proj, { recursive: true })
  fs.mkdirSync(path.join(home, '.claude', 'jobs', BG_SESSION.slice(0, 8)), { recursive: true })

  const lines = [
    { type: 'user', cwd: '/Users/someone/work', gitBranch: 'feat/x', timestamp: 't1', message: { content: 'please fix the build' } },
    { type: 'assistant', timestamp: 't2', message: { model: 'claude-sonnet', content: [
      { type: 'thinking', thinking: 'hmm let me look' },
      { type: 'text', text: 'Looking at it now.' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/Users/someone/work/src/index.js' } },
    ] } },
    { type: 'user', timestamp: 't3', message: { content: [{ type: 'tool_result', content: 'file body', is_error: false }] } },
    { type: 'summary', summary: 'fixing build', timestamp: 't4' },
    'this is not json',
  ]
  fs.writeFileSync(path.join(proj, CLAUDE_SESSION + '.jsonl'), lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n')

  // A background-job session: no sessionKind, but a matching ~/.claude/jobs entry
  fs.writeFileSync(path.join(proj, BG_SESSION + '.jsonl'),
    JSON.stringify({ type: 'user', cwd: '/tmp/bg', message: { content: '<system-reminder>ignored</system-reminder>' } }) + '\n')

  // A stale session (older than 48h) that must not surface
  const stale = path.join(proj, 'stale-0000-4000-8000-000000000003.jsonl')
  fs.writeFileSync(stale, JSON.stringify({ type: 'user', cwd: '/tmp/stale', message: { content: 'old' } }) + '\n')
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  fs.utimesSync(stale, old, old)

  const day = path.join(home, '.codex', 'sessions', '2026', '08', '22')
  fs.mkdirSync(day, { recursive: true })
  const codex = [
    { type: 'session_meta', payload: { cwd: '/Users/someone/codexwork', model: 'gpt-5-codex' } },
    { timestamp: 'c1', payload: { type: 'task_started' } },
    { timestamp: 'c2', payload: { type: 'agent_reasoning', text: 'thinking about it' } },
    { timestamp: 'c3', payload: { type: 'exec_command_begin', command: ['ls', '-la'] } },
    { timestamp: 'c4', payload: { type: 'exec_command_end', exit_code: 2, aggregated_output: 'boom' } },
    { timestamp: 'c5', payload: { type: 'agent_message', message: 'All   done here' } },
  ]
  fs.writeFileSync(path.join(day, 'rollout-2026-08-22T10-00-00-deadbeef-1111-2222-3333-444444444444.jsonl'),
    codex.map(l => JSON.stringify(l)).join('\n') + '\n')
  return { home, claudeFile: path.join(proj, CLAUDE_SESSION + '.jsonl') }
}

function runInHome(home, body) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], {
    cwd: root, env: { ...process.env, HOME: home }, encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('startSessions builds cards from claude + codex transcripts, skips stale files, flags bg jobs', () => {
  const { home } = fixtureHome()
  const out = runInHome(home, `
    globalThis.setInterval = () => ({ unref() {} })
    const { startSessions } = await import('./src/collectors/sessions.js')
    let captured
    startSessions({ update: (k, v) => { captured = { k, v } } })
    process.stdout.write(JSON.stringify(captured))
  `)
  assert.equal(out.k, 'sessions')
  const cards = out.v.cards
  const ids = cards.map(c => c.id)
  assert.ok(ids.includes(CLAUDE_SESSION))
  assert.ok(ids.includes(BG_SESSION))
  assert.ok(ids.includes('deadbeef'), 'codex id is the 8-hex token from the rollout filename')
  assert.ok(!ids.some(i => i.startsWith('stale')), 'stale session must not surface')

  const fg = cards.find(c => c.id === CLAUDE_SESSION)
  assert.equal(fg.agent, 'claude')
  assert.equal(fg.cwd, '/Users/someone/work')
  assert.equal(fg.branch, 'feat/x')
  assert.equal(fg.kind, 'fg')
  assert.equal(fg.model, 'claude-sonnet')
  assert.equal(fg.summary, '→ Read index.js')
  assert.equal(fg.active, true)

  const bg = cards.find(c => c.id === BG_SESSION)
  assert.equal(bg.kind, 'bg', 'a ~/.claude/jobs entry marks the session as background')
  assert.equal(bg.summary, '', 'system-reminder user lines are not summaries')

  const cx = cards.find(c => c.id === 'deadbeef')
  assert.equal(cx.agent, 'codex')
  assert.equal(cx.cwd, '/Users/someone/codexwork')
  assert.equal(cx.model, 'gpt-5-codex')
  assert.equal(cx.summary, 'All done here')
})

test('TranscriptWatcher parses claude and codex events and streams appended lines', () => {
  const { home, claudeFile } = fixtureHome()
  const codexFile = path.join(home, '.codex', 'sessions', '2026', '08', '22',
    'rollout-2026-08-22T10-00-00-deadbeef-1111-2222-3333-444444444444.jsonl')
  const out = runInHome(home, `
    const { TranscriptWatcher } = await import('./src/collectors/sessions.js')
    const fs = await import('node:fs')
    const sent = []
    const ws = { readyState: 1, send: s => sent.push(JSON.parse(s)) }
    const w = new TranscriptWatcher(ws)
    w.watch(${JSON.stringify(claudeFile)})
    fs.appendFileSync(${JSON.stringify(claudeFile)}, JSON.stringify({ type: 'system', content: 'compacted', timestamp: 't9' }) + '\\n')
    w.poll()
    w.poll() // nothing new → no message
    w.stop()
    const w2 = new TranscriptWatcher(ws)
    w2.watch(${JSON.stringify(codexFile)}, 'codex')
    w2.stop()
    fs.writeFileSync(${JSON.stringify(path.join(home, 'outside.jsonl'))}, '{}\\n')
    let refused = null
    try { new TranscriptWatcher(ws).watch(${JSON.stringify(path.join(home, 'outside.jsonl'))}) } catch (e) { refused = e.message }
    process.stdout.write(JSON.stringify({ sent, refused, timer: w.timer }))
  `)
  assert.equal(out.timer, null, 'stop() clears the poll timer')
  assert.equal(out.sent.length, 3)
  const [initial, appended, codex] = out.sent
  assert.equal(initial.type, 'transcript')
  assert.equal(initial.reset, true)
  assert.deepEqual(initial.events.map(e => e.kind), ['user', 'thinking', 'assistant', 'tool', 'result', 'system'])
  assert.equal(initial.events[3].label, 'Read')
  assert.equal(initial.events[4].error, false)
  assert.equal(initial.events[5].body, 'summary: fixing build')

  assert.equal(appended.reset, false)
  assert.deepEqual(appended.events, [{ ts: 't9', kind: 'system', body: 'compacted' }])

  assert.deepEqual(codex.events.map(e => e.kind), ['system', 'thinking', 'tool', 'result', 'assistant'])
  assert.equal(codex.events[2].body, 'ls -la')
  assert.equal(codex.events[3].error, true, 'non-zero exit_code marks the result as an error')
  assert.equal(codex.events[3].body, 'boom')

  assert.match(out.refused, /outside session directories/)
})
