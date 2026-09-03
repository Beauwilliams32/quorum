#!/usr/bin/env node
// Content Repurposing Pipeline — Node wrapper around the local Python scripts.
//
// The Python pair (`repurpose.py`, `verify.py`) is treated as the engine:
//   - `repurpose.py <input.mp4> <segments-json>` converts landscape to 9:16 and
//     losslessly cuts the segments the caller identified. It writes to
//     `./output_shorts` inside its working directory.
//   - `verify.py <file.mp4>` runs ffprobe and asserts a 1080x1920 9:16 vertical.
//
// This wrapper:
//   - Owns a per-job working directory so multiple concurrent calls don't
//     collide on `output_shorts/`.
//   - Spawns Python and streams the log lines so callers see ffmpeg progress.
//   - Verifies every produced short with `verify.py` and reports per-file
//     pass/fail.
//   - Exposes both a library API (`repurposeVideo`, `verifyVideo`) and a CLI
//     (`pipeline repurpose`, `pipeline verify`) so the Quorum server and the
//     `quorum` CLI can share the same code path.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_DIR = __dirname
const REPURPOSE_SCRIPT = path.join(SCRIPT_DIR, 'repurpose.py')
const VERIFY_SCRIPT = path.join(SCRIPT_DIR, 'verify.py')
const VARIANTS_SCRIPT = path.join(SCRIPT_DIR, 'variants.py')
const ASSET_LAYER_SCRIPT = path.join(SCRIPT_DIR, 'asset_layer.py')
const OUTPUT_ROOT = process.env.QUORUM_PIPELINE_DIR || path.join(os.homedir(), '.quorum', 'pipeline-output')
const PYTHON_BIN = process.env.QUORUM_PIPELINE_PYTHON || 'python3'
const PASS_MARKER = 'Quality Check Passed'

export function newJobId() {
  return crypto.randomBytes(8).toString('hex')
}

export async function repurposeVideo({ input, segments, outputDir, jobId = newJobId(), onLog } = {}) {
  if (!input) throw new Error('input is required')
  if (segments == null) throw new Error('segments is required')

  const segmentsJson = typeof segments === 'string' ? segments : JSON.stringify(segments)
  const workDir = outputDir || path.join(OUTPUT_ROOT, jobId)
  await fs.mkdir(workDir, { recursive: true })

  // Validate the input file exists before we shell out — a friendly 400 beats a
  // confusing ffmpeg error.
  try {
    const stat = await fs.stat(input)
    if (!stat.isFile()) throw new Error('not a regular file')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`input file not found: ${input}`)
    throw new Error(`input file is not readable: ${input} (${error.message || error})`)
  }

  const repurposeLog = []
  const startedAt = Date.now()
  await runPython(REPURPOSE_SCRIPT, [input, segmentsJson], {
    cwd: workDir,
    onLine: line => {
      repurposeLog.push(line)
      if (onLog) onLog({ phase: 'repurpose', line })
    },
  })

  const shortsDir = path.join(workDir, 'output_shorts')
  const files = await fs.readdir(shortsDir).catch(() => [])
  const mp4Files = files.filter(name => name.endsWith('.mp4') && !name.startsWith('temp_'))

  const verification = []
  for (const name of mp4Files) {
    const filePath = path.join(shortsDir, name)
    const log = []
    try {
      await runPython(VERIFY_SCRIPT, [filePath], {
        cwd: workDir,
        onLine: line => {
          log.push(line)
          if (onLog) onLog({ phase: 'verify', file: name, line })
        },
      })
      verification.push({
        file: name,
        path: filePath,
        passed: log.some(line => line.includes(PASS_MARKER)),
        log: log.join('\n'),
      })
    } catch (error) {
      verification.push({ file: name, path: filePath, passed: false, error: String(error.message || error), log: log.join('\n') })
    }
  }

  const finishedAt = Date.now()
  return {
    jobId,
    workDir,
    outputDir: shortsDir,
    segments: mp4Files.length,
    files: mp4Files.map(name => path.join(shortsDir, name)),
    verification,
    allPassed: verification.length > 0 && verification.every(entry => entry.passed),
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    repurposeLog: sanitizeLog(repurposeLog.join('\n')),
  }
}

export async function verifyVideo(filePath, { onLog } = {}) {
  if (!filePath) throw new Error('filePath is required')
  try {
    await fs.access(filePath)
  } catch {
    throw new Error(`file not found: ${filePath}`)
  }
  const log = []
  await runPython(VERIFY_SCRIPT, [filePath], {
    onLine: line => {
      log.push(line)
      if (onLog) onLog({ phase: 'verify', line })
    },
  })
  return {
    path: filePath,
    passed: log.some(line => line.includes(PASS_MARKER)),
    log: sanitizeLog(log.join('\n')),
  }
}

// Hyperframes-style 1→N variant generator. Takes a master short and produces
// `count` ad-ready variants with rotated hooks, CTAs, and brand tints. Pillow +
// ffmpeg only — no third-party services.
export async function generateVariants({ input, outputDir, count = 25, logo, seed = 42, jobId = newJobId(), onLog } = {}) {
  if (!input) throw new Error('input is required')
  // Validate the input file exists before we shell out — a friendly 400 beats a
  // confusing Python error.
  try {
    const stat = await fs.stat(input)
    if (!stat.isFile()) throw new Error('not a regular file')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`input file not found: ${input}`)
    throw new Error(`input file is not readable: ${input} (${error.message || error})`)
  }
  const workDir = outputDir || path.join(OUTPUT_ROOT, jobId, 'variants')
  await fs.mkdir(workDir, { recursive: true })
  const log = []
  await runPython(VARIANTS_SCRIPT, [
    '--input', input,
    '--output-dir', workDir,
    '--count', String(count),
    ...(logo ? ['--logo', logo] : []),
    '--seed', String(seed),
  ], {
    cwd: workDir,
    onLine: line => {
      log.push(line)
      if (onLog) onLog({ phase: 'variants', line })
    },
  })
  const files = await fs.readdir(workDir).catch(() => [])
  const variants = files.filter(n => n.endsWith('.mp4') && /^v\d{2}_/.test(n)).sort()
  const manifestPath = path.join(workDir, 'manifest.json')
  const manifest = await fs.readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null)
  return {
    jobId,
    workDir,
    count: variants.length,
    variants: variants.map(n => path.join(workDir, n)),
    manifestPath,
    manifest,
    log: sanitizeLog(log.join('\n')),
  }
}

// Resilient asset fetcher. Local-first, then free APIs (Pexels, Pixabay), then
// local generation (ComfyUI when available), then cloud fallback (only when
// `allowCloud` is set and the cost envelope approves).
export async function fetchAsset({ topic, duration = 5.0, aspect = '9:16', allowCloud = false, auth, budget = 0.10, outputDir, jobId = newJobId(), onLog } = {}) {
  if (!topic) throw new Error('topic is required')
  const workDir = outputDir || path.join(OUTPUT_ROOT, jobId, 'asset')
  await fs.mkdir(workDir, { recursive: true })
  const args = [
    '--topic', topic,
    '--duration', String(duration),
    '--aspect', aspect,
    '--budget', String(budget),
  ]
  if (allowCloud) args.push('--allow-cloud')
  if (auth) {
    const authPath = path.join(workDir, 'auth.json')
    await fs.writeFile(authPath, JSON.stringify(auth, null, 2))
    args.push('--auth', authPath)
  }
  const log = []
  await runPython(ASSET_LAYER_SCRIPT, args, {
    cwd: workDir,
    onLine: line => {
      log.push(line)
      if (onLog) onLog({ phase: 'asset', line })
    },
  })
  // Last JSON line is the structured AssetResult
  const structured = parseLastJson(log) || { source: 'none', note: 'no_structured_result' }
  return {
    jobId,
    workDir,
    topic,
    duration,
    aspect,
    allowCloud,
    result: structured,
    log: sanitizeLog(log.join('\n')),
  }
}

function parseLastJson(lines) {
  // Find the last complete JSON object in the log
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try { return JSON.parse(trimmed) } catch { /* keep scanning */ }
    }
  }
  return null
}

// ffmpeg/ffprobe write carriage returns, form-feeds, and stray ANSI escapes to
// their status streams. Strip control bytes before stuffing the text into a
// JSON payload — the values are diagnostic, not authoritative.
function sanitizeLog(text) {
  if (!text) return ''
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
}

function runPython(scriptPath, args, { cwd, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [scriptPath, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdoutBuf = ''
    let stderrBuf = ''
    const flush = (chunk, stream) => {
      const text = chunk.toString()
      if (stream === 'stderr') stderrBuf += text
      else stdoutBuf += text
      const lines = (stream === 'stderr' ? stderrBuf : stdoutBuf).split('\n')
      const tail = lines.pop()
      if (stream === 'stderr') stderrBuf = tail
      else stdoutBuf = tail
      for (const line of lines) {
        if (onLine) onLine(line)
      }
    }
    child.stdout.on('data', chunk => flush(chunk, 'stdout'))
    child.stderr.on('data', chunk => {
      // Surface ffmpeg's verbose stderr at debug-level for callers that want
      // every line; fold it into the same stream so the caller doesn't need
      // a second channel.
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() && onLine) onLine(`[stderr] ${line}`)
      }
    })
    child.on('error', error => reject(new Error(`failed to spawn ${PYTHON_BIN}: ${error.message || error}`)))
    child.on('close', code => {
      // Flush any trailing line without a newline.
      if (stdoutBuf && onLine) onLine(stdoutBuf)
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(scriptPath)} exited with code ${code}`))
    })
  })
}

function parseFlags(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out[key] = next; i++ }
      else out[key] = true
    } else {
      out._.push(token)
    }
  }
  return out
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

async function main(argv) {
  const cmd = argv[0]
  if (cmd === 'repurpose') {
    const flags = parseFlags(argv.slice(1))
    if (!flags.input || !flags.segments) {
      process.stderr.write('Usage: pipeline repurpose --input PATH --segments JSON [--output-dir DIR] [--job-id ID]\n')
      process.exit(2)
    }
    try {
      const result = await repurposeVideo({
        input: flags.input,
        segments: flags.segments,
        outputDir: flags['output-dir'],
        jobId: flags['job-id'],
      })
      printJson(result)
      process.exit(result.allPassed ? 0 : 1)
    } catch (error) {
      process.stderr.write(`pipeline repurpose: ${error.message || error}\n`)
      process.exit(1)
    }
  } else if (cmd === 'verify') {
    const flags = parseFlags(argv.slice(1))
    const file = flags._[0] || flags.input
    if (!file) {
      process.stderr.write('Usage: pipeline verify PATH\n')
      process.exit(2)
    }
    try {
      const result = await verifyVideo(file)
      printJson(result)
      process.exit(result.passed ? 0 : 1)
    } catch (error) {
      process.stderr.write(`pipeline verify: ${error.message || error}\n`)
      process.exit(1)
    }
  } else if (cmd === 'variants') {
    const flags = parseFlags(argv.slice(1))
    if (!flags.input) {
      process.stderr.write('Usage: pipeline variants --input PATH [--output-dir DIR] [--count N] [--logo PATH] [--seed N]\n')
      process.exit(2)
    }
    try {
      const result = await generateVariants({
        input: flags.input,
        outputDir: flags['output-dir'],
        count: Number(flags.count || 25),
        logo: flags.logo,
        seed: Number(flags.seed || 42),
      })
      printJson(result)
      process.exit(0)
    } catch (error) {
      process.stderr.write(`pipeline variants: ${error.message || error}\n`)
      process.exit(1)
    }
  } else if (cmd === 'asset') {
    const flags = parseFlags(argv.slice(1))
    if (!flags.topic) {
      process.stderr.write('Usage: pipeline asset --topic "..." [--duration SEC] [--aspect 9:16] [--allow-cloud] [--auth FILE] [--budget USD]\n')
      process.exit(2)
    }
    try {
      let auth = null
      if (flags.auth) {
        auth = JSON.parse(await fs.readFile(flags.auth, 'utf8'))
      }
      const result = await fetchAsset({
        topic: flags.topic,
        duration: Number(flags.duration || 5.0),
        aspect: flags.aspect || '9:16',
        allowCloud: !!flags['allow-cloud'],
        auth,
        budget: Number(flags.budget || 0.10),
      })
      printJson(result)
      process.exit(result.result.path ? 0 : 1)
    } catch (error) {
      process.stderr.write(`pipeline asset: ${error.message || error}\n`)
      process.exit(1)
    }
  } else if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write('Usage:\n  pipeline repurpose --input PATH --segments JSON [--output-dir DIR]\n  pipeline verify PATH\n  pipeline variants --input PATH [--count N] [--logo PATH]\n  pipeline asset --topic "..." [--allow-cloud] [--auth FILE]\n')
    process.exit(cmd ? 0 : 2)
  } else {
    process.stderr.write(`pipeline: unknown command '${cmd}'\n`)
    process.exit(2)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main(process.argv.slice(2))
}
