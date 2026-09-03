import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadRuntimes } from '../config.js'
import { RUNTIME_ADAPTERS, resolveProviderSpec } from './provider-registry.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const EXTRA_PATHS = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']

// Kept as a compatibility export for callers that only need the executable
// inventory.  The provider registry is the source of adapter behavior.
export const RUNTIMES = Object.fromEntries([
  ...Object.entries(RUNTIME_ADAPTERS).map(([id, spec]) => [id, { ...spec }]),
  ['generic', { command: null, label: 'Generic command agent', provider: 'generic', kind: 'custom' }],
])

export function executablePath(command, env = process.env) {
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : null
  const dirs = [...String(env.PATH || '').split(path.delimiter), ...EXTRA_PATHS]
  for (const dir of [...new Set(dirs)].filter(Boolean)) {
    const candidate = path.join(dir, command)
    try { if (fs.statSync(candidate).isFile() && (process.platform === 'win32' || (fs.statSync(candidate).mode & 0o111))) return candidate } catch { /* next candidate */ }
  }
  return null
}

export function detectRuntimes(env = process.env) {
  const configured = loadRuntimes()
  const specs = new Map([...Object.entries(RUNTIMES), ...configured.filter(item => item.id).map(item => [item.id, item])])
  return [...specs.entries()].filter(([id, runtime]) => id !== 'generic' && runtime.command).map(([id, runtime]) => {
    const resolved = executablePath(runtime.command, env)
    const providerSpec = resolveProviderSpec(id, runtime)
    return {
      id,
      label: runtime.label,
      provider: providerSpec?.provider || runtime.provider || id,
      kind: providerSpec?.kind || runtime.kind || 'custom',
      command: runtime.command,
      path: resolved,
      available: Boolean(resolved),
      promptMode: providerSpec?.promptMode || runtime.promptMode || 'stdin',
      modelDiscovery: providerSpec?.modelDiscovery || runtime.modelDiscovery || 'none',
      capabilities: runtime.capabilities || providerSpec?.capabilities || [],
      authReference: providerSpec?.authReference || 'user-managed-reference',
      structuredOutput: providerSpec?.structuredOutput || 'text',
      benchmark: providerSpec?.benchmark || { supported: false, reason: 'custom runtime requires explicit harness validation' },
      contractVersion: 1,
    }
  })
}

export function buildLaunch({ runtime = 'generic', role = 'researcher', cwd = process.cwd(), argv = [], runtimeSpec = null } = {}) {
  const configured = runtimeSpec || loadRuntimes().find(item => item.id === runtime)
  const spec = resolveProviderSpec(runtime, RUNTIMES[runtime] || configured) || configured || { command: runtime, label: runtime }
  const command = argv[0] || spec.command
  if (!command) throw new Error('missing runtime command')
  const args = argv.length ? argv.slice(1) : []
  const promptFile = path.join(ROOT, 'prompts', 'agent-system.md')
  const readOnly = role === 'researcher' || role === 'recovery'
  if (runtime === 'claude' && !args.includes('--append-system-prompt-file')) {
    args.push('--append-system-prompt-file', promptFile, spec.safeLaunch.permissionFlag, readOnly ? spec.safeLaunch.readOnly : spec.safeLaunch.write)
  }
  if (runtime === 'codex' && !args.includes('--cd')) {
    args.push(spec.safeLaunch.workdirFlag, path.resolve(cwd), spec.safeLaunch.sandboxFlag, readOnly ? spec.safeLaunch.readOnly : spec.safeLaunch.write, spec.safeLaunch.approvalFlag, readOnly ? spec.safeLaunch.readOnlyApproval : spec.safeLaunch.writeApproval)
  }
  if (runtime === 'hermes' && !args.includes('--in')) {
    args.push(spec.safeLaunch.workdirFlag, path.resolve(cwd))
    if (readOnly) args.push(spec.safeLaunch.readOnlyFlag)
  }
  if (spec.safeLaunch?.fixedArgs) {
    for (const arg of spec.safeLaunch.fixedArgs) if (!args.includes(arg)) args.push(arg)
  }
  if (runtime === 'gemini' && !args.includes('--approval-mode')) {
    args.push(spec.safeLaunch.approvalFlag, readOnly ? spec.safeLaunch.readOnly : spec.safeLaunch.write)
  }
  if (spec.workdirFlag && !args.includes(spec.workdirFlag) && !['claude', 'codex', 'hermes'].includes(runtime)) args.push(spec.workdirFlag, path.resolve(cwd))
  const env = { ...process.env, QUORUM_AGENT_ROLE: role, QUORUM_AGENT_WORKDIR: path.resolve(cwd) }
  const pathValue = [...new Set([...String(env.PATH || '').split(path.delimiter), ...EXTRA_PATHS])].filter(Boolean).join(path.delimiter)
  env.PATH = pathValue
  env.QUORUM_AGENT_CONTRACT_FILE = promptFile
  return {
    command: executablePath(command, env) || command,
    args,
    cwd: path.resolve(cwd),
    env,
    promptFile: fs.existsSync(promptFile) ? promptFile : null,
    provider: spec.provider || runtime,
    authReference: spec.authReference || 'user-managed-reference',
    structuredOutput: spec.structuredOutput || 'text',
    safety: { readOnly, contractVersion: 1 },
  }
}

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`

/**
 * Build a one-shot task invocation. The task is never used as shell syntax;
 * it is one quoted argv value for runtimes that support prompt mode. Runtimes
 * without a known prompt flag still open in their normal interactive mode.
 */
export function buildTaskLaunch({ runtime = 'generic', role = 'researcher', cwd = process.cwd(), task = '', model = '', promptFile = null, runtimeSpec = null, structured = false } = {}) {
  const configured = runtimeSpec || loadRuntimes().find(item => item.id === runtime) || null
  const spec = resolveProviderSpec(runtime, RUNTIMES[runtime] || configured) || configured || { promptMode: 'stdin' }
  const plan = buildLaunch({ runtime, runtimeSpec: configured, role, cwd })
  const args = [...plan.args]
  const prompt = String(task || '').trim().slice(0, 8000)
  const chosenModel = String(model || '').trim()
  if (runtime === 'claude') {
    args.unshift('-p', prompt || 'Inspect the current task and report the next safe action.')
    if (chosenModel && chosenModel !== 'auto') args.push('--model', chosenModel)
    if (promptFile && !args.includes(promptFile)) args.push('--append-system-prompt-file', promptFile)
    if (structured) args.push('--output-format', 'stream-json', '--verbose')
  } else if (runtime === 'codex') {
    // `--ask-for-approval` belongs to the interactive root command; codex exec
    // has no such option and exits before creating a thread if it is present.
    const approval = args.indexOf('--ask-for-approval')
    if (approval >= 0) args.splice(approval, 2)
    args.unshift('exec', prompt || 'Inspect the current task and report the next safe action.')
    if (chosenModel && chosenModel !== 'auto') args.push('--model', chosenModel)
    if (structured) args.push('--json')
  } else if (runtime === 'copilot') {
    args.unshift('-p', prompt || 'Inspect the current task and report the next safe action.')
    if (chosenModel && chosenModel !== 'auto') args.push('--model', chosenModel)
  } else if (runtime === 'hermes') {
    args.unshift('chat', '--query', prompt || 'Inspect the current task and report the next safe action.')
    if (chosenModel && chosenModel !== 'auto') args.push('--model', chosenModel)
  } else if (runtime === 'gemini') {
    args.unshift('-p', prompt || 'Inspect the current task and report the next safe action.')
    if (chosenModel && chosenModel !== 'auto') args.push('--model', chosenModel)
  } else if (runtime === 'ollama') {
    const localModel = chosenModel && chosenModel !== 'auto' ? chosenModel : 'gemma3:latest'
    args.unshift('run', localModel, prompt || 'Inspect the current task and report the next safe action.')
  } else if (spec.promptMode === 'arg' && spec.promptFlag) {
    args.push(spec.promptFlag, prompt || 'Inspect the current task and report the next safe action.')
    if (chosenModel && spec.modelFlag) args.push(spec.modelFlag, chosenModel)
  }
  const command = [plan.command, ...args].map(shellQuote).join(' ')
  // Claude -p and Codex exec both accept the prompt as an argv value. Leaving
  // stdin open makes Codex wait for a second prompt, so managed invocations do
  // not create a pipe unless a custom runtime explicitly requires stdin.
  const promptTransport = ['claude', 'codex', 'ollama'].includes(runtime) ? 'arg' : (spec.promptMode || 'stdin')
  return { ...plan, args, shellCommand: command, input: promptTransport === 'stdin' ? `${prompt || 'Inspect the current task and report the next safe action.'}\n` : null, taskIncluded: Boolean(prompt), promptTransport, packPromptFile: promptFile }
}

export function spawnLaunch(plan, { onExit } = {}) {
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: plan.input ? ['pipe', 'inherit', 'inherit'] : 'inherit' })
  if (plan.input && child.stdin) { child.stdin.write(plan.input); child.stdin.end() }
  if (onExit) child.once('exit', (code, signal) => onExit({ code, signal }))
  return child
}
