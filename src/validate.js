// Validation for everything Quorum did not hand-write.
//
// Two things generate configuration besides the user's own editor: the
// bootstrap (`npm run bootstrap` asks a model to propose a setup from your own
// session history) and Pro's custom cast files. Anything machine-written gets
// exactly one path into the running system: through the validators in this
// file. The same validators back the test suite, so "the model wrote it" and
// "the tests cover it" are the same claim — that is what wiring the test suite
// into the build structure means in practice.
//
// Every validator returns { ok, value, errors } and never throws: a bad
// generated file must degrade to "rejected, with reasons" — not take the
// cockpit down, and never be half-applied.

const HEX = /^#[0-9a-fA-F]{3,8}$/
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/
const ROLE_CAPABILITIES = {
  researcher: new Set(['discover', 'read', 'test']),
  builder: new Set(['discover', 'read', 'test', 'edit', 'git.commit', 'git.push', 'git.merge', 'git.tag']),
  operator: new Set(['discover', 'read', 'test', 'edit', 'git.commit', 'git.push', 'git.merge', 'git.tag', 'deploy', 'publish', 'provider.change', 'external.send', 'migration.remote']),
  recovery: new Set(['discover', 'read', 'recovery.inspect', 'recovery.takeover']),
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null)

/** Ollama endpoint only: no credentials, paths, queries, or shell syntax. */
export function normalizeOllamaHost(value) {
  const raw = str(value, 240)
  if (!raw) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) return null
    return url.origin
  } catch {
    return null
  }
}

/** ~/.quorum/config.json — also the shape the bootstrap is allowed to write. */
export function validateConfig(raw) {
  const errors = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, value: null, errors: ['config must be a JSON object'] }

  const value = {}

  if (raw.roots !== undefined) {
    if (!Array.isArray(raw.roots) || !raw.roots.every(r => typeof r === 'string' && r.length))
      errors.push('roots must be an array of paths')
    else value.roots = raw.roots.map(r => str(r, 300))
  }

  if (raw.projects !== undefined) {
    if (!Array.isArray(raw.projects)) errors.push('projects must be an array')
    else {
      value.projects = []
      raw.projects.forEach((p, i) => {
        if (!p || typeof p !== 'object' || !str(p.path, 300)) { errors.push(`projects[${i}] needs a path`); return }
        value.projects.push({
          id: str(p.id, 40) || undefined,
          label: str(p.label, 60) || undefined,
          path: str(p.path, 300),
        })
      })
    }
  }

  if (raw.hidden !== undefined) {
    if (!Array.isArray(raw.hidden)) errors.push('hidden must be an array of room ids')
    else value.hidden = raw.hidden.map(h => str(h, 40)).filter(Boolean)
  }

  if (raw.runtimes !== undefined) {
    if (!Array.isArray(raw.runtimes)) errors.push('runtimes must be an array')
    else {
      value.runtimes = []
      raw.runtimes.forEach((r, i) => {
        const v = validateRuntime(r)
        if (!v.ok) errors.push(...v.errors.map(e => `runtimes[${i}]: ${e}`))
        else value.runtimes.push(v.value)
      })
    }
  }

  if (raw.agentPacks !== undefined) {
    if (!Array.isArray(raw.agentPacks)) errors.push('agentPacks must be an array')
    else {
      value.agentPacks = []
      raw.agentPacks.forEach((pack, i) => {
        const v = validateAgentPack(pack)
        if (!v.ok) errors.push(...v.errors.map(e => `agentPacks[${i}]: ${e}`))
        else value.agentPacks.push(v.value)
      })
    }
  }

  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models) || !raw.models.every(m => typeof m === 'string'))
      errors.push('models must be an array of model names')
    else value.models = raw.models.map(m => str(m, 80)).filter(Boolean).slice(0, 20)
  }

  if (raw.ollamaHost !== undefined) {
    const host = normalizeOllamaHost(raw.ollamaHost)
    if (!host) errors.push('ollamaHost must be an HTTP(S) host with no credentials or path')
    else value.ollamaHost = host
  }

  if (raw.modelMappings !== undefined) {
    if (!raw.modelMappings || typeof raw.modelMappings !== 'object' || Array.isArray(raw.modelMappings)) errors.push('modelMappings must be an object')
    else value.modelMappings = Object.fromEntries(Object.entries(raw.modelMappings).filter(([k, v]) => ID.test(String(k)) && typeof v === 'string' && MODEL.test(v.trim())).slice(0, 40))
  }

  if (raw.pets !== undefined) {
    if (!raw.pets || typeof raw.pets !== 'object' || Array.isArray(raw.pets)) errors.push('pets must be an object')
    else value.pets = Object.fromEntries(Object.entries(raw.pets).filter(([k, v]) => ID.test(String(k)) && typeof v === 'string' && v.length < 240).slice(0, 40))
  }

  if (raw.display !== undefined) {
    if (!raw.display || typeof raw.display !== 'object' || Array.isArray(raw.display)) errors.push('display must be an object')
    else value.display = { theme: ['dark', 'light'].includes(raw.display.theme) ? raw.display.theme : 'dark', refreshSeconds: Math.max(2, Math.min(120, Number(raw.display.refreshSeconds) || 5)) }
  }

  return { ok: errors.length === 0, value, errors }
}

/**
 * A runtime is any agent CLI the user wants one-keystroke access to — gemini,
 * aider, goose, opencode, a company-internal wrapper. The command is a single
 * program name or absolute path, no arguments and no shell metacharacters:
 * it is executed via `zsh -lic <cmd>`, and "no metacharacters" is the line
 * between "add your own agent" and "config file runs arbitrary shell".
 */
export function validateRuntime(r) {
  const errors = []
  if (!r || typeof r !== 'object') return { ok: false, value: null, errors: ['runtime must be an object'] }
  const id = str(r.id, 20)?.toLowerCase()
  const command = str(r.command, 200)
  if (!id || !ID.test(id)) errors.push('id must be 1-20 chars of a-z 0-9 -')
  if (['shell', 'zsh'].includes(id)) errors.push('id conflicts with the built-in shell profile')
  if (!command) errors.push('command is required')
  else if (/[\s;&|<>$`\\'"(){}\[\]*?~#\n]/.test(command)) errors.push('command must be a bare program name or path — no arguments or shell characters')
  const kind = ['local', 'cloud', 'custom'].includes(r.kind) ? r.kind : 'custom'
  const promptMode = ['stdin', 'arg', 'file', 'interactive'].includes(r.promptMode) ? r.promptMode : 'stdin'
  const provider = str(r.provider, 40) || id
  const modelDiscovery = ['none', 'ollama', 'command'].includes(r.modelDiscovery) ? r.modelDiscovery : 'none'
  const workdirFlag = r.workdirFlag === undefined ? null : str(r.workdirFlag, 20)
  const approvalMode = r.approvalMode === undefined ? null : str(r.approvalMode, 40)
  const capabilities = Array.isArray(r.capabilities) ? [...new Set(r.capabilities.map(v => str(v, 40)).filter(Boolean))].slice(0, 30) : []
  const modelFlag = r.modelFlag === undefined ? null : str(r.modelFlag, 20)
  const promptFlag = r.promptFlag === undefined ? null : str(r.promptFlag, 20)
  if (modelFlag && !/^--?[a-z][a-z0-9-]*$/.test(modelFlag)) errors.push('modelFlag must be a simple CLI flag')
  if (promptFlag && !/^--?[a-z][a-z0-9-]*$/.test(promptFlag)) errors.push('promptFlag must be a simple CLI flag')
  if (promptMode === 'arg' && !promptFlag) errors.push('promptFlag is required when promptMode is arg')
  if (workdirFlag && !/^--?[a-z][a-z0-9-]*$/.test(workdirFlag)) errors.push('workdirFlag must be a simple CLI flag')
  if (capabilities.some(capability => !['discover', 'read', 'test', 'edit', 'git.commit', 'git.push', 'git.merge', 'git.tag', 'deploy', 'publish', 'provider.change', 'external.send', 'migration.remote', 'recovery.inspect', 'recovery.takeover'].includes(capability))) errors.push('capabilities contain an unknown policy capability')
  return {
    ok: errors.length === 0,
    value: errors.length ? null : {
      id,
      label: str(r.label, 24) || id,
      command,
      provider,
      kind,
      modelFlag,
      promptFlag,
      workdirFlag,
      promptMode,
      modelDiscovery,
      approvalMode,
      capabilities,
      retryableExitCodes: Array.isArray(r.retryableExitCodes) ? r.retryableExitCodes.filter(code => Number.isInteger(code) && code >= 0 && code <= 255).slice(0, 10) : [],
      roundtable: r.roundtable === true,
    },
    errors,
  }
}

/**
 * Validate a custom task pack without allowing it to mint capabilities. The
 * role is the authority boundary; a pack can only request capabilities already
 * granted to that role by the policy manifest.
 */
export function validateAgentPack(raw, allowedByRole = ROLE_CAPABILITIES) {
  const errors = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, value: null, errors: ['agent pack must be an object'] }
  const id = str(raw.id, 32)?.toLowerCase()
  const role = str(raw.role, 20)
  if (!id || !ID.test(id)) errors.push('id must be 1-40 chars of a-z 0-9 -')
  if (!ROLE_CAPABILITIES[role]) errors.push('role must be researcher, builder, operator, or recovery')
  const allowed = allowedByRole[role] instanceof Set ? allowedByRole[role] : new Set(allowedByRole[role] || [])
  const capabilities = Array.isArray(raw.capabilities) ? [...new Set(raw.capabilities.map(v => str(v, 40)).filter(Boolean))].slice(0, 30) : []
  if (capabilities.some(capability => !allowed.has(capability))) errors.push('capabilities exceed the assigned role policy')
  const runtimes = Array.isArray(raw.preferredRuntimes) ? [...new Set(raw.preferredRuntimes.map(v => str(v, 32)).filter(Boolean))].slice(0, 12) : []
  const gates = Array.isArray(raw.gates) ? raw.gates.map(v => str(v, 120)).filter(Boolean).slice(0, 20) : []
  const prompt = str(raw.prompt, 4000)
  if (!prompt || prompt.length < 80) errors.push('prompt must be at least 80 characters')
  if (errors.length) return { ok: false, value: null, errors }
  return { ok: true, errors: [], value: { id, label: str(raw.label, 60) || id, role, summary: str(raw.summary, 240) || '', capabilities, preferredRuntimes: runtimes, defaultModel: MODEL.test(String(raw.defaultModel || '')) ? String(raw.defaultModel) : 'auto', gates, prompt } }
}

/** A custom cast member — Pro's `~/.quorum/cast/*.json`, and bootstrap drafts. */
export function validatePersona(raw) {
  const errors = []
  if (!raw || typeof raw !== 'object') return { ok: false, value: null, errors: ['persona must be an object'] }

  const id = str(raw.id, 24)?.toLowerCase().replace(/[^a-z0-9-]/g, '')
  if (!id) errors.push('id is required')
  const prompt = str(raw.prompt, 4000)
  if (!prompt || prompt.length < 80) errors.push('prompt must be at least 80 characters — a persona that short cannot argue')

  const palette = raw.palette || {}
  for (const k of ['body', 'trim', 'glow']) {
    // Palette values land in SVG attributes: a non-hex value is markup injection.
    if (palette[k] !== undefined && !HEX.test(String(palette[k]))) errors.push(`palette.${k} must be a hex colour`)
  }

  const model = raw.model === undefined || ['sonnet', 'opus', 'haiku'].includes(raw.model) || typeof raw.model === 'string'

  if (errors.length) return { ok: false, value: null, errors }
  return {
    ok: true,
    errors,
    value: {
      id,
      name: str(raw.name, 24) || id,
      role: str(raw.role, 24) || 'Specialist',
      tagline: str(raw.tagline, 80) || '',
      edition: 'custom',
      palette: {
        body: HEX.test(String(palette.body)) ? palette.body : '#94a3b8',
        trim: HEX.test(String(palette.trim)) ? palette.trim : '#475569',
        glow: HEX.test(String(palette.glow)) ? palette.glow : '#e2e8f0',
      },
      visor: str(raw.visor, 12) || 'dot',
      crest: str(raw.crest, 12) || 'spark',
      prop: str(raw.prop, 12) || 'clipboard',
      model: model && typeof raw.model === 'string' ? str(raw.model, 80) : 'sonnet',
      prompt,
    },
  }
}

// A command whose whole job is to run whatever string it is handed. Quorum
// never interposes a shell, but `{command: '/bin/sh', args: ['-c', '…']}` is a
// shell the operator interposed themselves, and the argument rules below do
// nothing about it. These are refused by name so the guarantee and the code
// say the same thing.
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'ash', 'busybox', 'env', 'xargs', 'nohup', 'timeout'])
// Interpreters that are legitimate check runners (`node --test`, `python -m
// pytest`) but also take inline source. The program is allowed; the
// evaluate-this-string flag is not.
const INLINE_CODE_PROGRAMS = new Set(['node', 'deno', 'bun', 'python', 'python2', 'python3', 'perl', 'ruby', 'php', 'osascript'])
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '-E', '--eval', '--eval-file', '--command'])

/**
 * A mission task's own verification command — the thing Quorum runs itself to
 * decide whether the task is actually done, rather than believing an agent's
 * exit code.
 *
 * It is executed with `execFile`, so Quorum never interposes a shell: the
 * program and its arguments go to the OS as an argv vector and nothing
 * expands, globs or splits them. That is the whole of the containment claim,
 * and it is worth stating plainly what it is *not* — it is not a sandbox. A
 * verifyCommand is a real command the operator chose, set through the same
 * loopback, Origin-gated mission API as the launch path, and it runs with the
 * cockpit's own privileges. The rules here keep it an argv vector: a bare
 * program name or a path, no shell metacharacters or whitespace in the program,
 * plain-value arguments, and a refusal for programs whose only purpose is to
 * interpret a string as a script.
 */
export function validateVerifyCommand(raw) {
  const errors = []
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null, errors }
  const input = typeof raw === 'string' ? { command: raw } : raw
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, value: null, errors: ['verifyCommand must be a string or an object'] }
  const command = str(input.command, 200)
  if (!command) errors.push('verifyCommand needs a command')
  else if (/[\s;&|<>$`\\'"(){}\[\]*?~#\n]/.test(command)) errors.push('verifyCommand must be a bare program name or absolute path — no arguments or shell characters')
  const rawArgs = Array.isArray(input.args) ? input.args : []
  if (rawArgs.length > 20) errors.push('verifyCommand accepts at most 20 arguments')
  const args = rawArgs.slice(0, 20).map(value => str(value, 200))
  if (args.some(value => value === null)) errors.push('verifyCommand arguments must be strings')
  else if (args.some(value => /[;&|<>$`\\\n]/.test(value))) errors.push('verifyCommand arguments must not contain shell metacharacters')
  const program = String(command || '').split('/').pop().toLowerCase()
  if (SHELL_PROGRAMS.has(program)) errors.push(`verifyCommand must be the check itself, not a shell that runs one — ${program} interprets its argument as a script`)
  else if (INLINE_CODE_PROGRAMS.has(program) && args.some(value => INLINE_CODE_FLAGS.has(String(value)))) errors.push(`verifyCommand must not hand ${program} inline source to evaluate — point it at a script or a test runner instead`)
  const timeoutMs = Math.max(1_000, Math.min(Number(input.timeoutMs) || 600_000, 1_800_000))
  if (errors.length) return { ok: false, value: null, errors }
  return { ok: true, errors, value: { command, args, timeoutMs } }
}
