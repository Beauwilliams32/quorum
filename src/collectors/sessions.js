import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { tailBytes, jsonLines, withinDir } from '../util.js'
import { resolveProjectId } from './projects.js'

const HOME = os.homedir()
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects')
const CLAUDE_JOBS = path.join(HOME, '.claude', 'jobs')
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions')
const FRESH_MS = 48 * 3600 * 1000 // only surface sessions touched in the last 48h
const ACTIVE_MS = 90 * 1000       // transcript written in last 90s → "live"

// file -> { mtimeMs, size, card } so unchanged transcripts aren't re-read every tick
const cache = new Map()

// Every tick used to statSync every .jsonl under ~/.claude/projects and
// ~/.codex/sessions — 12,000 files on the benchmark corpus, 47ms of syscalls
// every 3 seconds, to learn that almost all of them are months old and
// outside the 48h window this collector even looks at.
//
// A cheap tick now stats only the files that were inside that window last
// time (the only ones that can produce or change a card) plus any directory
// whose own mtime moved, which is what creating a file does. Appending to a
// file does not move its directory's mtime, so a session dormant for more
// than 48h and then resumed would be invisible to cheap ticks alone — hence
// a full sweep every FULL_SWEEP_TICKS, which bounds that at 15 seconds.
export const FULL_SWEEP_TICKS = 5
const dirCursor = new Map()    // directory -> mtimeMs at its last full read
const freshByDir = new Map()   // directory -> Set of files inside the 48h window
let tickCount = 0

export function startSessions(state, { intervalMs = 3_000 } = {}) {
  const tick = () => {
    try {
      const full = tickCount % FULL_SWEEP_TICKS === 0
      tickCount += 1
      const seen = full ? new Set() : null
      const cards = [...scanClaude(full, seen), ...scanCodex(full, seen)]
      cards.sort((a, b) => b.mtimeMs - a.mtimeMs)
      const now = Date.now()
      for (const c of cards) c.active = now - c.mtimeMs < ACTIVE_MS
      if (full) evictUnseen(seen)
      state.update('sessions', { cards: cards.slice(0, 40) })
    } catch { /* collector must never die */ }
  }
  tick()
  return setInterval(tick, intervalMs)
}

/**
 * Drop cached transcripts whose files no longer exist. Without this the cache
 * grew for the life of the process — a rotated or deleted session stayed
 * resident forever.
 */
function evictUnseen(seen) {
  for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file)
  for (const [dir, files] of freshByDir) {
    for (const file of files) if (!seen.has(file)) files.delete(file)
    if (!files.size) freshByDir.delete(dir)
  }
}

/**
 * List the .jsonl files in `dir` worth stating this tick. On a full sweep, or
 * when the directory itself changed, that is all of them; otherwise it is
 * only the ones that were inside the freshness window last time.
 */
function candidates(dir, full, seen) {
  let dirMtime = null
  try { dirMtime = fs.statSync(dir).mtimeMs } catch { return [] }
  const changed = dirCursor.get(dir) !== dirMtime
  if (!full && !changed) return [...(freshByDir.get(dir) || [])]
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  dirCursor.set(dir, dirMtime)
  const files = names.filter(name => name.endsWith('.jsonl')).map(name => path.join(dir, name))
  if (seen) for (const file of files) seen.add(file)
  return files
}

function noteFreshness(dir, file, fresh) {
  if (fresh) {
    let files = freshByDir.get(dir)
    if (!files) { files = new Set(); freshByDir.set(dir, files) }
    files.add(file)
    return
  }
  const files = freshByDir.get(dir)
  if (!files) return
  files.delete(file)
  if (!files.size) freshByDir.delete(dir)
}

function forget(dir, file) {
  cache.delete(file)
  noteFreshness(dir, file, false)
}

function jobIds() {
  try { return fs.readdirSync(CLAUDE_JOBS) } catch { return [] }
}

function scanClaude(full = true, seen = null) {
  const cards = []
  const jobs = jobIds()
  let dirs = []
  try { dirs = fs.readdirSync(CLAUDE_PROJECTS) } catch { return cards }
  const now = Date.now()
  for (const dir of dirs) {
    const dpath = path.join(CLAUDE_PROJECTS, dir)
    for (const file of candidates(dpath, full, seen)) {
      const f = path.basename(file)
      let st
      try { st = fs.statSync(file) } catch { forget(dpath, file); continue }
      const fresh = now - st.mtimeMs <= FRESH_MS
      noteFreshness(dpath, file, fresh)
      if (!fresh) { cache.delete(file); continue }

      const hit = cache.get(file)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        if (!hit.card.projectId) hit.card.projectId = resolveProjectId(hit.card.cwd)
        cards.push(hit.card)
        continue
      }
      const lines = jsonLines(tailBytes(file, 65536))
      if (!lines.length) continue
      const meta = [...lines].reverse().find(l => l.cwd) || {}
      const id = path.basename(f, '.jsonl')
      const cwd = meta.cwd || null
      const card = {
        agent: 'claude',
        id,
        file,
        cwd,
        projectId: resolveProjectId(cwd),
        branch: meta.gitBranch || null,
        kind: meta.sessionKind || (jobs.some(j => id.startsWith(j)) ? 'bg' : 'fg'),
        model: [...lines].reverse().find(l => l.message?.model)?.message?.model || null,
        mtimeMs: st.mtimeMs,
        summary: summarizeClaude(lines),
      }
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, card })
      cards.push(card)
    }
  }
  return cards
}

function summarizeClaude(lines) {
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 50; i--) {
    const l = lines[i]
    if (l.type === 'assistant' && Array.isArray(l.message?.content)) {
      const c = l.message.content
      const tool = c.find(x => x.type === 'tool_use')
      if (tool) return `→ ${tool.name} ${toolHint(tool.input)}`.trim()
      const text = c.find(x => x.type === 'text' && x.text?.trim())
      if (text) return text.text.replace(/\s+/g, ' ').slice(0, 110)
    }
    if (l.type === 'user') {
      const c = l.message?.content
      if (typeof c === 'string' && c.trim() && !c.startsWith('<')) return '❯ ' + c.replace(/\s+/g, ' ').slice(0, 110)
    }
  }
  return ''
}

function toolHint(input) {
  if (!input || typeof input !== 'object') return ''
  const v = input.file_path || input.command || input.pattern || input.description || input.prompt || input.url || ''
  const s = String(v)
  return s.includes('/') && !s.includes(' ') ? s.split('/').pop() : s.slice(0, 60)
}

function scanCodex(full = true, seen = null) {
  const cards = []
  const now = Date.now()
  // sessions/YYYY/MM/DD/rollout-*.jsonl — walk newest few day-dirs only
  let days = []
  try {
    for (const y of fs.readdirSync(CODEX_SESSIONS).sort().reverse().slice(0, 1))
      for (const m of fs.readdirSync(path.join(CODEX_SESSIONS, y)).sort().reverse().slice(0, 2))
        for (const d of fs.readdirSync(path.join(CODEX_SESSIONS, y, m)).sort().reverse().slice(0, 5))
          days.push(path.join(CODEX_SESSIONS, y, m, d))
  } catch { return cards }

  for (const day of days.slice(0, 6)) {
    for (const file of candidates(day, full, seen)) {
      const f = path.basename(file)
      let st
      try { st = fs.statSync(file) } catch { forget(day, file); continue }
      const fresh = now - st.mtimeMs <= FRESH_MS
      noteFreshness(day, file, fresh)
      if (!fresh) { cache.delete(file); continue }

      const hit = cache.get(file)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        if (!hit.card.projectId) hit.card.projectId = resolveProjectId(hit.card.cwd)
        cards.push(hit.card)
        continue
      }
      const head = jsonLines(readHead(file, 4096))
      const lines = jsonLines(tailBytes(file, 32768))
      const meta = head.find(l => l.payload?.cwd || l.type === 'session_meta')?.payload || {}
      const cwd = meta.cwd || null
      const card = {
        agent: 'codex',
        id: (f.match(/([0-9a-f]{8})[0-9a-f-]*\.jsonl$/) || [, f.slice(0, 8)])[1],
        file,
        cwd,
        projectId: resolveProjectId(cwd),
        branch: null,
        kind: 'fg',
        model: meta.model || null,
        mtimeMs: st.mtimeMs,
        summary: summarizeCodex(lines),
      }
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, card })
      cards.push(card)
    }
  }
  return cards
}

function readHead(file, n) {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(n)
    const read = fs.readSync(fd, buf, 0, n, 0)
    fs.closeSync(fd)
    return buf.toString('utf8', 0, read)
  } catch { return '' }
}

function canonicalSessionDir(dir) {
  try { return fs.realpathSync(dir) } catch { return path.resolve(dir) }
}

function summarizeCodex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = lines[i].payload
    if (!p) continue
    if (p.type === 'agent_message' && p.message) return p.message.replace(/\s+/g, ' ').slice(0, 110)
    if (p.type === 'exec_command_begin') return '→ exec ' + (Array.isArray(p.command) ? p.command.join(' ') : String(p.command || '')).slice(0, 80)
    if (p.type === 'task_complete') return '✓ done' + (p.last_agent_message ? ': ' + p.last_agent_message.replace(/\s+/g, ' ').slice(0, 80) : '')
    if (p.type === 'task_started') return '… task started'
  }
  return lines.at(-1)?.payload?.type || lines.at(-1)?.type || ''
}

// ── Live transcript tailing for the detail pane ────────────────────────────────

export class TranscriptWatcher {
  constructor(ws) {
    this.ws = ws
    this.timer = null
    this.file = null
    this.pos = 0
    this.agent = 'claude'
  }

  watch(file, agent = 'claude') {
    this.stop()
    const real = fs.realpathSync(file) // throws if missing
    if (!withinDir(real, canonicalSessionDir(CLAUDE_PROJECTS)) && !withinDir(real, canonicalSessionDir(CODEX_SESSIONS)))
      throw new Error('refusing to watch a path outside session directories')
    this.file = real
    this.agent = agent
    const st = fs.statSync(real)
    const start = Math.max(0, st.size - 200_000)
    this.pos = st.size
    this.send(tailBytes(real, st.size - start), true)
    this.timer = setInterval(() => this.poll(), 1000)
  }

  poll() {
    try {
      const st = fs.statSync(this.file)
      if (st.size <= this.pos) return
      const fd = fs.openSync(this.file, 'r')
      const buf = Buffer.alloc(st.size - this.pos)
      fs.readSync(fd, buf, 0, buf.length, this.pos)
      fs.closeSync(fd)
      this.pos = st.size
      this.send(buf.toString('utf8'), false)
    } catch { /* file may rotate away */ }
  }

  send(text, reset) {
    const lines = jsonLines(text)
    const events = this.agent === 'codex' ? codexEvents(lines) : claudeEvents(lines)
    if (this.ws.readyState === 1)
      this.ws.send(JSON.stringify({ type: 'transcript', file: this.file, reset, events }))
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.file = null
  }
}

function claudeEvents(lines) {
  const out = []
  for (const l of lines) {
    const ts = l.timestamp
    if (l.type === 'assistant' && Array.isArray(l.message?.content)) {
      for (const c of l.message.content) {
        if (c.type === 'thinking' && c.thinking?.trim()) out.push({ ts, kind: 'thinking', body: c.thinking.slice(0, 700) })
        if (c.type === 'text' && c.text?.trim()) out.push({ ts, kind: 'assistant', body: c.text.slice(0, 4000) })
        if (c.type === 'tool_use') out.push({ ts, kind: 'tool', label: c.name, body: JSON.stringify(c.input).slice(0, 900) })
      }
    } else if (l.type === 'user') {
      const c = l.message?.content
      if (typeof c === 'string' && c.trim()) out.push({ ts, kind: 'user', body: c.slice(0, 2000) })
      else if (Array.isArray(c)) {
        for (const x of c) {
          if (x.type === 'tool_result') {
            let body = typeof x.content === 'string' ? x.content : JSON.stringify(x.content)
            out.push({ ts, kind: 'result', body: (body || '').slice(0, 1500), error: !!x.is_error })
          }
          if (x.type === 'text' && x.text?.trim()) out.push({ ts, kind: 'user', body: x.text.slice(0, 2000) })
        }
      }
    } else if (l.type === 'system' && l.content) {
      out.push({ ts, kind: 'system', body: String(l.content).slice(0, 600) })
    } else if (l.type === 'summary' && l.summary) {
      out.push({ ts, kind: 'system', body: 'summary: ' + l.summary })
    }
  }
  return out
}

function codexEvents(lines) {
  const out = []
  for (const l of lines) {
    const ts = l.timestamp
    const p = l.payload
    if (!p) continue
    if (p.type === 'agent_message' && p.message) out.push({ ts, kind: 'assistant', body: p.message.slice(0, 4000) })
    else if (p.type === 'agent_reasoning' && p.text) out.push({ ts, kind: 'thinking', body: p.text.slice(0, 700) })
    else if (p.type === 'exec_command_begin') out.push({ ts, kind: 'tool', label: 'exec', body: (Array.isArray(p.command) ? p.command.join(' ') : String(p.command || '')).slice(0, 900) })
    else if (p.type === 'exec_command_end') out.push({ ts, kind: 'result', body: String(p.aggregated_output ?? p.stdout ?? '').slice(0, 1500), error: p.exit_code !== 0 && p.exit_code != null })
    else if (p.type === 'task_started') out.push({ ts, kind: 'system', body: 'task started' })
    else if (p.type === 'task_complete') out.push({ ts, kind: 'system', body: 'task complete' + (p.last_agent_message ? ': ' + p.last_agent_message.slice(0, 300) : '') })
    else if (p.type === 'message' && Array.isArray(p.content)) {
      for (const c of p.content) {
        if ((c.type === 'output_text' || c.type === 'input_text') && c.text?.trim())
          out.push({ ts, kind: p.role === 'user' ? 'user' : 'assistant', body: c.text.slice(0, 3000) })
      }
    }
  }
  return out
}

/** Test seam: forget every cached transcript, cursor and freshness marker. */
export function resetSessionCachesForTests() {
  cache.clear()
  dirCursor.clear()
  freshByDir.clear()
  tickCount = 0
}
