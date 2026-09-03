import { spawn } from 'node:child_process'
import { buildTaskLaunch, detectRuntimes } from './adapters.js'
import { resolveProviderSpec, taskRoute } from './provider-registry.js'

export const BENCHMARK_PROMPT = 'Reply with exactly OK. Do not use tools, edit files, or access external services.'
const MAX_RUNTIME_MS = 90_000

export function benchmarkPlan({ runtimes = detectRuntimes(), taskTypes = ['monitoring', 'research', 'architecture', 'coding', 'review'] } = {}) {
  const wanted = new Set(taskTypes.map(value => String(value).toLowerCase()))
  return runtimes.map(runtime => {
    const spec = resolveProviderSpec(runtime.id, runtime)
    const supported = spec?.benchmark?.supported === true
    const interactive = ['interactive', 'provider-api'].includes(spec?.promptMode)
    const taskType = [...wanted].find(type => spec?.benchmark?.taskTypes?.includes(type)) || null
    return {
      runtime: runtime.id,
      provider: spec?.provider || runtime.provider || runtime.id,
      installed: runtime.available === true,
      kind: spec?.kind || runtime.kind || 'custom',
      supported,
      executable: Boolean(runtime.command),
      taskType,
      preferredRoute: taskType ? taskRoute(taskType).preferred : [],
      status: !runtime.available ? 'not-installed' : !supported ? (interactive ? 'interactive-only' : 'unsupported') : !taskType ? 'no-task-type' : 'ready-to-benchmark',
      reason: spec?.benchmark?.reason || null,
    }
  })
}

function runOne(plan, { cwd, allowCloud = false, timeoutMs = MAX_RUNTIME_MS } = {}) {
  return new Promise(resolve => {
    if (plan.kind === 'cloud' && !allowCloud) return resolve({ ...plan, status: 'skipped-cloud', reason: 'cloud execution requires --allow-cloud' })
    const startedAt = Date.now()
    let child
    try {
      const launch = buildTaskLaunch({ runtime: plan.runtime, role: 'researcher', cwd, task: BENCHMARK_PROMPT, structured: true })
      child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: 'ignore' })
    } catch (error) {
      return resolve({ ...plan, status: 'launch-error', reason: String(error.message || error).slice(0, 160), durationMs: Date.now() - startedAt })
    }
    let finished = false
    const finish = result => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ ...plan, ...result, durationMs: Date.now() - startedAt })
    }
    const timer = setTimeout(() => { try { child.kill('SIGTERM') } catch {} ; finish({ status: 'timeout', reason: `exceeded ${timeoutMs}ms` }) }, timeoutMs)
    child.once('error', error => finish({ status: 'process-error', reason: String(error.message || error).slice(0, 160) }))
    child.once('exit', (code, signal) => finish(code === 0 ? { status: 'passed', exitCode: 0 } : { status: 'failed', exitCode: code, signal: signal || null, reason: `exit:${code ?? 'null'}` }))
  })
}

export async function runBenchmarks({ runtimes = detectRuntimes(), cwd = process.cwd(), allowCloud = false, runtimeId = null, timeoutMs = MAX_RUNTIME_MS } = {}) {
  const plans = benchmarkPlan({ runtimes }).filter(plan => !runtimeId || plan.runtime === runtimeId)
  const results = []
  // Sequential execution prevents local model contention and makes latency
  // comparisons meaningful. No provider output is retained.
  for (const plan of plans) {
    if (plan.status !== 'ready-to-benchmark') { results.push(plan); continue }
    results.push(await runOne(plan, { cwd, allowCloud, timeoutMs }))
  }
  return { prompt: '[redacted benchmark prompt]', results }
}
