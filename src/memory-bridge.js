import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { searchArtifacts } from './artifacts.js'
import { sourceOfTruthStatus } from './source-of-truth.js'

const HOME = os.homedir()
const BRIDGE_ROOT = path.join(HOME, 'CLAUDE', 'agent-memory-bridge')
const DEFAULT_VAULT = path.join(HOME, 'Documents', 'Obsidian Vault')
const MAX_CONTEXT = 6_000
const PROBE_TIMEOUT_MS = 900
const SYNC_TIMEOUT_MS = 12_000
const execFile = promisify(execFileCallback)

const clean = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 1_200)

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function bridgeConfig(bridgeRoot = BRIDGE_ROOT) {
  const config = readJson(path.join(bridgeRoot, 'config.json')) || {}
  const url = String(process.env.QUORUM_CLAUDE_MEM_URL || config.memBaseUrl || '').trim()
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(url)
  return { url: local ? url.replace(/\/$/, '') : '', vault: path.resolve(String(process.env.QUORUM_VAULT_PATH || config.vaultPath || DEFAULT_VAULT)) }
}

function within(root, candidate) {
  const base = path.resolve(root)
  const target = path.resolve(candidate)
  return target === base || target.startsWith(base + path.sep)
}

function safeSlug(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'mission'
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temp, file)
}

function taskSection({ task, run, closeout, status, changedFiles }) {
  const start = `<!-- quorum-task:${safeSlug(task.id)}:start -->`
  const end = `<!-- quorum-task:${safeSlug(task.id)}:end -->`
  return [
    start,
    `## ${clean(task.title)}`,
    '',
    `- Status: ${status}`,
    `- Runtime: ${clean(run.runtime)}`,
    `- Worktree: ${clean(run.worktree)}`,
    run.providerSessionId ? `- Provider session: ${clean(run.providerSessionId)}` : '',
    changedFiles.length ? `- Changed files: ${changedFiles.map(clean).join(', ')}` : '',
    '',
    '### Closeout',
    '',
    closeout ? clean(closeout) : 'No closeout text was produced.',
    '',
    end,
    '',
  ].filter(Boolean).join('\n')
}

function upsertTaskSection(existing, section, taskId) {
  const marker = new RegExp(`<!-- quorum-task:${safeSlug(taskId)}:start -->[\\s\\S]*?<!-- quorum-task:${safeSlug(taskId)}:end -->\\n?`, 'm')
  if (!existing) return section
  if (marker.test(existing)) return existing.replace(marker, section)
  return `${existing.trimEnd()}\n\n${section}`
}

export class MemoryBridge {
  constructor({ fetchImpl = globalThis.fetch, vault = null, memUrl = null, bridgeRoot = null, now = () => new Date(), execFileImpl = execFile } = {}) {
    this.bridgeRoot = path.resolve(bridgeRoot || process.env.QUORUM_MEMORY_BRIDGE_ROOT || BRIDGE_ROOT)
    const config = bridgeConfig(this.bridgeRoot)
    this.fetchImpl = fetchImpl
    this.vault = path.resolve(vault || config.vault)
    const candidateUrl = memUrl === null ? config.url : String(memUrl || '')
    this.memUrl = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(candidateUrl) ? candidateUrl.replace(/\/$/, '') : ''
    this.now = now
    this.execFileImpl = execFileImpl
    this.probeState = { state: this.memUrl ? 'unknown' : 'offline', reachable: false, checkedAt: null, latencyMs: null, endpoint: null, error: this.memUrl ? 'not checked' : 'not configured' }
  }

  status() {
    const missionFolder = path.join(this.vault, '09_AI_AGENTS', 'Quorum', 'Missions')
    const vaultExists = fs.existsSync(this.vault)
    let writable = false
    try { if (vaultExists) fs.accessSync(this.vault, fs.constants.W_OK); writable = vaultExists } catch { writable = false }
    return {
      claudeMem: {
        configured: Boolean(this.memUrl), url: this.memUrl || null,
        loopbackOnly: !this.memUrl || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(this.memUrl),
        ...this.probeState,
      },
      obsidian: {
        configured: vaultExists, vault: this.vault, vaultExists, writable,
        missionFolder, missionFolderExists: fs.existsSync(missionFolder),
        writeScope: '09_AI_AGENTS/Quorum/Missions', state: vaultExists && writable ? 'ready' : 'offline',
      },
      sourceOfTruth: sourceOfTruthStatus({ vaultPath: this.vault }),
      checkedAt: this.probeState.checkedAt,
    }
  }

  async probe({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    if (!this.memUrl || !this.fetchImpl) {
      this.probeState = { state: 'offline', reachable: false, checkedAt: this.now().toISOString(), latencyMs: null, endpoint: null, error: 'not configured' }
      return this.status()
    }
    const started = Date.now()
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    let lastError = 'no health endpoint responded'
    try {
      for (const endpoint of ['/health', '/api/health', '/']) {
        try {
          const response = await this.fetchImpl(`${this.memUrl}${endpoint}`, { method: 'GET', signal: controller?.signal })
          if (response.status >= 200 && response.status < 500) {
            this.probeState = { state: response.ok ? 'ready' : 'reachable', reachable: true, checkedAt: this.now().toISOString(), latencyMs: Date.now() - started, endpoint, status: response.status, error: response.ok ? null : `HTTP ${response.status}` }
            return this.status()
          }
          lastError = `HTTP ${response.status}`
        } catch (error) { lastError = error?.name === 'AbortError' ? 'probe timed out' : clean(error?.message || error) }
      }
    } finally { if (timer) clearTimeout(timer) }
    this.probeState = { state: 'offline', reachable: false, checkedAt: this.now().toISOString(), latencyMs: Date.now() - started, endpoint: null, error: lastError }
    return this.status()
  }

  async recall(query, { limit = 8 } = {}) {
    const local = []
    if (this.memUrl && this.fetchImpl) {
      try {
        const response = await this.fetchImpl(`${this.memUrl}/api/context/semantic`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: clean(query), project: path.basename(path.resolve(process.cwd())), limit: Math.min(10, Math.max(1, Number(limit) || 8)), platformSource: 'quorum' }) })
        if (response.ok) {
          const body = await response.json()
          if (body.context) local.push(String(body.context).slice(0, MAX_CONTEXT))
        }
      } catch { /* memory is an accelerator; the vault index remains available */ }
    }
    const indexed = searchArtifacts(query, { source: 'vault', limit }).results || []
    const indexText = indexed.map(item => `- ${item.title} — ${item.relativePath}: ${item.summary}`).join('\n')
    return [...local, indexText ? `Vault index matches:\n${indexText}` : ''].filter(Boolean).join('\n\n').slice(0, MAX_CONTEXT)
  }

  async sync({ timeoutMs = SYNC_TIMEOUT_MS } = {}) {
    if (!this.memUrl) return { ok: false, state: 'offline', error: 'claude-mem is not configured' }
    const script = path.join(this.bridgeRoot, 'scripts', 'sync-and-export.mjs')
    const config = path.join(this.bridgeRoot, 'config.json')
    if (!fs.existsSync(script) || !fs.existsSync(config)) return { ok: false, state: 'offline', error: 'agent-memory-bridge sync files are unavailable' }
    try {
      const { stdout } = await this.execFileImpl(process.execPath, [script, '--config', config], {
        cwd: this.bridgeRoot,
        env: { HOME, PATH: process.env.PATH || '/usr/bin:/bin:/opt/homebrew/bin' },
        timeout: timeoutMs,
        maxBuffer: 1_000_000,
      })
      const result = JSON.parse(String(stdout || '{}'))
      return {
        ok: result.ok !== false,
        heartbeat: result.heartbeat === true,
        newItems: Number(result.sync?.newItems || 0),
        fetched: Number(result.sync?.fetched || 0),
        pending: Number(result.ledger?.counts?.pending || 0),
        reviewQueue: Number(result.reviewQueue?.pending || 0),
        statusPath: result.statusPath || null,
      }
    } catch (error) {
      return { ok: false, state: 'offline', error: clean(error?.stderr || error?.message || error) }
    }
  }

  async captureCloseout({ sessionId, closeout, cwd = process.cwd() } = {}) {
    if (!this.memUrl || !sessionId || !this.fetchImpl) return { ok: false, skipped: 'claude-mem-not-configured' }
    try {
      // Codex installations may not have claude-mem's optional transcript hook
      // enabled. Establishing the bounded synthetic session first lets the same
      // worker retain a managed-run closeout without ingesting the transcript.
      await this.fetchImpl(`${this.memUrl}/api/sessions/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentSessionId: String(sessionId).slice(0, 160), project: path.basename(path.resolve(cwd)), prompt: 'Quorum managed run closeout', platformSource: 'quorum' }) }).catch(() => null)
      const response = await this.fetchImpl(`${this.memUrl}/api/sessions/summarize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentSessionId: String(sessionId).slice(0, 160), last_assistant_message: String(closeout || '').slice(0, 4_000), platformSource: 'quorum', cwd: path.resolve(cwd) }) })
      return { ok: response.ok, status: response.status, body: response.ok ? await response.json().catch(() => null) : null }
    } catch (error) { return { ok: false, error: clean(error.message || error) } }
  }

  writeMissionNote({ mission, task, run, closeout = '' } = {}) {
    if (!mission || !task || !run) return { ok: false, error: 'mission, task, and run are required' }
    const folder = path.join(this.vault, '09_AI_AGENTS', 'Quorum', 'Missions')
    const file = path.join(folder, `${safeSlug(mission.title)}-${String(mission.id).slice(-12)}.md`)
    if (!within(this.vault, file)) throw new Error('refusing to write outside the configured Obsidian vault')
    const status = run.disposition || run.status || task.status
    const changedFiles = run.closeout?.changedFiles || run.checkpoints?.changedFiles || []
    const header = [
      '---',
      `quorum_mission: ${mission.id}`,
      'managed_by: quorum',
      `updated: ${this.now().toISOString()}`,
      'tags:',
      '  - ai/quorum',
      '  - ai/mission',
      '---',
      '',
      `# ${clean(mission.title)}`,
      '',
      `Objective: ${clean(mission.objective)}`,
      '',
      '> This note is maintained by Quorum. Human notes are never overwritten.',
      '',
    ].filter(Boolean).join('\n')
    let existing = ''
    try { existing = fs.readFileSync(file, 'utf8') } catch { /* first mission note */ }
    const body = upsertTaskSection(existing || header, taskSection({ task, run, closeout, status, changedFiles }), task.id)
    atomicWrite(file, body)
    return { ok: true, path: file }
  }
}

export function memoryBridgeStatus() { return new MemoryBridge().status() }
