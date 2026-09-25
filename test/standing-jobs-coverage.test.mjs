import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { StandingJobScheduler } from '../src/standing-jobs.js'
import { checkRepositories, readRepository } from '../src/collectors/repositories.js'
import { buildArtifactIndex } from '../src/artifacts.js'
import { scratchDir } from './helpers/scratch.mjs'

function repo(t, { dirty = false, conflicted = false } = {}) {
  const dir = fs.realpathSync(scratchDir(t, 'quorum-repo-health-'))
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['config', 'user.name', 'Quorum Test'])
  fs.writeFileSync(path.join(dir, 'file.txt'), 'base\n')
  git(['add', '-A']); git(['commit', '-qm', 'base'])
  if (conflicted) {
    git(['checkout', '-qb', 'other'])
    fs.writeFileSync(path.join(dir, 'file.txt'), 'other\n')
    git(['commit', '-qam', 'other'])
    git(['checkout', '-q', '-'])
    fs.writeFileSync(path.join(dir, 'file.txt'), 'main\n')
    git(['commit', '-qam', 'main'])
    try { git(['merge', 'other']) } catch { /* the conflict is the point */ }
  } else if (dirty) {
    fs.writeFileSync(path.join(dir, 'file.txt'), 'edited\n')
  }
  return dir
}

test('an unregistered standing job reports that it is not monitored, never green', async () => {
  let now = 100
  const scheduler = new StandingJobScheduler({ clock: () => now })
  assert.equal(scheduler.jobs.length, 9)
  assert.equal(scheduler.jobs.every(job => job.status === 'unmonitored' && job.registered === false), true)

  const job = await scheduler.run('build-health')
  assert.equal(job.status, 'unmonitored')
  assert.match(job.detail, /not monitored/)
  assert.notEqual(job.status, 'monitoring')
  assert.equal(scheduler.snapshot().history[0].status, 'unmonitored')

  const coverage = scheduler.snapshot().coverage
  assert.equal(coverage.advertised, 9)
  assert.equal(coverage.monitored, 0)
  assert.equal(coverage.unmonitored.includes('build-health'), true)
})

test('registering a job is what makes it a monitor', async () => {
  let now = 100
  const scheduler = new StandingJobScheduler({ clock: () => now })
  scheduler.register('build-health', async () => ({ detail: 'a real probe ran' }))
  assert.equal(scheduler.jobs.find(item => item.id === 'build-health').registered, true)
  const job = await scheduler.run('build-health')
  assert.equal(job.status, 'monitoring')
  assert.equal(job.detail, 'a real probe ran')
  assert.equal(scheduler.snapshot().coverage.monitored, 1)
  assert.equal(scheduler.snapshot().coverage.unmonitored.includes('build-health'), false)
})

test('repository health reads real repositories and raises only on states a person must resolve', t => {
  const clean = repo(t)
  const dirty = repo(t, { dirty: true })

  assert.equal(readRepository(clean).readable, true)
  assert.equal(readRepository(clean).dirty, 0)
  assert.equal(readRepository(dirty).dirty, 1)

  const ordinary = checkRepositories([{ id: 'clean', cwd: clean }, { id: 'dirty', cwd: dirty }])
  assert.equal(ordinary.attention, false, 'uncommitted work is normal and is not an alert')
  assert.match(ordinary.detail, /2\/2 repositories read/)
  assert.match(ordinary.detail, /1 with uncommitted work/)

  const plain = scratchDir(t, 'quorum-not-a-repo-')
  const unreadable = checkRepositories([{ id: 'plain', cwd: plain }])
  assert.equal(unreadable.attention, true)
  assert.equal(unreadable.repositories[0].readable, false)
  assert.match(unreadable.detail, /1 unreadable/)

  const none = checkRepositories([])
  assert.equal(none.attention, false)
  assert.match(none.detail, /nothing was checked/)
})

test('repository health raises attention on unmerged paths', t => {
  const conflicted = repo(t, { conflicted: true })
  const result = checkRepositories([{ id: 'conflicted', cwd: conflicted }])
  assert.equal(result.repositories[0].conflicts > 0, true)
  assert.equal(result.attention, true)
  assert.match(result.detail, /unmerged paths/)
})

test('a root the index cannot read is reported as degraded, not as an empty root', t => {
  const readable = fs.realpathSync(scratchDir(t, 'quorum-artifact-ok-'))
  fs.writeFileSync(path.join(readable, 'note.md'), '# note\n\nbody\n')
  const blocked = fs.realpathSync(scratchDir(t, 'quorum-artifact-blocked-'))
  fs.mkdirSync(path.join(blocked, 'inner'))
  fs.chmodSync(blocked, 0o000)
  try {
    const result = buildArtifactIndex({ persist: false, roots: [
      { id: 'workspace', label: 'Readable root', path: readable },
      { id: 'vault', label: 'Blocked root', path: blocked },
    ] })
    assert.equal(result.stats.total, 1)
    assert.equal(result.stats.degraded, true)
    assert.equal(result.stats.unreadable.length, 1)
    assert.equal(result.stats.unreadable[0].path, blocked)
    assert.equal(result.roots.find(root => root.id === 'vault').readable, false)
    assert.match(result.roots.find(root => root.id === 'vault').error, /EACCES|EPERM/)
    assert.equal(result.roots.find(root => root.id === 'workspace').readable, true)
    assert.equal(result.roots.find(root => root.id === 'workspace').error, null)
  } finally { fs.chmodSync(blocked, 0o700) }
})

test('a fully readable index is not marked degraded', t => {
  const readable = fs.realpathSync(scratchDir(t, 'quorum-artifact-clean-'))
  fs.writeFileSync(path.join(readable, 'note.md'), '# note\n')
  const result = buildArtifactIndex({ persist: false, roots: [{ id: 'workspace', label: 'Readable root', path: readable }] })
  assert.equal(result.stats.degraded, false)
  assert.deepEqual(result.stats.unreadable, [])
  assert.equal(result.roots[0].readable, true)
})
