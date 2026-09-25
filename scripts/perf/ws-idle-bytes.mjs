#!/usr/bin/env node
/**
 * Measure what the cockpit actually pushes at a browser while nothing is
 * happening.
 *
 * Boots `server.js` against a scratch HOME on a throwaway port, connects one
 * websocket client exactly the way public/app.js does (same Origin, same
 * `/ws` path), and counts every byte the server sends for a fixed window.
 *
 * The handshake burst (snapshot + cast + pty.list + rt.list) is reported
 * separately from the steady-state stream, because they answer different
 * questions: the handshake is what a page load costs, the stream is what
 * leaving the tab open costs.
 *
 * Usage:
 *   node scripts/perf/ws-idle-bytes.mjs --seconds 60 --port 47771 --home /tmp/h
 *
 * Never point this at the owner's cockpit: it always spawns its own server and
 * refuses to run against port 4747.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const SECONDS = Number(arg('seconds', 60))
const PORT = Number(arg('port', 47771))
const HOME = arg('home', fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-perf-home-')))
const LABEL = arg('label', 'run')

if (PORT === 4747) {
  console.error('refusing to measure on 4747 — that is the owner\'s cockpit port')
  process.exit(2)
}

function waitForHealth(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(`http://127.0.0.1:${port}/health`)
        .then(response => (response.ok ? resolve() : retry()))
        .catch(retry)
    }
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('server never became healthy'))
      setTimeout(attempt, 250)
    }
    attempt()
  })
}

const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, HOME, PORT: String(PORT), QUORUM_DISABLE_OPENCLAW: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', () => {})
child.stderr.on('data', chunk => process.stderr.write(`[server] ${chunk}`))

const stop = () => { try { child.kill('SIGTERM') } catch { /* already gone */ } }
process.on('exit', stop)

await waitForHealth(PORT)

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}` } })

const handshake = { messages: 0, bytes: 0 }
/** @type {Map<string, {messages: number, bytes: number}>} */
const handshakeKeys = new Map()
const stream = { messages: 0, bytes: 0 }
/** @type {Map<string, {messages: number, bytes: number}>} */
const perKey = new Map()
let settled = false

const bucket = (message, into) => {
  let parsed
  try { parsed = JSON.parse(message) } catch { parsed = {} }
  const key = parsed.key ? `${parsed.type}:${parsed.key}` : String(parsed.type || 'unknown')
  const entry = into.get(key) || { messages: 0, bytes: 0 }
  entry.messages += 1
  entry.bytes += Buffer.byteLength(message)
  into.set(key, entry)
  return key
}

const rank = (map, seconds) => [...map.entries()]
  .map(([key, value]) => ({ key, messages: value.messages, bytes: value.bytes, bytesPerMinute: seconds ? Math.round(value.bytes * 60 / seconds) : value.bytes }))
  .sort((a, b) => b.bytes - a.bytes)

await new Promise((resolve, reject) => {
  ws.on('error', reject)
  ws.on('open', () => {
    // The handshake burst lands in the first tick or two; everything after the
    // settle delay is the steady idle stream.
    setTimeout(() => {
      settled = true
      setTimeout(() => { ws.close(); resolve() }, SECONDS * 1000)
    }, 2000)
  })
  ws.on('message', data => {
    const text = data.toString()
    const target = settled ? stream : handshake
    target.messages += 1
    target.bytes += Buffer.byteLength(text)
    bucket(text, settled ? perKey : handshakeKeys)
  })
})

stop()

console.log(JSON.stringify({
  label: LABEL,
  seconds: SECONDS,
  home: HOME,
  port: PORT,
  handshakeBytes: handshake.bytes,
  handshakeMessages: handshake.messages,
  idle: {
    messages: stream.messages,
    bytes: stream.bytes,
    messagesPerMinute: Math.round(stream.messages * 60 / SECONDS),
    bytesPerMinute: Math.round(stream.bytes * 60 / SECONDS),
  },
  keys: rank(perKey, SECONDS),
  handshakeKeys: rank(handshakeKeys, 0),
}, null, 2))
process.exit(0)
