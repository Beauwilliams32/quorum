import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { commandCacheSize, invalidateCommandCache, resolveCommand } from '../src/command-lookup.js'
import { scratchDir } from './helpers/scratch.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('command lookup finds an installed binary without a login shell per call', () => {
  invalidateCommandCache()
  assert.equal(resolveCommand(process.execPath), process.execPath, 'an absolute path resolves to itself')
  assert.ok(resolveCommand('sh'), 'sh is on every PATH this ships to')
  assert.equal(resolveCommand('quorum-definitely-not-installed'), null)
})

test('a command name that could reach a shell is refused outright', () => {
  invalidateCommandCache()
  for (const command of ['sh; rm -rf /', 'sh && echo', '$(echo sh)', '../../bin/sh', 'sh|cat'])
    assert.equal(resolveCommand(command), null, `${command} resolved`)
})

test('lookups are memoised within the TTL and re-probed after it', t => {
  invalidateCommandCache()
  const bin = scratchDir(t, 'quorum-cmd-')
  const env = { PATH: bin }
  const tool = path.join(bin, 'quorum-fake-tool')

  assert.equal(resolveCommand('quorum-fake-tool', { env, now: 1_000 }), null)
  fs.writeFileSync(tool, '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(resolveCommand('quorum-fake-tool', { env, now: 1_500, ttl: 60_000 }), null, 'still the memoised answer')
  assert.equal(resolveCommand('quorum-fake-tool', { env, now: 90_000, ttl: 60_000 }), tool, 'the TTL expired, so it looked again')
  assert.equal(commandCacheSize(), 1)

  invalidateCommandCache()
  assert.equal(commandCacheSize(), 0)
})

// The catalog reads ~/.quorum/config.json, so cache behaviour is exercised in
// a child process against a scratch HOME rather than the developer's own.
function inScratchHome(home, script) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home },
    cwd: ROOT,
    encoding: 'utf8',
  }).trim().split('\n').at(-1))
}

const CATALOG = JSON.stringify(path.join(ROOT, 'src', 'catalog.js'))

test('the catalog is cached between calls and invalidated when config.json changes', t => {
  const home = scratchDir(t, 'quorum-catalog-')
  const config = path.join(home, '.quorum', 'config.json')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  fs.writeFileSync(config, JSON.stringify({ models: ['sonnet'] }))

  const result = inScratchHome(home, `
    import fs from 'node:fs'
    const m = await import(${CATALOG})
    const a = m.buildCatalog()
    const b = m.buildCatalog()
    fs.writeFileSync(${JSON.stringify(config)}, JSON.stringify({ models: ['sonnet', 'opus', 'custom-model-x'] }))
    // Same-second writes must still invalidate, so the stamp carries size too.
    const c = m.buildCatalog()
    m.invalidateCatalog()
    const d = m.buildCatalog()
    console.log(JSON.stringify({
      cachedWithinTtl: a === b,
      newAfterConfigChange: c !== b,
      sawNewModel: c.models.some(model => model.id === 'custom-model-x'),
      newAfterExplicitInvalidate: d !== c,
      frozen: Object.isFrozen(a) && Object.isFrozen(a.runtimes),
      explicitOptionsBypassCache: m.buildCatalog({ models: ['sonnet'] }) !== m.buildCatalog(),
    }))
  `)

  assert.equal(result.cachedWithinTtl, true, 'two calls in the same tick rebuilt the catalog')
  assert.equal(result.newAfterConfigChange, true, 'a config edit did not take effect')
  assert.equal(result.sawNewModel, true)
  assert.equal(result.newAfterExplicitInvalidate, true)
  assert.equal(result.frozen, true, 'a shared catalog must not be mutable by one caller')
  assert.equal(result.explicitOptionsBypassCache, true)
})

test('a cached catalog still reports the same runtimes and models as an uncached build', t => {
  const home = scratchDir(t, 'quorum-catalog-parity-')
  fs.mkdirSync(path.join(home, '.quorum'), { recursive: true })
  const result = inScratchHome(home, `
    const m = await import(${CATALOG})
    const cached = m.buildCatalog()
    m.invalidateCatalog({ commands: true })
    const fresh = m.buildCatalog()
    console.log(JSON.stringify({ equal: JSON.stringify(cached) === JSON.stringify(fresh), runtimes: cached.runtimes.length, models: cached.models.length }))
  `)
  assert.equal(result.equal, true, 'the cache changed what the catalog reports')
  assert.ok(result.runtimes >= 9)
  assert.ok(result.models >= 9)
})
