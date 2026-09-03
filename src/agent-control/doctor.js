import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, loadRuntimes } from '../config.js'
import { detectRuntimes } from './adapters.js'
import { providerCatalog } from './provider-registry.js'

const timeoutMs = 1500

function fetchJson(url) {
  return new Promise(resolve => {
    let parsed
    try { parsed = new URL(url) } catch { return resolve({ ok: false, reason: 'invalid-endpoint' }) }
    const client = parsed.protocol === 'https:' ? https : http
    const request = client.get(parsed, { timeout: timeoutMs, headers: { accept: 'application/json' } }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk.slice(0, 200_000) })
      response.on('end', () => {
        try { resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: JSON.parse(body) }) } catch { resolve({ ok: false, status: response.statusCode, reason: 'invalid-json' }) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', error => resolve({ ok: false, reason: error.code === 'ECONNREFUSED' ? 'unreachable' : error.message.slice(0, 80) }))
  })
}

function launchdHealth(home = os.homedir()) {
  const dir = path.join(home, 'Library', 'LaunchAgents')
  const labels = []
  try {
    for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.plist'))) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8')
      const label = text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
      if (label?.includes('quorum') || label?.includes('unified-ai-operator')) labels.push({ file, label, loaded: null })
    }
  } catch { /* launchd is optional outside macOS */ }
  return { canonicalLabels: [...new Set(labels.map(item => item.label))], duplicateCount: Math.max(0, labels.length - 1), files: labels }
}

function machineSafety(home = os.homedir()) {
  const claude = []
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(home, '.claude', name)
    if (!fs.existsSync(file)) continue
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'))
      claude.push({ file, present: true, safe: json.permissions?.defaultMode !== 'bypassPermissions' && json.skipDangerousModePermissionPrompt !== true && json.skipAutoPermissionPrompt !== true })
    } catch { claude.push({ file, present: true, safe: false, reason: 'malformed-settings' }) }
  }
  const hermesFile = path.join(home, '.hermes', 'config.yaml')
  const hermes = { file: hermesFile, present: fs.existsSync(hermesFile), safe: true, checks: {} }
  if (hermes.present) {
    let source = ''
    try { source = fs.readFileSync(hermesFile, 'utf8') } catch { hermes.safe = false; hermes.reason = 'unreadable-config' }
    for (const key of ['verify_on_stop', 'hard_stop_enabled', 'guard_agent_created', 'write_approval']) {
      const match = source.match(new RegExp(`^\\s*${key}:\\s*(true|false)\\s*$`, 'mi'))
      hermes.checks[key] = match ? match[1] === 'true' : 'not-configured'
      if (match && match[1] !== 'true') hermes.safe = false
    }
    const autoApprove = source.match(/^\s*subagent_auto_approve:\s*(true|false)\s*$/mi)
    hermes.checks.subagent_auto_approve = autoApprove ? autoApprove[1] === 'false' : 'not-configured'
    if (autoApprove && autoApprove[1] !== 'false') hermes.safe = false
  }
  return { claude, hermes }
}

export async function runDoctor({ home = os.homedir(), env = process.env } = {}) {
  const config = loadConfig()
  const runtimes = detectRuntimes(env)
  const ollama = runtimes.find(item => item.id === 'ollama')
  const endpoint = config.ollamaHost || env.OLLAMA_HOST || 'http://127.0.0.1:11434'
  const endpointResult = await fetchJson(`${String(endpoint).replace(/\/$/, '')}/api/tags`)
  const models = endpointResult.ok && Array.isArray(endpointResult.json?.models)
    ? endpointResult.json.models.map(model => typeof model?.name === 'string' ? model.name.slice(0, 160) : null).filter(Boolean).slice(0, 100)
    : []
  const modelRoot = typeof env.OLLAMA_MODELS === 'string' && env.OLLAMA_MODELS.trim() ? path.resolve(env.OLLAMA_MODELS) : null
  const routeReady = Boolean(endpointResult.ok && models.length)
  const launchd = launchdHealth(home)
  const safety = machineSafety(home)
  const providerEntries = providerCatalog({ runtimes })
  let safeEndpoint = 'configured'
  try { safeEndpoint = new URL(endpoint).origin } catch { /* keep opaque status */ }
  return {
    ok: runtimes.some(item => item.available) && (!ollama || !ollama.available || routeReady || endpointResult.reason === 'unreachable'),
    runtimes,
    providers: {
      catalog: providerEntries,
      contractVersion: 1,
      ollama: {
        cliInstalled: Boolean(ollama?.available),
        endpoint: safeEndpoint,
        endpointReachable: endpointResult.ok,
        route: routeReady ? 'ready' : endpointResult.reason === 'unreachable' ? 'unreachable' : 'model-unavailable',
        models,
        modelDirectory: modelRoot ? { path: modelRoot, mounted: fs.existsSync(modelRoot) } : { configured: false },
      },
    },
    launchd,
    safety,
    state: { directory: path.join(home, '.quorum', 'agent-control'), legacyReadable: fs.existsSync(path.join(home, '.agent-control', 'state.json')) },
    blockers: [
      ...runtimes.filter(item => !item.available).map(item => `${item.id} CLI unavailable`),
      ...(ollama?.available && !routeReady && endpointResult.reason !== 'unreachable' ? ['Ollama endpoint reachable without an installed model route'] : []),
      ...(launchd.duplicateCount ? ['duplicate Quorum LaunchAgent candidates'] : []),
      ...(safety.claude.some(item => item.safe === false) ? ['Claude permission bypass posture detected'] : []),
      ...(safety.hermes.present && safety.hermes.safe === false ? ['Hermes safety guard is not enabled'] : []),
    ],
  }
}
