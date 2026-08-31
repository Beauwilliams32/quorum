import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('occupied loopback port exits once with an actionable error', async () => {
  const holder = http.createServer()
  await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve))
  const port = holder.address().port
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('collision process did not exit')), 15000)
    child.on('exit', code => { clearTimeout(timeout); resolve(code) })
    child.on('error', reject)
  })
  await new Promise(resolve => holder.close(resolve))
  assert.equal(exitCode, 1)
  assert.match(stderr, new RegExp(`127\\.0\\.0\\.1:${port} is already in use`))
})