import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildMemory } from '../src/collectors/memory.js'

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uao-memory-test-'))
  const root = path.join(dir, 'agent-memory-bridge')
  const vault = path.join(dir, 'vault')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(path.join(vault, '09_AI_AGENTS'), { recursive: true })
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
    memBaseUrl: 'http://127.0.0.1:37701',
    vaultPath: vault,
    inboxRelativePath: '09_AI_AGENTS/Claude-Mem-Promotion-Inbox.md',
    statusRelativePath: '09_AI_AGENTS/Agent-Memory-Control-Plane.md',
    projects: ['CLAUDE', 'williams-media-portal'],
    ledgerPath: '.sync-state.json',
  }), 'utf8')
  await fs.writeFile(path.join(root, '.sync-state.json'), JSON.stringify({
    cursor: { highestId: 44 },
    observations: {
      1: { status: 'pending' },
      2: { status: 'pending' },
      3: { status: 'promoted' },
      4: { status: 'archived' },
    },
  }), 'utf8')
  await fs.writeFile(path.join(vault, '09_AI_AGENTS/Claude-Mem-Promotion-Inbox.md'), '<!-- claude-mem:1 -->\n<!-- claude-mem:2 -->\n', 'utf8')
  await fs.writeFile(path.join(vault, '09_AI_AGENTS/Agent-Memory-Control-Plane.md'), '# Agent Memory Control Plane\n', 'utf8')
  return { root }
}

test('buildMemory summarizes bridge config, ledger, inbox, and status note', async () => {
  const { root } = await fixture()
  const status = buildMemory(root)

  assert.equal(status.ok, true)
  assert.deepEqual(status.projects, ['CLAUDE', 'williams-media-portal'])
  assert.equal(status.ledger.counts.pending, 2)
  assert.equal(status.ledger.counts.promoted, 1)
  assert.equal(status.ledger.counts.archived, 1)
  assert.equal(status.ledger.cursorHighestId, 44)
  assert.equal(status.inbox.observationMarkers, 2)
  assert.equal(status.statusNote.exists, true)
})

test('buildMemory flags drift and non-loopback source', async () => {
  const { root } = await fixture()
  const configPath = path.join(root, 'config.json')
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  config.memBaseUrl = 'https://example.com'
  await fs.writeFile(configPath, JSON.stringify(config), 'utf8')
  const inboxPath = path.join(config.vaultPath, config.inboxRelativePath)
  await fs.writeFile(inboxPath, '<!-- claude-mem:1 -->\n', 'utf8')

  const status = buildMemory(root)
  assert.equal(status.ok, false)
  assert.ok(status.health.includes('source-not-loopback'))
  assert.ok(status.health.includes('inbox-ledger-count-drift'))
})
