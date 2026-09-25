// Terminal rendering for Quorum HQ — the `quorum` CLI and the `quorum top`
// dashboard. Pure functions: an HQ snapshot in, lines of text out. Colour is
// ANSI and optional (off when stdout is not a TTY or NO_COLOR is set), so the
// same frame a person watches is the frame a test reads.

const ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m' }
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const PRESENCE_WORD = { working: 'working', waiting: 'needs you', queued: 'queued', idle: 'idle', paused: 'paused', offline: 'terminated' }
const PRESENCE_COLOR = { working: 'cyan', waiting: 'yellow', queued: 'blue', idle: 'green', paused: 'gray', offline: 'dim' }
const STATUS_COLOR = { in_progress: 'cyan', todo: 'blue', blocked: 'red', done: 'green', backlog: 'gray', cancelled: 'dim' }
const STATUS_WORD = { in_progress: 'in progress', todo: 'to do', blocked: 'blocked', done: 'done', backlog: 'backlog', cancelled: 'cancelled' }

export function painter(enabled) {
  const paint = (style, text) => enabled && ANSI[style] ? `${ANSI[style]}${text}${ANSI.reset}` : String(text)
  return new Proxy({}, { get: (_, style) => text => paint(style, text) })
}

export const visibleLength = text => [...String(text).replace(ANSI_PATTERN, '')].length

/** Pad or cut to exactly `width` visible columns, keeping colour codes intact. */
export function fit(text, width) {
  const value = String(text)
  if (width <= 0) return ''
  const length = visibleLength(value)
  if (length <= width) return value + ' '.repeat(width - length)
  let out = ''
  let seen = 0
  for (const part of value.split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[/.test(part)) { out += part; continue }
    for (const ch of part) {
      if (seen >= width - 1) break
      out += ch
      seen += 1
    }
  }
  return `${out}…${value.includes('\x1b[') ? ANSI.reset : ''}`
}

export const money = value => `$${Number(value || 0).toFixed(2)}`
const clock = iso => { const at = new Date(iso); return Number.isFinite(at.getTime()) ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '--:--' }

// Stored text is data, never terminal instructions. C0 and C1 controls (ESC,
// BEL, the 8-bit CSI, DEL…) are dropped before anything reaches a terminal,
// so a message, a name or a room label cannot move the cursor, retitle the
// window, write the clipboard (OSC 52) or forge a line of output. Tab and
// newline survive; this module's own colour codes are added after.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
export const safe = text => String(text ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '')

/** Every string in a parsed API response, made safe to print. */
export function safeDeep(value) {
  if (typeof value === 'string') return safe(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(safeDeep)
  const out = {}
  for (const [key, item] of Object.entries(value)) out[safe(key)] = safeDeep(item)
  return out
}

const oneLine = (text, max = 400) => { const value = safe(text).replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value }

/** A local date and time, for anything that can be days old. */
const stampOf = value => {
  const at = new Date(value)
  return Number.isFinite(at.getTime()) ? `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${clock(at.toISOString())}` : '--'
}

export function bar(pct, width, c, state = 'ok') {
  const filled = Math.max(0, Math.min(width, Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)))
  const tone = state === 'over' ? 'red' : state === 'warn' ? 'yellow' : state === 'uncapped' ? 'gray' : 'green'
  return c[tone]('█'.repeat(filled)) + c.gray('░'.repeat(width - filled))
}

export function presenceText(agent, c, tick = 0) {
  const state = agent.presence?.state || 'idle'
  const mark = state === 'working' ? SPINNER[tick % SPINNER.length] : state === 'waiting' ? '◆' : state === 'paused' ? '‖' : state === 'offline' ? '×' : '●'
  const extra = state === 'working' ? ` ${agent.presence.ticketId}${agent.presence.phase ? ` · ${agent.presence.phase}` : ''}` : state === 'waiting' && agent.presence.ticketId ? ` ${agent.presence.ticketId}` : state === 'paused' && agent.pausedReason === 'budget' ? ' (budget)' : ''
  return c[PRESENCE_COLOR[state] || 'green'](`${mark} ${PRESENCE_WORD[state] || state}${extra}`)
}

export const statusText = (status, c) => c[STATUS_COLOR[status] || 'gray'](STATUS_WORD[status] || status)

function budgetText(budget) {
  if (!budget) return ''
  const unpriced = budget.unpricedRuns ? ` +${budget.unpricedRuns} unpriced` : ''
  return budget.state === 'uncapped' ? `${money(budget.spentUsd)} no cap${unpriced}` : `${money(budget.spentUsd)}/${money(budget.limitUsd)}${unpriced}`
}

/** The org chart as a tree under the board. */
export function formatOrg(hq, { c = painter(false), tick = 0 } = {}) {
  hq = safeDeep(hq)
  const agents = (hq.agents || []).filter(agent => agent.status !== 'terminated')
  const ids = new Set(agents.map(agent => agent.id))
  const children = id => agents.filter(agent => (id === null ? !agent.reportsTo || !ids.has(agent.reportsTo) : agent.reportsTo === id)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  const lines = [`${c.bold('The board')} ${c.gray('(you — approvals, budgets, hiring)')}`]
  const walk = (id, prefix) => {
    const list = children(id)
    list.forEach((agent, index) => {
      const last = index === list.length - 1
      const note = agent.dispatchable === false ? c.yellow(' [not dispatchable here]') : ''
      lines.push(`${c.gray(prefix + (last ? '└─ ' : '├─ '))}${c.bold(agent.name)} ${c.gray('·')} ${agent.title} ${c.gray('·')} ${c.magenta(agent.runtime)} ${c.gray('·')} ${presenceText(agent, c, tick)} ${c.gray('·')} ${budgetText(agent.budget)}${note}`)
      walk(agent.id, prefix + (last ? '   ' : '│  '))
    })
  }
  walk(null, '')
  if (lines.length === 1) lines.push(c.gray('   nobody reports to you yet — quorum hire <name> --title <title>'))
  return lines
}

export function formatTeam(hq, { c = painter(false), tick = 0 } = {}) {
  hq = safeDeep(hq)
  const agents = (hq.agents || []).filter(agent => agent.status !== 'terminated').sort((a, b) => a.name.localeCompare(b.name))
  if (!agents.length) return [c.gray('No agents yet. quorum hire <name> --title <title> [--runtime claude|codex]')]
  const header = `${fit(c.gray('ID'), 10)} ${fit(c.gray('NAME'), 10)} ${fit(c.gray('TITLE'), 20)} ${fit(c.gray('HARNESS'), 16)} ${fit(c.gray('STATUS'), 24)} ${fit(c.gray('MONTH'), 26)} ${c.gray('HEARTBEAT')}`
  return [header, ...agents.map(agent => [
    fit(agent.id, 10), fit(c.bold(agent.name), 10), fit(agent.title, 20), fit(c.magenta(agent.modelRef || agent.runtime), 16),
    fit(presenceText(agent, c, tick), 24),
    fit(`${bar(agent.budget?.pct || 0, 8, c, agent.budget?.state)} ${budgetText(agent.budget)}`, 26),
    agent.heartbeat?.enabled ? `every ${agent.heartbeat.everyMinutes}m` : c.gray('off'),
  ].join(' '))]
}

export function formatTickets(tickets, hq, { c = painter(false) } = {}) {
  tickets = safeDeep(tickets); hq = safeDeep(hq)
  if (!tickets.length) return [c.gray('No tickets.')]
  const names = new Map((hq.agents || []).map(agent => [agent.id, agent.name]))
  return tickets.map(ticket => `${fit(c.bold(ticket.id), 7)} ${fit(statusText(ticket.status, c), 12)} ${fit(ticket.assigneeId ? `@${ticket.assigneeId}` : c.gray('unassigned'), 12)} ${fit(ticket.priority === 'normal' ? '' : c[ticket.priority === 'urgent' ? 'red' : ticket.priority === 'high' ? 'yellow' : 'gray'](ticket.priority), 7)} ${oneLine(ticket.title, 120)}${ticket.blockedBy?.length ? c.gray(`  waits on ${ticket.blockedBy.join(', ')}`) : ''}${ticket.verified ? c.green('  ✓ verified') : ''}${ticket.checkout ? c.cyan(`  ▶ ${names.get(ticket.checkout.agentId) || ticket.checkout.agentId}`) : ''}`)
}

/** Word-wrap to `width` columns. A word longer than a line is split, never dropped. */
export function wrap(text, width) {
  const lines = []
  let line = ''
  for (const word of String(text).split(' ')) {
    if (!line) line = word
    else if (visibleLength(line) + 1 + visibleLength(word) <= width) line += ` ${word}`
    else { lines.push(line); line = word }
    while (visibleLength(line) > width) { lines.push(line.slice(0, width)); line = line.slice(width) }
  }
  if (line || !lines.length) lines.push(line)
  return lines
}

function authorName(message, hq) {
  if (message.author?.kind === 'board') return 'You'
  if (message.author?.kind === 'agent') return (hq.agents || []).find(agent => agent.id === message.author.id)?.name || message.author.id
  return 'Quorum'
}

export function formatMessages(messages, hq, { c = painter(false), width = 100 } = {}) {
  messages = safeDeep(messages); hq = safeDeep(hq)
  if (!messages.length) return [c.gray('No messages yet.')]
  const lines = []
  for (const message of messages) {
    const who = authorName(message, hq)
    const tone = message.author?.kind === 'board' ? 'cyan' : message.author?.kind === 'agent' ? 'magenta' : 'gray'
    const thread = message.threadId && message.card?.type !== 'ticket' ? `[${message.threadId}] ` : ''
    // Only an approval still waiting gets the command to answer it.
    const pending = message.card?.type === 'approval' && (hq.approvals || []).some(item => item.id === message.card.approvalId && item.status === 'pending')
    const text = `${thread}${oneLine(message.text, 2000)}${pending ? ` → quorum approve ${message.card.approvalId}` : ''}`
    const head = `${c.gray(clock(message.at))} ${fit(c[tone](c.bold(who)), 8)} `
    wrap(text, Math.max(20, width - 16)).forEach((chunk, index) => lines.push(`${index === 0 ? head : ' '.repeat(15)}${chunk}`))
  }
  return lines
}

export function formatTicketDetail(detail, hq, { c = painter(false), width = 100 } = {}) {
  detail = safeDeep(detail); hq = safeDeep(hq)
  const ticket = detail.ticket
  const verify = ticket.verifyCommand ? [ticket.verifyCommand.command, ...(ticket.verifyCommand.args || [])].join(' ') : null
  return [
    `${c.bold(ticket.id)}  ${statusText(ticket.status, c)}  ${ticket.priority}${ticket.verified ? c.green('  ✓ verified by the evidence gate') : ''}`,
    c.bold(oneLine(ticket.title, 200)),
    ticket.body && ticket.body !== ticket.title ? oneLine(ticket.body, 1200) : null,
    `${c.gray('assignee')} ${ticket.assigneeId ? `@${ticket.assigneeId}` : 'nobody'}   ${c.gray('goal')} ${ticket.goalId || '—'}   ${c.gray('channel')} #${ticket.channelId}${ticket.branch ? `   ${c.gray('branch')} ${ticket.branch}` : ''}`,
    ticket.blockedBy?.length ? `${c.gray('waits on')} ${ticket.blockedBy.join(', ')}` : null,
    verify ? `${c.gray('verified by')} ${verify}` : null,
    ...(ticket.runs || []).map(run => `${c.gray(`run #${run.attempt}`)} ${run.runtime} ${run.status} ${run.costUsd !== null && run.costUsd !== undefined ? money(run.costUsd) : run.finishedAt ? 'unpriced' : '…'} ${c.gray(run.runId || '')}`),
    '',
    c.gray('THREAD'),
    ...formatMessages(detail.thread || [], hq, { c, width }),
  ].filter(line => line !== null)
}

export function formatBudget(budgets, { c = painter(false) } = {}) {
  budgets = safeDeep(budgets)
  const lines = [`${c.bold('Month')} ${budgets.month} (UTC)   ${c.bold(money(budgets.total.spentUsd))} recorded of ${money(budgets.total.limitUsd)} in caps${budgets.total.unpricedRuns ? c.yellow(`   ${budgets.total.unpricedRuns} run(s) reported no price and are not counted`) : ''}`]
  for (const agent of budgets.agents) lines.push(`${fit(c.bold(agent.name), 10)} ${bar(agent.budget.pct, 20, c, agent.budget.state)} ${fit(budgetText(agent.budget), 26)} ${agent.status === 'paused' ? c.gray('paused') : ''}`)
  if (budgets.dailyCeiling?.reason) lines.push('', `${c.gray('daily cloud ceiling')} ${budgets.dailyCeiling.reason}`)
  lines.push(c.gray('A run is priced when it exits, so one run can carry an agent past its cap before the next is refused.'))
  return lines
}

export function formatInbox(hq, { c = painter(false) } = {}) {
  hq = safeDeep(hq)
  const pending = (hq.approvals || []).filter(item => item.status === 'pending')
  const blocked = (hq.tickets || []).filter(ticket => ticket.status === 'blocked')
  const paused = (hq.agents || []).filter(agent => agent.status === 'paused')
  const lines = [c.bold(`APPROVALS (${pending.length})`)]
  if (!pending.length) lines.push(c.gray('  nothing is waiting on you'))
  for (const approval of pending) {
    lines.push(`  ${c.yellow(approval.id)} ${oneLine(approval.summary, 300)}`)
    // A hire's brief goes into every run the hire makes: it is shown whole.
    const brief = approval.kind === 'hire' ? String(approval.proposal?.instructions || '') : ''
    if (brief) {
      lines.push(c.gray(`       brief (${brief.length} chars):`))
      for (const paragraph of brief.split('\n')) for (const line of wrap(paragraph, 88)) lines.push(`         ${line}`)
    }
    lines.push(c.gray(`       quorum approve ${approval.id}   ·   quorum deny ${approval.id} [reason]`))
  }
  lines.push('', c.bold(`BLOCKED (${blocked.length})`))
  if (!blocked.length) lines.push(c.gray('  none'))
  for (const ticket of blocked) lines.push(`  ${c.red(ticket.id)} ${oneLine(ticket.title, 120)}  ${c.gray(`quorum ticket show ${ticket.id}`)}`)
  if (paused.length) {
    lines.push('', c.bold(`PAUSED (${paused.length})`))
    for (const agent of paused) lines.push(`  ${agent.name} ${c.gray(agent.pausedReason === 'budget' ? '— monthly budget reached' : '— paused by the board')}  ${c.gray(`quorum resume ${agent.id}`)}`)
  }
  return lines
}

export function formatActivity(entries, { c = painter(false) } = {}) {
  entries = safeDeep(entries)
  return entries.map(entry => `${c.gray(`#${String(entry.seq).padEnd(4)}`)} ${c.gray(clock(entry.at))} ${fit(entry.actor?.kind === 'agent' ? c.magenta(entry.actor.id) : entry.actor?.kind === 'board' ? c.cyan('board') : c.gray('system'), 8)} ${fit(c.bold(entry.action), 22)} ${entry.target || ''} ${c.gray(oneLine(entry.detail, 100))}`)
}

export function formatOverview(hq, { c = painter(false), width = 100, tick = 0 } = {}) {
  hq = safeDeep(hq)
  const t = hq.totals || {}
  const general = (hq.messages || []).filter(message => message.channelId === 'general').slice(-6)
  return [
    `${c.cyan(c.bold('QUORUM HQ'))}  ${c.bold(hq.company.name)}`,
    hq.company.mission ? c.gray(hq.company.mission) : null,
    '',
    `  ${t.agents} agents · ${c.cyan(`${t.working} working`)} · ${t.waiting ? c.yellow(`${t.waiting} need you`) : '0 need you'} · ${t.openTickets} open tickets · ${money(t.spentUsd)} of ${money(t.limitUsd)} this month (${t.month})${t.unpricedRuns ? c.yellow(` · ${t.unpricedRuns} unpriced`) : ''}`,
    '',
    c.bold('TEAM'),
    ...formatOrg(hq, { c, tick }).map(line => `  ${line}`),
    '',
    ...formatInbox(hq, { c }).slice(0, 8),
    '',
    c.bold('#general'),
    ...formatMessages(general, hq, { c, width: width - 2 }).map(line => `  ${line}`),
  ].filter(line => line !== null)
}

/**
 * One frame of `quorum top`: exactly `height` lines of exactly `width`
 * columns. Left: the org chart with live presence and budget bars. Right:
 * the inbox and the ticket board. Bottom: the #general stream. Everything on
 * it is read from the snapshot — the spinner turns only for a live run.
 */
export function renderTopFrame(rawHq, rawHealth = null, { width = 100, height = 32, tick = 0, color = false, now = Date.now(), channel = 'general' } = {}) {
  const hq = rawHq ? safeDeep(rawHq) : rawHq
  const health = rawHealth ? safeDeep(rawHealth) : rawHealth
  const c = painter(color)
  const w = Math.max(60, width)
  const h = Math.max(16, height)
  const rule = c.gray('─'.repeat(w))
  const stamp = new Date(now).toTimeString().slice(0, 8)
  const cockpit = health ? (health.readiness?.cockpit === 'ready' ? c.green('● cockpit ready') : c.yellow(`● cockpit ${health.status || 'degraded'}`)) : c.red('● cockpit unreachable')
  const title = `${c.cyan(c.bold(' QUORUM HQ '))} ${hq?.ready ? c.bold(hq.company.name) : c.gray('not founded yet')}`
  const header = fit(`${title}${' '.repeat(Math.max(1, w - visibleLength(title) - visibleLength(cockpit) - 12))}${cockpit}  ${c.gray(stamp)}`, w)
  if (!hq) {
    const body = ['', `  ${c.red('Cannot reach the Quorum cockpit.')}`, '', `  ${c.bold('quorum start')} ${c.gray('then run quorum top again — this screen retries on its own')}`]
    return [header, rule, ...body, ...Array(Math.max(0, h - body.length - 3)).fill(''), c.gray(' q quit')].slice(0, h).map(line => fit(line, w)).join('\n')
  }
  if (!hq.ready) {
    const body = ['', '  HQ is not set up on this cockpit yet.', '', `  ${c.bold('quorum hq init "Acme" --mission "What the company is for" [--template studio|solo|blank] [--room <id>]')}`, '', c.gray('  or open the HQ view in the dashboard: quorum dashboard')]
    return [header, rule, ...body, ...Array(Math.max(0, h - body.length - 3)).fill(''), c.gray(' q quit')].slice(0, h).map(line => fit(line, w)).join('\n')
  }
  const t = hq.totals || {}
  const pulse = fit(`  ${c.bold(t.agents)} agents   ${c.cyan(c.bold(t.working))} working   ${(t.waiting ? c.yellow : c.gray)(`${t.waiting} need you`)}   ${c.bold(t.openTickets)} open tickets   ${c.bold(money(t.spentUsd))}${c.gray(`/${money(t.limitUsd)}`)} ${c.gray(t.month)}${t.unpricedRuns ? c.yellow(`  +${t.unpricedRuns} unpriced`) : ''}`, w)

  const leftWidth = Math.floor(w * 0.56)
  const rightWidth = w - leftWidth - 3
  const left = [c.bold('TEAM'), ...formatOrg(hq, { c, tick })]
  const pending = (hq.approvals || []).filter(item => item.status === 'pending')
  const byStatus = status => (hq.tickets || []).filter(ticket => ticket.status === status)
  const right = [
    c.bold(`INBOX ${pending.length ? c.yellow(`(${pending.length})`) : c.gray('(0)')}`),
    ...(pending.length ? pending.slice(0, 4).map(item => `${c.yellow(item.id)} ${oneLine(item.summary, 200)}`) : [c.gray('nothing waits on you')]),
    '',
    c.bold('TICKETS'),
    `${statusText('in_progress', c)} ${byStatus('in_progress').length}  ${statusText('todo', c)} ${byStatus('todo').length}  ${statusText('blocked', c)} ${byStatus('blocked').length}  ${statusText('done', c)} ${byStatus('done').length}`,
    ...[...byStatus('in_progress'), ...byStatus('blocked'), ...byStatus('todo')].slice(0, 8).map(ticket => `${c.bold(ticket.id)} ${statusText(ticket.status, c)} ${ticket.assigneeId ? c.magenta(`@${ticket.assigneeId}`) : ''} ${oneLine(ticket.title, 200)}`),
  ]
  const topRows = Math.max(left.length, right.length)
  const bodyRows = Math.min(topRows, Math.max(6, Math.floor((h - 8) * 0.6)))
  const columns = []
  for (let i = 0; i < bodyRows; i += 1) columns.push(`${fit(left[i] || '', leftWidth)} ${c.gray('│')} ${fit(right[i] || '', rightWidth)}`)

  const feedRows = Math.max(3, h - 3 - 2 - bodyRows - 2 - 1)
  const stream = formatMessages((hq.messages || []).filter(message => message.channelId === channel), hq, { c, width: w - 2 }).slice(-feedRows)
  const lines = [
    header, pulse, rule,
    ...columns,
    rule,
    fit(`${c.bold(`#${channel}`)} ${c.gray('— quorum say "#' + channel + '" "@agent …" hands out work')}`, w),
    ...stream,
  ]
  while (lines.length < h - 1) lines.push('')
  lines.length = h - 1
  lines.push(c.gray(fit(` q quit · r refresh · refreshed every few seconds from the same /api/hq the dashboard uses`, w)))
  return lines.map(line => fit(line, w)).join('\n')
}

/** Routines: what recurs, for whom, how often, and what it last opened. */
export function formatRoutines(routines, { c = painter(false) } = {}) {
  routines = safeDeep(routines)
  if (!routines?.length) return [c.gray('No routines yet — quorum routine add "<title>" --assign <agent> --every 1d')]
  const state = routine => routine.status === 'active' ? c.green('active') : routine.status === 'paused' ? c.yellow('paused') : c.gray(routine.status)
  return routines.map(routine => `${fit(c.bold(routine.id), 6)} ${fit(state(routine), 8)} ${fit(`every ${routine.every}`, 10)} ${fit(`@${routine.assigneeId}`, 12)} ${oneLine(routine.title, 80)}` +
    (routine.status === 'active' ? c.gray(`  next ${stampOf(routine.nextAt)}`) : routine.pausedReason && routine.pausedReason !== 'board' ? c.gray(`  (${routine.pausedReason})`) : '') +
    (routine.lastTicketId ? c.gray(`  last ${routine.lastTicketId} ${routine.lastTicketStatus || ''}`) : ''))
}

/** Search results: matching tickets, then matching messages with where and when they were said. */
export function formatSearch(result, hq = {}, { c = painter(false), width = 100 } = {}) {
  result = safeDeep(result); hq = safeDeep(hq)
  const names = new Map((hq?.agents || []).map(agent => [agent.id, agent.name]))
  const lines = []
  if (result.note) lines.push(c.gray(result.note))
  if (result.tickets?.length) {
    lines.push(c.bold(`TICKETS (${result.tickets.length})`))
    for (const ticket of result.tickets) lines.push(`  ${fit(c.bold(ticket.id), 7)} ${fit(statusText(ticket.status, c), 12)} ${fit(ticket.assigneeId ? `@${ticket.assigneeId}` : c.gray('unassigned'), 12)} ${oneLine(ticket.title, 100)}`)
    lines.push('')
  }
  const messages = result.messages || []
  lines.push(c.bold(`MESSAGES (${messages.length}${result.scanned ? ` · ${result.scanned} searched` : ''})`))
  if (!messages.length) lines.push(c.gray('  nothing matched'))
  for (const message of messages) {
    const who = message.author?.kind === 'board' ? 'You' : message.author?.kind === 'agent' ? names.get(message.author.id) || message.author.id : 'Quorum'
    lines.push(`  ${c.gray(`#${message.channelId}`)} ${c.gray(stampOf(message.at))} ${c.bold(who)}: ${oneLine(message.text, Math.max(40, width - 34))}${message.threadId ? c.gray(`  (${message.threadId})`) : ''}`)
  }
  return lines
}
