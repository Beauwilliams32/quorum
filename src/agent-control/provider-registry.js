// Provider and runtime contracts are deliberately data-only.  They describe
// how Quorum may talk to an installed agent; they never contain credentials or
// read provider auth files.  A provider is not "ready" merely because its CLI
// exists — readiness still needs a safe, direct smoke test.

const freeze = value => Object.freeze(value)

const RUNTIME_SPECS = [
  {
    id: 'claude', label: 'Claude Code', provider: 'anthropic', kind: 'cloud', command: 'claude',
    promptMode: 'arg', promptFlag: '-p', modelFlag: '--model', authReference: 'hermes-or-keychain',
    capabilities: ['discover', 'read', 'test', 'edit'], structuredOutput: 'stream-json',
    safeLaunch: { permissionFlag: '--permission-mode', readOnly: 'plan', write: 'acceptEdits' },
    benchmark: { supported: true, taskTypes: ['architecture', 'coding', 'review'] },
  },
  {
    id: 'codex', label: 'Codex CLI', provider: 'openai-codex', kind: 'cloud', command: 'codex',
    promptMode: 'arg', modelFlag: '--model', authReference: 'codex-oauth-existing',
    capabilities: ['discover', 'read', 'test', 'edit'], structuredOutput: 'json',
    safeLaunch: { workdirFlag: '--cd', sandboxFlag: '--sandbox', readOnly: 'read-only', write: 'workspace-write', approvalFlag: '--ask-for-approval', readOnlyApproval: 'untrusted', writeApproval: 'on-request' },
    benchmark: { supported: true, taskTypes: ['architecture', 'coding', 'review'] },
  },
  {
    id: 'copilot', label: 'GitHub Copilot CLI', provider: 'github', kind: 'cloud', command: 'copilot',
    promptMode: 'arg', promptFlag: '-p', modelFlag: '--model', authReference: 'cli-managed',
    capabilities: ['discover', 'read', 'test', 'edit'], structuredOutput: 'text',
    benchmark: { supported: true, taskTypes: ['coding', 'review'] },
  },
  {
    id: 'gemini', label: 'Gemini CLI', provider: 'google-gemini', kind: 'cloud', command: 'gemini',
    promptMode: 'arg', promptFlag: '-p', modelFlag: '--model', authReference: 'cli-managed',
    capabilities: ['discover', 'read', 'test', 'edit'], structuredOutput: 'text',
    safeLaunch: { approvalFlag: '--approval-mode', readOnly: 'plan', write: 'auto_edit' },
    benchmark: { supported: true, taskTypes: ['research', 'architecture', 'review'] },
  },
  {
    id: 'hermes', label: 'Hermes', provider: 'hermes', kind: 'orchestrator', command: 'hermes',
    promptMode: 'arg', promptFlag: '--query', modelFlag: '--model', authReference: 'hermes-config-reference',
    capabilities: ['discover', 'read', 'test', 'edit'], structuredOutput: 'text',
    safeLaunch: { workdirFlag: '--in', readOnlyFlag: '--safe-mode' },
    benchmark: { supported: true, taskTypes: ['monitoring', 'orchestration', 'coding'] },
  },
  {
    id: 'openclaw', label: 'OpenClaw', provider: 'openclaw', kind: 'orchestrator', command: 'openclaw',
    promptMode: 'interactive', authReference: 'cli-managed', capabilities: ['discover', 'read', 'test', 'edit'],
    structuredOutput: 'text', safeLaunch: { fixedArgs: ['--no-color'] },
    benchmark: { supported: false, reason: 'interactive runtime; use supervised task sessions' },
  },
  {
    id: 'ollama', label: 'Ollama', provider: 'ollama', kind: 'local', command: 'ollama',
    promptMode: 'arg', authReference: 'local-no-credential', capabilities: ['discover', 'read', 'test', 'edit'],
    structuredOutput: 'text', modelDiscovery: 'ollama',
    benchmark: { supported: true, taskTypes: ['monitoring', 'research', 'coding', 'review'] },
  },
  {
    id: 'cursor', label: 'Cursor CLI', provider: 'cursor', kind: 'local', command: 'cursor',
    promptMode: 'interactive', authReference: 'cli-managed', capabilities: ['discover', 'read', 'test', 'edit'],
    structuredOutput: 'text',
    benchmark: { supported: false, reason: 'interactive editor runtime; use supervised task sessions' },
  },
]

// These routes are available to Hermes/Quorum configuration, but are not
// considered configured or authenticated until a user completes setup and a
// direct provider smoke test succeeds.  The registry intentionally stores a
// credential reference class, never an environment variable or secret.
const API_SPECS = [
  ['anthropic', 'Anthropic', 'anthropic', 'hermes-config-reference'],
  ['openai', 'OpenAI', 'openai', 'hermes-config-reference'],
  ['openai-codex', 'OpenAI Codex OAuth', 'openai-codex', 'codex-oauth-existing'],
  ['ollama', 'Ollama', 'ollama', 'local-no-credential'],
  ['openrouter', 'OpenRouter', 'openrouter', 'hermes-config-reference'],
  ['minimax', 'MiniMax', 'minimax', 'hermes-config-reference'],
  ['google-gemini', 'Google / Gemini', 'google-gemini', 'hermes-config-reference'],
  ['xai', 'xAI', 'xai', 'hermes-config-reference'],
  ['aws-bedrock', 'AWS Bedrock', 'aws-bedrock', 'hermes-config-reference'],
  ['openai-compatible', 'OpenAI-compatible endpoint', 'openai-compatible', 'keychain-reference'],
].map(([id, label, provider, authReference]) => ({
  id, label, provider, kind: id === 'ollama' ? 'local' : 'cloud', command: null,
  promptMode: 'provider-api', authReference, capabilities: ['discover', 'read', 'test'],
  structuredOutput: 'provider-native', benchmark: { supported: true, taskTypes: ['monitoring', 'research', 'architecture', 'coding', 'review'] },
}))

export const RUNTIME_ADAPTERS = freeze(Object.fromEntries(RUNTIME_SPECS.map(spec => [spec.id, freeze(spec)])))
export const PROVIDER_SPECS = freeze([...RUNTIME_SPECS, ...API_SPECS].map(freeze))

export const TASK_ROUTING = freeze({
  monitoring: freeze({ preferred: ['ollama', 'hermes', 'gemini'], reason: 'low-cost or local continuous observation' }),
  research: freeze({ preferred: ['gemini', 'hermes', 'ollama'], reason: 'broad retrieval and evidence synthesis' }),
  architecture: freeze({ preferred: ['codex', 'claude', 'openai-codex'], reason: 'strong reasoning with project context' }),
  coding: freeze({ preferred: ['codex', 'claude', 'copilot', 'ollama'], reason: 'tool-aware implementation and verification' }),
  review: freeze({ preferred: ['claude', 'codex', 'gemini', 'ollama'], reason: 'independent adversarial checks' }),
  orchestration: freeze({ preferred: ['hermes', 'openclaw'], reason: 'managed lifecycle and integrations' }),
})

export function resolveProviderSpec(id, runtimeSpec = null) {
  const key = String(id || '').trim().toLowerCase()
  const known = RUNTIME_ADAPTERS[key] || PROVIDER_SPECS.find(spec => spec.id === key || spec.provider === key)
  if (known) return known
  if (runtimeSpec && typeof runtimeSpec === 'object') {
    return {
      id: key || 'custom',
      label: String(runtimeSpec.label || key || 'Custom runtime').slice(0, 60),
      provider: String(runtimeSpec.provider || key || 'custom').slice(0, 60),
      kind: runtimeSpec.kind || 'custom',
      command: runtimeSpec.command || null,
      promptMode: runtimeSpec.promptMode || 'stdin',
      promptFlag: runtimeSpec.promptFlag || null,
      modelFlag: runtimeSpec.modelFlag || null,
      workdirFlag: runtimeSpec.workdirFlag || null,
      authReference: 'user-managed-reference',
      capabilities: Array.isArray(runtimeSpec.capabilities) ? runtimeSpec.capabilities : [],
      structuredOutput: 'text',
      benchmark: { supported: false, reason: 'custom runtime requires explicit harness validation' },
    }
  }
  return null
}

export function providerCatalog({ runtimes = [], configuredProviders = [] } = {}) {
  const installed = new Map((runtimes || []).map(runtime => [runtime.id, runtime]))
  const configured = new Set((configuredProviders || []).map(value => String(value).toLowerCase()))
  // A CLI and an API route can represent the same provider (for example
  // codex -> openai-codex).  Present one canonical provider record so the UI
  // never implies that one provider has two independent credential states.
  const canonical = new Map()
  for (const spec of PROVIDER_SPECS) if (!canonical.has(spec.provider)) canonical.set(spec.provider, spec)
  return [...canonical.values()].map(spec => {
    const runtime = installed.get(spec.id) || [...installed.values()].find(item => item.provider === spec.provider) || null
    const runtimeInstalled = Boolean(runtime?.available)
    const configReady = configured.has(spec.id) || configured.has(spec.provider)
    return {
      id: spec.provider,
      label: spec.label,
      provider: spec.provider,
      kind: spec.kind,
      runtime: runtime?.id || (spec.command ? spec.id : null),
      command: runtime?.command || spec.command,
      installed: runtimeInstalled,
      configured: configReady,
      // This is intentionally a status, not a credential probe.  Auth is
      // resolved by the owning CLI/keychain and verified with a direct test.
      authReference: spec.authReference,
      authStatus: spec.authReference === 'local-no-credential' ? 'not-required' : runtime ? 'runtime-owned-unverified' : configReady ? 'reference-configured' : 'not-configured',
      available: runtimeInstalled || configReady,
      readiness: runtimeInstalled ? 'installed-unverified' : (configReady ? 'configured-unverified' : 'not-configured'),
      structuredOutput: spec.structuredOutput,
      benchmark: spec.benchmark,
    }
  })
}

export function taskRoute(taskType = 'coding') {
  return TASK_ROUTING[String(taskType || '').toLowerCase()] || TASK_ROUTING.coding
}
