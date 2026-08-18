import test from 'node:test'
import assert from 'node:assert/strict'
import { debateToMarkdown } from '../src/decision-record.js'

const turn = (o) => ({
  speaker: 'vex', speakerName: 'Vex', speakerRole: 'Architect',
  phase: 'opening', position: '', body: '', confidence: null,
  targets: [], conceded: false, failed: false, ...o,
})

const debate = {
  id: 'rt1', topic: 'Retry failed posts automatically?', roomLabel: 'Portal',
  model: 'sonnet', participants: ['vex', 'bolt'], costUsd: 0.42,
  startedAt: Date.UTC(2026, 7, 17, 9, 30), endedAt: Date.UTC(2026, 7, 17, 9, 34),
  phase: 'done', cancelled: false, error: null,
  turns: [
    turn({ speaker: 'nib', speakerName: 'Nib', speakerRole: 'Moderator', phase: 'brief', body: 'The decision is whether retries are automatic.' }),
    turn({ phase: 'opening', position: 'Retry automatically', confidence: 80, body: 'Idempotent writes make this safe.' }),
    turn({ speaker: 'bolt', speakerName: 'Bolt', speakerRole: 'Builder', phase: 'opening', position: 'Surface for review', confidence: 60, body: 'Cheaper to build.' }),
    turn({ phase: 'converge', position: 'Retry automatically', confidence: 85, body: 'Unmoved.' }),
    turn({ speaker: 'bolt', speakerName: 'Bolt', speakerRole: 'Builder', phase: 'converge', position: 'Retry, bounded', confidence: 40, conceded: true, body: 'Vex is right about the idempotency.' }),
    turn({ speaker: 'nib', speakerName: 'Nib', speakerRole: 'Moderator', phase: 'verdict', body: 'Retry with a bounded backoff.' }),
  ],
}

test('the record leads with the verdict', () => {
  const md = debateToMarkdown(debate)
  assert.match(md, /^# Retry failed posts automatically\?/)
  assert.match(md, /## Decision/)
  assert.match(md, /Retry with a bounded backoff\./)
})

test('the header records what the debate cost and who sat', () => {
  const md = debateToMarkdown(debate)
  assert.match(md, /vex, bolt/)
  assert.match(md, /\$0\.420/)
  assert.match(md, /`sonnet`/)
})

// Movement is the only evidence the debate did any work, so it has to be
// visible without reading the transcript.
test('the movement table shows confidence shifts and who held', () => {
  const md = debateToMarkdown(debate)
  assert.match(md, /## Movement/)
  assert.match(md, /80 → 85/)
  assert.match(md, /60 → 40 \(-20\)/)
})

// Agreeing with the verdict is not dissent. The room can converge on one
// answer from three different directions, and reporting that as dissent
// misrepresents what happened — so every final position is listed, with the
// concessions flagged rather than filtered out.
test('every final position is reported, with concessions flagged', () => {
  const md = debateToMarkdown(debate)
  const section = md.split('## Where each specialist landed')[1].split('## Full transcript')[0]
  assert.match(section, /Vex/)
  assert.match(section, /Bolt/)
  assert.match(section, /\*\*Bolt — Builder\*\* \(confidence 40\) — \*\*conceded\*\*/)
  assert.doesNotMatch(section, /\*\*Vex — Architect\*\* \(confidence 85\) — \*\*conceded\*\*/)
})

test('a cancelled debate is labelled partial rather than presented as a decision', () => {
  const md = debateToMarkdown({ ...debate, cancelled: true })
  assert.match(md, /Cancelled before conclusion/)
})

test('a failed debate surfaces the error', () => {
  const md = debateToMarkdown({ ...debate, error: 'turn timed out' })
  assert.match(md, /Failed: turn timed out/)
})

// A position containing a pipe would otherwise split the markdown row and
// silently shift every later column.
test('pipes in a position do not break the movement table', () => {
  const md = debateToMarkdown({
    ...debate,
    turns: [
      turn({ phase: 'opening', position: 'use a | b', confidence: 50, body: 'x' }),
      turn({ phase: 'converge', position: 'still a | b', confidence: 50, body: 'y' }),
    ],
  })
  const row = md.split('\n').find(l => l.includes('still a'))
  assert.ok(row.includes('\\|'), 'pipe should be escaped')
  assert.equal(row.split(/(?<!\\)\|/).length - 1, 6, 'row should still have 6 unescaped delimiters')
})

test('newlines in a position are flattened so the row stays one line', () => {
  const md = debateToMarkdown({
    ...debate,
    turns: [turn({ phase: 'converge', position: 'line one\nline two', confidence: 50, body: 'y' })],
  })
  assert.match(md, /line one line two/)
})

test('an empty or malformed debate produces a document rather than throwing', () => {
  assert.match(debateToMarkdown(null), /no such debate/)
  assert.doesNotThrow(() => debateToMarkdown({ topic: 'x' }))
  assert.doesNotThrow(() => debateToMarkdown({ topic: 'x', turns: 'not an array' }))
})

test('failed turns are shown in the transcript but excluded from the verdict lookup', () => {
  const md = debateToMarkdown({
    ...debate,
    turns: [...debate.turns, turn({ phase: 'verdict', speaker: 'nib', speakerName: 'Nib', failed: true, body: 'boom' })],
  })
  // The good verdict still leads the document.
  assert.match(md.split('## Movement')[0], /Retry with a bounded backoff/)
  assert.match(md, /FAILED/)
})
