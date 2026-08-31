import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apiKeyAvailable, commandAvailable, resolveClaudeCommand, resolveRoundtableAuth } from '../src/collectors/services.js'

test('commandAvailable reports only executable bare commands on the supplied path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-runtime-'))
  const cli = path.join(dir, 'quorum-test-cli')
  try {
    fs.writeFileSync(cli, '#!/bin/sh\n')
    fs.chmodSync(cli, 0o755)
    assert.equal(commandAvailable('quorum-test-cli', dir), true)
    assert.equal(commandAvailable('missing-cli', dir), false)
    assert.equal(commandAvailable('../quorum-test-cli', dir), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveClaudeCommand finds an executable on PATH and a local SDK fallback', () => {
  const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-claude-path-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-claude-home-'))
  const cli = path.join(pathDir, 'claude')
  const sdk = path.join(home, 'CLAUDE', 'claude-mem', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude')
  try {
    fs.writeFileSync(cli, '#!/bin/sh\n')
    fs.chmodSync(cli, 0o755)
    assert.equal(resolveClaudeCommand(pathDir, home), cli)
    fs.rmSync(cli)
    fs.mkdirSync(path.dirname(sdk), { recursive: true })
    fs.writeFileSync(sdk, '#!/bin/sh\n')
    fs.chmodSync(sdk, 0o755)
    assert.equal(resolveClaudeCommand('', home), sdk)
  } finally {
    fs.rmSync(pathDir, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('API-key readiness is a boolean only and requires a nonblank environment value', () => {
  assert.equal(apiKeyAvailable({}), false)
  assert.equal(apiKeyAvailable({ ANTHROPIC_API_KEY: '   ' }), false)
  assert.equal(apiKeyAvailable({ ANTHROPIC_API_KEY: 'configured' }), true)
})

test('roundtable auth prefers a signed-in CLI but supports an explicit key path', () => {
  const both = { claude: { cli: true, configured: true }, anthropic: { apiKeyAvailable: true } }
  assert.equal(resolveRoundtableAuth(both), 'cli')
  assert.equal(resolveRoundtableAuth(both, 'api-key'), 'api-key')
  assert.equal(resolveRoundtableAuth({ claude: { cli: true, configured: false }, anthropic: { apiKeyAvailable: true } }), 'api-key')
  assert.throws(() => resolveRoundtableAuth({ claude: { cli: true, configured: false }, anthropic: { apiKeyAvailable: false } }), /Sign in/)
  assert.throws(() => resolveRoundtableAuth({ claude: { cli: false, configured: true }, anthropic: { apiKeyAvailable: true } }), /not installed/)
})
