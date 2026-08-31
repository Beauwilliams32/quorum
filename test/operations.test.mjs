import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOperations } from '../src/operations.js'

test('buildOperations projects local state without transcripts or credentials', () => {
  const result = buildOperations({
    sessions: { cards: [{ id: 's1', agent: 'claude', model: 'sonnet', summary: '  hello\nworld  ', active: true, secret: 'nope' }] },
    agents: { agents: [{ sessionId: 's1', name: 'Claude', chatCapable: true, status: 'busy' }] },
    projects: { rooms: [{ id: 'portal' }] },
    services: { openclaw: { up: true, port: 18790 }, hermes: { up: false }, comfy: { up: false } },
    tasks: { tasks: [{ id: 't1', subject: 'Ship', status: 'active', live: true }] },
    composio: { cliPresent: true, toolkits: ['github'] },
  }, [{ kind: 'note', ts: 1, text: '  event\ntext ' }], [{ id: 'pty-1', exited: false }], {
    runtimes: [{ id: 'claude', label: 'Claude', kind: 'cli', available: true, authReady: true, capabilities: ['chat', 'code'] }],
  })

  assert.deepEqual(result.overview, { activeSessions: 1, sessions: 1, agents: 1, trackedPtys: 1, skills: 2, nodes: 2 })
  assert.equal(result.sessions[0].summary, 'hello world')
  assert.equal(result.sessions[0].secret, undefined)
  assert.equal(result.nodes.find(node => node.id === 'openclaw').detail, '127.0.0.1:18790')
  assert.equal(result.channels.find(channel => channel.id === 'composio').detail, '1 local toolkits')
  assert.equal(result.events[0].text, 'event text')
  assert.equal(JSON.stringify(result).includes('nope'), false)
})

test('buildOperations redacts prompt-bearing local text before it reaches the projection', () => {
  const result = buildOperations({
    sessions: { cards: [{ id: 's', summary: 'prompt: do not expose this' }] },
    tasks: { tasks: [{ id: 't', subject: 'prompt from a task', status: 'pending' }] },
  }, [{ kind: 'log', ts: 1, text: 'prompt from an event' }])
  assert.equal(JSON.stringify(result).includes('prompt'), false)
  assert.match(result.sessions[0].summary, /\[redacted\]/)
  assert.match(result.cronJobs[0].subject, /\[redacted\]/)
  assert.match(result.events[0].text, /\[redacted\]/)
})
