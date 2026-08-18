import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')

// public/app.js is a plain browser script with no module boundary, so lift the
// chat composer and the chat.opened handler out of it and drive them against
// stub nodes (same approach as composio-render.test.mjs).
function loadChat(S) {
  const start = APP.indexOf('/* ── chat with a running agent')
  assert.notEqual(start, -1, 'chat section not found in public/app.js')
  const end = APP.indexOf('function renderAll()')
  const sectionSrc = APP.slice(start, end)
  const handlerSrc = APP.match(/^ {2}'chat\.opened'\(m\) \{[\s\S]*?^ {2}\},$/m)
  assert.ok(handlerSrc, "'chat.opened' handler not found in public/app.js")

  const node = () => ({ value: '', textContent: '', innerHTML: '', disabled: false, focus() {}, classList: { contains: () => false, remove() {}, add() {} }, appendChild() {} })
  const nodes = {}
  for (const id of ['chat-form', 'chat-input', 'chat-send', 'chat-log', 'chat-target', 'chat-hint', 'drawer']) nodes[id] = node()
  const $ = id => nodes[id]

  const sent = []
  const timers = []
  const terms = []
  const activated = []
  const factory = new Function(
    '$', 'S', 'send', 'setTimeout', 'document', 'ensureTerm', 'activateTerm', 'renderAvatars',
    `${sectionSrc}\nconst H = {\n${handlerSrc[0]}\n}\n` +
    'return { submit: $("chat-form").onsubmit, chatOpened: H["chat.opened"] }')

  const api = factory(
    $, S,
    m => sent.push(m),
    (fn, ms) => timers.push({ fn, ms }),
    { createElement: () => node() },
    (id, profile) => terms.push({ id, profile }),
    id => activated.push(id),
    () => {})

  return { ...api, nodes, sent, timers, terms, activated }
}

const AGENTS = { agents: [{ sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'claude', projectId: 'portal', chatCapable: true }] }
const runTimers = timers => { for (const t of timers.splice(0)) t.fn() }

// The bug: the message was typed into S.activeTerm 2.5s after chat.open. A
// pty.attach never switches the active tab, so that is whatever terminal the
// user already had open — often a raw `zsh`, which would execute the chat text
// as a shell command.
test('chat message is typed into the resumed chat pty, not the already-active terminal', () => {
  const S = { chatTarget: AGENTS.agents[0].sessionId, chatPending: null, activeTerm: 't1', agents: AGENTS }
  const c = loadChat(S)
  c.nodes['chat-input'].value = 'ship it'

  c.submit({ preventDefault() {} })
  const open = c.sent.find(x => x.type === 'chat.open')
  assert.ok(open, 'chat.open was not sent')
  assert.ok(open.requestId, 'chat.open carries no requestId to correlate the answer')

  // Server answers with the pty it actually resumed the session in.
  c.chatOpened({ type: 'chat.opened', id: 't7', requestId: open.requestId })
  runTimers(c.timers)

  const input = c.sent.filter(x => x.type === 'pty.input')
  assert.equal(input.length, 1)
  assert.equal(input[0].id, 't7')
  assert.notEqual(input[0].id, S.activeTerm)
  assert.equal(input[0].data, 'ship it\r')
  assert.deepEqual(c.activated, ['t7'])
})

test('an answer for a different request never types into this one', () => {
  const S = { chatTarget: AGENTS.agents[0].sessionId, chatPending: null, activeTerm: 't1', agents: AGENTS }
  const c = loadChat(S)
  c.nodes['chat-input'].value = 'ship it'
  c.submit({ preventDefault() {} })

  c.chatOpened({ type: 'chat.opened', id: 't9', requestId: 'someone-elses-request' })
  runTimers(c.timers)
  assert.equal(c.sent.filter(x => x.type === 'pty.input').length, 0)
})

// Each chat.open spawns a `claude --resume` against a live transcript, so a
// double-submit must not fire two of them.
test('a second submit while chat.open is in flight is ignored', () => {
  const S = { chatTarget: AGENTS.agents[0].sessionId, chatPending: null, activeTerm: null, agents: AGENTS }
  const c = loadChat(S)
  c.nodes['chat-input'].value = 'ship it'
  c.submit({ preventDefault() {} })
  c.nodes['chat-input'].value = 'ship it'
  c.submit({ preventDefault() {} })

  assert.equal(c.sent.filter(x => x.type === 'chat.open').length, 1)
  assert.equal(c.nodes['chat-send'].disabled, true)

  // …and the composer re-opens once the server answers.
  const open = c.sent.find(x => x.type === 'chat.open')
  c.chatOpened({ type: 'chat.opened', id: 't7', requestId: open.requestId })
  assert.equal(c.nodes['chat-send'].disabled, false)
  assert.equal(S.chatPending, null)
})

// If the answer never arrives (socket dropped, server threw) the composer must
// not stay wedged shut.
test('an unanswered chat.open releases the composer on timeout', () => {
  const S = { chatTarget: AGENTS.agents[0].sessionId, chatPending: null, activeTerm: null, agents: AGENTS }
  const c = loadChat(S)
  c.nodes['chat-input'].value = 'ship it'
  c.submit({ preventDefault() {} })
  assert.equal(c.nodes['chat-input'].disabled, true)

  runTimers(c.timers)
  assert.equal(S.chatPending, null)
  assert.equal(c.nodes['chat-input'].disabled, false)
  assert.equal(c.sent.filter(x => x.type === 'pty.input').length, 0)
})
