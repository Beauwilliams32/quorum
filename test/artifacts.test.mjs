import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildArtifactIndex, openArtifact, openDirectory, readArtifact, searchArtifacts } from '../src/artifacts.js'

test('artifact index maps vault and agent files without exposing its search corpus', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-artifacts-'))
  const vault = path.join(root, 'vault')
  const codex = path.join(root, 'codex')
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(codex, { recursive: true })
  fs.writeFileSync(path.join(vault, 'Decision.md'), '# Deployment Decision\nUse a staged rollout.\n\n#release\n', 'utf8')
  fs.writeFileSync(path.join(codex, 'rollout.jsonl'), '{"payload":{"type":"agent_message","message":"Use token=«redacted:sk-…» only in the environment"}}\n', 'utf8')
  const state = buildArtifactIndex({ roots: [{ id: 'vault', label: 'Vault', path: vault }, { id: 'codex', label: 'Codex', path: codex }], persist: false })
  assert.equal(state.stats.total, 2)
  assert.equal(state.stats.bySource.vault, 1)
  assert.ok(state.entries.every(entry => !('searchText' in entry)))
  const result = searchArtifacts('staged rollout')
  assert.equal(result.total, 1)
  const opened = readArtifact(result.results[0].id)
  assert.match(opened.content, /Deployment Decision/)
  assert.doesNotMatch(opened.content, /«redacted:sk-…»/)
})

test('protected credential artifacts cannot be opened or revealed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-artifacts-protected-'))
  fs.writeFileSync(path.join(root, 'auth.json'), '{"token":"do-not-open"}\n', 'utf8')
  const state = buildArtifactIndex({ roots: [{ id: 'codex', label: 'Codex', path: root }], persist: false })
  const auth = state.entries.find(entry => entry.title === 'auth.json')
  assert.equal(auth.openable, false)
  assert.throws(() => openArtifact(auth.id), /protected/)
})

test('symlinked artifacts cannot escape the indexed root when opened', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-artifacts-link-'))
  const linkedPath = path.join(root, 'linked.txt')
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-artifacts-outside-')), 'outside.txt')
  fs.writeFileSync(linkedPath, 'inside', 'utf8')
  fs.writeFileSync(outside, 'outside', 'utf8')
  const state = buildArtifactIndex({ roots: [{ id: 'workspace', label: 'Workspace', path: root }], persist: false })
  const linked = state.entries.find(entry => entry.title === 'linked.txt')
  fs.unlinkSync(linkedPath)
  fs.symlinkSync(outside, linkedPath)
  assert.throws(() => openArtifact(linked.id), /outside an indexed root/)
})

test('overlapping roots do not duplicate the same artifact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-artifacts-overlap-'))
  const nested = path.join(root, 'nested')
  fs.mkdirSync(nested)
  fs.writeFileSync(path.join(nested, 'artifact.md'), '# One copy\n', 'utf8')
  const state = buildArtifactIndex({
    roots: [{ id: 'workspace', label: 'Workspace', path: root }, { id: 'custom', label: 'Nested', path: nested }],
    persist: false,
  })
  assert.equal(state.stats.total, 1)
  assert.equal(state.entries[0].source, 'custom')
})

test('project folders can only be opened inside an indexed root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-project-root-'))
  const project = path.join(root, 'project')
  fs.mkdirSync(project)
  let invocation
  const result = openDirectory(project, 'reveal', [{ id: 'workspace', path: root }], (...args) => { invocation = args; return { unref() {} } })
  assert.equal(result.ok, true)
  assert.deepEqual(invocation.slice(0, 2), ['open', ['-R', fs.realpathSync(project)]])
  assert.throws(() => openDirectory(os.tmpdir()), /outside an indexed root/)
})
