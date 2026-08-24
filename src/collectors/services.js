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

async function getJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1800) })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

async function probeHermes() {
  const h = await getJson('http://127.0.0.1:8644/health')
  return { up: !!h, port: 8644, detail: h }
}

async function probeComfy() {
  const stats = await getJson('http://127.0.0.1:8188/system_stats')
  if (!stats) return { up: false, port: 8188 }
  const q = await getJson('http://127.0.0.1:8188/queue')
  const dev = stats.devices?.[0]
  return {
    up: true,
    port: 8188,
    running: q?.queue_running?.length || 0,
    pending: q?.queue_pending?.length || 0,
    device: dev?.name?.slice(0, 40) || null,
    vramFreeGB: dev?.vram_free ? +(dev.vram_free / 1e9).toFixed(1) : null,
  }
}

async function probeOpenClaw() {
  const candidates = [18789, 18790]
  for (const port of candidates) {
    const health = await getJson(`http://127.0.0.1:${port}/health`)
    if (health) return { up: true, port, detail: { status: health.status || 'reachable' } }
    const root = await getJson(`http://127.0.0.1:${port}/`)
    if (root) return { up: true, port, detail: { status: 'reachable' } }
  }
  return { up: false, port: 18789 }
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
  out.claude = { configured: claudeConfigured, cli: commandAvailable('claude') }
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
      state.event({ kind: comfy.up ? 'up' : 'down', text: `comfyui engine ${comfy.up ? 'UP' : 'DOWN'} :8188` })
    if (last.openclaw !== undefined && last.openclaw !== openclaw.up)
      state.event({ kind: openclaw.up ? 'up' : 'down', text: `openclaw gateway ${openclaw.up ? 'UP' : 'DOWN'} :${openclaw.port}` })
    last = { hermes: hermes.up, comfy: comfy.up, openclaw: openclaw.up }
    state.update('services', { hermes, comfy, openclaw, auth })
  }
  tick()
  setInterval(tick, 5000)
}
