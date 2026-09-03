import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { sourceOfTruthStatus } from '../source-of-truth.js'

const HOME = os.homedir()
export const DEFAULT_BRIDGE_ROOT = path.join(HOME, 'CLAUDE', 'agent-memory-bridge')
export const DEFAULT_STATUS_RELATIVE_PATH = '09_AI_AGENTS/Agent-Memory-Control-Plane.md'

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function statMaybe(file) {
  try {
    const stat = fs.statSync(file)
    return { exists: true, path: file, bytes: stat.size, updatedAt: new Date(stat.mtimeMs).toISOString(), mtimeMs: stat.mtimeMs }
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, path: file }
    return { exists: false, path: file, error: error.message }
  }
}

function ledgerCounts(ledger) {
  const counts = { pending: 0, promoted: 0, archived: 0, total: 0 }
  for (const entry of Object.values(ledger?.observations || {})) {
    if (entry?.status === 'pending') counts.pending += 1
    else if (entry?.status === 'promoted') counts.promoted += 1
    else if (entry?.status === 'archived') counts.archived += 1
    counts.total += 1
  }
  return counts
}

function markerCount(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return [...text.matchAll(/<!--\s*claude-mem:(\d+)\s*-->/g)].length
  } catch { return 0 }
}

export function buildMemory(root = DEFAULT_BRIDGE_ROOT) {
  const configPath = path.join(root, 'config.json')
  const config = readJson(configPath)
  const configStat = statMaybe(configPath)
  const ledgerPath = config?.ledgerPath
    ? (path.isAbsolute(config.ledgerPath) ? config.ledgerPath : path.join(root, config.ledgerPath))
    : path.join(root, '.sync-state.json')
  const ledger = readJson(ledgerPath) || { observations: {} }
  const vaultPath = config?.vaultPath || path.join(HOME, 'Documents', 'Obsidian Vault')
  const inboxRelativePath = config?.inboxRelativePath || '09_AI_AGENTS/Claude-Mem-Promotion-Inbox.md'
  const statusRelativePath = config?.statusRelativePath || DEFAULT_STATUS_RELATIVE_PATH
  const inboxPath = path.join(vaultPath, inboxRelativePath)
  const statusPath = path.join(vaultPath, statusRelativePath)
  const counts = ledgerCounts(ledger)
  const inboxMarkers = markerCount(inboxPath)
  const health = []
  if (!configStat.exists) health.push('missing-config')
  if (!statMaybe(ledgerPath).exists) health.push('missing-ledger')
  if (!statMaybe(inboxPath).exists) health.push('missing-inbox')
  if (!statMaybe(statusPath).exists) health.push('missing-status-note')
  if (config?.memBaseUrl && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/.test(config.memBaseUrl)) health.push('source-not-loopback')
  if (inboxMarkers !== counts.pending) health.push('inbox-ledger-count-drift')

  return {
    ok: health.length === 0,
    health,
    bridgeRoot: root,
    configPresent: configStat.exists,
    projects: config?.projects || [],
    source: { url: config?.memBaseUrl || null, localOnly: !health.includes('source-not-loopback') },
    ledger: {
      path: ledgerPath,
      exists: statMaybe(ledgerPath).exists,
      counts,
      cursorHighestId: Number(ledger?.cursor?.highestId || 0),
      updatedAt: statMaybe(ledgerPath).updatedAt || null,
    },
    inbox: {
      path: inboxPath,
      exists: statMaybe(inboxPath).exists,
      observationMarkers: inboxMarkers,
      updatedAt: statMaybe(inboxPath).updatedAt || null,
    },
    statusNote: {
      path: statusPath,
      exists: statMaybe(statusPath).exists,
      updatedAt: statMaybe(statusPath).updatedAt || null,
    },
    sourceOfTruth: sourceOfTruthStatus({ vaultPath }),
    policy: 'review-first: sync -> inbox, promote/archive -> durable vault context',
    ts: Date.now(),
  }
}

export function startMemory(state) {
  const tick = () => {
    try { state.update('memory', buildMemory()) } catch { /* collector must never die */ }
  }
  tick()
  return setInterval(tick, 10_000)
}
