import os from 'node:os'
import pty from 'node-pty'

// One-keystroke launch profiles. Agent CLIs run inside an interactive login zsh
// so they inherit the user's full PATH and (crucially) the machine's shared
// credentials: ~/.claude, ~/.codex/auth.json, ~/.hermes — no auth plumbing needed.
const CMDS = { claude: 'claude', hermes: 'hermes', codex: 'codex' }
const SCROLLBACK = 200_000

let seq = 0

export class PtyManager {
  constructor(state) {
    this.state = state
    this.map = new Map()
  }

  // `command` overrides the profile's default CLI. It is built server-side only
  // (never from raw client text) — see buildResumeCommand in server.js.
  create(profile = 'shell', cwd, cols = 120, rows = 30, command = null) {
    const shell = process.env.SHELL || '/bin/zsh'
    const cli = command || CMDS[profile] || 'true'
    const args = profile === 'shell' && !command ? ['-l'] : ['-l', '-i', '-c', cli]
    // Strip CLAUDE* vars: this server may itself run under a Claude session and
    // a spawned `claude` must not think it's nested.
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE')) delete env[k]

    const id = 't' + (++seq)
    const term = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols, rows,
      cwd: cwd || os.homedir(),
      env,
    })
    const rec = { id, profile, cwd: cwd || os.homedir(), term, buf: '', subs: new Set(), exited: false }
    this.map.set(id, rec)

    term.onData(data => {
      rec.buf += data
      if (rec.buf.length > SCROLLBACK) rec.buf = rec.buf.slice(-SCROLLBACK)
      const msg = JSON.stringify({ type: 'pty.data', id, data })
      for (const ws of rec.subs) if (ws.readyState === 1) ws.send(msg)
    })
    term.onExit(({ exitCode }) => {
      rec.exited = true
      this.state.broadcast({ type: 'pty.exit', id, code: exitCode })
      this.state.event({ kind: 'exit', text: `terminal ${profile} (${id}) exited ${exitCode}` })
      this.broadcastList()
    })

    this.state.event({ kind: 'spawn', text: `terminal ${profile} (${id}) opened` })
    this.broadcastList()
    return rec
  }

  attach(id, ws) {
    const rec = this.map.get(id)
    if (!rec) return
    rec.subs.add(ws)
    if (ws.readyState === 1)
      ws.send(JSON.stringify({ type: 'pty.attach', id, profile: rec.profile, data: rec.buf, exited: rec.exited }))
  }

  detachAll(ws) {
    for (const rec of this.map.values()) rec.subs.delete(ws)
  }

  input(id, data) { this.map.get(id)?.term.write(data) }

  resize(id, cols, rows) {
    const rec = this.map.get(id)
    if (rec && !rec.exited && cols > 0 && rows > 0) rec.term.resize(cols, rows)
  }

  kill(id) {
    const rec = this.map.get(id)
    if (!rec) return
    if (!rec.exited) rec.term.kill()
    this.map.delete(id)
    this.broadcastList()
  }

  list() {
    return [...this.map.values()].map(r => ({ id: r.id, profile: r.profile, cwd: r.cwd, exited: r.exited }))
  }

  broadcastList() { this.state.broadcast({ type: 'pty.list', ptys: this.list() }) }
}
