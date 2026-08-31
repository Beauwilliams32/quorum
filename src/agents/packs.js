import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAgentPacks, loadRuntimes } from '../config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PACK_DIR = path.join(ROOT, 'prompts', 'agent-packs')

// Packs are deliberately boring data. They describe the job, role, and gates;
// the selected runtime remains an interchangeable execution detail.
export const AGENT_PACKS = [
  { id: 'scout', label: 'Discovery Scout', role: 'researcher', summary: 'Map the relevant code, docs, history, and evidence before anyone edits.', capabilities: ['discover', 'read', 'test'], defaultModel: 'haiku', preferredRuntimes: ['claude', 'codex', 'gemini', 'hermes', 'ollama'], gates: ['bounded discovery', 'source citations', 'fresh git status'] },
  { id: 'review', label: 'Code Reviewer', role: 'researcher', summary: 'Find correctness, security, and maintainability risks with focused proof.', capabilities: ['read', 'test'], defaultModel: 'sonnet', preferredRuntimes: ['claude', 'codex', 'gemini', 'ollama'], gates: ['focused diff', 'tests or reproduction', 'severity and owner'] },
  { id: 'builder', label: 'Builder', role: 'builder', summary: 'Implement the task, run project gates, and prepare an auditable change.', capabilities: ['discover', 'read', 'test', 'edit', 'git.commit', 'git.push'], defaultModel: 'sonnet', preferredRuntimes: ['claude', 'codex', 'copilot', 'hermes', 'ollama'], gates: ['project guide', 'tests', 'diff review', 'closeout'] },
  { id: 'qa', label: 'QA Sentinel', role: 'researcher', summary: 'Exercise the product and report reproducible failures without mutating it.', capabilities: ['discover', 'read', 'test'], defaultModel: 'haiku', preferredRuntimes: ['codex', 'gemini', 'hermes', 'ollama'], gates: ['clean test boundary', 'reproduction', 'fresh environment evidence'] },
  { id: 'recovery', label: 'Recovery Steward', role: 'recovery', summary: 'Recover an expired run or worktree using leases and preserved evidence.', capabilities: ['recovery.inspect', 'recovery.takeover'], defaultModel: 'haiku', preferredRuntimes: ['claude', 'codex', 'hermes', 'ollama'], gates: ['expired lease', 'missed heartbeat', 'new run id'] },
  { id: 'release', label: 'Release Steward', role: 'builder', summary: 'Prepare release notes, tags, and rollback evidence; external release stays gated.', capabilities: ['test', 'edit', 'git.commit', 'git.push', 'git.tag'], defaultModel: 'sonnet', preferredRuntimes: ['claude', 'codex', 'copilot', 'hermes'], gates: ['release checklist', 'rollback path', 'post-change verification'] },
]

export function resolveAgentPack(id) {
  const key = String(id || '').trim()
  const pack = [...AGENT_PACKS, ...loadAgentPacks()].find(item => item.id === key)
  if (!pack) throw new Error(`unknown agent pack: ${id}`)
  return pack
}

export function agentPackPromptPath(id) {
  const pack = resolveAgentPack(id)
  const file = path.join(PACK_DIR, `${pack.id}.md`)
  if (!fs.existsSync(file)) throw new Error(`agent pack prompt is missing: ${pack.id}`)
  return file
}

export function agentPackPromptContent(id) {
  const pack = resolveAgentPack(id)
  const file = path.join(PACK_DIR, `${pack.id}.md`)
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').slice(0, 4000)
  return String(pack.prompt || '').slice(0, 4000)
}

export function publicAgentPacks({ runtimes = loadRuntimes(), modelOptions = [] } = {}) {
  const available = new Set(runtimes.filter(runtime => runtime.command).map(runtime => runtime.id))
  const models = modelOptions.filter(option => option.available || option.provider === 'claude').map(option => ({
    id: option.id, label: option.label, provider: option.provider, model: option.model,
    kind: option.kind, local: option.local === true, available: option.available === true,
  }))
  return [...AGENT_PACKS, ...loadAgentPacks()].map(pack => ({
    id: pack.id,
    label: pack.label,
    role: pack.role,
    summary: pack.summary,
    capabilities: pack.capabilities,
    defaultModel: pack.defaultModel,
    preferredRuntimes: pack.preferredRuntimes,
    gates: pack.gates,
    runtimes: [...new Set([...pack.preferredRuntimes, ...available])].filter(id => available.has(id)),
    models,
    promptAvailable: Boolean(fs.existsSync(path.join(PACK_DIR, `${pack.id}.md`)) || pack.prompt),
  }))
}

export function defaultPackModel(packId, runtimeId, modelOptions = []) {
  const pack = resolveAgentPack(packId)
  const preferred = runtimeId === 'ollama' ? modelOptions.find(item => item.provider === 'ollama' && item.available) : null
  if (preferred) return preferred.id
  const sameProvider = modelOptions.find(item => item.provider === runtimeId && item.model === pack.defaultModel)
  if (sameProvider) return sameProvider.id
  if (runtimeId === 'claude') return `claude:${pack.defaultModel}`
  return `${runtimeId}:auto`
}
