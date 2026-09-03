import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_PATH, loadConfig } from './config.js'
import { validateConfig, validateRuntime } from './validate.js'
import { buildTaskLaunch } from './agent-control/adapters.js'
import { defaultPackModel, resolveAgentPack, agentPackPromptPath } from './agents/packs.js'

const ACTIONS = new Set(['launch', 'stop', 'route', 'chain', 'config'])
const chains = new Set(['question-roundtable-task', 'roundtable-decision-task'])

export function previewAction(input = {}, catalog, state, ptys) {
  const action = String(input.action || '')
  if (!ACTIONS.has(action)) throw new Error('unknown command action')
  if (action === 'launch') {
    const runtime = catalog.runtimes.find(r => r.id === input.runtimeId)
    const room = (state.data.projects?.rooms || []).find(r => r.id === input.roomId)
    if (!runtime || runtime.kind === 'cloud' && runtime.id === 'openai-api') throw new Error('runtime is not launchable')
    if (!room) throw new Error('unknown project room')
    if (input.packId) {
      const pack = resolveAgentPack(input.packId)
      // Preferred runtimes shape the UI, but a validated custom CLI is also a
      // valid execution target. The pack controls role and contract; it does
      // not create an arbitrary provider allowlist.
      if (!input.task || typeof input.task !== 'string' || !input.task.trim()) throw new Error('agent task is required')
      const modelRef = String(input.modelRef || defaultPackModel(pack.id, runtime.id, input.modelOptions || [])).slice(0, 160)
      const split = modelRef.indexOf(':')
      const provider = split > 0 ? modelRef.slice(0, split) : runtime.id
      const model = split > 0 ? modelRef.slice(split + 1) : modelRef
      if (provider !== runtime.id) throw new Error(`model provider ${provider} does not match ${runtime.id}`)
      let contractFile = null
      try { contractFile = agentPackPromptPath(pack.id) } catch { /* custom packs carry a validated local contract; no browser exposure */ }
      const built = buildTaskLaunch({ runtime: runtime.id, runtimeSpec: runtime, role: pack.role, cwd: room.cwd, task: input.task, model, promptFile: contractFile, structured: input.managed === true })
      // Never return the launch environment to the browser: it inherits the
      // user's runtime auth and may contain provider credentials.
      const { env: _secretBearingEnv, ...launch } = built
      return { action, summary: `Run ${pack.label} with ${runtime.label} in ${room.label}`, runtimeId: runtime.id, roomId: room.id, packId: pack.id, packLabel: pack.label, role: pack.role, modelRef, task: input.task.slice(0, 8000), command: runtime.command, launch }
    }
    return { action, summary: `Launch ${runtime.label} in ${room.label}`, runtimeId: runtime.id, roomId: room.id, command: runtime.command }
  }
  if (action === 'stop') {
    const pty = ptys.list().find(item => item.id === input.ptyId)
    if (!pty || pty.exited) throw new Error('session is not a tracked PTY')
    return { action, summary: `Stop tracked ${pty.profile} session ${pty.id}`, ptyId: pty.id }
  }
  if (action === 'route') {
    const room = (state.data.projects?.rooms || []).find(r => r.id === input.roomId)
    if (!room) throw new Error('unknown project room')
    if (!catalog.models.some(m => m.id === input.modelId || m.harnessId === input.modelId)) throw new Error('unknown catalog model')
    return { action, summary: `Route ${input.modelId} to ${room.label}`, roomId: room.id, modelId: input.modelId }
  }
  if (action === 'chain') {
    if (!chains.has(input.chainId) || !Array.isArray(input.steps) || input.steps.length < 2 || input.steps.some(step => typeof step !== 'string')) throw new Error('chain is not an approved orchestration sequence')
    return { action, summary: `Run approved chain ${input.chainId}`, chainId: input.chainId, steps: input.steps.slice(0, 8) }
  }
  const cfg = validateConfig(input.config)
  if (!cfg.ok) throw new Error(cfg.errors.join('; '))
  return { action, summary: 'Write allowlisted Quorum configuration', config: cfg.value }
}

export function executeAction(preview, input, { state, ptys, startPty }) {
  if (input.confirm !== true) throw new Error('explicit confirmation is required')
  if (preview.action === 'launch') {
    const rec = startPty(preview.runtimeId, input.roomId, preview.launch || null)
    state.event({ kind: 'command', text: `${preview.packId ? `task ${preview.packId}` : 'launch'} confirmed → ${preview.runtimeId} in ${input.roomId}` })
    return { ok: true, ptyId: rec.id }
  }
  if (preview.action === 'stop') { ptys.kill(preview.ptyId); state.event({ kind: 'command', text: `stop confirmed → ${preview.ptyId}` }); return { ok: true } }
  if (preview.action === 'route') { state.event({ kind: 'command', text: `route confirmed → ${preview.modelId} to ${preview.roomId}` }); return { ok: true } }
  if (preview.action === 'chain') { state.event({ kind: 'command', text: `chain confirmed → ${preview.chainId}` }); return { ok: true, chainId: preview.chainId } }
  const file = CONFIG_PATH
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(preview.config, null, 2) + '\n', { mode: 0o600 })
  state.event({ kind: 'command', text: 'configuration write confirmed → allowlisted fields' })
  return { ok: true, path: file }
}

export function validateCustomRuntime(runtime) { return validateRuntime(runtime) }
