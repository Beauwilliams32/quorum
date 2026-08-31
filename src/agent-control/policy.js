import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const POLICY_PATH = path.resolve(HERE, '../../config/agent-policy.json')
const HOME = os.homedir()

export function loadPolicy(file = POLICY_PATH) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!raw || ![1, 2].includes(raw.schemaVersion) || !raw.roles || !raw.actions) throw new Error('invalid agent policy schema')
  return raw
}

export function rolePolicy(policy, role) {
  const value = policy.roles?.[role]
  if (!value) throw new Error(`unknown agent role: ${role}`)
  return { role, capabilities: [...new Set(value.capabilities || [])], permissionMode: value.permissionMode || 'plan' }
}

export function actionAllowed(policy, role, action, { target, verified = false } = {}) {
  const r = rolePolicy(policy, role)
  const rule = policy.actions?.[action]
  if (!rule) return { ok: false, reason: `unknown action: ${action}` }
  if (!r.capabilities.includes(rule.capability)) return { ok: false, reason: `role ${role} lacks ${rule.capability}` }
  if (policy.killSwitch?.enabled) return { ok: false, reason: `kill switch enabled${policy.killSwitch.reason ? `: ${policy.killSwitch.reason}` : ''}` }
  if (rule.approval === 'target-record' && (!target || typeof target !== 'object' || !target.account || !target.project)) return { ok: false, reason: 'external action needs an explicit account and project target' }
  if (rule.approval === 'target-record' && target.rollback !== true) return { ok: false, reason: 'external action needs a rollback or abort path' }
  if (rule.approval === 'target-record' && target.audit !== true) return { ok: false, reason: 'external action needs an audit record' }
  return { ok: true, rule, role: r }
}

function globToRegExp(glob) {
  const expanded = glob.replace(/^~/, HOME).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${expanded}$`, 'i')
}

export function isProtectedPath(policy, candidate) {
  const absolute = path.resolve(String(candidate || ''))
  return (policy.protectedPaths || []).some(pattern => {
    const expanded = pattern.replace(/^~/, HOME)
    return globToRegExp(pattern).test(absolute) || (!expanded.includes('*') && (absolute === path.resolve(expanded) || absolute.startsWith(path.resolve(expanded) + path.sep)))
  })
}

export function classifyAction(argv = []) {
  const args = argv.map(value => String(value))
  const command = path.basename(args[0] || '').toLowerCase()
  const joined = args.join(' ').toLowerCase()
  if (command === 'git') {
    if (args[1] === 'commit') return 'git.commit'
    if (args[1] === 'push') return 'git.push'
    if (args[1] === 'merge') return 'git.merge'
    if (args[1] === 'tag') return 'git.tag'
    if (['status', 'diff', 'log', 'show', 'branch', 'worktree'].includes(args[1])) return 'read'
  }
  if (command === 'npm' && (args[1] === 'test' || args[1] === 'run' && /test|check|lint|qa/.test(args[2] || ''))) return 'test'
  if (command === 'npx' && /playwright|wrangler/.test(joined) && /test|check|qa/.test(joined)) return 'test'
  if (/(^|\s)(wrangler|vercel|netlify)\s+(deploy|promote|rollback)/.test(joined)) return 'deploy'
  if (/\b(publish|send|message|email|post|tweet)\b/.test(joined)) return 'external.send'
  if (/\b(migrate|migration)\b/.test(joined) && /remote|prod|production/.test(joined)) return 'migration.remote'
  if (/\b(provider|integration|oauth|webhook|secret|domain)\b/.test(joined) && /set|update|change|rotate|create|delete/.test(joined)) return 'provider.change'
  if (command === 'rm' || /\b(delete|destroy|drop|quarantine|reset --hard|clean -fd)\b/.test(joined)) return 'protected'
  if (['claude', 'codex', 'copilot', 'hermes', 'gemini', 'ollama', 'aider', 'goose', 'opencode'].includes(command)) return 'read'
  return 'edit'
}

export function policySummary(policy) {
  return {
    schemaVersion: policy.schemaVersion,
    roles: Object.fromEntries(Object.entries(policy.roles).map(([role, value]) => [role, { capabilities: value.capabilities, permissionMode: value.permissionMode }])),
    protectedPathCount: policy.protectedPaths?.length || 0,
    lease: policy.lease,
    retries: policy.retries || { maxAttempts: 3, backoffSeconds: [5, 30, 120], noProgressLimit: 3 },
    killSwitch: policy.killSwitch,
    shadowMode: Boolean(policy.guardrails?.shadowMode),
  }
}
