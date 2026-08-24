import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHealth } from '../src/health.js'

test('health is ok when Hermes is available and counts active work', () => {
  const health = buildHealth({
    services: { hermes: { up: true }, comfy: { up: false } },
    sessions: { cards: [{ active: true }, { active: false }] },
    projects: { rooms: [{ active: true }, { active: false }] },
  }, { now: 1200, startedAt: 200 })

  assert.deepEqual(health, {
    status: 'ok',
    uptimeMs: 1000,
    services: { hermes: true, comfy: false, openclaw: false },
    readiness: { cockpit: 'ready', roundtable: 'missing-claude-cli', hermes: 'ready', openclaw: 'optional-offline' },
    sessions: { total: 2, active: 1 },
    projects: { total: 2, active: 1 },
    ts: 1200,
  })
})

test('health degrades without Hermes but still reports local cockpit state', () => {
  const health = buildHealth({
    services: {},
    sessions: { cards: [{ active: true }] },
    projects: { rooms: [] },
  }, { now: 50, startedAt: 100 })

  assert.equal(health.status, 'degraded')
  assert.equal(health.uptimeMs, 0)
  assert.equal(health.sessions.active, 1)
  assert.deepEqual(health.services, { hermes: false, comfy: false, openclaw: false })
  assert.deepEqual(health.readiness, { cockpit: 'ready', roundtable: 'missing-claude-cli', hermes: 'optional-offline', openclaw: 'optional-offline' })
})

test('health distinguishes CLI and environment API-key roundtable readiness', () => {
  const ready = buildHealth({ services: { auth: { claude: { cli: true, configured: true } } } })
  const needsLogin = buildHealth({ services: { auth: { claude: { cli: true, configured: false } } } })
  const both = buildHealth({ services: { auth: { claude: { cli: true, configured: true }, anthropic: { apiKeyAvailable: true } } } })
  const apiKey = buildHealth({ services: { auth: { claude: { cli: true, configured: false }, anthropic: { apiKeyAvailable: true } } } })
  assert.equal(ready.readiness.roundtable, 'ready-cli')
  assert.equal(needsLogin.readiness.roundtable, 'needs-claude-login-or-api-key')
  assert.equal(both.readiness.roundtable, 'ready-cli-and-api-key')
  assert.equal(apiKey.readiness.roundtable, 'ready-api-key')
})
