const JOBS = [
  ['runtime-health', 'Runtime health', 15_000], ['daemon-health', 'Daemon health', 30_000],
  ['repository-health', 'Repository and worktree health', 300_000], ['build-health', 'Test and build monitoring', 900_000],
  ['memory-maintenance', 'Memory indexing and context compaction', 300_000], ['artifact-organization', 'Artifact and session organization', 600_000],
  ['security-review', 'Security and dependency review', 3_600_000], ['deployment-readiness', 'Deployment readiness', 1_800_000],
  ['failed-run-recovery', 'Failed-run recovery', 120_000],
]

export const DEFAULT_LIMITS = { maxConcurrentCloudAgents: 4, dailyCloudBudgetUsd: 25, maxAttempts: 3, backoffSeconds: [5, 30, 120] }

export class StandingJobScheduler {
  constructor({ clock = () => Date.now(), limits = DEFAULT_LIMITS } = {}) {
    this.clock = clock; this.limits = { ...DEFAULT_LIMITS, ...limits }; this.timer = null
    this.jobs = JOBS.map(([id, label, intervalMs]) => ({ schemaVersion: 1, id, label, intervalMs, status: 'monitoring', lastRunAt: null, nextRunAt: clock() + intervalMs, attempt: 0, suspended: false, detail: 'standing watch' }))
    this.history = []; this.handlers = new Map()
  }
  register(id, handler) { if (this.jobs.some(job => job.id === id)) this.handlers.set(id, handler) }
  start(onUpdate = () => {}) { if (this.timer) return; const tick = async () => { const now = this.clock(); for (const job of this.jobs.filter(item => !item.suspended && item.nextRunAt <= now)) await this.run(job.id, onUpdate); onUpdate(this.snapshot()) }; this.timer = setInterval(() => void tick(), 5000); this.timer.unref?.(); onUpdate(this.snapshot()) }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }
  suspend(id, suspended = true) { const job = this.jobs.find(item => item.id === id); if (!job) throw new Error('unknown standing job'); job.suspended = Boolean(suspended); job.status = job.suspended ? 'sleeping' : 'monitoring'; job.nextRunAt = this.clock() + job.intervalMs; return job }
  async run(id, onUpdate = () => {}) { const job = this.jobs.find(item => item.id === id); if (!job) throw new Error('unknown standing job'); if (job.suspended) return job; job.status = 'working'; job.detail = 'running bounded probe'; onUpdate(this.snapshot()); try { const result = await (this.handlers.get(id)?.() || Promise.resolve({ detail: 'monitoring active' })); job.status = result?.attention ? 'attention' : 'monitoring'; job.detail = String(result?.detail || 'check complete').slice(0, 240); job.attempt = 0 } catch (error) { job.attempt++; job.status = job.attempt >= this.limits.maxAttempts ? 'blocked' : 'recovering'; job.detail = String(error.message || error).slice(0, 240) } job.lastRunAt = this.clock(); const delay = job.status === 'recovering' ? this.limits.backoffSeconds[Math.min(job.attempt - 1, this.limits.backoffSeconds.length - 1)] * 1000 : job.intervalMs; job.nextRunAt = this.clock() + delay; this.history = [{ id: `${id}:${job.lastRunAt}`, jobId: id, status: job.status, detail: job.detail, at: job.lastRunAt }, ...this.history].slice(0, 200); onUpdate(this.snapshot()); return job }
  snapshot() { return { schemaVersion: 1, jobs: this.jobs.map(job => ({ ...job })), history: this.history.map(item => ({ ...item })), limits: { ...this.limits }, ts: this.clock() } }
}
