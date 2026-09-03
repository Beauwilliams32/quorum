import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()

// Do not execute a CLI just to render the cockpit.  A path lookup is enough to
// distinguish a missing runtime from an installed runtime that still needs the
// operator to sign in, and it keeps the readiness collector read-only.
export function commandAvailable(command, envPath = process.env.PATH || '') {
  if (!command || /[\\/]/.test(command)) return false
  return envPath.split(path.delimiter).some(dir => {
    if (!dir) return false
    try {
      const stat = fs.statSync(path.join(dir, command))
      return stat.isFile() && (stat.mode & 0o111) !== 0
    } catch { return false }
  })
}

function executable(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() && (stat.mode & 0o111) !== 0
  } catch { return false }
}

/**
 * Resolve Claude Code the same way for readiness and roundtable child turns.
 * LaunchAgents do not inherit an interactive shell's PATH, and Claude Code
 * can be installed as the executable shipped with the local Agent SDK rather
 * than as a global `claude` command. The returned value is a path only; no
 * credential or command output is persisted.
 */
export function resolveClaudeCommand(envPath = process.env.PATH || '', home = HOME, env = process.env) {
  const configured = typeof env.QUORUM_CLAUDE_COMMAND === 'string' ? env.QUORUM_CLAUDE_COMMAND.trim() : ''
  if (configured && executable(configured)) return configured
  for (const dir of String(envPath).split(path.delimiter)) {
    const candidate = dir ? path.join(dir, 'claude') : ''
    if (candidate && executable(candidate)) return candidate
  }

  // Claude Code's standalone SDK binary is a valid headless CLI and is
  // present in local-first installs where the global npm shim is absent.
  const projectRoots = [
    path.join(home, 'CLAUDE', 'claude-mem'),
    path.join(home, 'claude-mem'),
  ]
  for (const root of projectRoots) {
    const vendorRoot = path.join(root, 'node_modules', '@anthropic-ai')
    let entries = []
    try { entries = fs.readdirSync(vendorRoot) } catch { continue }
    for (const entry of entries.filter(name => name.startsWith('claude-agent-sdk-')).sort().reverse()) {
      const candidate = path.join(vendorRoot, entry, 'claude')
      if (executable(candidate)) return candidate
    }
  }
  return null
}

async function getJson(url, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(1800) })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

async function probeHermes() {
  const h = await getJson('http://127.0.0.1:8644/health')
  return { up: !!h, port: 8644, detail: h }
}

// The current managed WMH engine runs on :8199; :8188 remains a compatibility
// fallback for legacy direct ComfyUI launches. Probe only one reachable engine.
export async function probeComfy(fetchImpl = fetch, ports = [8199, 8188]) {
  for (const port of ports) {
    const stats = await getJson(`http://127.0.0.1:${port}/system_stats`, fetchImpl)
    if (!stats) continue
    const q = await getJson(`http://127.0.0.1:${port}/queue`, fetchImpl)
    const dev = stats.devices?.[0]
    return {
      up: true,
      port,
      running: q?.queue_running?.length || 0,
      pending: q?.queue_pending?.length || 0,
      device: dev?.name?.slice(0, 40) || null,
      vramFreeGB: dev?.vram_free ? +(dev.vram_free / 1e9).toFixed(1) : null,
    }
  }
  return { up: false, port: ports[0] || 8199 }
}

async function probeOpenClaw() {
  const candidates = [18789, 18790]
  for (const port of candidates) {
    const health = await getJson(`http://127.0.0.1:${port}/health`)
    if (health) return { up: true, port, connectionState: 'reachable', authState: 'required', detail: { status: health.status || 'reachable' } }
    const root = await getJson(`http://127.0.0.1:${port}/`)
    if (root) return { up: true, port, connectionState: 'reachable', authState: 'required', detail: { status: 'reachable' } }
  }
  return { up: false, port: 18789, connectionState: 'offline', authState: 'unknown' }
}

// This is intentionally a boolean only. The key stays in the process
// environment for the Claude CLI to consume; it never enters state, logs, UI,
// test fixtures, or a Quorum config file.
export function apiKeyAvailable(env = process.env) {
  return typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim().length > 0
}

// Resolve the one safe command path for a roundtable. A signed-in CLI is the
// default because it needs no extra configuration. API-key mode is explicit
// and only available when the server already received a key in its own
// environment; Quorum never asks for, reads, or stores that key.
export function resolveRoundtableAuth(auth = {}, requested = 'auto') {
  if (!auth.claude?.cli) throw new Error('Claude Code is not installed; install it before convening a table')
  const cliReady = auth.claude.configured === true
  const apiKeyReady = auth.anthropic?.apiKeyAvailable === true
  const mode = requested === 'cli' || requested === 'api-key' ? requested : 'auto'

  if (mode === 'cli') {
    if (!cliReady) throw new Error('Claude Code sign-in is required for CLI account mode')
    return 'cli'
  }
  if (mode === 'api-key') {
    if (!apiKeyReady) throw new Error('API-key mode is unavailable; start Quorum with its API key in the environment')
    return 'api-key'
  }
  if (cliReady) return 'cli'
  if (apiKeyReady) return 'api-key'
  throw new Error('Sign in to Claude Code or start Quorum with an API key in its environment')
}

// Read-only auth freshness. Never writes, never exposes token values.
export function readAuth(env = process.env) {
  const out = {}
  const claudeConfigured = fs.existsSync(path.join(HOME, '.claude'))
  const hermesConfigured = fs.existsSync(path.join(HOME, '.hermes'))
  try {
    const a = JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'auth.json'), 'utf8'))
    out.codex = { configured: true, cli: commandAvailable('codex'), mode: a.auth_mode || 'unknown', lastRefresh: a.last_refresh || null }
  } catch { out.codex = { configured: false, cli: commandAvailable('codex') } }
  out.claude = { configured: claudeConfigured, cli: !!resolveClaudeCommand(env.PATH, HOME, env) }
  out.hermes = { configured: hermesConfigured, cli: commandAvailable('hermes') }
  out.anthropic = { apiKeyAvailable: apiKeyAvailable(env) }
  return out
}

export function startServices(state) {
  let last = {}
  const tick = async () => {
    const [hermes, comfy, openclaw] = await Promise.all([probeHermes(), probeComfy(), probeOpenClaw()])
    const auth = readAuth()
    if (last.hermes !== undefined && last.hermes !== hermes.up)
      state.event({ kind: hermes.up ? 'up' : 'down', text: `hermes gateway ${hermes.up ? 'UP' : 'DOWN'} :8644` })
    if (last.comfy !== undefined && last.comfy !== comfy.up)
      state.event({ kind: comfy.up ? 'up' : 'down', text: `comfyui engine ${comfy.up ? 'UP' : 'DOWN'} :${comfy.port}` })
    if (last.openclaw !== undefined && last.openclaw !== openclaw.up)
      state.event({ kind: openclaw.up ? 'up' : 'down', text: `openclaw gateway ${openclaw.up ? 'UP' : 'DOWN'} :${openclaw.port}` })
    last = { hermes: hermes.up, comfy: comfy.up, openclaw: openclaw.up }
    state.update('services', { hermes, comfy, openclaw, auth })
  }
  tick()
  setInterval(tick, 5000)
}
