import { buildTaskLaunch, executablePath } from './adapters.js'
import { createLineParser, redactRuntimeText } from '../runtime-events.js'
import { parseReviewerDecision } from '../util.js'

// An independent review that can be trusted to terminate.
//
// The previous reviewer spawned `codex "<task>"` into an interactive PTY and
// grepped the raw terminal buffer for APPROVE or REJECT. Three things were
// wrong with that: the task string was interpolated into a shell command line,
// the verdict was read out of ANSI-laden screen scrollback rather than the
// provider's own output, and a reviewer that never printed a verdict simply
// sat there — the PTY stayed open and the mission task stayed "working"
// forever. There was no timeout and no way to record "the reviewer did not
// decide", so an undecided review was indistinguishable from a pending one.
//
// This runs the same review as one structured, non-interactive invocation
// (`codex exec --json` / `claude -p --output-format stream-json`), reads the
// verdict from parsed provider events, and always terminates with one of three
// recorded outcomes: approve, reject, or no-decision. A deadline sends SIGTERM
// to the process group and escalates to SIGKILL after a grace period, so the
// bound is on the reviewer process and not merely on how long we wait for it.

const clean = value => redactRuntimeText(value).slice(0, 900)

export const REVIEW_DECISIONS = ['approve', 'reject', 'no-decision']

/**
 * Pull a verdict out of the provider's own assistant text. The last explicit
 * verdict wins — both across events and within one event's text — and text
 * that never states one yields null, which the caller records as `no-decision`
 * rather than as a rejection, because "the reviewer said nothing" and "the
 * reviewer said no" are different facts.
 *
 * Only the provider's own structured `assistant`/`completed` events are
 * verdict-eligible. stderr is still parsed for telemetry, but a non-JSON line
 * arrives as `type: 'output'`, and letting arbitrary prose on a child's stderr
 * decide a review is not a review.
 */
export function decisionFromEvents(events = []) {
  const texts = events.filter(event => ['assistant', 'completed'].includes(event.type) && event.text).map(event => String(event.text))
  for (const text of [...texts].reverse()) {
    const parsed = parseReviewerDecision(text)
    if (parsed) return { decision: parsed.decision.toLowerCase(), reasoning: clean(parsed.reasoning) }
  }
  return null
}

export function reviewTaskPrompt(runId) {
  return [
    `Review the work of run ${runId}. Check correctness, safety, and adherence to the brief.`,
    'Read the repository and its diff. Do not modify anything.',
    'End your reply with a final line that is exactly APPROVE or REJECT, followed by your reasoning.',
  ].join(' ')
}

/**
 * Run one bounded, non-interactive verification and report what it decided.
 *
 * Always resolves. `{ decision: 'no-decision' }` with a reason covers every
 * way a review can fail to produce a verdict — the runtime is missing, the
 * process died, the timeout fired, or it simply never stated one.
 */
export async function runStructuredVerification({
  runtime = 'codex', role = 'reviewer', cwd = process.cwd(), task = '', model = '',
  timeoutMs = 10 * 60 * 1000, killGraceMs = 10_000, spawnImpl = null, executablePathImpl = executablePath,
  processKillImpl = process.kill.bind(process), onEvent = () => {}, onPid = () => {},
} = {}) {
  const plan = buildTaskLaunch({ runtime, role, cwd, task: String(task || '').slice(0, 8_000), model: model === 'auto' ? '' : model, structured: true })
  const base = { runtime, command: plan.command, args: plan.args, cwd: plan.cwd, events: [], providerSessionId: null, exitCode: null, timedOut: false }
  if (!executablePathImpl(plan.command, plan.env)) {
    return { ...base, decision: 'no-decision', reasoning: `${runtime} executable is not available on Quorum's PATH` }
  }
  const spawn = spawnImpl || ((command, args, options) => import('node:child_process').then(({ spawn: launch }) => launch(command, args, options)))
  let child
  try {
    child = await spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return { ...base, decision: 'no-decision', reasoning: clean(`verification run could not start: ${error?.message || error}`) }
  }
  try { if (child.pid) onPid(child.pid) } catch { /* binding is an audit aid, not a precondition */ }

  const events = []
  const parser = createLineParser(runtime, event => {
    if (event.sessionId) base.providerSessionId = event.sessionId
    events.push(event)
    try { onEvent(event) } catch { /* a telemetry consumer must not stop the review */ }
  })
  child.stdout?.on('data', chunk => parser.push(chunk))
  child.stderr?.on('data', chunk => parser.push(chunk))

  const grace = Math.max(0, Math.min(Number(killGraceMs) || 0, 60_000))
  const outcome = await new Promise(resolve => {
    let settled = false
    let stopping = false
    let escalation = null
    const stop = signal => {
      const pid = Number(child.pid)
      if (!pid) return
      try { if (process.platform !== 'win32') processKillImpl(-pid, signal); else child.kill(signal) } catch { try { child.kill(signal) } catch { /* already gone */ } }
    }
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(escalation); resolve(stopping ? { ...value, timedOut: true } : value) }
    const timer = setTimeout(() => {
      // A reviewer that has not decided by the deadline is stopped. An
      // undecided review that hangs is worse than one that says so.
      stopping = true
      stop('SIGTERM')
      // …and a reviewer that ignores SIGTERM is killed. Resolving on the
      // deadline alone left the process running unreaped, still feeding a
      // parser whose result had already been discarded; "bounded" has to mean
      // the run actually ends, not that we stopped waiting for it.
      escalation = setTimeout(() => { stop('SIGKILL'); finish({ exitCode: null, timedOut: true }) }, grace)
      escalation.unref?.()
    }, timeoutMs)
    timer.unref?.()
    child.once('error', error => finish({ exitCode: null, timedOut: false, error: clean(error?.message || error) }))
    child.once('exit', (code, signal) => finish({ exitCode: Number.isInteger(code) ? code : null, timedOut: false, signal }))
  })
  parser.flush()

  const verdict = decisionFromEvents(events)
  const result = { ...base, events, exitCode: outcome.exitCode, timedOut: Boolean(outcome.timedOut) }
  if (outcome.timedOut) return { ...result, decision: 'no-decision', reasoning: `verification run exceeded its ${Math.round(timeoutMs / 1000)}s budget and was stopped` }
  if (outcome.error) return { ...result, decision: 'no-decision', reasoning: outcome.error }
  if (!verdict) return { ...result, decision: 'no-decision', reasoning: `verification run exited ${outcome.exitCode ?? 'unknown'} without stating APPROVE or REJECT` }
  return { ...result, decision: verdict.decision, reasoning: verdict.reasoning }
}
