import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Run a command, resolve with stdout ('' on any error) — collectors must never throw.
export const sh = (cmd, args = []) =>
  new Promise(resolve =>
    execFile(cmd, args, { maxBuffer: 16e6 }, (err, out) => resolve(err ? '' : out)))

// Read the last n bytes of a file as utf8 ('' on any error).
export function tailBytes(file, n) {
  try {
    const st = fs.statSync(file)
    const start = Math.max(0, st.size - n)
    const len = st.size - start
    if (len <= 0) return ''
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, 'r')
    fs.readSync(fd, buf, 0, len, start)
    fs.closeSync(fd)
    return buf.toString('utf8')
  } catch { return '' }
}

// True when `child` is `parent` itself or a path inside it. A bare
// startsWith() would also accept siblings that merely share the prefix
// (`public-old` under `public`), so the separator boundary is required.
export function withinDir(child, parent) {
  return child === parent || child.startsWith(parent + path.sep)
}

// Browsers do not apply the Same-Origin Policy to WebSocket connections, so
// listening on loopback does not keep other pages out: any tab the user has
// open can dial ws://127.0.0.1:PORT/ws and drive a PTY. Only the cockpit's own
// loopback origins are accepted. A missing Origin (curl, tests, native clients)
// passes — a browser always sends one, so a hostile page cannot omit it.
export function isAllowedOrigin(origin, port) {
  if (origin == null || origin === '') return true
  let u
  try { u = new URL(origin) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const originPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  if (originPort !== Number(port)) return false
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)
}

// Parse JSONL text defensively: skips partial/garbage lines.
export function jsonLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try { out.push(JSON.parse(s)) } catch { /* partial line */ }
  }
  return out
}
