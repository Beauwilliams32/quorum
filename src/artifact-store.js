import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

// The artifact index used to be a single `~/.quorum/artifact-index.json` that
// `JSON.stringify`'d every entry and rewrote the whole file every 30s. On the
// author's machine that was 107 MB (230 MB on the benchmark corpus) written
// 120 times an hour, and nothing ever read it back: it was pure cost.
//
// This module replaces it with an append-only log that IS read on startup:
//
//   artifact-index.ndjson      one JSON op per line, appended as files change
//   artifact-index.meta.json   a few KB of roots + stats, rewritten per tick
//
// A tick that changes nothing writes nothing. A tick that changes k entries
// writes k lines. The log is compacted — rewritten from the live entries —
// once it holds substantially more lines than there are live entries, so it
// is bounded by the size of the index rather than by uptime.

export const INDEX_VERSION = 2

const READ_CHUNK = 1 << 20

/** Where the index lives for a given `~/.quorum`-style directory. */
export function indexPaths(dir) {
  return {
    dir,
    log: path.join(dir, 'artifact-index.ndjson'),
    meta: path.join(dir, 'artifact-index.meta.json'),
    legacy: path.join(dir, 'artifact-index.json'),
    archive: path.join(dir, 'archive'),
  }
}

/**
 * Read the log back into `{ entries, lines }`, last write per path winning.
 *
 * Read in 1 MB chunks rather than with `readFileSync`: a large index would
 * otherwise materialise as one multi-hundred-megabyte string, which is the
 * allocation this whole rewrite exists to avoid. A truncated or corrupt tail —
 * a crash mid-append — costs the lines after the break, not the file.
 *
 * Decoding goes through `StringDecoder`, not `Buffer#toString`. A chunk
 * boundary lands wherever 1 MiB lands, which is regularly in the middle of a
 * multi-byte character; `toString` turns each such half into U+FFFD, the line
 * still parses as JSON, and `syncEntry` then re-uses the mangled entry forever
 * because its mtime and size still match the file. Carrying the partial LINE
 * across chunks is not enough — the partial CHARACTER has to be carried too,
 * which is exactly what `StringDecoder` holds back.
 */
export function readLog(file) {
  const entries = new Map()
  let lines = 0
  let fd
  try { fd = fs.openSync(file, 'r') } catch { return { entries, lines, present: false } }
  try {
    const buffer = Buffer.alloc(READ_CHUNK)
    const decoder = new StringDecoder('utf8')
    let carry = ''
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, READ_CHUNK, null)
      if (read <= 0) break
      const text = carry + decoder.write(buffer.subarray(0, read))
      const parts = text.split('\n')
      carry = parts.pop() ?? ''
      for (const part of parts) {
        if (!applyLine(entries, part)) continue
        lines += 1
      }
    }
    // A file whose last character is itself truncated leaves bytes in the
    // decoder; `end()` releases them so the tail line is judged on what is
    // really there rather than silently losing it.
    carry += decoder.end()
    if (carry.trim() && applyLine(entries, carry)) lines += 1
  } catch { /* a partial read still yields a usable, older index */ }
  finally { try { fs.closeSync(fd) } catch { /* already gone */ } }
  return { entries, lines, present: true }
}

function applyLine(entries, line) {
  const trimmed = line.trim()
  if (!trimmed) return false
  let op
  try { op = JSON.parse(trimmed) } catch { return false }
  if (op?.op === 'put' && op.e?.path) { entries.set(op.e.path, op.e); return true }
  if (op?.op === 'del' && op.p) { entries.delete(op.p); return true }
  return false
}

export function readMeta(file) {
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
    return meta && meta.v === INDEX_VERSION ? meta : null
  } catch { return null }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/**
 * Append `put`/`del` ops. Returns the bytes written — 0 when nothing changed.
 *
 * Serialised in slices rather than joined into one payload: the very first
 * append after a cold start carries the whole index, and building that as a
 * single several-hundred-megabyte string would reproduce the allocation spike
 * this module exists to remove.
 */
export function appendOps(paths, { put = [], del = [] } = {}) {
  if (!put.length && !del.length) return 0
  ensureDir(paths.dir)
  const fd = fs.openSync(paths.log, 'a', 0o600)
  let bytes = 0
  try {
    let chunk = ''
    for (const entry of put) {
      chunk += JSON.stringify({ op: 'put', e: entry }) + '\n'
      if (chunk.length >= READ_CHUNK) { bytes += fs.writeSync(fd, chunk); chunk = '' }
    }
    for (const p of del) {
      chunk += JSON.stringify({ op: 'del', p }) + '\n'
      if (chunk.length >= READ_CHUNK) { bytes += fs.writeSync(fd, chunk); chunk = '' }
    }
    if (chunk) bytes += fs.writeSync(fd, chunk)
  } finally { fs.closeSync(fd) }
  return bytes
}

/** Rewrite the log from the live entries. Returns bytes written. */
export function compactLog(paths, entries) {
  ensureDir(paths.dir)
  const temp = `${paths.log}.${process.pid}.tmp`
  const fd = fs.openSync(temp, 'w', 0o600)
  let bytes = 0
  try {
    let chunk = ''
    for (const entry of entries) {
      chunk += JSON.stringify({ op: 'put', e: entry }) + '\n'
      // Flush in slices so compaction never holds the whole index as one
      // string — the exact allocation the old full-file rewrite did.
      if (chunk.length >= READ_CHUNK) { bytes += fs.writeSync(fd, chunk); chunk = '' }
    }
    if (chunk) bytes += fs.writeSync(fd, chunk)
  } finally { fs.closeSync(fd) }
  fs.renameSync(temp, paths.log)
  return bytes
}

export function writeMeta(paths, meta) {
  ensureDir(paths.dir)
  const temp = `${paths.meta}.${process.pid}.tmp`
  const payload = JSON.stringify({ v: INDEX_VERSION, ...meta }) + '\n'
  fs.writeFileSync(temp, payload, { mode: 0o600 })
  fs.renameSync(temp, paths.meta)
  return Buffer.byteLength(payload)
}

/**
 * Move a pre-v2 `artifact-index.json` aside exactly once.
 *
 * Nothing in the cockpit ever read that file, but it is the owner's data and
 * the workspace rule is archive, never delete — so it moves to
 * `~/.quorum/archive/` and the move is reported in the index stats rather
 * than happening silently.
 */
export function archiveLegacyIndex(paths) {
  let stat
  try { stat = fs.statSync(paths.legacy) } catch { return null }
  if (!stat.isFile()) return null
  try {
    ensureDir(paths.archive)
    const target = path.join(paths.archive, `artifact-index-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.renameSync(paths.legacy, target)
    return { archivedTo: target, bytes: stat.size }
  } catch { return null }
}

/** True when the log has grown enough past the live set to be worth rewriting. */
export function shouldCompact(logLines, liveEntries) {
  return logLines > Math.max(1_000, liveEntries * 1.5)
}
