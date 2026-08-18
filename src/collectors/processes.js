import { sh } from '../util.js'

// Order matters: first match wins (claude-mem must match before the generic claude rule).
// 'exe' rules test only the executable path — a `git` process with ~/.claude in its
// args must NOT classify as claude.
const RULES = [
  ['comfy',      /ComfyUI/,                      'exe'],
  ['hermes',     /hermes/i,                      'exe'],
  ['codex',      /codex/,                        'exe'],
  ['mem',        /claude-mem/,                   'cmd'],
  ['mcp',        /(gitnexus|mcp-server\.cjs)/,   'cmd'],
  ['dev',        /(workerd|esbuild|wrangler\b|\bvite\b)/, 'cmd'],
  ['claude-app', /Applications\/Claude\.app/,    'exe'],
  ['claude',     /claude/i,                      'exe'],
]

// Only these groups produce spawn/exit feed events (mcp/dev/mem churn is noise).
const FEED_GROUPS = new Set(['claude', 'codex', 'hermes', 'comfy'])

// Human-readable short name for a command line.
export function shortName(cmd) {
  const hf = cmd.match(/hf download\s+\S+\s+(\S+)/)
  if (hf) return 'hf ⇣ ' + hf[1].split('/').pop()
  if (/ComfyUI\/main\.py/.test(cmd)) return 'ComfyUI server'
  const first = cmd.split(' ')[0].split('/').pop()
  if (/^(python[\d.]*|node|bun)$/.test(first)) {
    const script = cmd.split(' ').find(t => /\.(py|js|cjs|mjs)$/.test(t))
    if (script) return `${first} ${script.split('/').pop()}`
    if (/hermes/.test(cmd)) return 'hermes'
  }
  if (first.toLowerCase().includes('claude')) {
    if (cmd.includes('bg-spare')) return 'claude bg-spare'
    if (cmd.includes('daemon')) return 'claude daemon'
    if (cmd.includes('bg-pty-host') || cmd.includes('--bg-pty-host')) return 'claude pty-host'
    const sid = cmd.match(/--session-id ([0-9a-f]{8})/)
    return 'claude' + (sid ? ' ' + sid[1] : '')
  }
  return first
}

export function startProcesses(state) {
  let prev = new Map()
  let first = true

  const tick = async () => {
    const out = await sh('/bin/ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,command='])
    if (!out) return
    const procs = []
    const all = []
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/)
      if (!m) continue
      const p = {
        pid: +m[1], ppid: +m[2], cpu: +m[3],
        rssMB: +(m[4] / 1024).toFixed(1),
        etime: m[5], cmd: m[6].slice(0, 220),
      }
      all.push(p)
      const exe = p.cmd.split(' ')[0]
      for (const [group, re, target] of RULES) {
        if (re.test(target === 'exe' ? exe : p.cmd)) {
          p.group = group; p.name = shortName(p.cmd); procs.push(p); break
        }
      }
    }

    // spawn / exit events
    const cur = new Map(procs.map(p => [p.pid, p]))
    if (!first) {
      for (const [pid, p] of cur)
        if (!prev.has(pid) && FEED_GROUPS.has(p.group))
          state.event({ kind: 'spawn', text: `+ ${p.name} (${pid})` })
      for (const [pid, p] of prev)
        if (!cur.has(pid) && FEED_GROUPS.has(p.group))
          state.event({ kind: 'exit', text: `− ${p.name} (${pid}) exited` })
    }
    prev = cur
    first = false

    const groups = {}
    for (const p of procs) groups[p.group] = (groups[p.group] || 0) + 1
    const topRss = [...all].sort((a, b) => b.rssMB - a.rssMB).slice(0, 8)
      .map(p => ({ pid: p.pid, rssMB: p.rssMB, cpu: p.cpu, name: p.name || shortName(p.cmd), group: p.group || null }))

    state.update('processes', { procs, groups, topRss })
  }

  tick()
  setInterval(tick, 2500)
}
