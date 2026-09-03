import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sourceOfTruthPaths, sourceOfTruthStatus } from '../src/source-of-truth.js'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-source-truth-'))
  const vault = path.join(root, 'vault')
  const repo = path.join(root, 'repo')
  const home = path.join(root, 'home')
  for (const directory of [vault, repo, home, path.join(home, 'skills')]) fs.mkdirSync(directory, { recursive: true })
  fs.mkdirSync(path.join(vault, '00_SYSTEM'), { recursive: true })
  fs.mkdirSync(path.join(vault, '09_AI_AGENTS'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(home, '.quorum-operator-memory.md'), '# local memory\n')
  for (const file of [
    path.join(vault, 'VAULT-INDEX.md'),
    path.join(vault, '00_SYSTEM', 'Agentic-LLM-Source-of-Truth.md'),
    path.join(vault, '09_AI_AGENTS', 'Agent-Memory-Control-Plane.md'),
    path.join(repo, 'CLAUDE.md'),
    path.join(repo, 'docs', 'ARCHITECTURE.md'),
  ]) fs.writeFileSync(file, '# fixture\n')
  return { root, vault, repo, home, skill: path.join(home, 'skills') }
}

test('source-of-truth status exposes a secret-free pointer graph', () => {
  const f = fixture()
  const memory = path.join(f.home, '.quorum-operator-memory.md')
  const status = sourceOfTruthStatus({ home: f.home, vaultPath: f.vault, repoRoot: f.repo, operatorMemoryPath: memory, skillRoots: [f.skill], workspaceRoot: f.root })
  assert.equal(status.ok, true)
  assert.equal(status.memory.localOverride, true)
  assert.equal(status.references.find(item => item.id === 'vault-index').exists, true)
  assert.equal(status.references.some(item => JSON.stringify(item).includes('api_key')), false)
})

test('missing canonical pointers degrade status without throwing', () => {
  const f = fixture()
  const status = sourceOfTruthStatus({ home: f.home, vaultPath: f.vault, repoRoot: f.repo, operatorMemoryPath: path.join(f.home, 'missing.md'), skillRoots: [], workspaceRoot: f.root })
  assert.equal(status.ok, false)
  assert.equal(status.state, 'degraded')
  assert.ok(status.health.includes('missing-operator-memory'))
  assert.ok(status.health.includes('missing-skill-roots'))
})

test('path resolution honors explicit roots without reading file contents', () => {
  const f = fixture()
  const paths = sourceOfTruthPaths({ home: f.home, vaultPath: f.vault, repoRoot: f.repo, operatorMemoryPath: path.join(f.home, 'missing.md'), skillRoots: [f.skill], workspaceRoot: f.root })
  assert.equal(paths.vault, path.resolve(f.vault))
  assert.equal(paths.repo, path.resolve(f.repo))
  assert.equal(paths.skillRoots[0], path.resolve(f.skill))
  assert.equal(paths.memory, path.join(f.repo, 'docs', 'agent-control', 'operator-memory.md'))
})
