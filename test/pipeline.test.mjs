import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { newJobId, repurposeVideo, verifyVideo } from '../scripts/pipeline/pipeline.mjs'

const FFMPEG = 'ffmpeg'
const HAS_FFMPEG = (() => {
  try {
    const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return probe.status === 0
  } catch { return false }
})()

function makeLandscapeVideo(filePath, { duration = 6, width = 1920, height = 1080 } = {}) {
  // testsrc gives us a moving pattern that ffmpeg can produce without external
  // assets; the loud sine lets verify.py distinguish a real file from a stub.
  const args = [
    '-y', '-f', 'lavfi', '-i', `testsrc=duration=${duration}:size=${width}x${height}:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
    '-c:a', 'aac', '-shortest', filePath,
  ]
  const result = spawnSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr?.toString()}`)
}

test('newJobId returns 16 hex characters', () => {
  const id = newJobId()
  assert.match(id, /^[0-9a-f]{16}$/)
})

test('repurposeVideo rejects missing input without shelling out', async () => {
  await assert.rejects(() => repurposeVideo({ input: '', segments: '[]' }), /input is required/)
})

test('repurposeVideo rejects missing segments without shelling out', async () => {
  await assert.rejects(() => repurposeVideo({ input: '/tmp/whatever.mp4', segments: null }), /segments is required/)
})

test('repurposeVideo rejects an input that does not exist on disk', async () => {
  await assert.rejects(
    () => repurposeVideo({ input: '/tmp/definitely-not-a-real-video.mp4', segments: '[]' }),
    /input file not found|not readable/,
  )
})

test('verifyVideo rejects missing file argument', async () => {
  await assert.rejects(() => verifyVideo(''), /filePath is required/)
})

test('verifyVideo rejects missing file on disk', async () => {
  await assert.rejects(() => verifyVideo('/tmp/definitely-not-real.mp4'), /file not found/)
})

// The integration test below needs a real ffmpeg. Skip it on hosts without
// the binary so the suite remains green in CI; the wrapper-level checks above
// still cover the contract.
const integrationTest = HAS_FFMPEG ? test : test.skip
integrationTest('repurposeVideo converts a landscape clip to vertical shorts and verifies them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-pipeline-'))
  const input = path.join(root, 'source.mp4')
  const workDir = path.join(root, 'job')
  makeLandscapeVideo(input, { duration: 6 })
  const segments = [
    { start: '00:00:00.500', end: '00:00:02.500', hook_type: 'opener' },
    { start: '00:00:03.000', end: '00:00:05.500', hook_type: 'payoff' },
  ]
  const result = await repurposeVideo({ input, segments, outputDir: workDir, jobId: 'smoke' })
  assert.equal(result.jobId, 'smoke')
  assert.equal(result.segments, 2)
  assert.equal(result.files.length, 2)
  assert.ok(result.verification.every(entry => entry.passed), `verification failures: ${JSON.stringify(result.verification, null, 2)}`)
  for (const file of result.files) {
    assert.ok(fs.existsSync(file), `expected output ${file} to exist`)
    const stat = fs.statSync(file)
    assert.ok(stat.size > 1000, `output ${file} is suspiciously small (${stat.size} bytes)`)
  }
  // A second call with the same explicit jobId should still work and produce
  // its own files — confirms the wrapper handles the cwd independently of the
  // Python module-level `OUTPUT_DIR`.
  const result2 = await repurposeVideo({ input, segments, outputDir: path.join(root, 'job2'), jobId: 'smoke2' })
  assert.equal(result2.segments, 2)
})
