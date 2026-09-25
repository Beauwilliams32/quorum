import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { redactRuntimeText } from '../runtime-events.js'
import { validateVerifyCommand } from '../validate.js'

// What the cockpit measures for itself when a managed run says it is done.
//
// None of this asks the agent whether it succeeded. A dispatched task used to
// be marked "completed" on exit code 0 alone, which is the weakest possible
// claim: `claude -p` and `codex exec` both exit 0 after reporting an error,
// and a run that does nothing at all exits 0 too. These helpers produce facts
// the cockpit gathered itself — a worktree digest before and after, and the
// exit status of a check Quorum ran — so completion can be gated on evidence.

const digestOf = value => crypto.createHash('sha256').update(String(value ?? '')).digest('hex')
const bytesDigest = buffer => crypto.createHash('sha256').update(buffer).digest('hex')
const clean = value => redactRuntimeText(value).slice(0, 900)

// Bounds on how much of a changed path is read to hash it. Past them a file
// is represented by its size and mtime, a directory by the entries it had
// room for — still a change detector, just a coarser one.
const HASHED_FILE_BYTES = 4 * 1024 * 1024
const HASHED_TOTAL_BYTES = 64 * 1024 * 1024
const HASHED_DIR_FILES = 400

/**
 * What one changed path holds, as a short string. `git status` only says a
 * path differs from HEAD; it says the same thing before and after a run that
 * edits a file which was already uncommitted. Hashing the bytes is what lets
 * two readings tell those apart. Only the hash is kept, never the content.
 */
function pathDigest(target, budget) {
  let stat
  try { stat = fs.lstatSync(target) } catch { return 'missing' }
  if (stat.isSymbolicLink()) { try { return `link:${fs.readlinkSync(target)}` } catch { return 'link' } }
  if (stat.isDirectory()) {
    let names = []
    try { names = fs.readdirSync(target).sort() } catch { return 'dir:unreadable' }
    const parts = []
    for (const name of names) {
      if (name === '.git') continue
      if (budget.files <= 0) { parts.push('…'); break }
      parts.push(`${name}=${pathDigest(path.join(target, name), budget)}`)
    }
    return `dir:${digestOf(parts.join('\n'))}`
  }
  budget.files -= 1
  if (!stat.isFile()) return `other:${stat.mode}`
  if (stat.size > HASHED_FILE_BYTES || stat.size > budget.bytes) return `large:${stat.size}:${stat.mtimeMs}`
  budget.bytes -= stat.size
  try { return bytesDigest(fs.readFileSync(target)) } catch { return `unreadable:${stat.size}:${stat.mtimeMs}` }
}

/**
 * A digest of the worktree's uncommitted state plus its HEAD. Two digests
 * taken around a run answer "did anything actually change?". Changed paths
 * are read only to hash them, so an edit to a file that was already dirty
 * before the run still counts — nothing but the hash is kept.
 *
 * Returns `{ measured, reason, digest, changedFiles, head }`. `measured:false`
 * is a first-class answer — a directory that is not a git worktree cannot be
 * diffed, and saying so is better than reporting a change that was not seen.
 */
export function worktreeDigest(cwd, { execImpl = execFileSync } = {}) {
  const run = args => String(execImpl('git', args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }))
  let status
  let head = ''
  let top = cwd
  try { status = run(['status', '--porcelain=v1', '-z']) } catch (error) {
    return { measured: false, reason: clean(`worktree is not a readable git repository: ${error?.message || error}`), digest: null, changedFiles: [], head: '' }
  }
  try { head = run(['rev-parse', 'HEAD']).trim() } catch { head = '' }
  try { top = run(['rev-parse', '--show-toplevel']).trim() || cwd } catch { top = cwd }
  // `-z` gives every path raw and NUL-terminated. Without it git quotes a name
  // with a space or a non-ASCII byte ("notes file.md"), which then resolves
  // to nothing and hides an edit to it. A rename or copy carries its source
  // as the next field. Paths are relative to the repository top level, not
  // to the directory the command ran in, so they are resolved against it
  // before they are handed on as evidence artifacts.
  const changed = []
  const fields = status.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i]
    if (entry.length < 4) continue
    changed.push(entry.slice(3))
    if (/[RC]/.test(entry.slice(0, 2))) i += 1
  }
  const changedFiles = changed.slice(0, 200).map(file => path.resolve(top, file))
  const budget = { files: HASHED_DIR_FILES, bytes: HASHED_TOTAL_BYTES }
  const contents = changedFiles.map(file => `${file}\0${pathDigest(file, budget)}`).join('\n')
  return { measured: true, reason: 'git status, HEAD and the changed paths\' contents read', digest: digestOf(`${head}\n${status}\n${contents}`), changedFiles, head, top }
}

/**
 * Run a mission task's declared verification command and report what happened.
 * The command is validated (bare program or absolute path, no shell
 * metacharacters) and executed through `execFile` — never a shell.
 *
 * `{ ran: false }` with a reason is returned for an absent or invalid command.
 * It is never reported as a pass.
 */
export async function runDeclaredCheck(spec, { cwd, execImpl = execFile } = {}) {
  const validated = validateVerifyCommand(spec)
  if (!validated.ok) return { ran: false, reason: clean(validated.errors.join('; ')), exitCode: null, outputDigest: null, tail: '' }
  if (!validated.value) return { ran: false, reason: 'no verification command declared', exitCode: null, outputDigest: null, tail: '' }
  const { command, args, timeoutMs } = validated.value
  return await new Promise(resolve => {
    execImpl(command, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`
      const exitCode = error ? (Number.isInteger(error.code) ? error.code : 1) : 0
      resolve({
        ran: true,
        reason: error?.killed ? `check timed out after ${timeoutMs}ms` : `ran ${command} ${args.join(' ')}`.trim(),
        command: `${command} ${args.join(' ')}`.trim(),
        exitCode,
        timedOut: Boolean(error?.killed),
        outputDigest: digestOf(output),
        tail: clean(output.slice(-1_200)),
      })
    })
  })
}

/**
 * Build the acceptance criteria and actions for a finished managed run.
 *
 * Only criteria that something can actually decide are included. A task with
 * no declared verification command does not get a "tests pass" criterion that
 * silently passes; it simply has no such criterion, and the run's closeout says
 * which criteria were judged.
 */
export function buildTaskPlanInput({ missionId, taskId, attempt = 1, role = 'builder', hasDeclaredCheck = false, worktreeMeasured = false } = {}) {
  const readOnly = ['researcher', 'reviewer', 'recovery'].includes(role)
  const acceptanceCriteria = [
    { id: 'provider-result', description: 'the runtime reported a terminal result of its own, not merely a zero exit status' },
  ]
  const actions = [
    { id: 'record-run', action: 'read', expected: 'the provider result and exit status are recorded', criterionIds: ['provider-result'] },
  ]
  // A worktree that git cannot read yields no criterion at all. Inventing one
  // that always fails would block every task in a non-repository directory,
  // and inventing one that always passes would be the lie this whole change
  // exists to remove. The closeout names it as not measured instead.
  if (worktreeMeasured) {
    acceptanceCriteria.push({ id: 'worktree-effect', description: readOnly ? 'a read-only run left the worktree unchanged' : 'the run changed the worktree it claimed' })
    actions.push({ id: 'inspect-worktree', action: 'read', expected: 'the worktree digest is re-read after the run', criterionIds: ['worktree-effect'] })
  }
  if (hasDeclaredCheck) {
    acceptanceCriteria.push({ id: 'declared-check', description: "the task's declared verification command exits zero when Quorum runs it" })
    actions.push({ id: 'run-declared-check', action: 'test', expected: 'the declared check is executed by Quorum and its exit status recorded', criterionIds: ['declared-check'] })
  }
  return { idempotencyKey: `${missionId}:${taskId}:attempt-${attempt}`, source: { missionId, taskId, attempt }, acceptanceCriteria, actions, maxAttempts: 1 }
}

export const evidenceDigest = digestOf
