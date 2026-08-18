// Where Quorum keeps its local data.
//
// The product was called "Unified AI Operator" before it was called Quorum, and
// installs from that era have presence and finished roundtables sitting in
// `~/.unified-ai-operator`. Renaming the directory outright would strand that
// data — including debates the user paid for — so the rule here is: write to
// the new home, read from both.
//
// Nothing is moved or deleted. The legacy directory is left exactly where it is
// and simply keeps being read until it is empty of anything interesting.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()

export const DATA_DIR = path.join(HOME, '.quorum')
export const LEGACY_DATA_DIR = path.join(HOME, '.unified-ai-operator')

/** Directory to write to. Always the current one. */
export function dataDir(...parts) {
  return path.join(DATA_DIR, ...parts)
}

/**
 * Every directory a reader should look in, newest naming first. Callers merge
 * results themselves rather than us guessing a precedence they may not want.
 */
export function readDirs(...parts) {
  return [path.join(DATA_DIR, ...parts), path.join(LEGACY_DATA_DIR, ...parts)]
}

/**
 * First existing file across current and legacy homes, or null.
 * Used for single-file state like presence.json, where "the newest one wins"
 * is the right answer and merging would produce a nonsense record.
 */
export function findFile(...parts) {
  for (const dir of [DATA_DIR, LEGACY_DATA_DIR]) {
    const file = path.join(dir, ...parts)
    try { if (fs.existsSync(file)) return file } catch { /* unreadable home */ }
  }
  return null
}
