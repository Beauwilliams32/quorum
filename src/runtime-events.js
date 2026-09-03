const MAX_TEXT = 900
const PRIVATE_KEY = /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi
const SECRET_ASSIGNMENT = /((?:["']?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|authorization|cookie|token|secret|private[-_ ]?key)["']?\s*[:=]\s*))(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
export const redactRuntimeText = value => normalize(value)
  .replace(PRIVATE_KEY, '[redacted-private-key]')
  .replace(/bearer\s+[a-z0-9._~+/=-]+/gi, 'bearer [redacted]')
  .replace(/\b(?:sk|gh[pousr]|github_pat|xox[baprs]|AIza|AKIA|ASIA)[a-z0-9_:-]{8,}\b/gi, '[redacted-secret]')
  .replace(SECRET_ASSIGNMENT, '$1[redacted-secret]')

const clean = redactRuntimeText
const redact = redactRuntimeText

function textFromContent(content) {
  if (typeof content === 'string') return clean(content)
  if (!Array.isArray(content)) return ''
  return clean(content.map(item => item?.text || item?.thinking || '').filter(Boolean).join(' '))
}

export function parseRuntimeLine(runtime, line) {
  const raw = String(line || '').trim()
  if (!raw) return null
  let item
  try { item = JSON.parse(raw) } catch { return { type: 'output', text: redact(raw) } }
  if (!item || typeof item !== 'object') return null

  if (runtime === 'claude') {
    const sessionId = item.session_id || item.sessionId || item.message?.session_id || null
    if (item.type === 'system') return { type: 'started', sessionId, phase: clean(item.subtype || 'started'), text: redact(item.message) }
    if (item.type === 'assistant') return { type: 'assistant', sessionId, text: redact(textFromContent(item.message?.content || item.content)) }
    if (item.type === 'tool_use' || item.type === 'tool_result') return { type: 'tool', sessionId, phase: clean(item.type), text: redact(textFromContent(item.content || item.message?.content)) }
    if (item.type === 'result') return { type: item.is_error ? 'failed' : 'completed', sessionId, phase: clean(item.subtype || 'result'), text: redact(item.result || item.message) }
    return { type: 'event', sessionId, phase: clean(item.subtype || item.type), text: redact(textFromContent(item.message || item.content || item.result)) }
  }

  if (runtime === 'codex') {
    const sessionId = item.thread_id || item.session_id || item.threadId || item.payload?.thread_id || null
    const payload = item.payload || item
    if (item.type === 'thread.started' || payload.type === 'task_started') return { type: 'started', sessionId, phase: clean(item.type || payload.type), text: '' }
    if (item.type === 'item.completed' || payload.type === 'agent_message') {
      const value = item.item || payload
      return { type: value.type === 'agent_message' ? 'assistant' : 'tool', sessionId, phase: clean(value.type), text: redact(value.text || value.message || value.command || value.output) }
    }
    if (item.type === 'turn.completed' || payload.type === 'task_complete') return { type: 'completed', sessionId, phase: clean(item.type || payload.type), text: redact(payload.last_agent_message) }
    if (item.type === 'error' || payload.type === 'error') return { type: 'failed', sessionId, phase: 'error', text: redact(item.message || payload.message || item.error) }
    return { type: 'event', sessionId, phase: clean(item.type || payload.type), text: redact(item.message || payload.message || payload.command) }
  }

  return { type: 'output', text: redact(item.message || item.text || item.result || raw) }
}

export function createLineParser(runtime, onEvent) {
  let buffer = ''
  return {
    push(chunk) {
      buffer += String(chunk || '')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        const event = parseRuntimeLine(runtime, line)
        if (event) onEvent(event)
      }
    },
    flush() {
      const event = parseRuntimeLine(runtime, buffer)
      buffer = ''
      if (event) onEvent(event)
    },
  }
}

export function closeoutText({ missionTitle = '', taskTitle = '', status = '', runtime = '', providerSessionId = '', changedFiles = [], checks = [], blocker = '' } = {}) {
  const lines = [
    `Quorum mission: ${clean(missionTitle) || 'untitled'}`,
    `Task: ${clean(taskTitle) || 'untitled'}`,
    `Status: ${clean(status) || 'unknown'}`,
    `Runtime: ${clean(runtime) || 'unknown'}`,
    providerSessionId ? `Provider session: ${clean(providerSessionId)}` : '',
    changedFiles.length ? `Changed files: ${changedFiles.map(clean).filter(Boolean).join(', ')}` : '',
    checks.length ? `Checks: ${checks.map(clean).filter(Boolean).join(', ')}` : '',
    blocker ? `Blocker: ${clean(blocker)}` : '',
  ]
  return lines.filter(Boolean).join('\n').slice(0, 4_000)
}
