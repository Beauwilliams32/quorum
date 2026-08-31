import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadRuntimes } from '../config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const EXTRA_PATHS = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']

export const RUNTIMES = {
  claude: { command: 'claude', label: 'Claude Code' },
  codex: { command: 'codex', label: 'Codex CLI' },
  copilot: { command: 'copilot', label: 'GitHub Copilot CLI' },
  hermes: { command: 'hermes', label: 'Hermes' },
  openclaw: { command: 'openclaw', label: 'OpenClaw' },
  gemini: { command: 'gemini', label: 'Gemini' },
  ollama: { command: 'ollama', label: 'Ollama/local model' },
  generic: { command: null, label: 'Generic command agent' },
}

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
    return { id, label: runtime.label, provider: runtime.provider || id, kind: runtime.kind || 'custom', command: runtime.command, path: resolved, available: Boolean(resolved), promptMode: runtime.promptMode || 'stdin', modelDiscovery: runtime.modelDiscovery || 'none', capabilities: runtime.capabilities || [] }
  })
}

export function buildLaunch({ runtime = 'generic', role = 'researcher', cwd = process.cwd(), argv = [], runtimeSpec = null } = {}) {
  const configured = runtimeSpec || loadRuntimes().find(item => item.id === runtime)
  const spec = RUNTIMES[runtime] || configured || { command: runtime, label: runtime }
  const command = argv[0] || spec.command
  if (!command) throw new Error('missing runtime command')
  const args = argv.length ? argv.slice(1) : []
  const promptFile = path.join(ROOT, 'prompts', 'agent-system.md')
  if (runtime === 'claude' && !args.includes('--append-system-prompt-file')) {
    args.push('--append-system-prompt-file', promptFile, '--permission-mode', role === 'researcher' || role === 'recovery' ? 'plan' : 'acceptEdits')
  }
  if (runtime === 'codex' && !args.includes('--cd')) {
    args.push('--cd', path.resolve(cwd), '--sandbox', role === 'researcher' || role === 'recovery' ? 'read-only' : 'workspace-write', '--ask-for-approval', role === 'researcher' || role === 'recovery' ? 'untrusted' : 'on-request')
  }
  if (runtime === 'hermes' && !args.includes('--in')) {
    args.push('--in', path.resolve(cwd))
    if (role === 'researcher' || role === 'recovery') args.push('--safe-mode')
  }
  if (runtime === 'openclaw' && !args.includes('--no-color')) {
    args.push('--no-color')
  }
  if (runtime === 'gemini' && !args.includes('--approval-mode')) {
    args.push('--approval-mode', role === 'researcher' || role === 'recovery' ? 'plan' : 'auto_edit')
  }
  if (spec.workdirFlag && !args.includes(spec.workdirFlag) && !['claude', 'codex'].includes(runtime)) args.push(spec.workdirFlag, path.resolve(cwd))
  const env = { ...process.env, QUORUM_AGENT_ROLE: role, QUORUM_AGENT_WORKDIR: path.resolve(cwd) }
  const pathValue = [...new Set([...String(env.PATH || '').split(path.delimiter), ...EXTRA_PATHS])].filter(Boolean).join(path.delimiter)
  env.PATH = pathValue
  env.QUORUM_AGENT_CONTRACT_FILE = promptFile
  return { command: executablePath(command, env) || command, args, cwd: path.resolve(cwd), env, promptFile: fs.existsSync(promptFile) ? promptFile : null }
}

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`

/**
 * Build a one-shot task invocation. The task is never used as shell syntax;
 * it is one quoted argv value for runtimes that support prompt mode. Runtimes
 * without a known prompt flag still open in their normal interactive mode.
 */
export function buildTaskLaunch({ runtime = 'generic', role = 'researcher', cwd = process.cwd(), task = '', model = '', promptFile = null, runtimeSpec = null } = {}) {
  const configured = runtimeSpec || loadRuntimes().find(item => item.id === runtime) || null
  const adapterRuntime = RUNTIMES[runtime] ? runtime : (configured?.command || runtime)
  const plan = buildLaunch({ runtime, runtimeSpec: configured, role, cwd })
  const args = [...plan.args]
  const prompt = String(task || '').trim().slice(0, 8000)
  const chosenModel = String(model || '').trim()
  if (runtime === 'claude') {
    args.unshift('-p', prompt || 'Inspect the current task and report the next safe action.')
    if (chosenModel && chosenModel !== 'auto') args.push('--model', chosenModel)
    if (promptFile && !args.includes(promptFile)) args.push('--append-system-prompt-file', promptFile)
  } else if (runtime === 'codex') {
    args.unshift('exec', prompt || 'Inspect the current task and report the next safe action.')
    if (chosenModel && chosenModel !== 'auto') args.push('--model', chosenModel)
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
  } else if (configured?.promptMode === 'arg' && configured.promptFlag) {
    args.push(configured.promptFlag, prompt || 'Inspect the current task and report the next safe action.')
    if (chosenModel && configured.modelFlag) args.push(configured.modelFlag, chosenModel)
  }
  const command = [plan.command, ...args].map(shellQuote).join(' ')
  const promptTransport = configured?.promptMode || (runtime === 'ollama' ? 'arg' : 'stdin')
  return { ...plan, args, shellCommand: command, input: promptTransport === 'stdin' ? `${prompt || 'Inspect the current task and report the next safe action.'}\n` : null, taskIncluded: Boolean(prompt), promptTransport, packPromptFile: promptFile }
}

export function spawnLaunch(plan, { onExit } = {}) {
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: plan.input ? ['pipe', 'inherit', 'inherit'] : 'inherit' })
  if (plan.input && child.stdin) { child.stdin.write(plan.input); child.stdin.end() }
  if (onExit) child.once('exit', (code, signal) => onExit({ code, signal }))
  return child
}
