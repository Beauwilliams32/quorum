// presence.js and edition.js resolve ~/.quorum at import time, so they are
// exercised in a child process with HOME pointed at a scratch directory —
// the real presence file and licence are never touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (home, code) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
  cwd: root, env: { ...process.env, HOME: home }, encoding: 'utf8',
}))

test('paths write to ~/.quorum and read from the legacy home too', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-home-'))
  fs.mkdirSync(path.join(home, '.unified-ai-operator'), { recursive: true })
  fs.writeFileSync(path.join(home, '.unified-ai-operator', 'old.json'), '{}')
  const out = run(home, `
    import { DATA_DIR, dataDir, readDirs, findFile } from './src/paths.js'
    console.log(JSON.stringify({ DATA_DIR, d: dataDir('x'), r: readDirs('a'), old: findFile('old.json'), none: findFile('nope') }))`)
  assert.equal(out.DATA_DIR, path.join(home, '.quorum'))
  assert.equal(out.d, path.join(home, '.quorum', 'x'))
  assert.deepEqual(out.r, [path.join(home, '.quorum', 'a'), path.join(home, '.unified-ai-operator', 'a')])
  assert.equal(out.old, path.join(home, '.unified-ai-operator', 'old.json'))
  assert.equal(out.none, null)
})

test('stampPresence dedupes by pty, caps the ring and writes to the new home only', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-home-'))
  const out = run(home, `
    import { stampPresence, loadPresence, PRESENCE_FILE } from './src/presence.js'
    const skipped = stampPresence({ agent: 'claude' })
    for (let i = 0; i < 45; i++) stampPresence({ projectId: 'p' + i, agent: 'claude', ptyId: 'pty' + i, cwd: '/w' })
    stampPresence({ projectId: 'again', agent: 'codex', ptyId: 'pty44', cwd: '/w' })
    const p = loadPresence()
    console.log(JSON.stringify({ skipped: skipped ?? null, n: p.seats.length, first: p.seats[0], dup: p.seats.filter(s => s.ptyId === 'pty44').length, file: PRESENCE_FILE }))`)
  assert.equal(out.skipped, null)
  assert.equal(out.n, 40)
  assert.equal(out.first.projectId, 'again')
  assert.equal(out.first.agent, 'codex')
  assert.equal(out.dup, 1)
  assert.equal(out.file, path.join(home, '.quorum', 'presence.json'))
  assert.ok(fs.existsSync(out.file))
  assert.equal(fs.existsSync(path.join(home, '.unified-ai-operator')), false)
})

test('without a licence the edition is free, the Pro cast is advertised as locked and custom cast is not read', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-home-'))
  fs.mkdirSync(path.join(home, '.quorum', 'cast'), { recursive: true })
  fs.writeFileSync(path.join(home, '.quorum', 'cast', 'x.json'), JSON.stringify({ id: 'x', prompt: 'p'.repeat(50), palette: { body: '#fff' } }))
  const out = run(home, `
    import { loadEdition, editionInfo, isPro } from './src/edition.js'
    import { cast } from './src/cast.js'
    const before = editionInfo()
    const info = await loadEdition()
    console.log(JSON.stringify({ before, info, pro: isPro(), ids: cast().map(c => c.id) }))`)
  assert.equal(out.before.tier, 'free')
  assert.equal(out.before.reason, 'not loaded')
  assert.equal(out.info.tier, 'free')
  assert.equal(out.info.licence.tier, 'free')
  assert.equal(out.pro, false)
  assert.equal(out.info.customCount, 0)
  assert.deepEqual(out.info.locked.map(c => c.id), ['sable', 'muse', 'ledger'])
  assert.equal(out.ids.includes('x'), false)
  assert.equal(out.ids.includes('sable'), false)
})
