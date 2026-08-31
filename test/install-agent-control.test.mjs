import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `scripts/install-agent-control.mjs` is the one shipped script with no
// coverage: it rewrites Claude settings, flips eight Hermes safety scalars and
// symlinks the `agent` CLI into ~/.local/bin. Every case below drives it with
// `--home <tempdir>`, so it never touches the real home directory.

const root = new URL('..', import.meta.url).pathname
const script = join(root, 'scripts', 'install-agent-control.mjs')

// Every key the installer rewrites must already be present at its "from" value,
// otherwise the script refuses the file rather than guessing at Hermes config.
const HERMES_FIXTURE = [
  'verify_on_stop: false',
  'enabled: false',
  'delete_orphans: true',
  'hard_stop_enabled: false',
  'subagent_auto_approve: true',
  'guard_agent_created: false',
  'write_approval: false',
  'tirith_fail_open: true',
  '',
].join('\n')

function home({ hermes = false, settings = null, agent = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-agent-control-home-'))
  if (hermes) {
    mkdirSync(join(dir, '.hermes'), { recursive: true })
    writeFileSync(join(dir, '.hermes', 'config.yaml'), HERMES_FIXTURE)
  }
  if (settings) {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(settings, null, 2))
  }
  if (agent) {
    mkdirSync(join(dir, '.local', 'bin'), { recursive: true })
    writeFileSync(join(dir, '.local', 'bin', 'agent'), agent)
  }
  return dir
}

function run(dir, ...extra) {
  return execFileSync(process.execPath, [script, '--home', dir, ...extra], { encoding: 'utf8' })
}

test('the default run is a dry run that plans the writes and performs none', () => {
  const dir = home({ hermes: true, settings: { permissions: {} } })
  const output = run(dir)
  const plan = JSON.parse(output.slice(output.indexOf('{'), output.indexOf('\nNo files were written')))

  assert.equal(plan.apply, false)
  assert.match(output, /No files were written/)
  // The plan names the agent install and the safety contract it operates under.
  assert.equal(plan.files.at(-1).action, 'install')
  assert.match(plan.files.at(-1).file, /\.local\/bin\/agent$/)
  assert.ok(plan.safety.some(note => /backups are created before writes/.test(note)))
  assert.ok(plan.safety.some(note => /no secrets or prompts are copied/.test(note)))
  // Nothing on disk moved.
  assert.equal(existsSync(join(dir, '.local', 'bin', 'agent')), false)
  assert.equal(existsSync(join(dir, '.claude', 'scheduled-tasks')), false)
  assert.equal(readFileSync(join(dir, '.hermes', 'config.yaml'), 'utf8'), HERMES_FIXTURE)
})

test('--apply links the agent CLI at the repo and installs the reconciliation task', () => {
  const dir = home()
  const result = JSON.parse(run(dir, '--apply'))
  const link = join(dir, '.local', 'bin', 'agent')

  assert.equal(result.ok, true)
  assert.equal(result.installed, link)
  // A symlink to the repo, not a copy — so the CLI tracks the checkout.
  assert.equal(lstatSync(link).isSymbolicLink(), true)
  assert.equal(readlinkSync(link), join(root, 'bin', 'agent'))

  const task = readFileSync(join(dir, '.claude', 'scheduled-tasks', 'workspace-reconciliation', 'SKILL.md'), 'utf8')
  assert.match(task, /name: workspace-reconciliation/)
  // The reconciliation contract must keep the no-delete and lease-evidence rules.
  assert.match(task, /agent recover/)
  assert.match(task, /File age, directory mtime, transcript age, and stale documentation are not ownership evidence/)
  assert.match(task, /Do not commit, push, merge, remove worktrees, reset, clean, delete, quarantine, or move anything merely because it is old/)
  assert.match(task, /Never print credentials, tokens, prompts, transcripts, provider payloads, or auth-file contents/)
})

test('an existing agent binary is refused unless --replace is given, and is backed up when it is', () => {
  const dir = home({ agent: '#!/bin/sh\necho original\n' })

  assert.throws(() => run(dir, '--apply'), /exists; use --replace only after reviewing the plan/)
  // The refusal left the operator's own binary untouched.
  assert.equal(readFileSync(join(dir, '.local', 'bin', 'agent'), 'utf8'), '#!/bin/sh\necho original\n')

  run(dir, '--apply', '--replace')
  assert.equal(lstatSync(join(dir, '.local', 'bin', 'agent')).isSymbolicLink(), true)
  // Nothing is destroyed: the replaced binary survives in a timestamped backup.
  const backups = readdirSync(join(dir, '.agent-control', 'backups'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(dir, '.agent-control', 'backups', backups[0], 'agent'), 'utf8'), '#!/bin/sh\necho original\n')
})

test('--apply downgrades bypassPermissions and strips the prompt-skipping escape hatches', () => {
  const dir = home({
    settings: {
      permissions: { defaultMode: 'bypassPermissions', skipDangerousModePermissionPrompt: true },
      skipDangerousModePermissionPrompt: true,
      skipAutoPermissionPrompt: true,
      keepMe: 'untouched',
    },
  })
  run(dir, '--apply')
  const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'))

  assert.equal(settings.permissions.defaultMode, 'auto')
  assert.equal(settings.permissions.skipDangerousModePermissionPrompt, undefined)
  assert.equal(settings.skipDangerousModePermissionPrompt, undefined)
  assert.equal(settings.skipAutoPermissionPrompt, undefined)
  // Unrelated operator settings are preserved rather than rewritten wholesale.
  assert.equal(settings.keepMe, 'untouched')
})

test('--apply flips every Hermes guard to its safe value', () => {
  const dir = home({ hermes: true })
  run(dir, '--apply')
  const yaml = readFileSync(join(dir, '.hermes', 'config.yaml'), 'utf8')

  for (const line of ['verify_on_stop: true', 'enabled: true', 'delete_orphans: false', 'hard_stop_enabled: true',
    'subagent_auto_approve: false', 'guard_agent_created: true', 'write_approval: true', 'tirith_fail_open: false']) {
    assert.ok(yaml.includes(line), `expected ${line}`)
  }
})

test('a Hermes config missing an expected guard is refused instead of guessed at', () => {
  const dir = home()
  mkdirSync(join(dir, '.hermes'), { recursive: true })
  writeFileSync(join(dir, '.hermes', 'config.yaml'), 'verify_on_stop: false\n')
  assert.throws(() => run(dir, '--apply'), /Hermes config did not contain expected/)
})

test('re-applying over a previous install is idempotent', () => {
  const dir = home({ hermes: true, settings: { permissions: { defaultMode: 'bypassPermissions' } } })
  run(dir, '--apply')
  const firstYaml = readFileSync(join(dir, '.hermes', 'config.yaml'), 'utf8')
  const firstSettings = readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8')

  // The second pass must not trip the "already at the safe value" branch.
  run(dir, '--apply', '--replace')
  assert.equal(readFileSync(join(dir, '.hermes', 'config.yaml'), 'utf8'), firstYaml)
  assert.equal(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'), firstSettings)
  assert.equal(readlinkSync(join(dir, '.local', 'bin', 'agent')), join(root, 'bin', 'agent'))
})
