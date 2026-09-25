#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { debateToHtml, debateToMarkdown } from '../src/decision-record.js'

const demo = {
  id: 'demo-roundtable',
  topic: 'Should this service add a queue before the next release?',
  roomLabel: 'Example project',
  model: 'demo fixture',
  participants: ['vex', 'bolt'],
  costUsd: 0,
  startedAt: Date.UTC(2026, 8, 6, 12, 0),
  endedAt: Date.UTC(2026, 8, 6, 12, 4),
  phase: 'done',
  cancelled: false,
  error: null,
  turns: [
    { speaker: 'nib', speakerName: 'Nib', speakerRole: 'Moderator', phase: 'brief', body: 'The decision is whether throughput risk justifies queue complexity.', position: 'Judge throughput risk against operational complexity.', confidence: 90, failed: false },
    { speaker: 'vex', speakerName: 'Vex', speakerRole: 'Architect', phase: 'opening', position: 'Add a queue after measuring the bottleneck', confidence: 72, body: 'A queue is useful only if the current bottleneck is measured and the retry boundary is explicit.', failed: false },
    { speaker: 'bolt', speakerName: 'Bolt', speakerRole: 'Builder', phase: 'opening', position: 'Do not add a queue yet', confidence: 78, body: 'The service can ship a bounded synchronous path now; an unneeded queue adds deployment and debugging surface.', failed: false },
    { speaker: 'vex', speakerName: 'Vex', speakerRole: 'Architect', phase: 'clash', position: 'Measure first, then queue if the boundary is real', confidence: 68, body: 'Bolt is right that an unmeasured queue is architecture theatre. The first gate should be a load test.', targets: ['bolt'], conceded: false, failed: false },
    { speaker: 'bolt', speakerName: 'Bolt', speakerRole: 'Builder', phase: 'clash', position: 'Ship the bounded path and instrument it', confidence: 70, body: 'Vex is right about measuring the boundary. I concede that the instrumentation must land with the first release.', targets: ['vex'], conceded: true, failed: false },
    { speaker: 'vex', speakerName: 'Vex', speakerRole: 'Architect', phase: 'converge', position: 'Instrument now; queue only after the threshold is crossed', confidence: 86, body: 'The measured threshold is the decision gate, not a preselected technology.', failed: false },
    { speaker: 'bolt', speakerName: 'Bolt', speakerRole: 'Builder', phase: 'converge', position: 'Ship instrumentation before queueing', confidence: 84, body: 'I changed my position: the safe short path includes evidence for the later queue decision.', conceded: true, failed: false },
    { speaker: 'nib', speakerName: 'Nib', speakerRole: 'Moderator', phase: 'verdict', position: 'Instrument first; add a queue only if measured load crosses the agreed threshold.', confidence: 92, body: 'Ship instrumentation and a bounded synchronous path. Define the threshold and revisit the queue after the first load test.', failed: false },
  ],
}

function arg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const outDir = path.resolve(arg('--out-dir', 'dist/roundtable-demo'))
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'roundtable-demo.md'), debateToMarkdown(demo))
fs.writeFileSync(path.join(outDir, 'roundtable-demo.html'), debateToHtml(demo))
fs.writeFileSync(path.join(outDir, 'README.txt'), 'Synthetic, zero-cost demo fixture. It makes no provider calls and is not evidence of a live debate.\n')
console.log(`Wrote synthetic roundtable demo to ${outDir}`)
