import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'

const COMPOSIO_DIR = path.join(os.homedir(), '.composio')
const CLI = path.join(os.homedir(), '.local', 'bin', 'composio')

// `composio connections list` is a network round-trip, so it runs on its own
// slower interval than the file scan and always under an explicit timeout —
// util.sh() has none, and a hung CLI would stall the collector forever.
function cli(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(CLI, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) return resolve(null)
      try { resolve(JSON.parse(stdout)) } catch { resolve(null) }
    })
  })
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// Toolkit prefixes of every cached tool definition — a decent proxy for what
// this machine has actually exercised, independent of live connection state.
function localToolkits() {
  try {
    const files = fs.readdirSync(path.join(COMPOSIO_DIR, 'tool_definitions'))
    const set = new Set()
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const m = f.match(/^([A-Z0-9]+?)_/)
      if (m) set.add(m[1].toLowerCase())
    }
    return { count: files.length, toolkits: [...set].sort() }
  } catch { return { count: 0, toolkits: [] } }
}

export function summarizeConnections(raw) {
  if (!raw || typeof raw !== 'object') return null
  const accounts = []
  for (const [toolkit, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue
    for (const c of list) {
      accounts.push({
        toolkit,
        status: c?.status || 'UNKNOWN',
        // word_id is an opaque handle, not a credential — safe to display, and
        // it is what an agent must pass to `--account` to pick the right identity.
        wordId: c?.word_id || null,
      })
    }
  }
  accounts.sort((a, b) => a.toolkit.localeCompare(b.toolkit) || String(a.wordId).localeCompare(String(b.wordId)))
  const counts = { active: 0, expired: 0, other: 0 }
  const dupes = {}
  for (const a of accounts) {
    if (a.status === 'ACTIVE') counts.active++
    else if (a.status === 'EXPIRED') counts.expired++
    else counts.other++
    dupes[a.toolkit] = (dupes[a.toolkit] || 0) + 1
  }
  // Toolkits with >1 connection are the --account footgun: an unpinned call
  // can hit the wrong identity (e.g. business vs personal Gmail).
  const ambiguous = Object.keys(dupes).filter((t) => dupes[t] > 1).sort()
  return { accounts, counts, ambiguous }
}

export function startComposio(state) {
  let conns = null
  let lastErr = null

  const scan = () => {
    const analytics = readJson(path.join(COMPOSIO_DIR, 'analytics.json'))
    const tools = localToolkits()
    const pendingLogin = fs.existsSync(path.join(COMPOSIO_DIR, 'pending-login-session.json'))
    let cliPresent = false
    try { cliPresent = fs.statSync(CLI).isFile() } catch { /* not installed */ }

    return {
      cliPresent,
      // Fingerprint only — never the key itself.
      keyFingerprint: analytics?.api_key_fingerprint || null,
      installId: analytics?.install_id || null,
      toolDefs: tools.count,
      toolkits: tools.toolkits,
      pendingLogin,
      connections: conns,
      error: lastErr,
      ts: Date.now(),
    }
  }

  const refreshConnections = async () => {
    const raw = await cli(['connections', 'list'])
    if (raw) { conns = summarizeConnections(raw); lastErr = null }
    else { lastErr = 'composio connections list failed or timed out' }
    try { state.update('composio', scan()) } catch { /* never die */ }
  }

  const tick = () => {
    try { state.update('composio', scan()) } catch { /* never die */ }
  }

  tick()
  refreshConnections()
  setInterval(tick, 5000)
  return setInterval(refreshConnections, 60000)
}
