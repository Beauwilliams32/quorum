import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()

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

// Read-only auth freshness. Never writes, never exposes token values.
function readAuth() {
  const out = {}
  try {
    const a = JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'auth.json'), 'utf8'))
    out.codex = { mode: a.auth_mode || 'unknown', lastRefresh: a.last_refresh || null }
  } catch { out.codex = null }
  out.claude = fs.existsSync(path.join(HOME, '.claude'))
  out.hermes = fs.existsSync(path.join(HOME, '.hermes'))
  return out
}

export function startServices(state) {
  let last = {}
  const tick = async () => {
    const [hermes, comfy] = await Promise.all([probeHermes(), probeComfy()])
    const auth = readAuth()
    if (last.hermes !== undefined && last.hermes !== hermes.up)
      state.event({ kind: hermes.up ? 'up' : 'down', text: `hermes gateway ${hermes.up ? 'UP' : 'DOWN'} :8644` })
    if (last.comfy !== undefined && last.comfy !== comfy.up)
      state.event({ kind: comfy.up ? 'up' : 'down', text: `comfyui engine ${comfy.up ? 'UP' : 'DOWN'} :8188` })
    last = { hermes: hermes.up, comfy: comfy.up }
    state.update('services', { hermes, comfy, auth })
  }
  tick()
  setInterval(tick, 5000)
}
