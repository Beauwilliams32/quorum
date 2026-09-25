import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { withinDir, isAllowedOrigin, stripAnsi, parseReviewerDecision } from '../src/util.js'

test('withinDir accepts the directory itself and its children', () => {
  const pub = path.join('/srv', 'app', 'public')
  assert.equal(withinDir(pub, pub), true)
  assert.equal(withinDir(path.join(pub, 'index.html'), pub), true)
  assert.equal(withinDir(path.join(pub, 'sub', 'a.js'), pub), true)
})

test('withinDir rejects siblings that merely share the prefix', () => {
  const pub = path.join('/srv', 'app', 'public')
  // A bare startsWith() would accept both of these.
  assert.equal(withinDir(path.join('/srv', 'app', 'public-old', 'x.js'), pub), false)
  assert.equal(withinDir(path.join('/srv', 'app', 'public2', 'x.js'), pub), false)

  const projects = path.join('/home', 'u', '.claude', 'projects')
  assert.equal(withinDir(path.join('/home', 'u', '.claude', 'projects-archive', 's.jsonl'), projects), false)
  assert.equal(withinDir(path.join(projects, 'p', 's.jsonl'), projects), true)
})

test('isAllowedOrigin accepts only our own loopback origins', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:4747', 4747), true)
  assert.equal(isAllowedOrigin('http://localhost:4747', 4747), true)
  assert.equal(isAllowedOrigin('http://[::1]:4747', 4747), true)
  // Non-browser clients send no Origin at all; a hostile page cannot omit it.
  assert.equal(isAllowedOrigin(undefined, 4747), true)
  assert.equal(isAllowedOrigin('', 4747), true)
})

test('isAllowedOrigin rejects foreign pages, wrong ports and opaque origins', () => {
  assert.equal(isAllowedOrigin('https://evil.example', 4747), false)
  assert.equal(isAllowedOrigin('http://evil.example:4747', 4747), false)
  // Lookalike hostnames that a bare substring check would let through.
  assert.equal(isAllowedOrigin('http://localhost.evil.example:4747', 4747), false)
  assert.equal(isAllowedOrigin('http://127.0.0.1.evil.example:4747', 4747), false)
  // Another local service on a different port is still a different origin.
  assert.equal(isAllowedOrigin('http://127.0.0.1:3000', 4747), false)
  // Sandboxed iframes and file:// pages send Origin: null — any site can arrange that.
  assert.equal(isAllowedOrigin('null', 4747), false)
  assert.equal(isAllowedOrigin('file://', 4747), false)
})

test('reviewer verdict parsing handles terminal ANSI and requires a final verdict line', () => {
  assert.equal(stripAnsi('\u001b[32mAPPROVE\u001b[0m'), 'APPROVE')
  assert.deepEqual(parseReviewerDecision('\u001b[32mAPPROVE:\u001b[0m focused tests passed'), {
    decision: 'APPROVE',
    reasoning: 'focused tests passed',
  })
  assert.deepEqual(parseReviewerDecision('notes first\nREJECT unsafe lifecycle\nneeds a regression test'), {
    decision: 'REJECT',
    reasoning: 'unsafe lifecycle\nneeds a regression test',
  })
  assert.equal(parseReviewerDecision('The word APPROVE appeared in analysis, but there is no verdict line.'), null)
  // Structured provider output arrives with its whitespace collapsed, so a
  // verdict that closes a sentence has to be read as a verdict.
  assert.deepEqual(parseReviewerDecision('The diff is focused and tested. APPROVE: tests cover the change'), {
    decision: 'APPROVE',
    reasoning: 'tests cover the change',
  })
})

test('the last verdict wins, so a reviewer that rejects is never read as approving', () => {
  // The reviewer's own probe string. A leftmost match read this as APPROVE and
  // marked the mission task completed; the reviewer had rejected it.
  assert.deepEqual(parseReviewerDecision('I reviewed the change. APPROVE is not warranted because the migration drops rows. REJECT'), {
    decision: 'REJECT',
    reasoning: '',
  })
  // The mirror image: a reviewer who talks about rejecting and then approves.
  assert.equal(parseReviewerDecision('REJECT would be harsh. The tests cover it. APPROVE').decision, 'APPROVE')
  // Multiple verdict lines: the closing one is the verdict.
  assert.deepEqual(parseReviewerDecision('APPROVE: looked fine at first\nREJECT: the migration drops rows'), {
    decision: 'REJECT',
    reasoning: 'the migration drops rows',
  })
  // A verdict word buried mid-sentence is still not a verdict.
  assert.equal(parseReviewerDecision('I would not APPROVE this, nor would I REJECT it outright'), null)
})

// End-to-end: the same handshake gate server.js installs must refuse a
// cross-origin upgrade, which is the RCE path (pty.create → pty.input).
test('websocket upgrade is refused for a foreign Origin', async () => {
  const server = http.createServer()
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ origin }) => isAllowedOrigin(origin, server.address()?.port),
  })
  wss.on('connection', ws => ws.send('hello'))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const url = `ws://127.0.0.1:${port}/ws`

  const connect = origin => new Promise(resolve => {
    const ws = new WebSocket(url, origin ? { origin } : {})
    ws.on('open', () => { ws.close(); resolve('open') })
    ws.on('error', () => resolve('rejected'))
  })

  assert.equal(await connect('https://evil.example'), 'rejected')
  assert.equal(await connect(`http://127.0.0.1:${port}`), 'open')
  assert.equal(await connect(null), 'open')

  wss.close()
  await new Promise(r => server.close(r))
})
