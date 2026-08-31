#!/usr/bin/env node
// Build a Quorum setup from how this machine is actually used.
//
//   npm run bootstrap           # propose, print a diff, write nothing
//   npm run bootstrap -- --apply  # write ~/.quorum/config.json, then verify
//
// The problem this solves: a new user's floor is technically correct (every
// repo becomes a room) but undifferentiated — twenty equal-looking rooms, no
// labels that mean anything, no idea which agents they actually use. This asks
// a model to read the evidence already on the machine and propose a setup.
//
// ── What is sent to the model, and what is not ──────────────────────────────
// Transcripts are NOT sent. The model receives *derived signal* only: which
// directories sessions ran in and how often, which agent CLIs exist on PATH,
// and the headings of a workspace CLAUDE.md if one exists. That is enough to
// name rooms and rank them, and it means bootstrapping does not ship the
// contents of private conversations to an API call.
//
// ── Why nothing is applied without --apply ──────────────────────────────────
// This writes the file that decides what the product shows. A generated config
// that silently replaced a hand-tuned one would be a data-loss bug wearing a
// feature's clothes. So: propose → validate → diff → confirm → verify.
//
// Every generated field goes through validateConfig() before it is written or
// even printed as acceptable, and --apply re-runs the test suite afterwards.
// Generated configuration and tested configuration are the same thing here.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { validateConfig } from '../src/validate.js'
import { defaultRoots, discoverProjects, CONFIG_PATH } from '../src/config.js'

const HOME = os.homedir()
const APPLY = process.argv.includes('--apply')
const MODEL = argOf('--model') || 'sonnet'

function argOf(flag) {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null
}

const say = s => process.stderr.write(`\x1b[38;5;214m${s}\x1b[0m\n`)
const info = s => process.stderr.write(`  ${s}\n`)

// ── evidence ────────────────────────────────────────────────────────────────

/** How often sessions have run in each directory — the usage signal. */
function cwdFrequency() {
  const dir = path.join(HOME, '.claude', 'projects')
  const counts = new Map()
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return counts }

  for (const e of entries) {
    // Claude Code encodes the cwd in the directory name with '-' for '/'.
    const decoded = '/' + e.replace(/^-/, '').replace(/-/g, '/')
    let n = 0
    try { n = fs.readdirSync(path.join(dir, e)).filter(f => f.endsWith('.jsonl')).length } catch { continue }
    if (n) counts.set(decoded, (counts.get(decoded) || 0) + n)
  }
  return counts
}

/** Which agent CLIs this machine actually has. */
function availableRuntimes() {
  const candidates = ['claude', 'codex', 'hermes', 'gemini', 'aider', 'goose', 'opencode', 'cursor-agent', 'copilot', 'amp', 'crush']
  const found = []
  for (const c of candidates) {
    try {
      execFileSync('command', ['-v', c], { shell: '/bin/zsh', stdio: 'ignore' })
      found.push(c)
    } catch { /* not installed */ }
  }
  return found
}

/** Headings of a workspace CLAUDE.md — the superproject's own vocabulary. */
function workspaceContext(roots) {
  for (const root of roots) {
    const f = path.join(root, 'CLAUDE.md')
    try {
      const text = fs.readFileSync(f, 'utf8')
      const heads = text.split('\n').filter(l => /^#{1,3} /.test(l)).slice(0, 40)
      // Table rows in the project tables carry the real labels ("Trident NIL").
      const rows = text.split('\n').filter(l => /^\|\s*\*?\*?[A-Za-z]/.test(l) && l.includes('|')).slice(0, 40)
      return { file: f, headings: heads, rows }
    } catch { /* no CLAUDE.md at this root */ }
  }
  return null
}

function gather() {
  const roots = defaultRoots()
  const discovered = discoverProjects(roots)
  const freq = cwdFrequency()

  // Rank discovered projects by how much work has actually happened in them.
  const ranked = discovered.map(p => {
    let hits = 0
    for (const [cwd, n] of freq) if (cwd === p.pathPrefix || cwd.startsWith(p.pathPrefix + '/')) hits += n
    return { id: p.id, path: p.pathPrefix, sessions: hits }
  }).sort((a, b) => b.sessions - a.sessions)

  return {
    roots,
    projects: ranked,
    runtimes: availableRuntimes(),
    workspace: workspaceContext(roots),
    totalSessions: [...freq.values()].reduce((a, b) => a + b, 0),
  }
}

// ── the proposal ────────────────────────────────────────────────────────────

const SCHEMA = `Respond with ONLY a JSON object, no prose and no code fence:
{
  "projects": [{"id":"short-slug","label":"Human Readable Name","path":"/absolute/path"}],
  "hidden": ["ids of discovered rooms not worth showing"],
  "runtimes": [{"id":"gemini","label":"gemini","command":"gemini"}],
  "models": ["any extra model names to offer in the roundtable"],
  "notes": "one paragraph: what you inferred about how this machine is used"
}
Rules: only use paths from the evidence. Label projects the way the workspace
documentation names them, not by folder name. Put low-activity or scratch
directories in "hidden". Only list runtimes from the detected list. Omit any
key you have nothing useful to say about.`

function buildPrompt(ev) {
  const top = ev.projects.slice(0, 30)
    .map(p => `  ${p.path}  (${p.sessions} sessions)`).join('\n')
  const ws = ev.workspace
    ? `Workspace documentation at ${ev.workspace.file}:\n${ev.workspace.headings.join('\n')}\n\nProject table rows:\n${ev.workspace.rows.join('\n')}`
    : 'No workspace CLAUDE.md found.'

  return `You are configuring Quorum, a local cockpit that shows each software project as a "room" and runs debates between AI specialists about that project.

Configure it for THIS machine, from the evidence below.

Scan roots: ${ev.roots.join(', ')}

Discovered project directories, ranked by how many AI sessions have run in each:
${top || '  (none)'}

Agent CLIs installed: ${ev.runtimes.join(', ') || '(none detected)'}

${ws}

Give the most-used projects clear labels drawn from the workspace documentation
where it names them. Hide directories that are clearly scratch, archive or
vendor. Include the installed agent CLIs as runtimes so they get launch buttons.

${SCHEMA}`
}

function ask(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--model', MODEL,
      '--max-turns', '1',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands',
      '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit',
    ]
    const env = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE')) delete env[k]

    execFile('claude', args, { timeout: 180_000, maxBuffer: 16e6, env }, (err, stdout) => {
      if (err && !stdout) return reject(new Error(err.killed ? 'timed out' : String(err.message || err)))
      let payload
      try { payload = JSON.parse(stdout) } catch { return reject(new Error('unparseable CLI output')) }
      if (payload.is_error) return reject(new Error(payload.result || 'the model reported an error'))
      resolve(payload)
    })
  })
}

function parseProposal(text) {
  const raw = String(text || '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1].trim() : raw
  const a = candidate.indexOf('{'), b = candidate.lastIndexOf('}')
  if (a === -1 || b <= a) throw new Error('no JSON object in the response')
  return JSON.parse(candidate.slice(a, b + 1))
}

// ── run ─────────────────────────────────────────────────────────────────────

const ev = gather()
say('Quorum bootstrap')
info(`${ev.projects.length} candidate projects · ${ev.totalSessions} past sessions · runtimes: ${ev.runtimes.join(', ') || 'none'}`)
if (!ev.projects.length) {
  info('No projects found to reason about. Set "roots" in ~/.quorum/config.json first.')
  process.exit(1)
}
info(`asking ${MODEL} to propose a setup (one turn, ~$0.05–0.15)…`)

let proposal
try {
  const res = await ask(buildPrompt(ev))
  proposal = parseProposal(res.result)
  if (Number.isFinite(res.total_cost_usd)) info(`cost $${res.total_cost_usd.toFixed(3)}`)
} catch (e) {
  say(`Bootstrap failed: ${e.message}`)
  info('Nothing was written. Your existing config is untouched.')
  process.exit(1)
}

const notes = typeof proposal.notes === 'string' ? proposal.notes : null
delete proposal.notes

// The gate: a generated config is validated exactly like a hand-written one.
const { ok, value, errors } = validateConfig(proposal)
if (!ok) {
  say('The proposal did not validate — nothing written.')
  for (const e of errors) info(`✗ ${e}`)
  process.exit(1)
}
// Discovery already handles roots; a generated config should refine, not
// re-specify, so roots are only carried through if the model had a reason.
if (!value.roots) value.roots = ev.roots.map(r => r.replace(HOME, '~'))

say('\nProposed configuration')
if (notes) info(`note: ${notes}\n`)
process.stdout.write(JSON.stringify(value, null, 2) + '\n')

let current = null
try { current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { /* none yet */ }
if (current) {
  say('\nThis would REPLACE your existing config')
  info(`current: ${(current.projects || []).length} projects, ${(current.runtimes || []).length} runtimes`)
  info(`proposed: ${(value.projects || []).length} projects, ${(value.runtimes || []).length} runtimes`)
}

if (!APPLY) {
  say('\nDry run — nothing written.')
  info('Re-run with --apply to write it:  npm run bootstrap -- --apply')
  process.exit(0)
}

// Applying: back up first. Overwriting a hand-tuned config with no way back
// would be the single worst thing this script could do.
if (current) {
  const backup = CONFIG_PATH.replace(/\.json$/, `.backup-${Date.now()}.json`)
  fs.copyFileSync(CONFIG_PATH, backup)
  info(`backed up existing config → ${backup}`)
}
fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
fs.writeFileSync(CONFIG_PATH, JSON.stringify(value, null, 2) + '\n')
say(`\nWrote ${CONFIG_PATH}`)

// An auto-adjustment that isn't verified is just an unreviewed commit. Re-read
// the file through the same loader the server uses, then run the suite.
try {
  const reread = validateConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')))
  if (!reread.ok) throw new Error(reread.errors.join('; '))
  info('re-read and validated from disk')
} catch (e) {
  say(`Written file failed re-validation: ${e.message}`)
  process.exit(1)
}

say('Verifying the build')
try {
  execFileSync('npm', ['test'], { cwd: path.join(import.meta.dirname, '..'), stdio: 'ignore' })
  info('test suite passed')
} catch {
  info('test suite reported failures — run `npm test` to see them')
  process.exit(1)
}

say('\nDone. Restart Quorum (or wait 30s) to see the new floor.')
