import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { CONFIG_PATH, loadConfig, loadModels, loadRuntimes } from './config.js'

const hasCommand = command => {
  if (!command) return false
  try { execFileSync('zsh', ['-lc', `command -v -- ${JSON.stringify(command)}`], { stdio: 'ignore', timeout: 800 }); return true } catch { return false }
}
const envReady = names => names.some(name => Boolean(process.env[name]))
const pet = (subjectId, source = 'fallback') => {
  const assetPath = `${os.homedir()}/.quorum/pets/${subjectId}.svg`
  return fs.existsSync(assetPath) ? { subjectId, assetPath, source } : { subjectId, source }
}

const BUILTIN = [
  { id: 'claude', label: 'Claude', kind: 'cloud', command: 'claude', auth: ['ANTHROPIC_API_KEY'], capabilities: ['reasoning', 'roundtable', 'project-sessions'], provider: 'Anthropic', model: 'claude' },
  { id: 'codex', label: 'Codex', kind: 'cloud', command: 'codex', auth: ['OPENAI_API_KEY'], capabilities: ['coding', 'project-sessions'], provider: 'OpenAI', model: 'codex' },
  { id: 'openai-api', label: 'OpenAI API', kind: 'cloud', command: null, auth: ['OPENAI_API_KEY'], capabilities: ['reasoning', 'routing'], provider: 'OpenAI', model: 'gpt' },
  { id: 'gemini', label: 'Gemini', kind: 'cloud', command: 'gemini', auth: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'], capabilities: ['reasoning', 'research'], provider: 'Google', model: 'gemini' },
  { id: 'hermes', label: 'Hermes', kind: 'local', command: 'hermes', auth: [], capabilities: ['orchestration', 'background-jobs'], provider: 'Hermes', model: 'hermes' },
  { id: 'openclaw', label: 'OpenClaw', kind: 'local', command: 'openclaw', auth: [], capabilities: ['automation', 'adapters'], provider: 'OpenClaw', model: 'openclaw' },
  { id: 'comfyui-wan', label: 'ComfyUI / Wan', kind: 'local', command: null, auth: [], capabilities: ['image-generation', 'video-generation'], provider: 'ComfyUI', model: 'wan' },
]

function runtimeFor(id, runtimes) {
  return runtimes.find(runtime => runtime.id === id) || null
}

export function buildCatalog({ config = loadConfig(), runtimes = loadRuntimes(), models = loadModels() } = {}) {
  const runtimeEntries = BUILTIN.map(item => {
    const runtime = runtimeFor(item.id, runtimes)
    const available = item.id === 'openai-api' ? envReady(item.auth) : item.id === 'comfyui-wan'
      ? Boolean(config.services?.comfyui) || hasCommand('comfy') || hasCommand('comfyui')
      : Boolean(runtime && item.command && hasCommand(runtime.command))
    return { id: item.id, label: item.label, kind: item.kind, ...(runtime?.command ? { command: runtime.command } : {}), available, authReady: item.auth.length === 0 ? available : envReady(item.auth), capabilities: item.capabilities }
  })
  for (const runtime of runtimes.filter(item => !BUILTIN.some(b => b.id === item.id))) {
    runtimeEntries.push({ id: runtime.id, label: runtime.label, kind: 'custom', command: runtime.command, available: hasCommand(runtime.command), authReady: hasCommand(runtime.command), capabilities: ['project-sessions', 'custom-runtime'] })
  }
  const modelEntries = [
    { id: 'claude-sonnet', provider: 'Anthropic', kind: 'cloud', available: runtimeEntries.some(r => r.id === 'claude' && r.available), harnessId: 'claude' },
    { id: 'codex', provider: 'OpenAI', kind: 'cloud', available: runtimeEntries.some(r => r.id === 'codex' && r.available), harnessId: 'codex' },
    { id: 'gpt-api', provider: 'OpenAI', kind: 'cloud', available: runtimeEntries.some(r => r.id === 'openai-api' && r.available), harnessId: 'openai-api' },
    { id: 'gemini', provider: 'Google', kind: 'cloud', available: runtimeEntries.some(r => r.id === 'gemini' && r.available), harnessId: 'gemini' },
    { id: 'hermes-local', provider: 'Hermes', kind: 'local', available: runtimeEntries.some(r => r.id === 'hermes' && r.available), harnessId: 'hermes' },
    { id: 'openclaw-local', provider: 'OpenClaw', kind: 'local', available: runtimeEntries.some(r => r.id === 'openclaw' && r.available), harnessId: 'openclaw' },
    { id: 'wan-local', provider: 'ComfyUI', kind: 'local', available: runtimeEntries.some(r => r.id === 'comfyui-wan' && r.available), harnessId: 'comfyui-wan' },
    ...models.filter(model => typeof model === 'string' && !['sonnet', 'opus', 'haiku'].includes(model)).map(model => ({ id: model, provider: 'Custom', kind: 'cloud', available: true, harnessId: 'custom' })),
  ]
  const projects = config.projects?.length || 0
  return {
    runtimes: runtimeEntries,
    models: modelEntries,
    config: { path: config.path || CONFIG_PATH, exists: Boolean(config.exists), projectCount: projects, runtimeCount: runtimeEntries.length, modelCount: modelEntries.length },
    pets: [...runtimeEntries.map(r => pet(r.id, config.pets?.[r.id] && fs.existsSync(`${os.homedir()}/.quorum/pets/${r.id}.svg`) ? 'generated' : 'fallback')), ...modelEntries.map(m => pet(m.id, config.pets?.[m.id] && fs.existsSync(`${os.homedir()}/.quorum/pets/${m.id}.svg`) ? 'generated' : 'fallback'))],
  }
}

export function publicCatalog(catalog = buildCatalog()) {
  return JSON.parse(JSON.stringify(catalog))
}

export function petDirectory() { return `${os.homedir()}/.quorum/pets` }
