#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = os.homedir()
const args = new Set(process.argv.slice(2))
const argValue = flag => { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : undefined }
const apply = args.has('--apply')
const replace = args.has('--replace')
const targetHome = path.resolve(argValue('--home') || process.env.AGENT_CONTROL_HOME || home)
const backupDir = path.join(targetHome, '.agent-control', 'backups', new Date().toISOString().replaceAll(':', '').replaceAll('.', ''))
const scheduled = path.join(targetHome, '.claude', 'scheduled-tasks', 'workspace-reconciliation', 'SKILL.md')
const claudeSettings = path.join(targetHome, '.claude', 'settings.local.json')
const claudeGlobalSettings = path.join(targetHome, '.claude', 'settings.json')
const claudeSettingsFiles = [claudeSettings, claudeGlobalSettings]
const hermesConfig = path.join(targetHome, '.hermes', 'config.yaml')
const agentBin = path.join(targetHome, '.local', 'bin', 'agent')

const reconciliation = `---
name: workspace-reconciliation
description: Lease-based workspace reconciliation: recover expired agent runs, surface blockers, and preserve ownership
---

Run the daily reconciliation for /Users/beauwilliams/CLAUDE and its repositories using Quorum's agent control plane.

1. Run \`agent doctor --repo /Users/beauwilliams/CLAUDE\` and record runtime, launchd, task, git-root, branch, and worktree evidence.
2. Run \`agent recover\`. Treat only an expired lease plus the configured missed-heartbeat threshold as recovery evidence. File age, directory mtime, transcript age, and stale documentation are not ownership evidence.
3. Inspect \`GET /api/agent-control/runs\` and \`GET /api/agent-control/claims\` when Quorum is available. Report active, stale, recovery-pending, blocked, and pending-approval records by run ID.
4. For each repository, collect fresh \`git status --short --branch\`, actual git root, worktree list, branch, and remote state. Keep clean separation between source readiness and deployment, provider, owner, rights, device, account, and commercial gates.
5. Preserve dirty or claimed work. Do not commit, push, merge, remove worktrees, reset, clean, delete, quarantine, or move anything merely because it is old. A builder may land its own claimed work only when its run capability, project gates, and checkpoint evidence authorize it.
6. Verify launchd paths and scheduled-task paths read-only. Never print credentials, tokens, prompts, transcripts, provider payloads, or auth-file contents.
7. End with changed files, checks actually run, blockers, pending owner/provider actions, exact run IDs, and next owner action. Append the summary to this task's run log without retaining prompts or secrets.

When uncertain, report and leave the state unchanged. Recovery creates a new run ID and preserves the original evidence; it never infers ownership from mtime.
`

function read(file) { return fs.readFileSync(file, 'utf8') }
function backup(file) {
  if (!fs.existsSync(file)) return null
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const backup = path.join(backupDir, path.basename(file))
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink()) fs.writeFileSync(`${backup}.symlink`, fs.readlinkSync(file), { mode: 0o600 })
  else fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
  return backup
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, value, { mode: 0o600 })
  fs.renameSync(temp, file)
}
function replaceYamlScalar(source, key, from, to) {
  const pattern = new RegExp(`^(\\s*${key}:\\s*)${from.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(\\s*)$`, 'm')
  const desired = new RegExp(`^(\\s*${key}:\\s*)${to.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(\\s*)$`, 'm')
  if (desired.test(source)) return source
  if (!pattern.test(source)) throw new Error(`Hermes config did not contain expected ${key}: ${from}`)
  return source.replace(pattern, `$1${to}$2`)
}
function planned() {
  const out = { apply, repo: ROOT, files: [], safety: ['backups are created before writes', 'no secrets or prompts are copied', 'existing agent symlink requires --replace'] }
  for (const file of [...claudeSettingsFiles, hermesConfig, scheduled]) if (fs.existsSync(file)) out.files.push({ file, action: 'update', backup: path.join(backupDir, path.basename(file)) })
  out.files.push({ file: agentBin, action: fs.existsSync(agentBin) ? replace ? 'replace-with-backup' : 'refuse-existing' : 'install' })
  return out
}

if (!apply) { console.log(JSON.stringify(planned(), null, 2)); console.log('No files were written. Re-run with --apply after reviewing this plan.'); process.exit(0) }
if (fs.existsSync(agentBin) && !replace) throw new Error(`${agentBin} exists; use --replace only after reviewing the plan`)

for (const file of [...claudeSettingsFiles, hermesConfig, scheduled, agentBin]) backup(file)
for (const settingsFile of claudeSettingsFiles) if (fs.existsSync(settingsFile)) {
  const settings = JSON.parse(read(settingsFile))
  settings.permissions ||= {}
  if (settings.permissions.defaultMode === 'bypassPermissions') settings.permissions.defaultMode = 'auto'
  delete settings.skipDangerousModePermissionPrompt
  delete settings.skipAutoPermissionPrompt
  if (settings.permissions.skipDangerousModePermissionPrompt !== undefined) delete settings.permissions.skipDangerousModePermissionPrompt
  if (settings.permissions.skipAutoPermissionPrompt !== undefined) delete settings.permissions.skipAutoPermissionPrompt
  write(settingsFile, JSON.stringify(settings, null, 2) + '\n')
}
if (fs.existsSync(hermesConfig)) {
  let yaml = read(hermesConfig)
  for (const [key, from, to] of [
    ['verify_on_stop', 'false', 'true'], ['enabled', 'false', 'true'], ['delete_orphans', 'true', 'false'],
    ['hard_stop_enabled', 'false', 'true'], ['subagent_auto_approve', 'true', 'false'], ['guard_agent_created', 'false', 'true'],
    ['write_approval', 'false', 'true'], ['tirith_fail_open', 'true', 'false'],
  ]) yaml = replaceYamlScalar(yaml, key, from, to)
  write(hermesConfig, yaml)
}
write(scheduled, reconciliation)
fs.mkdirSync(path.dirname(agentBin), { recursive: true })
if (fs.existsSync(agentBin)) fs.unlinkSync(agentBin)
fs.symlinkSync(path.join(ROOT, 'bin', 'agent'), agentBin)
console.log(JSON.stringify({ ok: true, backupDir, installed: agentBin, updated: [...claudeSettingsFiles, hermesConfig, scheduled].filter(fs.existsSync) }, null, 2))
