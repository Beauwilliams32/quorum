import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = os.homedir()
export const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_VAULT = path.join(HOME, 'Documents', 'Obsidian Vault')
export const DEFAULT_WORKSPACE_ROOT = path.join(HOME, 'CLAUDE')
export const DEFAULT_LOCAL_MEMORY = path.join(HOME, '.quorum', 'operator-memory.md')
export const DEFAULT_MEMORY_TEMPLATE = path.join(DEFAULT_REPO_ROOT, 'docs', 'agent-control', 'operator-memory.md')

const DEFAULT_SKILL_ROOTS = [
  path.join(HOME, '.agents', 'skills'),
  path.join(HOME, '.codex', 'skills'),
  path.join(HOME, '.hermes', 'skills'),
]

function statMaybe(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() && !stat.isDirectory()) return { exists: false, path: file }
    return { exists: true, path: file, kind: stat.isDirectory() ? 'directory' : 'file', bytes: stat.isFile() ? stat.size : null, updatedAt: new Date(stat.mtimeMs).toISOString() }
  } catch (error) {
    return { exists: false, path: file, error: error.code === 'ENOENT' ? undefined : error.message }
  }
}

function resolved(value, fallback) {
  return path.resolve(String(value || fallback))
}

function reference(id, kind, file, required, purpose) {
  const stat = statMaybe(file)
  return { id, kind, path: file, required, purpose, ...stat, healthy: stat.exists || !required }
}

/**
 * Resolve the small set of pointers that make up Quorum's operator memory.
 * The memory file is a routing contract; the vault remains the authority for
 * business and project facts. No referenced file is loaded by this function.
 */
export function sourceOfTruthPaths({ home = HOME, vaultPath = null, repoRoot = DEFAULT_REPO_ROOT, operatorMemoryPath = null, skillRoots = null, workspaceRoot = null } = {}) {
  const baseHome = path.resolve(home)
  const vault = resolved(vaultPath || process.env.QUORUM_VAULT_PATH, path.join(baseHome, 'Documents', 'Obsidian Vault'))
  const repo = path.resolve(repoRoot)
  const localMemory = resolved(operatorMemoryPath || process.env.QUORUM_OPERATOR_MEMORY_PATH, path.join(baseHome, '.quorum', 'operator-memory.md'))
  const template = path.join(repo, 'docs', 'agent-control', 'operator-memory.md')
  const memory = fs.existsSync(localMemory) ? localMemory : template
  const roots = (skillRoots || [
    path.join(baseHome, '.agents', 'skills'),
    path.join(baseHome, '.codex', 'skills'),
    path.join(baseHome, '.hermes', 'skills'),
  ]).map(item => path.resolve(item))
  const workspace = resolved(workspaceRoot || process.env.QUORUM_WORKSPACE_ROOT, path.join(baseHome, 'CLAUDE'))

  return {
    memory,
    localMemory,
    template,
    vault,
    workspace,
    repo,
    skillRoots: roots,
  }
}

/**
 * Return secret-free readiness for the operator memory contract. This is
 * intentionally metadata-only: paths and freshness are useful to the UI,
 * while prompts, tokens, and note contents remain outside the status payload.
 */
export function sourceOfTruthStatus(options = {}) {
  const paths = sourceOfTruthPaths(options)
  const health = []
  const localAvailable = statMaybe(paths.localMemory).exists
  const memoryStat = statMaybe(paths.memory)
  if (!memoryStat.exists) health.push('missing-operator-memory')
  if (!statMaybe(path.join(paths.vault, 'VAULT-INDEX.md')).exists) health.push('missing-vault-index')
  if (!statMaybe(path.join(paths.vault, '00_SYSTEM', 'Agentic-LLM-Source-of-Truth.md')).exists) health.push('missing-vault-source-note')
  if (!statMaybe(path.join(paths.vault, '09_AI_AGENTS', 'Agent-Memory-Control-Plane.md')).exists) health.push('missing-memory-control-plane')
  if (!statMaybe(path.join(paths.repo, 'CLAUDE.md')).exists) health.push('missing-repo-instructions')
  if (!statMaybe(path.join(paths.repo, 'docs', 'ARCHITECTURE.md')).exists) health.push('missing-repo-architecture')
  if (!statMaybe(paths.workspace).exists) health.push('missing-workspace-root')
  if (!paths.skillRoots.some(root => statMaybe(root).exists)) health.push('missing-skill-roots')

  const references = [
    reference('operator-memory', 'memory', paths.memory, true, 'Council operating contract and read/write routing'),
    reference('vault-index', 'vault-index', path.join(paths.vault, 'VAULT-INDEX.md'), true, 'Canonical vault map and conflict rule'),
    reference('vault-source-of-truth', 'vault-policy', path.join(paths.vault, '00_SYSTEM', 'Agentic-LLM-Source-of-Truth.md'), true, 'Durable knowledge-layer policy'),
    reference('memory-control-plane', 'control-plane', path.join(paths.vault, '09_AI_AGENTS', 'Agent-Memory-Control-Plane.md'), true, 'Shared bridge health, allowlist, and review state'),
    reference('repo-instructions', 'repo-policy', path.join(paths.repo, 'CLAUDE.md'), true, 'Repository safety and architecture rules'),
    reference('repo-architecture', 'repo-map', path.join(paths.repo, 'docs', 'ARCHITECTURE.md'), true, 'Runtime surfaces and execution flows'),
    reference('workspace-root', 'workspace', paths.workspace, true, 'Repository discovery boundary'),
    ...paths.skillRoots.map((root, index) => reference(`skills-${index + 1}`, 'skills', root, false, 'Procedural skill discovery root')),
  ]

  return {
    ok: health.length === 0,
    state: health.length === 0 ? 'ready' : 'degraded',
    health,
    memory: {
      path: paths.memory,
      localOverride: localAvailable,
      bundledTemplate: paths.memory === paths.template,
      exists: memoryStat.exists,
      updatedAt: memoryStat.updatedAt || null,
    },
    references,
    policy: {
      facts: 'Obsidian vault is authoritative; repo instructions govern code; live checks govern dynamic state',
      history: 'LLM Wiki is historical/read-only and never outranks the vault',
      writes: 'Quorum writes bounded mission notes and proposals; secrets, prompts, and transcripts stay out of the control plane',
      autonomy: 'discover -> assess -> propose -> verify -> notify -> execute within policy -> close out',
    },
    ts: Date.now(),
  }
}

export { DEFAULT_SKILL_ROOTS }
