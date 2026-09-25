import { execFileSync } from 'node:child_process'

// A run is "alive" only when the exact process that owns it is still running.
//
// Before this module, a run's liveness was inferred from its lease: a record
// whose `leaseExpiresAt` was in the future counted as alive, and one whose
// lease had expired was assumed dead and replaced. Nothing ever checked that a
// process existed at all, so a run created without a process (every recovery
// replacement) looked alive for its TTL, then expired, then spawned another.
//
// A pid on its own is not an identity: the OS reuses pids. The pair
// (pid, start time) is, for the lifetime of the machine's uptime, unique. We
// read the start time from `ps`, which needs no privileges and no shell.
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim()

/**
 * The start-time key for a pid, or null when the process does not exist (or
 * the platform gives us no way to ask). `ps -o lstart=` prints the process
 * start time on macOS and Linux; a bare `ps -p` that exits non-zero means the
 * pid is not running.
 */
export function processStartKey(pid, { execImpl = execFileSync } = {}) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return null
  try {
    const out = execImpl('ps', ['-o', 'lstart=', '-p', String(value)], { encoding: 'utf8', timeout: 4_000 })
    return clean(out).slice(0, 120) || null
  } catch { return null }
}

/**
 * Liveness for a run record. Returns `{ alive, reason }` — never a bare
 * boolean, because every caller has to be able to say *why* it treated a run
 * as dead, and "not measured" is a different answer from "dead".
 *
 * Deliberately strict: a run with no recorded pid, or no recorded start key,
 * is not alive. It is not "unknown" either — a run that was never bound to a
 * process has no process to be alive, and pretending otherwise is what
 * manufactured 79 phantom runs on the author's machine.
 */
export function runLiveness(run, { startKeyImpl = processStartKey } = {}) {
  const pid = Number(run?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, reason: 'run is not bound to a process' }
  const recorded = clean(run?.pidStartedAt)
  if (!recorded) return { alive: false, reason: 'run recorded no process start key' }
  const current = startKeyImpl(pid)
  // `undefined` means the caller declined to measure (a sweep that has spent
  // its probe budget); `null` means it asked and the process is gone. They are
  // different facts and only one of them is "dead".
  if (current === undefined) return { alive: false, unmeasured: true, reason: `liveness of pid ${pid} was not measured this pass` }
  if (!current) return { alive: false, reason: `process ${pid} is no longer running` }
  if (current !== recorded) return { alive: false, reason: `pid ${pid} was reused by a different process` }
  return { alive: true, reason: `pid ${pid} is running` }
}
