// The process and system collectors each run one tick immediately and then
// arm a setInterval. Run the first tick for real (ps / vm_stat on this machine)
// with setInterval stubbed so the test process can exit.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'

const realSetInterval = globalThis.setInterval

function stubbedTick(start) {
  return new Promise(resolve => {
    globalThis.setInterval = () => ({ unref() {} })
    const events = []
    const state = {
      event: e => events.push(e),
      broadcast() {},
      update: (key, value, broadcastValue) => {
        globalThis.setInterval = realSetInterval
        resolve({ key, value, broadcastValue, events })
      },
    }
    start(state)
  })
}

test('startProcesses publishes classified procs, group counts and a bounded topRss list', async () => {
  const { startProcesses, shortName } = await import('../src/collectors/processes.js')
  const { key, value, events } = await stubbedTick(startProcesses)
  assert.equal(key, 'processes')
  assert.ok(Array.isArray(value.procs))
  assert.ok(value.topRss.length > 0 && value.topRss.length <= 8)
  for (const p of value.topRss) {
    assert.equal(typeof p.pid, 'number')
    assert.equal(typeof p.rssMB, 'number')
    assert.equal(typeof p.name, 'string')
  }
  // sorted by rss desc
  for (let i = 1; i < value.topRss.length; i++) assert.ok(value.topRss[i - 1].rssMB >= value.topRss[i].rssMB)
  // every tracked proc carries a group and a human name matching shortName()
  for (const p of value.procs) {
    assert.ok(['comfy', 'hermes', 'codex', 'mem', 'mcp', 'dev', 'claude-app', 'claude'].includes(p.group), p.group)
    assert.equal(p.name, shortName(p.cmd))
    assert.ok(p.cmd.length <= 220)
  }
  const sum = Object.values(value.groups).reduce((a, b) => a + b, 0)
  assert.equal(sum, value.procs.length, 'group counts add up to the tracked list')
  assert.equal(events.length, 0, 'the first tick never emits spawn/exit events')
})

test('startSystem publishes a memory sample and broadcasts only the latest', { skip: os.platform() !== 'darwin' && 'vm_stat is macOS-only' }, async () => {
  const { startSystem } = await import('../src/collectors/system.js')
  const { key, value, broadcastValue } = await stubbedTick(startSystem)
  assert.equal(key, 'system')
  const s = value.latest
  assert.equal(s.totalMB, Math.round(os.totalmem() / 1048576))
  for (const f of ['freeMB', 'usedMB', 'inactiveMB', 'compMB', 'swapUsedMB', 'soRate', 'load'])
    assert.ok(Number.isFinite(s[f]) && s[f] >= 0, `${f}=${s[f]}`)
  assert.ok(s.usedMB > 0, 'active+wired pages parsed from vm_stat')
  assert.ok(s.usedMB + s.freeMB <= s.totalMB * 1.05)
  assert.equal(value.hist.at(-1), s)
  assert.deepEqual(broadcastValue, { latest: s }, 'history is stored but not broadcast')
})
