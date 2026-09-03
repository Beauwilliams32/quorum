import test from 'node:test'
import assert from 'node:assert/strict'
import { createLineParser, parseRuntimeLine, redactRuntimeText } from '../src/runtime-events.js'

test('Claude stream-json events become bounded lifecycle events', () => {
  assert.deepEqual(parseRuntimeLine('claude', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-123' })), { type: 'started', sessionId: 'claude-123', phase: 'init', text: '' })
  assert.deepEqual(parseRuntimeLine('claude', JSON.stringify({ type: 'assistant', session_id: 'claude-123', message: { content: [{ type: 'text', text: 'working' }] } })), { type: 'assistant', sessionId: 'claude-123', text: 'working' })
  assert.equal(parseRuntimeLine('claude', JSON.stringify({ type: 'result', subtype: 'success', session_id: 'claude-123', result: 'done' })).type, 'completed')
})

test('Codex JSONL events preserve thread identity and terminal state', () => {
  assert.equal(parseRuntimeLine('codex', JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })).sessionId, 'thread-1')
  assert.equal(parseRuntimeLine('codex', JSON.stringify({ type: 'item.completed', thread_id: 'thread-1', item: { type: 'agent_message', text: 'done' } })).type, 'assistant')
  assert.equal(parseRuntimeLine('codex', JSON.stringify({ type: 'turn.completed', thread_id: 'thread-1' })).type, 'completed')
})

test('line parser handles split JSON without leaking raw unbounded output', () => {
  const events = []
  const parser = createLineParser('claude', event => events.push(event))
  parser.push('{"type":"assistant","session_id":"s1","message":{"content":[{"type":"text","text":"hel')
  parser.push('lo"}]}}\n')
  parser.flush()
  assert.equal(events.length, 1)
  assert.equal(events[0].text, 'hello')
})

test('runtime redaction removes common credential formats before persistence', () => {
  const value = redactRuntimeText('github_pat_1234567890abcdef AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF token=super-secret -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----')
  assert.doesNotMatch(value, /github_pat_1234567890abcdef|AKIA1234567890ABCDEF|super-secret|BEGIN PRIVATE KEY/)
  assert.match(value, /redacted/)
})
