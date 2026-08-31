// The roundtable — structured multi-agent debate.
//
// The point of this file is that agreement has to be *earned*. A naive
// implementation shows every agent the same prompt and the same growing
// transcript, and what comes back is a chorus: each model reads the previous
// answers as context to agree with, and the operator ends up with one opinion
// wearing five hats. That is worse than a single answer, because it looks like
// corroboration.
//
// So the protocol below does three specific things:
//
//   1. OPENING statements are generated in parallel, in mutual ignorance. No
//      participant can see another's opening, so the positions are genuinely
//      independent and disagreement is real rather than performed.
//   2. CLASH forces each participant to name the single strongest argument
//      against their own position and either rebut it or concede it out loud.
//      Conceding is a first-class outcome — it is recorded, not penalized.
//   3. CONVERGE asks for a revised position plus what changed. Because we keep
//      `position` and `confidence` from every phase, the UI can show a mind
//      actually changing, which is the only observable proof the debate did
//      any work.
//
// Every turn is a separate `claude -p` process with tools and MCP stripped:
// debaters reason, they do not touch the machine. That keeps a turn cheap
// (~$0.08 vs ~$0.27 with the default toolset loaded) and means a debate can
// never edit a file as a side effect of arguing about it.

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { castMember, MODERATOR_ID } from './cast.js'
import { dataDir, readDirs } from './paths.js'
import { resolveClaudeCommand } from './collectors/services.js'
import { loadConfig, loadRuntimes } from './config.js'

const STORE = dataDir('roundtables')
const TURN_TIMEOUT_MS = 180_000
const MAX_PARTICIPANTS = 5
const MAX_TOPIC = 600

// Rough per-turn cost measured against the real CLI with tools stripped. Used
// only to warn before spending; the actual figure reported afterwards comes
// from the CLI's own `total_cost_usd`.
export const EST_COST_PER_TURN_USD = 0.08

export const PHASES = ['brief', 'opening', 'clash', 'converge', 'verdict']
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/

/** Normalize legacy Claude values and explicit provider:model references. */
export function resolveModelRef(value, runtimes = loadRuntimes()) {
  const raw = String(value || 'sonnet').trim()
  const split = raw.indexOf(':')
  const provider = split > 0 ? raw.slice(0, split).toLowerCase() : 'claude'
  const requested = split > 0 ? raw.slice(split + 1) : raw
  if (!SAFE_MODEL.test(requested)) throw new Error('model must be a simple provider:model name')
  if (provider === 'claude') {
    const model = ['sonnet', 'opus', 'haiku'].includes(requested) ? requested : 'sonnet'
    return { provider, model, ref: `${provider}:${model}`, runtime: runtimes.find(r => r.id === provider) || null }
  }
  const runtime = runtimes.find(r => r.id === provider)
  if (!runtime || runtime.kind !== 'local' || runtime.roundtable !== true) throw new Error(`runtime ${provider} is not enabled for local roundtables`)
  return { provider, model: requested, ref: `${provider}:${requested}`, runtime }
}

/**
 * Tools and MCP servers are stripped for two independent reasons: cost (the
 * default toolset is ~33k tokens of cache creation per turn) and blast radius
 * (a debater with Edit can rewrite the code it is arguing about).
 */
export function turnArgs(prompt, persona, model, extra = []) {
  return [
    '-p', prompt,
    '--output-format', 'json',
    '--system-prompt', persona,
    '--model', model || 'sonnet',
    '--max-turns', '1',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep',
    'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit',
    ...extra,
  ]
}

/**
 * Models fence JSON, prepend prose, or ignore the schema entirely. None of
 * those are worth failing a paid turn over, so parsing degrades: a turn that
 * yields no JSON still shows up in the UI as plain argument text.
 */
export function parseTurn(text) {
  const raw = String(text ?? '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1].trim() : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const o = JSON.parse(candidate.slice(start, end + 1))
      if (o && typeof o === 'object') {
        return {
          position: str(o.position, 200),
          body: str(o.body ?? o.argument ?? o.text, 2000) || raw.slice(0, 2000),
          confidence: clampConfidence(o.confidence),
          targets: Array.isArray(o.targets) ? o.targets.map(t => String(t).toLowerCase()).slice(0, 4) : [],
          conceded: o.conceded === true,
          parsed: true,
        }
      }
    } catch { /* fall through to the plain-text shape */ }
  }
  return { position: '', body: raw.slice(0, 2000), confidence: null, targets: [], conceded: false, parsed: false }
}

const str = (v, n) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, n))

function clampConfidence(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.round(n)))
}

const SCHEMA = 'Respond with ONLY a JSON object, no prose outside it, no code fence: ' +
  '{"position": "your stance in one sentence, max 160 chars", ' +
  '"confidence": <integer 0-100, how sure you are>, ' +
  '"body": "your argument, max 700 chars, concrete and specific", ' +
  '"targets": ["id of the participant you are pushing back on, if any"], ' +
  '"conceded": <true only if you are abandoning your earlier position>}'

/**
 * One live debate. Owns its child processes so `cancel()` can actually stop
 * spending money mid-phase rather than just hiding the UI.
 */
export class Roundtable {
  constructor(state, opts = {}) {
    const participants = (Array.isArray(opts.participants) ? opts.participants : [])
      .map(String)
      .filter(id => castMember(id) && id !== MODERATOR_ID)
    const unique = [...new Set(participants)].slice(0, MAX_PARTICIPANTS)
    if (unique.length < 2) throw new Error('a roundtable needs at least 2 participants')

    const topic = String(opts.topic || '').trim()
    if (!topic) throw new Error('a roundtable needs a topic')

    this.state = state
    this.id = 'rt' + Date.now().toString(36)
    this.topic = topic.slice(0, MAX_TOPIC)
    this.roomId = opts.roomId || null
    this.roomLabel = opts.roomLabel || opts.roomId || 'the workspace'
    // Grounding the turn in the project directory is deliberate: the project's
    // own CLAUDE.md is loaded as context, so the debate argues about *this*
    // codebase instead of producing generic best-practice mush.
    this.cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir()
    const selection = resolveModelRef(opts.model)
    this.provider = selection.provider
    this.model = selection.model
    this.modelRef = selection.ref
    this.ollamaHost = this.provider === 'ollama' ? loadConfig().ollamaHost : null
    // Only server-side readiness resolution can select API-key mode. This
    // marker is safe to persist and display; the key itself remains solely in
    // the launched process environment.
    this.authMode = this.provider === 'claude' ? (opts.authMode === 'api-key' ? 'api-key' : 'cli') : 'local'
    this.participants = unique
    this.phase = 'idle'
    this.turns = []
    this.costUsd = 0
    this.startedAt = Date.now()
    this.endedAt = null
    this.error = null
    this.cancelled = false
    this.children = new Set()
  }

  /** Number of model calls this debate will make, for the pre-flight estimate. */
  static turnCount(n) { return 1 + n * 3 + 1 }

  snapshot() {
    return {
      id: this.id,
      topic: this.topic,
      roomId: this.roomId,
      roomLabel: this.roomLabel,
      provider: this.provider,
      modelRef: this.modelRef,
      model: this.model,
      authMode: this.authMode,
      participants: this.participants,
      phase: this.phase,
      turns: this.turns,
      costUsd: Math.round(this.costUsd * 10000) / 10000,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      error: this.error,
      cancelled: this.cancelled,
    }
  }

  publish() {
    this.state.broadcast({ type: 'rt.update', debate: this.snapshot() })
  }

  setPhase(phase) {
    this.phase = phase
    this.publish()
  }

  addTurn(turn) {
    this.turns.push(turn)
    this.state.broadcast({ type: 'rt.turn', debateId: this.id, turn })
    this.publish()
  }

  async run() {
    try {
      this.state.event({ kind: 'spawn', text: `roundtable "${this.topic.slice(0, 48)}" opened in ${this.roomLabel}` })

      await this.preflight()
      if (this.cancelled) return this.finish()

      await this.brief()
      if (this.cancelled) return this.finish()

      await this.opening()
      if (this.cancelled) return this.finish()

      await this.clash()
      if (this.cancelled) return this.finish()

      await this.converge()
      if (this.cancelled) return this.finish()

      await this.verdict()
    } catch (e) {
      this.error = String(e?.message || e)
    }
    return this.finish()
  }

  async preflight() {
    if (this.provider !== 'ollama') return
    await new Promise((resolve, reject) => {
      execFile('ollama', ['show', this.model], { cwd: this.cwd, env: this.providerEnv(), timeout: 8_000, maxBuffer: 2e6 }, error => {
        if (this.cancelled) return reject(new Error('cancelled'))
        if (error) return reject(new Error(`Ollama model ${this.model} is unavailable; install it with "ollama pull ${this.model}"`))
        resolve()
      })
    })
  }

  finish() {
    this.endedAt = Date.now()
    this.setPhase(this.cancelled ? 'cancelled' : this.error ? 'failed' : 'done')
    this.persist()
    this.state.event({
      kind: this.error ? 'kill' : 'exit',
      text: `roundtable ${this.id} ${this.cancelled ? 'cancelled' : this.error ? 'failed' : 'concluded'} · $${this.costUsd.toFixed(3)}`,
    })
    return this.snapshot()
  }

  cancel() {
    if (this.endedAt) return
    this.cancelled = true
    for (const child of this.children) {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }
  }

  // ── phases ───────────────────────────────────────────────────────────────

  async brief() {
    this.setPhase('brief')
    const prompt =
      `A team is about to debate this question about the project "${this.roomLabel}":\n\n` +
      `"${this.topic}"\n\n` +
      `Restate the actual decision being made in one sentence, then list the 3 ` +
      `criteria this decision should be judged on. Be specific to this project ` +
      `rather than generic. Do not answer the question yourself.\n\n` + SCHEMA
    await this.turn(MODERATOR_ID, 'brief', prompt)
  }

  /**
   * Parallel and mutually blind. This is the whole reason the debate produces
   * disagreement rather than an echo — see the file header.
   */
  async opening() {
    this.setPhase('opening')
    const brief = this.turnsOf('brief')[0]
    const context = brief ? `The moderator framed it as: ${brief.body}\n\n` : ''
    await Promise.all(this.participants.map(id => {
      const c = castMember(id)
      const prompt =
        `Project: ${this.roomLabel}\n\nQuestion under debate:\n"${this.topic}"\n\n${context}` +
        `Give your opening position as ${c.name}, the ${c.role}. Argue from your ` +
        `own priorities — do not try to be balanced, and do not hedge. Other ` +
        `specialists are answering this separately and will push back on you.\n\n` + SCHEMA
      return this.turn(id, 'opening', prompt)
    }))
  }

  /**
   * Each participant now sees every opening and is required to engage with the
   * strongest one against them. Requiring them to *name* the argument stops the
   * common failure where a model acknowledges disagreement in the abstract and
   * then restates its original position unchanged.
   */
  async clash() {
    this.setPhase('clash')
    const openings = this.turnsOf('opening')
    await Promise.all(this.participants.map(id => {
      const c = castMember(id)
      const others = openings.filter(t => t.speaker !== id)
      if (!others.length) return null
      const board = others.map(t =>
        `[${t.speakerName}, ${t.speakerRole}] position: ${t.position || '(see argument)'}\n${t.body}`
      ).join('\n\n')
      const mine = openings.find(t => t.speaker === id)
      const prompt =
        `Question under debate:\n"${this.topic}"\n\nYour opening position was:\n` +
        `${mine ? mine.position + '\n' + mine.body : '(not recorded)'}\n\n` +
        `The other specialists argued:\n\n${board}\n\n` +
        `As ${c.name}: identify the single strongest argument against your ` +
        `position, name whose it is, and then either rebut it with something ` +
        `concrete or concede it explicitly. Do not restate your opening. If you ` +
        `are conceding, set "conceded" to true and say what you were wrong about.\n\n` +
        `Participant ids you may target: ${this.participants.filter(p => p !== id).join(', ')}\n\n` + SCHEMA
      return this.turn(id, 'clash', prompt)
    }).filter(Boolean))
  }

  async converge() {
    this.setPhase('converge')
    const clashes = this.turnsOf('clash')
    const board = clashes.map(t =>
      `[${t.speakerName}] ${t.conceded ? '(CONCEDED) ' : ''}${t.position || ''}\n${t.body}`
    ).join('\n\n')
    await Promise.all(this.participants.map(id => {
      const c = castMember(id)
      const mine = this.turnsOf('opening').find(t => t.speaker === id)
      const prompt =
        `Question under debate:\n"${this.topic}"\n\nThe cross-examination round produced:\n\n${board}\n\n` +
        `As ${c.name}, state your final position. If it is unchanged from your ` +
        `opening ("${mine?.position || 'n/a'}"), say so and say why the ` +
        `counter-arguments did not move you. If it changed, say exactly what ` +
        `changed it. Set "confidence" honestly — a lower number than your ` +
        `opening is a legitimate and useful outcome.\n\n` + SCHEMA
      return this.turn(id, 'converge', prompt)
    }))
  }

  async verdict() {
    this.setPhase('verdict')
    const finals = this.turnsOf('converge')
    const board = finals.map(t =>
      `[${t.speakerName}, ${t.speakerRole}] confidence ${t.confidence ?? '?'}\nposition: ${t.position}\n${t.body}`
    ).join('\n\n')
    const prompt =
      `Question that was debated:\n"${this.topic}"\n\nFinal positions:\n\n${board}\n\n` +
      `As moderator, write the decision record. State: (1) the recommended ` +
      `decision and the reasoning that actually carried it, (2) the dissent ` +
      `that survived — name who still disagrees and what they would need to see ` +
      `to change their mind, (3) what remains genuinely unknown. If the room ` +
      `did not converge, say that explicitly rather than inventing a consensus. ` +
      `Put the whole record in "body".\n\n` + SCHEMA
    await this.turn(MODERATOR_ID, 'verdict', prompt)
  }

  turnsOf(phase) { return this.turns.filter(t => t.phase === phase && !t.failed) }

  // ── the actual model call ────────────────────────────────────────────────

  async turn(speakerId, phase, prompt) {
    if (this.cancelled) return null
    const c = castMember(speakerId)
    const started = Date.now()

    // The UI shows a character as "speaking" from the moment the process is
    // spawned — a turn can take 30s+ and a silent floor reads as a hang.
    this.state.broadcast({ type: 'rt.speaking', debateId: this.id, speaker: speakerId, phase })

    let res
    try {
      res = await this.exec(this.buildInvocation(prompt, c.prompt))
    } catch (e) {
      const turn = {
        id: `${this.id}-${this.turns.length}`,
        speaker: speakerId, speakerName: c.name, speakerRole: c.role,
        phase, position: '', body: String(e?.message || e), confidence: null,
        targets: [], conceded: false, failed: true, ms: Date.now() - started, ts: Date.now(),
      }
      this.addTurn(turn)
      return turn
    }

    const parsed = parseTurn(res.result)
    if (Number.isFinite(res.costUsd)) this.costUsd += res.costUsd

    const turn = {
      id: `${this.id}-${this.turns.length}`,
      speaker: speakerId,
      speakerName: c.name,
      speakerRole: c.role,
      phase,
      position: parsed.position,
      body: parsed.body,
      confidence: parsed.confidence,
      // Only keep targets that name a real participant — models occasionally
      // invent a speaker, and a dangling edge would draw an arrow to nobody.
      targets: parsed.targets.filter(t => this.participants.includes(t)),
      conceded: parsed.conceded,
      failed: false,
      costUsd: res.costUsd ?? null,
      ms: Date.now() - started,
      ts: Date.now(),
    }
    this.addTurn(turn)
    return turn
  }

  buildInvocation(prompt, persona) {
    // `--bare` is the documented Claude CLI key path. It is added only when
    // server-side readiness verified that a key is already in this process's
    // environment; no client input can inject command arguments.
    if (this.provider === 'claude') return { kind: 'claude', args: turnArgs(prompt, persona, this.model, this.authMode === 'api-key' ? ['--bare'] : []) }

    // Local providers receive the persona and question as data over stdin or a
    // single prompt argument. They never receive shell source, file tools, or
    // credentials, and Ollama is always invoked in non-agent `run` mode.
    const combined = `You are ${persona}\n\n${prompt}`
    if (this.provider === 'ollama') return { kind: 'local', command: 'ollama', args: ['run', this.model], input: combined }
    if (this.provider === 'gemini') return { kind: 'local', command: 'gemini', args: ['--approval-mode', 'plan', '--prompt', combined] }

    const runtime = loadRuntimes().find(r => r.id === this.provider)
    if (!runtime?.command) throw new Error(`runtime ${this.provider} has no executable command`)
    const args = []
    if (runtime.modelFlag) args.push(runtime.modelFlag, this.model)
    if (runtime.promptMode === 'arg') args.push(runtime.promptFlag, combined)
    return { kind: 'local', command: runtime.command, args, input: runtime.promptMode === 'arg' ? null : combined }
  }

  exec(invocation) {
    if (invocation.kind === 'local') return this.execLocal(invocation)
    return new Promise((resolve, reject) => {
      const command = resolveClaudeCommand()
      if (!command) return reject(new Error('Claude Code CLI is unavailable in the Quorum launch environment'))
      const child = execFile(command, invocation.args, {
        cwd: this.cwd,
        timeout: TURN_TIMEOUT_MS,
        maxBuffer: 16e6,
        // A debate turn must not inherit this process's Claude session vars,
        // or the spawned CLI treats itself as a nested session.
        env: this.providerEnv(),
      }, (err, stdout) => {
        this.children.delete(child)
        if (this.cancelled) return reject(new Error('cancelled'))
        if (err && !stdout) return reject(new Error(err.killed ? 'turn timed out' : String(err.message || err)))
        let payload
        try { payload = JSON.parse(stdout) } catch { return reject(new Error('agent returned unparseable output')) }
        if (payload.is_error) return reject(new Error(payload.result || 'agent reported an error'))
        resolve({ result: payload.result, costUsd: payload.total_cost_usd, sessionId: payload.session_id })
      })
      this.children.add(child)
    })
  }

  execLocal({ command, args, input }) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.cwd,
        env: this.providerEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); this.children.delete(child); fn(value) }
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish(reject, new Error('local model turn timed out'))
      }, TURN_TIMEOUT_MS)
      child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 16e6) child.kill('SIGTERM') })
      child.stderr.on('data', chunk => { stderr += String(chunk).slice(-4000) })
      child.once('error', error => finish(reject, new Error(String(error.message || error))))
      child.once('close', (code, signal) => {
        const text = stdout.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '').trim()
        if (this.cancelled) return finish(reject, new Error('cancelled'))
        if (code !== 0 && !text) return finish(reject, new Error(stderr.trim() || `local model exited ${code ?? (signal || 'unknown')}`))
        finish(resolve, { result: text, costUsd: null, sessionId: null })
      })
      this.children.add(child)
      if (input != null) child.stdin.end(`${input}\n`)
      else child.stdin.end()
    })
  }

  providerEnv() {
    const env = strippedEnv()
    if (this.provider === 'ollama' && this.ollamaHost) env.OLLAMA_HOST = this.ollamaHost
    return env
  }

  persist() {
    try {
      fs.mkdirSync(STORE, { recursive: true })
      fs.writeFileSync(path.join(STORE, `${this.id}.json`), JSON.stringify(this.snapshot(), null, 2))
    } catch { /* a debate is still useful in memory if the disk write fails */ }
  }
}

function strippedEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE')) delete env[k]
  return env
}

/**
 * Registry of debates. One live debate per room: two tables arguing the same
 * question in the same project is pure duplicate spend, and the floor has only
 * one seat per character to animate.
 */
export class RoundtableRegistry {
  constructor(state) {
    this.state = state
    this.live = new Map()   // roomId -> Roundtable
    this.recent = []        // finished snapshots, newest first
  }

  start(opts) {
    const key = opts.roomId || '_'
    const existing = this.live.get(key)
    if (existing && !existing.endedAt) throw new Error(`a roundtable is already running in ${existing.roomLabel}`)

    const rt = new Roundtable(this.state, opts)
    this.live.set(key, rt)
    rt.publish()
    rt.run().then(snap => {
      this.live.delete(key)
      this.recent.unshift(snap)
      if (this.recent.length > 20) this.recent.pop()
      this.state.broadcast({ type: 'rt.done', debate: snap })
    })
    return rt
  }

  cancel(id) {
    for (const rt of this.live.values()) if (rt.id === id) return rt.cancel()
  }

  list() {
    return {
      live: [...this.live.values()].map(r => r.snapshot()),
      recent: this.recent.slice(0, 8),
    }
  }

  /**
   * Load debates written by earlier runs so the archive survives a restart.
   * Reads the pre-rename home too — a debate the user paid for should not
   * disappear from the archive because the product changed its name.
   */
  loadArchive() {
    const snaps = []
    const seen = new Set()
    for (const dir of readDirs('roundtables')) {
      let files = []
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')) } catch { continue }
      for (const f of files) {
        try {
          const snap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
          if (snap?.id && !seen.has(snap.id)) { seen.add(snap.id); snaps.push(snap) }
        } catch { /* skip a corrupt record rather than losing the archive */ }
      }
    }
    snaps.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    this.recent = snaps.slice(0, 20)
  }
}
