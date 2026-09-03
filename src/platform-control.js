import crypto from 'node:crypto'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const clean = value => String(value || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 240)
const token = () => crypto.randomBytes(24).toString('hex')
const SAFE_SIGNALS = new Set(['SIGSTOP', 'SIGCONT', 'SIGTERM'])

export function platformCapabilities(platform = process.platform) {
  if (platform === 'darwin') return { platform, serviceManager: 'launchd', processSignals: true, priority: true, serviceInspect: true, serviceControl: 'user-domain', hostAccepted: true }
  if (platform === 'linux') return { platform, serviceManager: 'systemd', processSignals: true, priority: true, serviceInspect: true, serviceControl: 'user-domain', hostAccepted: false }
  if (platform === 'win32') return { platform, serviceManager: 'windows-services', processSignals: false, priority: true, serviceInspect: true, serviceControl: 'user-domain', hostAccepted: false }
  return { platform, serviceManager: 'unknown', processSignals: false, priority: false, serviceInspect: false, serviceControl: 'none', hostAccepted: false }
}

export function classifyProcess(proc, { uid = typeof process.getuid === 'function' ? process.getuid() : null, platform = process.platform } = {}) {
  const pid = Number(proc.pid)
  const own = proc.uid == null || uid == null ? null : Number(proc.uid) === Number(uid)
  const command = clean(proc.command || proc.cmd || '')
  const executable = clean(proc.executable || command.split(/\s+/)[0]).split('/').pop()
  const quorum = /(?:^|\/)(?:node|Quorum)(?:\s|$)/i.test(command) && /(?:server\.js|quorum)/i.test(command)
  const agent = /^(claude|codex|gemini|hermes|ollama|copilot|cursor)$/i.test(executable) || /claude-mem|openclaw/i.test(command)
  const protectedProcess = pid <= 1 || (!own && own !== null) || /kernel_task|launchd|WindowServer|securityd|opendirectoryd|loginwindow/i.test(command)
  return {
    ownership: quorum ? 'quorum-launched' : protectedProcess ? 'protected' : own === true ? 'user-owned' : own === false ? 'system-managed' : 'unknown',
    kind: agent ? 'agent-runtime' : /docker|containerd|podman/i.test(command) ? 'container' : /(?:zsh|bash|fish|Terminal|iTerm)/i.test(command) ? 'terminal' : 'process',
    protected: protectedProcess,
    platform,
  }
}

export function normalizeProcess(proc, options = {}) {
  const classification = classifyProcess(proc, options)
  const executable = clean(proc.executable || proc.command || proc.cmd).split(/\s+/)[0]
  return {
    schemaVersion: 1,
    id: `process:${Number(proc.pid)}`,
    pid: Number(proc.pid),
    ppid: Number(proc.ppid || 0),
    name: clean(proc.name || executable.split('/').pop()),
    executable,
    cpuPercent: Number(proc.cpu || proc.cpuPercent || 0),
    memoryMB: Number(proc.rssMB || proc.memoryMB || 0),
    elapsed: clean(proc.etime || proc.elapsed),
    ...classification,
  }
}

export async function listServices(platform = process.platform) {
  try {
    if (platform === 'darwin') {
      const { stdout } = await exec('/bin/launchctl', ['list'], { timeout: 2500, maxBuffer: 2_000_000 })
      return stdout.split('\n').slice(1).map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 3).slice(0, 400).map(parts => ({ schemaVersion: 1, id: `service:${parts[2]}`, label: clean(parts[2]), manager: 'launchd', state: parts[0] === '-' ? 'waiting' : 'running', pid: /^\d+$/.test(parts[0]) ? Number(parts[0]) : null, exitCode: /^-?\d+$/.test(parts[1]) ? Number(parts[1]) : null, scope: 'user', hostAccepted: true }))
    }
    if (platform === 'linux') {
      const { stdout } = await exec('systemctl', ['--user', '--no-pager', '--plain', '--all', '--type=service', '--output=json'], { timeout: 3000, maxBuffer: 2_000_000 })
      return JSON.parse(stdout).slice(0, 400).map(row => ({ schemaVersion: 1, id: `service:${clean(row.unit)}`, label: clean(row.unit), manager: 'systemd', state: clean(row.active), scope: 'user', hostAccepted: false }))
    }
    if (platform === 'win32') {
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Service | Select-Object -First 400 Name,Status | ConvertTo-Json -Compress'], { timeout: 4000, maxBuffer: 2_000_000 })
      const rows = JSON.parse(stdout || '[]')
      return (Array.isArray(rows) ? rows : [rows]).map(row => ({ schemaVersion: 1, id: `service:${clean(row.Name)}`, label: clean(row.Name), manager: 'windows-services', state: clean(row.Status), scope: 'system', hostAccepted: false }))
    }
  } catch (error) { return [{ schemaVersion: 1, id: 'service:probe-error', label: 'service inventory unavailable', manager: platformCapabilities(platform).serviceManager, state: 'error', detail: clean(error.message), scope: 'unknown', hostAccepted: platform === process.platform }] }
  return []
}

export class ProcessController {
  constructor({ clock = () => Date.now(), kill = process.kill, resolveProcess = null } = {}) { this.clock = clock; this.kill = kill; this.resolveProcess = resolveProcess; this.previews = new Map(); this.audit = [] }

  preview(input, processRecord) {
    if (!processRecord) throw new Error('unknown process')
    const action = clean(input.action)
    if (!['pause', 'resume', 'terminate', 'reprioritize', 'restart'].includes(action)) throw new Error('unsupported process action')
    if (processRecord.protected || !['user-owned', 'quorum-launched'].includes(processRecord.ownership)) throw new Error('protected process requires the privileged broker')
    if (action === 'restart' && !processRecord.restart) throw new Error('restart is available only for Quorum-launched or managed services')
    const record = { id: `preview-${token()}`, schemaVersion: 1, actor: clean(input.actor || 'operator'), action, target: { id: processRecord.id, pid: processRecord.pid, name: processRecord.name, executable: processRecord.executable || '' }, reason: clean(input.reason || 'operator request'), status: 'pending-confirmation', requiresConfirmation: true, expiresAt: this.clock() + 60_000, createdAt: this.clock() }
    this.previews.set(record.id, record); this.#record(record)
    return record
  }

  confirm(id) {
    const record = this.previews.get(String(id))
    if (!record || record.status !== 'pending-confirmation') throw new Error('unknown or consumed preview')
    if (record.expiresAt < this.clock()) { record.status = 'expired'; this.#record(record); throw new Error('preview expired') }
    const current = this.resolveProcess?.(record.target.pid)
    if (this.resolveProcess && (!current || current.name !== record.target.name || (record.target.executable && current.executable !== record.target.executable))) {
      record.status = 'rejected'; record.verification = 'pid-identity-changed'; this.previews.delete(record.id); this.#record(record)
      throw new Error('process identity changed after preview; action rejected')
    }
    const signal = record.action === 'pause' ? 'SIGSTOP' : record.action === 'resume' ? 'SIGCONT' : record.action === 'terminate' ? 'SIGTERM' : null
    if (!signal || !SAFE_SIGNALS.has(signal)) throw new Error(`${record.action} needs a managed relaunch adapter`)
    this.kill(record.target.pid, signal)
    record.status = 'executed'; record.signal = signal; record.executedAt = this.clock(); record.verification = 'signal-accepted'; this.previews.delete(record.id); this.#record(record)
    return record
  }

  #record(record) { this.audit = [...this.audit.filter(item => item.id !== record.id), { ...record }].slice(-200) }
  snapshot() { return { schemaVersion: 1, previews: [...this.previews.values()].map(item => ({ ...item })), audit: this.audit.map(item => ({ ...item })) } }
}
