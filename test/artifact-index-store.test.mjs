import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { appendOps, archiveLegacyIndex, compactLog, indexPaths, readLog, shouldCompact, writeMeta } from '../src/artifact-store.js'
import { nextInterval } from '../src/artifacts.js'
import { scratchDir } from './helpers/scratch.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = (t, label) => indexPaths(scratchDir(t, `quorum-index-${label}-`))
const entry = (file, extra = {}) => ({ id: file, source: 'vault', path: file, title: file, mtimeMs: 1, bytes: 1, ...extra })

test('the index log round-trips, and the last write for a path wins', t => {
  const paths = scratch(t, 'log')
  appendOps(paths, { put: [entry('/a'), entry('/b')] })
  appendOps(paths, { put: [entry('/a', { title: 'newer' })] })
  const { entries, lines } = readLog(paths.log)
  assert.equal(lines, 3)
  assert.equal(entries.size, 2)
  assert.equal(entries.get('/a').title, 'newer')
})

test('a delete op removes a path from the restored index', t => {
  const paths = scratch(t, 'del')
  appendOps(paths, { put: [entry('/a'), entry('/b')] })
  appendOps(paths, { del: ['/a'] })
  const { entries } = readLog(paths.log)
  assert.deepEqual([...entries.keys()], ['/b'])
})

test('a tick that changes nothing writes nothing to the log', t => {
  const paths = scratch(t, 'idle')
  appendOps(paths, { put: [entry('/a')] })
  const before = fs.statSync(paths.log).size
  assert.equal(appendOps(paths, { put: [], del: [] }), 0)
  assert.equal(fs.statSync(paths.log).size, before)
})

test('a crash mid-append costs the torn line, not the index', t => {
  const paths = scratch(t, 'torn')
  appendOps(paths, { put: [entry('/a'), entry('/b')] })
  fs.appendFileSync(paths.log, '{"op":"put","e":{"path":"/c"')
  const { entries } = readLog(paths.log)
  assert.deepEqual([...entries.keys()].sort(), ['/a', '/b'])
})

test('compaction collapses a log of repeated writes to one line per live entry', t => {
  const paths = scratch(t, 'compact')
  for (let i = 0; i < 20; i++) appendOps(paths, { put: [entry('/a', { mtimeMs: i })] })
  assert.equal(readLog(paths.log).lines, 20)
  compactLog(paths, readLog(paths.log).entries.values())
  const after = readLog(paths.log)
  assert.equal(after.lines, 1)
  assert.equal(after.entries.get('/a').mtimeMs, 19)
})

test('compaction is triggered by log growth relative to the live set, not by uptime', () => {
  assert.equal(shouldCompact(500, 100), false)
  assert.equal(shouldCompact(1_001, 100), true)
  assert.equal(shouldCompact(40_000, 30_000), false)
  assert.equal(shouldCompact(46_000, 30_000), true)
})

test('a pre-v2 index file is archived beside the new one, never deleted', t => {
  const paths = scratch(t, 'legacy')
  fs.mkdirSync(paths.dir, { recursive: true })
  fs.writeFileSync(paths.legacy, '{"entries":[]}\n')
  const moved = archiveLegacyIndex(paths)
  assert.ok(moved.archivedTo.startsWith(paths.archive))
  assert.equal(fs.existsSync(paths.legacy), false)
  assert.equal(fs.readFileSync(moved.archivedTo, 'utf8'), '{"entries":[]}\n')
  assert.equal(archiveLegacyIndex(paths), null, 'the move happens once')
})

test('the meta file stays small enough to rewrite on every tick', t => {
  const paths = scratch(t, 'meta')
  const bytes = writeMeta(paths, { generatedAt: new Date().toISOString(), roots: [{ id: 'vault', path: '/v' }], stats: { total: 26_000 }, logLines: 26_000, entries: 26_000 })
  assert.ok(bytes < 8_192, `meta was ${bytes} bytes`)
})

test('the scan interval backs off while idle and snaps back on the first change', () => {
  assert.equal(nextInterval(0), 30_000)
  assert.equal(nextInterval(2), 30_000)
  assert.equal(nextInterval(3), 60_000)
  assert.equal(nextInterval(4), 120_000)
  assert.equal(nextInterval(40), 120_000, 'capped')
  assert.equal(nextInterval(0), 30_000, 'a changed file resets the cursor')
})

// The persisted index is only worth its bytes if a restart reads it back, so
// this runs the real module in a child process against a scratch HOME.
function runInScratchHome(home, script) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, QUORUM_ARTIFACT_ROOTS: '' },
    cwd: ROOT,
    encoding: 'utf8',
  }).trim().split('\n').at(-1))
}

test('a restart restores the index from disk instead of re-walking every root', t => {
  const home = scratchDir(t, 'quorum-index-home-')
  const vault = path.join(home, 'Documents', 'Obsidian Vault')
  fs.mkdirSync(vault, { recursive: true })
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(vault, `note-${i}.md`), `# Note ${i}\n\nstaged rollout ${i}\n`)

  const mod = JSON.stringify(path.join(ROOT, 'src', 'artifacts.js'))
  const first = runInScratchHome(home, `
    const m = await import(${mod})
    const s = await m.reindexArtifacts()
    console.log(JSON.stringify({ total: s.stats.total, rescanned: s.stats.rescanned, hydrated: s.stats.hydratedFromDisk }))
  `)
  assert.equal(first.total, 5)
  assert.equal(first.rescanned, 5)

  const restart = runInScratchHome(home, `
    const m = await import(${mod})
    const restored = m.hydrateFromDisk()
    const before = m.buildArtifactState()
    const s = await m.reindexArtifacts()
    console.log(JSON.stringify({
      restored: restored.restored,
      entriesBeforeAnyWalk: before.entries.length,
      searchBeforeAnyWalk: m.searchArtifacts('staged rollout').total,
      rescanned: s.stats.rescanned,
      reused: s.stats.reused,
      hydrated: s.stats.hydratedFromDisk,
    }))
  `)
  assert.equal(restart.restored, 5, 'the index came back off disk')
  assert.equal(restart.entriesBeforeAnyWalk, 5, 'the panel is populated before the first walk')
  assert.equal(restart.searchBeforeAnyWalk, 5, 'restored entries are searchable, not just listable')
  assert.equal(restart.rescanned, 0, 'the mtime cursor re-read nothing')
  assert.equal(restart.reused, 5)
  assert.equal(restart.hydrated, true)
})

test('a file that disappears is evicted from the index and from search', t => {
  const home = scratchDir(t, 'quorum-index-evict-')
  const vault = path.join(home, 'Documents', 'Obsidian Vault')
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(vault, 'keep.md'), '# Keep\n\nunique-keeper\n')
  fs.writeFileSync(path.join(vault, 'drop.md'), '# Drop\n\nunique-dropper\n')

  const mod = JSON.stringify(path.join(ROOT, 'src', 'artifacts.js'))
  const result = runInScratchHome(home, `
    import fs from 'node:fs'
    const m = await import(${mod})
    await m.reindexArtifacts()
    const found = m.searchArtifacts('unique-dropper').total
    fs.unlinkSync(${JSON.stringify(path.join(vault, 'drop.md'))})
    const s = await m.reindexArtifacts()
    console.log(JSON.stringify({ found, total: s.stats.total, removed: s.stats.removed, afterSearch: m.searchArtifacts('unique-dropper').total }))
  `)
  assert.equal(result.found, 1)
  assert.equal(result.total, 1)
  assert.equal(result.removed, 1)
  assert.equal(result.afterSearch, 0, 'a deleted file must not linger in an unevicted cache')

  const { entries } = readLog(indexPaths(path.join(home, '.quorum')).log)
  assert.deepEqual([...entries.keys()].map(p => path.basename(p)), ['keep.md'], 'the log records the deletion too')
})

test('an idle tick adds no bytes to the on-disk log', t => {
  const home = scratchDir(t, 'quorum-index-quiet-')
  const vault = path.join(home, 'Documents', 'Obsidian Vault')
  fs.mkdirSync(vault, { recursive: true })
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(vault, `note-${i}.md`), `# Note ${i}\n\nbody ${i}\n`)
  const mod = JSON.stringify(path.join(ROOT, 'src', 'artifacts.js'))
  const result = runInScratchHome(home, `
    import fs from 'node:fs'
    const m = await import(${mod})
    const log = ${JSON.stringify(path.join(home, '.quorum', 'artifact-index.ndjson'))}
    await m.reindexArtifacts()
    const afterFirst = fs.statSync(log).size
    await m.reindexArtifacts()
    await m.reindexArtifacts()
    console.log(JSON.stringify({ afterFirst, afterIdle: fs.statSync(log).size }))
  `)
  assert.ok(result.afterFirst > 0)
  assert.equal(result.afterIdle, result.afterFirst, 'three ticks, one write')
})

test('an unset QUORUM_ARTIFACT_ROOTS does not index the process working directory', t => {
  const home = scratchDir(t, 'quorum-index-roots-')
  fs.mkdirSync(path.join(home, 'Documents', 'Obsidian Vault'), { recursive: true })
  const mod = JSON.stringify(path.join(ROOT, 'src', 'artifacts.js'))
  const script = `
    const m = await import(${mod})
    console.log(JSON.stringify({ ids: m.artifactRoots().map(r => r.id) }))
  `
  for (const value of [undefined, '', '  ', ':']) {
    const env = { ...process.env, HOME: home }
    if (value === undefined) delete env.QUORUM_ARTIFACT_ROOTS
    else env.QUORUM_ARTIFACT_ROOTS = value
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, cwd: ROOT, encoding: 'utf8' }).trim())
    assert.deepEqual(out.ids, ['vault'], `QUORUM_ARTIFACT_ROOTS=${JSON.stringify(value)} added a root`)
  }
})

// readLog() reads in 1 MiB chunks. It used to carry only the partial LINE
// across a chunk boundary and decode each chunk with `Buffer#toString`, so a
// multi-byte character straddling the boundary was split into two halves and
// each half became U+FFFD. The line still parsed as JSON, so nothing failed —
// the title/summary/searchText simply came back corrupted, and `syncEntry`
// re-used the corrupted entry forever because the file's mtime and size were
// unchanged. The corpus is pure ASCII, which is why no bench caught it.
const CHUNK = 1 << 20

test('a multi-byte character straddling a read chunk boundary survives readLog', t => {
  const paths = scratch(t, 'utf8-boundary')
  const head = '{"op":"put","e":{"path":"/p","id":"/p","source":"vault","mtimeMs":1,"bytes":1,"title":"'
  for (const offset of [-2, -1, 0, 1, 2]) {
    const file = path.join(paths.dir, `boundary${offset + 2}.ndjson`)
    const pad = CHUNK + offset - Buffer.byteLength(head)
    fs.writeFileSync(file, `${head}${'a'.repeat(pad)}€${'b'.repeat(8)}"}}\n`)
    const title = readLog(file).entries.get('/p')?.title ?? ''
    assert.ok(title.includes('€'), `euro sign lost at boundary offset ${offset}`)
    assert.equal(title.match(/�/g), null, `replacement character introduced at boundary offset ${offset}`)
  }
})

test('a log of accented, CJK and emoji titles restores byte-for-byte across many chunks', t => {
  const paths = scratch(t, 'utf8-corpus')
  const titles = ['café résumé', '日本語のノート', 'note 🎛️ mixdown', 'Über-Straße', 'Ωμέγα']
  const line = (file, title) => `${JSON.stringify({ op: 'put', e: entry(file, { title }) })}\n`
  const parts = []
  let at = 0
  let n = 0
  const emit = text => { parts.push(text); at += Buffer.byteLength(text) }
  // Deterministically place a 3-byte character across each of the first three
  // 1 MiB boundaries, with ordinary multi-byte notes filling the space between
  // — the shape of a real vault, not a corpus that happens to line up.
  for (let boundary = CHUNK; boundary <= 3 * CHUNK; boundary += CHUNK) {
    while (boundary - at > 4_096) emit(line(`/note-${n++}`, `${titles[n % titles.length]} ${'x'.repeat(900)}`))
    const file = `/straddle-${boundary / CHUNK}`
    const head = `{"op":"put","e":{"path":"${file}","id":"${file}","source":"vault","mtimeMs":1,"bytes":1,"title":"`
    const pad = boundary - 1 - at - Buffer.byteLength(head)
    assert.ok(pad >= 0, 'straddling line must fit before the boundary')
    emit(`${head}${'a'.repeat(pad)}\u20ac日本${'b'.repeat(8)}"}}\n`)
  }
  fs.mkdirSync(paths.dir, { recursive: true })
  fs.writeFileSync(paths.log, parts.join(''))
  const { entries } = readLog(paths.log)
  const corrupted = [...entries.values()].filter(value => String(value.title).includes('\uFFFD')).map(value => value.path)
  assert.deepEqual(corrupted, [], `${corrupted.length} entries restored with U+FFFD`)
  for (let i = 1; i <= 3; i++) assert.ok(entries.get(`/straddle-${i}`).title.includes('\u20ac日本'), `boundary ${i} lost its multi-byte run`)
  assert.equal(entries.size, n + 3)
})

// evictMissing() used to run at the end of every walk regardless of whether a
// root could be read. One transient EPERM on the vault — the launchd/Documents
// case this repo already documents — dropped every entry under it AND appended
// a `del` op per entry, which tripped compaction and rewrote the whole log.
// Recovery then cost a full re-read of every file, reintroducing exactly the
// cost the persisted index exists to remove.

function scratchVault(t, label, count) {
  const home = scratchDir(t, `quorum-index-${label}-`)
  const vault = path.join(home, 'Documents', 'Obsidian Vault')
  fs.mkdirSync(vault, { recursive: true })
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(vault, `note-${i}.md`), `# Note ${i}\n\nflap corpus ${i}\n`)
  return { home, vault }
}

test('an unreadable root holds its entries instead of evicting them', (t) => {
  const { home, vault } = scratchVault(t, 'flap', 40)
  const mod = JSON.stringify(path.join(ROOT, 'src', 'artifacts.js'))
  const tick = extra => runInScratchHome(home, `
    const m = await import(${mod})
    const s = await m.reindexArtifacts()
    console.log(JSON.stringify({ total: s.stats.total, removed: s.stats.removed, held: s.stats.evictionHeld, degraded: s.stats.degraded, rescanned: s.stats.rescanned, reused: s.stats.reused, readable: s.roots.find(r => r.id === 'vault')?.readable }))
  `)
  const log = path.join(home, '.quorum', 'artifact-index.ndjson')

  assert.equal(tick().total, 40)
  const logBefore = fs.readFileSync(log, 'utf8')

  fs.chmodSync(vault, 0o000)
  // Running as a user who can read through mode 000 (root in some CI images)
  // makes the flap unreproducible; the truncation test below covers the same
  // guard without needing permissions.
  let blocked = true
  try { fs.readdirSync(vault); blocked = false } catch { /* the flap is reproducible here */ }
  if (!blocked) { fs.chmodSync(vault, 0o700); t.skip('this user can read a mode-000 directory'); return }

  try {
    const flap = tick()
    assert.equal(flap.removed, 0, 'a single EPERM evicted the whole root')
    assert.equal(flap.total, 40, 'the index survives a flap')
    assert.equal(flap.held, 40, 'the held count is reported')
    assert.equal(flap.degraded, true, 'the flap is still reported honestly')
    assert.equal(flap.readable, false, 'the unreadable-root badge still fires')
    assert.equal(fs.readFileSync(log, 'utf8'), logBefore, 'the flap rewrote the on-disk log')
  } finally { fs.chmodSync(vault, 0o700) }

  const recovered = tick()
  assert.equal(recovered.reused, 40, 'recovery re-read files it already had')
  assert.equal(recovered.rescanned, 0)
})

test('a walk truncated at maxFiles evicts nothing', t => {
  const { home } = scratchVault(t, 'truncated', 12)
  const mod = JSON.stringify(path.join(ROOT, 'src', 'artifacts.js'))
  const result = runInScratchHome(home, `
    const m = await import(${mod})
    const full = await m.reindexArtifacts()
    // The next walk stops after 4 files, so the other 8 look "missing".
    const capped = await m.reindexArtifacts({ maxFiles: 4 })
    console.log(JSON.stringify({ full: full.stats.total, capped: capped.stats.total, removed: capped.stats.removed, truncated: capped.stats.truncated }))
  `)
  assert.equal(result.full, 12)
  assert.equal(result.truncated, true)
  assert.equal(result.removed, 0, 'a truncated walk evicted the files it never looked at')
  assert.equal(result.capped, 12, 'the index still holds every file')
})

// scripts/bench/index-bench.mjs is the evidence for the "disk bytes written
// per steady tick" claim, so its accounting has to be right. fs.writeFileSync
// called WITH a mode option leaves the writeFileUtf8 fast path and loops
// through fs.writeSync — and both the pre-v2 artifact-index.json path and the
// new meta write pass {mode: 0o600} — so a bench that patches both layers
// counts those writes twice on both sides of the A/B. A steady tick writes
// exactly the meta file, so the reported figure must equal the meta file.
test('the index bench attributes each write exactly once', t => {
  const home = scratchDir(t, 'qbench-accounting-')
  const vault = path.join(home, 'Documents', 'Obsidian Vault')
  fs.mkdirSync(vault, { recursive: true })
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(vault, `note-${i}.md`), `# Note ${i}\n\nbench accounting ${i}\n`)

  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'bench', 'index-bench.mjs')], {
    env: { ...process.env, HOME: home, QUORUM_ARTIFACT_ROOTS: '', BENCH_TICKS: '3' },
    cwd: ROOT,
    encoding: 'utf8',
  })
  const report = JSON.parse(out)
  const meta = report.indexFiles.find(file => file.name === 'artifact-index.meta.json')
  assert.ok(meta, 'the bench should report the meta file')
  assert.deepEqual(report.steadyBytesPerTickByFile, { 'artifact-index.meta.json': meta.bytes },
    'a steady tick writes the meta file once and nothing else')
  assert.equal(report.steadyBytesPerTick, meta.bytes,
    `bench reported ${report.steadyBytesPerTick} B/tick against a ${meta.bytes} B meta file`)
})
