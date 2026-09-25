/* Quorum HQ in the browser — the company and the room.
 *
 * Left: the company, the inbox, channels, and the team with live presence.
 * Centre: a channel. @mention an agent to hand them work; their pickup, their
 * own report and the evidence card land in the same stream.
 * Right: the org chart, the ticket board, goals, budgets, the audit log — or
 * whatever was clicked: an agent's profile, a ticket's thread.
 *
 * Everything shown is read from the `hq` state key the server publishes; every
 * change goes through /api/hq, the same API the CLI uses. The builders below
 * are pure (state in, markup out) so test/hq-render.test.mjs runs them against
 * stub state. Presence, budgets and statuses are what the server measured —
 * this file never invents a "working" or a "done".
 */
'use strict'

import { drawCharacter, drawMascot } from './art.js'

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const clip = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text }

export const PRESENCE = { working: 'working', waiting: 'needs you', queued: 'queued', idle: 'idle', paused: 'paused', offline: 'terminated' }
export const STATUS = { backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' }
const BOARD_COLUMNS = ['in_progress', 'todo', 'blocked', 'backlog', 'done']
const PANELS = [['org', 'Org'], ['tickets', 'Tickets'], ['goals', 'Goals'], ['budget', 'Budget'], ['activity', 'Log']]

export const money = value => `$${Number(value || 0).toFixed(2)}`

export function clock(iso) {
  const at = new Date(iso)
  return Number.isFinite(at.getTime()) ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : ''
}

function dayLabel(iso, now = Date.now()) {
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return ''
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const diff = Math.round((start.getTime() - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export const agentMap = hq => new Map((hq?.agents || []).map(agent => [agent.id, agent]))
const ticketMap = hq => new Map((hq?.tickets || []).map(ticket => [ticket.id, ticket]))

// ── identity art ──────────────────────────────────────────────────────────

function member(agent) {
  return { name: agent.name, role: agent.title, palette: agent.avatar.palette, visor: agent.avatar.visor, crest: agent.avatar.crest, prop: agent.avatar.prop }
}

/** An agent's pet, framed by a presence ring whose colour and motion come from what the server measured. */
export function avatarHtml(agent, size = 32) {
  if (!agent?.avatar) return ''
  const state = agent.presence?.state || 'idle'
  const art = drawCharacter(member(agent), { size: Math.round(size * 0.82), state: state === 'working' ? 'busy' : 'idle' })
  return `<span class="hq-avatar presence-${esc(state)}" style="--avatar-size:${size}px" data-presence="${esc(state)}" title="${esc(agent.name)} · ${esc(PRESENCE[state] || state)}">${art}<i class="hq-presence-dot" aria-hidden="true"></i></span>`
}

export function boardAvatar(size = 32) {
  return `<span class="hq-avatar hq-avatar-board" style="--avatar-size:${size}px" title="You — the board" aria-label="you, the board">you</span>`
}

export function systemAvatar(size = 32, mascot = null) {
  const art = mascot?.palette ? drawMascot(mascot) : '<b>Q</b>'
  return `<span class="hq-avatar hq-avatar-system" style="--avatar-size:${size}px" title="Quorum" aria-label="Quorum">${art}</span>`
}

/** A budget as a ring: the arc is the share of the monthly cap already recorded. */
export function budgetRing(budget, size = 28) {
  const state = budget?.state || 'ok'
  const pct = state === 'uncapped' ? 0 : Math.max(0, Math.min(100, Number(budget?.pct) || 0))
  const label = !budget ? 'no budget data' : state === 'uncapped' ? `${money(budget.spentUsd)} this month, no cap` : `${money(budget.spentUsd)} of ${money(budget.limitUsd)} this month`
  return `<svg class="hq-ring state-${esc(state)}${pct === 0 ? ' is-empty' : ''}" viewBox="0 0 36 36" width="${size}" height="${size}" role="img" aria-label="${esc(label)}"><title>${esc(label)}${budget?.unpricedRuns ? ` · ${budget.unpricedRuns} unpriced run(s) not counted` : ''}</title>` +
    `<circle class="hq-ring-track" cx="18" cy="18" r="15.9155"/><circle class="hq-ring-arc" cx="18" cy="18" r="15.9155" pathLength="100" stroke-dasharray="${pct} 100" transform="rotate(-90 18 18)"/></svg>`
}

// ── text ──────────────────────────────────────────────────────────────────

/**
 * Message text as markup. Everything is escaped first; the only markup added
 * afterwards is ours: code, bold, line breaks, and buttons for @agents and
 * ticket references the company actually has.
 */
export function formatText(text, known = new Set(), tickets = new Set()) {
  const inline = part => {
    let html = esc(part)
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>')
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    html = html.replace(/(^|[^\w@&])@([a-z][\w-]{0,31})/gi, (match, before, handle) => known.has(handle.toLowerCase()) ? `${before}<button type="button" class="hq-mention" data-hq-agent="${handle.toLowerCase()}">@${handle}</button>` : match)
    html = html.replace(/\bT-(\d{1,6})\b/g, (match, n) => tickets.has(`T-${n}`) ? `<button type="button" class="hq-ref" data-hq-ticket="T-${n}">T-${n}</button>` : match)
    return html.replace(/\n/g, '<br>')
  }
  return String(text ?? '').split('```').map((part, i) => i % 2 ? `<pre class="hq-code">${esc(part.replace(/^[\w-]*\n/, ''))}</pre>` : inline(part)).join('')
}

// ── cards ─────────────────────────────────────────────────────────────────

const statusPill = status => `<span class="hq-status status-${esc(status)}">${esc(STATUS[status] || status)}</span>`

/**
 * What a hire proposal would hire, in full, wherever it can be approved. The
 * brief goes into every run the hire makes, so the board reads all of it.
 */
export function proposalHtml(approval) {
  const proposal = approval?.kind === 'hire' && approval.status === 'pending' ? approval.proposal : null
  if (!proposal) return ''
  const brief = String(proposal.instructions || '')
  return `<div class="hq-proposal"><span>${esc(proposal.packId)} pack · ${esc(proposal.runtime)} · ${esc(proposal.modelRef)} · ${money(proposal.budget?.monthlyUsd)}/mo · ${esc(proposal.roomId || 'no room')}</span>` +
    (brief ? `<details><summary>Brief · ${brief.length} chars</summary><pre class="hq-brief">${esc(brief)}</pre></details>` : '<span>No brief.</span>') + `</div>`
}

function approvalButtons(approval) {
  if (!approval || approval.status !== 'pending') return approval ? `<span class="hq-resolved status-${esc(approval.status)}">${esc(approval.status)}${approval.reason ? ` — ${esc(clip(approval.reason, 120))}` : ''}</span>` : ''
  return `<span class="hq-approval-actions"><button type="button" class="hq-btn primary" data-hq-approve="${esc(approval.id)}">Approve</button><button type="button" class="hq-btn" data-hq-deny="${esc(approval.id)}">Deny</button></span>`
}

/**
 * Whether a card already says everything its message's text says. Only then is
 * a system message's text left out — a verdict, a denial, a budget warning or a
 * hire keeps its words.
 */
export function cardRestatesText(card) {
  if (!card) return false
  if (card.type === 'ticket') return card.event === 'opened'
  if (card.type === 'run') return card.event === 'finished'
  if (card.type === 'convene') return card.event !== 'verdict'
  return false
}

export function cardHtml(message, hq, ctx = {}) {
  const card = message.card
  if (!card) return ''
  const agents = agentMap(hq)
  const tickets = ticketMap(hq)
  if (card.type === 'ticket') {
    const ticket = tickets.get(card.ticketId)
    if (!ticket) return ''
    const assignee = ticket.assigneeId ? agents.get(ticket.assigneeId) : null
    const pending = (hq.approvals || []).find(item => item.ticketId === ticket.id && item.status === 'pending')
    const replies = (hq.messages || []).filter(item => item.threadId === ticket.id && item.id !== message.id).length
    return `<div class="hq-card hq-card-ticket" data-hq-ticket="${esc(ticket.id)}" role="button" tabindex="0">` +
      `<div class="hq-card-row"><span class="hq-ticket-id">${esc(ticket.id)}</span><b class="hq-card-title">${esc(ticket.title)}</b>${statusPill(ticket.status)}</div>` +
      `<div class="hq-card-meta">${assignee ? `${avatarHtml(assignee, 18)}<span>${esc(assignee.name)}</span>` : '<span>unassigned</span>'}<span class="hq-dot-sep">·</span><span class="priority-${esc(ticket.priority)}">${esc(ticket.priority)}</span>${ticket.verified ? '<span class="hq-verified" title="the evidence gate passed">verified</span>' : ''}${replies ? `<span class="hq-dot-sep">·</span><span>${replies} in thread</span>` : ''}</div>` +
      (pending ? `<div class="hq-card-waiting"><span class="hq-card-kicker">waiting on you</span><button type="button" class="hq-ref" data-hq-panel="inbox">${esc(pending.id)}</button></div>` : '') +
      `</div>`
  }
  if (card.type === 'approval') {
    const approval = (hq.approvals || []).find(item => item.id === card.approvalId)
    // An approval old enough to have left the snapshot shows no state rather than a guessed one.
    return `<div class="hq-card hq-card-approval kind-${esc(card.kind)}"><span class="hq-card-kicker">${card.kind === 'hire' ? 'hire proposal' : 'asks to start'} · ${esc(card.approvalId)}</span>${proposalHtml(approval)}${approval ? approvalButtons(approval) : ''}</div>`
  }
  if (card.type === 'run') {
    if (card.event === 'started') return `<div class="hq-card hq-card-run started"><span class="hq-card-kicker">run started · ${esc(card.runtime || '')}</span><code>${esc(card.runId || '')}</code></div>`
    const checks = Array.isArray(card.checks) ? card.checks : []
    return `<div class="hq-card hq-card-run finished status-${esc(card.ticketStatus)}"><div class="hq-card-row">${statusPill(card.ticketStatus)}<span>${card.costUsd !== null && card.costUsd !== undefined ? money(card.costUsd) : 'cost not reported'}${card.unpriced ? ` · ${card.unpriced} unpriced` : ''}</span></div>` +
      (card.error ? `<div class="hq-card-error">${esc(card.error)}</div>` : '') +
      (checks.length ? `<details class="hq-checks"><summary>${checks.length} check${checks.length === 1 ? '' : 's'}</summary><ul>${checks.map(check => `<li>${esc(check)}</li>`).join('')}</ul></details>` : '') + `</div>`
  }
  if (card.type === 'agent' && card.event === 'hired') {
    const agent = agents.get(card.agentId)
    if (!agent) return ''
    return `<button type="button" class="hq-card hq-card-agent" data-hq-agent="${esc(agent.id)}">${avatarHtml(agent, 34)}<span class="hq-row-copy"><b>${esc(agent.name)}</b><small>${esc(agent.title)} · <span class="hq-runtime runtime-${esc(agent.runtime)}">${esc(agent.runtime)}</span></small></span></button>`
  }
  if (card.type === 'budget') return `<div class="hq-card hq-card-budget">${budgetRing(agents.get(card.agentId)?.budget, 22)}<span>budget ${esc(card.event === 'warn' ? 'warning' : 'reached')}</span></div>`
  if (card.type === 'convene') {
    const names = (card.participants || []).map(id => ctx.cast?.get?.(id)?.name || id).join(', ')
    if (card.event === 'proposed') {
      return `<div class="hq-card hq-card-convene"><span class="hq-card-kicker">roundtable proposed</span><b class="hq-card-title">${esc(card.question)}</b>` +
        `<div class="hq-card-meta"><span>${esc(names)}</span><span class="hq-dot-sep">·</span><span>${Number(card.turns) || 0} turns</span><span class="hq-dot-sep">·</span><span>${card.local ? 'local, no API cost' : `est. ~${money(card.estimateUsd)}`}</span>${card.available === false ? '<span class="hq-warn-text">model unavailable</span>' : ''}</div>` +
        `<button type="button" class="hq-btn primary" data-hq-convene="${esc(message.id)}"${card.available === false ? ' disabled' : ''}>Convene</button></div>`
    }
    if (card.event === 'started') return `<div class="hq-card hq-card-convene live"><span class="hq-card-kicker">roundtable in session</span><b class="hq-card-title">${esc(card.question)}</b><button type="button" class="hq-btn" data-hq-view="table">Watch</button></div>`
    return `<blockquote class="hq-card hq-card-verdict"><span class="hq-card-kicker">verdict · ${esc(names)} · ${money(card.costUsd)}</span><a class="hq-btn" href="/api/roundtable/${encodeURIComponent(card.debateId)}.md">decision record</a></blockquote>`
  }
  return ''
}

// ── the stream ────────────────────────────────────────────────────────────

function authorOf(message, hq) {
  const author = message.author || {}
  if (author.kind === 'agent') {
    const agent = agentMap(hq).get(author.id)
    return { key: `agent:${author.id}`, name: agent?.name || author.id, title: agent?.title || 'agent', agent }
  }
  if (author.kind === 'board') return { key: 'board', name: 'You', title: 'the board' }
  return { key: 'system', name: 'Quorum', title: 'system' }
}

export function channelMessages(hq, channelId) {
  return (hq?.messages || []).filter(message => message.channelId === channelId).sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

export function messagesHtml(hq, ui, ctx = {}) {
  const list = channelMessages(hq, ui.channel)
  if (!list.length) return `<div class="hq-empty">No messages in #${esc(ui.channel)} yet. @mention an agent to hand them work — they reply here.</div>`
  const known = new Set((hq.agents || []).filter(agent => agent.status !== 'terminated').map(agent => agent.id))
  const tickets = new Set((hq.tickets || []).map(ticket => ticket.id))
  let html = ''
  let previous = null
  let previousDay = ''
  for (const message of list) {
    const today = dayLabel(message.at)
    if (today !== previousDay) { html += `<div class="hq-day"><span>${esc(today)}</span></div>`; previousDay = today; previous = null }
    const who = authorOf(message, hq)
    const grouped = previous && previous.key === who.key && !message.card && !previous.card && Date.parse(message.at) - Date.parse(previous.at) < 5 * 60_000
    const avatar = who.agent ? avatarHtml(who.agent, 34) : who.key === 'board' ? boardAvatar(34) : systemAvatar(34, ctx.mascot)
    const thread = message.threadId && tickets.has(message.threadId) && message.card?.type !== 'ticket' ? `<button type="button" class="hq-thread-chip" data-hq-ticket="${esc(message.threadId)}">${esc(message.threadId)}</button>` : ''
    const level = message.card?.type === 'notice' ? ` level-${esc(message.card.level || 'info')}` : ''
    const text = who.key === 'system' && cardRestatesText(message.card) ? '' : formatText(message.text, known, tickets)
    html += `<article class="hq-msg${grouped ? ' grouped' : ''} author-${esc(who.key.split(':')[0])}${level}" data-message="${esc(message.id)}">` +
      (grouped ? `<time class="hq-msg-time-inline" datetime="${esc(message.at)}">${esc(clock(message.at))}</time>` : `<div class="hq-msg-avatar"${who.agent ? ` data-hq-agent="${esc(who.agent.id)}"` : ''}>${avatar}</div>`) +
      `<div class="hq-msg-body">` +
      (grouped ? '' : `<header class="hq-msg-head"><b${who.agent ? ` data-hq-agent="${esc(who.agent.id)}"` : ''}>${esc(who.name)}</b><span class="hq-msg-title">${esc(who.title)}</span><time datetime="${esc(message.at)}" title="${esc(new Date(message.at).toLocaleString())}">${esc(clock(message.at))}</time>${message.signed ? '<span class="hq-signed" title="signed by the author’s key — quorum hq verify checks it">signed</span>' : ''}${thread}</header>`) +
      (text ? `<div class="hq-msg-text">${text}</div>` : '') +
      cardHtml(message, hq, ctx) +
      `</div></article>`
    previous = { key: who.key, at: message.at, card: message.card }
  }
  return html
}

/** Who is working on something in this channel right now — from live run state, never guessed. */
export function typingHtml(hq, ui) {
  const tickets = ticketMap(hq)
  const working = (hq?.agents || []).filter(agent => agent.presence?.state === 'working' && tickets.get(agent.presence.ticketId)?.channelId === ui.channel)
  if (!working.length) return ''
  return working.map(agent => `<span class="hq-typing-item">${avatarHtml(agent, 18)}<b>${esc(agent.name)}</b> is working on <button type="button" class="hq-ref" data-hq-ticket="${esc(agent.presence.ticketId)}">${esc(agent.presence.ticketId)}</button><span class="hq-phase">${esc(clip(agent.presence.phase || 'starting', 40))}</span><span class="hq-dots" aria-hidden="true"><i></i><i></i><i></i></span></span>`).join('')
}

// ── chrome ────────────────────────────────────────────────────────────────

export function sidebarHtml(hq, ui) {
  const channels = (hq.channels || []).filter(channel => channel.kind !== 'dm')
  const tickets = ticketMap(hq)
  const busy = new Set((hq.agents || []).filter(agent => agent.presence?.state === 'working').map(agent => tickets.get(agent.presence.ticketId)?.channelId))
  const pending = hq.totals?.pendingApprovals || 0
  const team = (hq.agents || []).filter(agent => agent.status !== 'terminated').sort((a, b) => a.name.localeCompare(b.name))
  const icon = channel => channel.kind === 'branch' ? '⎇' : channel.kind === 'goal' ? '◎' : '#'
  return `<div class="hq-company"><span class="eyebrow">HQ</span><b>${esc(hq.company?.name)}</b>${hq.company?.mission ? `<p>${esc(clip(hq.company.mission, 140))}</p>` : ''}</div>` +
    `<button type="button" class="hq-nav${ui.panel === 'inbox' ? ' on' : ''}" data-hq-panel="inbox"><span>Inbox</span>${pending ? `<span class="hq-count attention">${pending}</span>` : '<span class="hq-count">0</span>'}</button>` +
    `<div class="hq-section-head"><span>Channels</span><button type="button" class="hq-icon-btn" data-hq-action="new-channel" title="New channel" aria-label="New channel">+</button></div>` +
    channels.map(channel => `<button type="button" class="hq-channel${ui.channel === channel.id ? ' on' : ''}" data-hq-channel="${esc(channel.id)}"><span class="hq-channel-icon">${icon(channel)}</span><span class="hq-channel-name">${esc(channel.name)}</span>${busy.has(channel.id) ? '<i class="hq-live-dot" title="an agent is working here"></i>' : ''}</button>`).join('') +
    `<div class="hq-section-head"><span>Team</span><button type="button" class="hq-icon-btn" data-hq-action="hire" title="Hire an agent" aria-label="Hire an agent">+</button></div>` +
    team.map(agent => `<button type="button" class="hq-member${ui.channel === `dm-${agent.id}` ? ' on' : ''}" data-hq-dm="${esc(agent.id)}">${avatarHtml(agent, 26)}<span class="hq-member-copy"><b>${esc(agent.name)}</b><small>${agent.presence?.state === 'working' ? `on ${esc(agent.presence.ticketId)}` : esc(PRESENCE[agent.presence?.state] || agent.presence?.state || '')}</small></span></button>`).join('') +
    (team.length ? '' : '<p class="hq-hint">No one on the team yet. Hire your first agent with +.</p>')
}

export function channelHeadHtml(hq, ui) {
  const channel = (hq.channels || []).find(item => item.id === ui.channel)
  if (!channel) return ''
  const agent = channel.kind === 'dm' ? agentMap(hq).get(channel.agentId) : null
  const rooms = new Map((hq.rooms || []).map(room => [room.id, room]))
  const bind = [
    channel.roomId ? `<span class="hq-chip" title="work handed out here runs in this project">▣ ${esc(rooms.get(channel.roomId)?.label || channel.roomId)}</span>` : '',
    channel.branch ? `<span class="hq-chip branch" title="branch room">⎇ ${esc(channel.branch)}</span>` : '',
  ].join('')
  return `<div class="hq-channel-title">${agent ? avatarHtml(agent, 28) : `<span class="hq-channel-hash">${channel.kind === 'branch' ? '⎇' : '#'}</span>`}<div><h2>${esc(agent ? agent.name : channel.name)}</h2><p>${esc(agent ? `${agent.title} · ${PRESENCE[agent.presence?.state] || ''}` : channel.topic || '')}</p></div></div>` +
    `<div class="hq-channel-tools">${bind}${agent ? `<button type="button" class="hq-btn" data-hq-agent="${esc(agent.id)}">Profile</button>` : ''}<button type="button" class="hq-btn" data-hq-action="compose" data-text="/convene " title="Ask a roundtable to argue it out here">Convene</button></div>`
}

export function pulseHtml(hq) {
  const t = hq.totals || {}
  const stat = (value, label, cls = '') => `<span class="hq-stat ${cls}"><b>${value}</b><small>${label}</small></span>`
  return stat(t.agents || 0, 'agents') +
    stat(t.working || 0, 'working', t.working ? 'live' : '') +
    stat(t.waiting || 0, 'need you', t.waiting ? 'attention' : '') +
    stat(t.openTickets || 0, 'open tickets') +
    stat(`${money(t.spentUsd)}<span class="hq-of">/${money(t.limitUsd)}</span>`, `${esc(t.month || '')} spend${t.unpricedRuns ? ` · ${t.unpricedRuns} unpriced` : ''}`, t.limitUsd && t.spentUsd >= t.limitUsd ? 'attention' : '')
}

export function tabsHtml(ui) {
  const contextual = ui.panel === 'agent' ? 'Agent' : ui.panel === 'ticket' ? ui.ticketId || 'Ticket' : ui.panel === 'inbox' ? 'Inbox' : ui.panel === 'hire' ? 'Hire' : ui.panel === 'search' ? 'Search' : ''
  return PANELS.map(([id, label]) => `<button type="button" role="tab" aria-selected="${ui.panel === id}" class="${ui.panel === id ? 'on' : ''}" data-hq-panel="${id}">${label}</button>`).join('') +
    (contextual ? `<button type="button" role="tab" aria-selected="true" class="on contextual">${esc(contextual)}</button>` : '')
}

// ── panels ────────────────────────────────────────────────────────────────

function orgNode(node, agents) {
  const agent = agents.get(node.id) || node
  return `<li><button type="button" class="hq-org-node presence-${esc(agent.presence?.state || 'idle')}" data-hq-agent="${esc(agent.id)}">${avatarHtml(agent, 40)}<span class="hq-org-copy"><b>${esc(agent.name)}</b><small>${esc(agent.title)}</small><span class="hq-org-meta"><span class="hq-runtime runtime-${esc(agent.runtime)}">${esc(agent.runtime)}</span>${agent.dispatchable ? '' : '<span class="hq-warn-text" title="this harness cannot take HQ work here">not dispatchable</span>'}</span></span>${budgetRing(agent.budget, 26)}</button>` +
    (node.children?.length ? `<ul>${node.children.map(child => orgNode(child, agents)).join('')}</ul>` : '') + '</li>'
}

/** The org chart, built from reportsTo; the board is the root. */
export function orgHtml(hq) {
  const agents = agentMap(hq)
  const live = (hq.agents || []).filter(agent => agent.status !== 'terminated')
  const byManager = new Map()
  for (const agent of live) {
    const manager = agent.reportsTo && agents.get(agent.reportsTo)?.status !== 'terminated' ? agent.reportsTo : null
    if (!byManager.has(manager)) byManager.set(manager, [])
    byManager.get(manager).push(agent)
  }
  const build = id => (byManager.get(id) || []).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(agent => ({ id: agent.id, children: build(agent.id) }))
  const roots = build(null)
  return `<div class="hq-org"><div class="hq-org-board">${boardAvatar(30)}<span><b>The board</b><small>you — approvals, budgets, hiring</small></span></div>` +
    (roots.length ? `<ul class="hq-org-tree">${roots.map(node => orgNode(node, agents)).join('')}</ul>` : '<p class="hq-hint">Nobody reports to you yet.</p>') + '</div>'
}

export function ticketsHtml(hq) {
  const agents = agentMap(hq)
  const all = hq.tickets || []
  return `<div class="hq-board">${BOARD_COLUMNS.map(status => {
    const list = all.filter(ticket => ticket.status === status).slice(0, status === 'done' ? 8 : 40)
    return `<section class="hq-col status-${status}"><h3>${esc(STATUS[status])}<span>${all.filter(ticket => ticket.status === status).length}</span></h3>` +
      (list.length ? list.map(ticket => {
        const assignee = ticket.assigneeId ? agents.get(ticket.assigneeId) : null
        return `<button type="button" class="hq-ticket" data-hq-ticket="${esc(ticket.id)}"><span class="hq-ticket-id">${esc(ticket.id)}</span><span class="hq-ticket-title">${esc(clip(ticket.title, 90))}</span><span class="hq-ticket-meta">${assignee ? avatarHtml(assignee, 18) : ''}<i class="priority-dot priority-${esc(ticket.priority)}" title="${esc(ticket.priority)} priority"></i>${ticket.blockedBy?.length ? `<small>waits on ${esc(ticket.blockedBy.join(', '))}</small>` : ''}</span></button>`
      }).join('') : '<p class="hq-hint">—</p>') + '</section>'
  }).join('')}</div>`
}

/** When a routine next fires, in the reader's own time. */
const whenOf = ms => { const at = new Date(Number(ms)); return Number.isFinite(at.getTime()) ? at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—' }

function routineRow(routine, agents, live = []) {
  const agent = agents.get(routine.assigneeId)
  // A routine whose agent is gone can be handed to someone else right here.
  const orphaned = routine.status !== 'retired' && (!agent || agent.status === 'terminated')
  const handOver = orphaned && live.length ? `<form class="hq-inline-form hq-routine-assign" data-id="${esc(routine.id)}" autocomplete="off"><label class="sr-only" for="hand-${esc(routine.id)}">Hand ${esc(routine.id)} to</label><select id="hand-${esc(routine.id)}" name="assigneeId">${live.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select><button type="submit" class="hq-btn">Hand over</button></form>` : ''
  const act = (action, label) => `<button type="button" class="hq-link" data-hq-action="routine-${action}" data-id="${esc(routine.id)}">${label}</button>`
  const actions = routine.status === 'retired' ? '' : `${routine.status === 'active' ? act('run', 'Run now') + act('pause', 'Pause') : act('resume', 'Resume')}${act('retire', 'Retire')}`
  const state = routine.status === 'active' ? `next ${whenOf(routine.nextAt)}` : `${routine.status}${routine.pausedReason && routine.pausedReason !== 'board' ? ` — ${routine.pausedReason}` : ''}`
  return `<div class="hq-routine status-${esc(routine.status)}"><div class="hq-card-row"><span class="hq-ticket-id">${esc(routine.id)}</span><b>${esc(routine.title)}</b><span class="hq-routine-every">every ${esc(routine.every)}</span></div>` +
    `<div class="hq-card-meta">${agent ? `${avatarHtml(agent, 18)}<span>${esc(agent.name)}</span>` : `<span>@${esc(routine.assigneeId)}</span>`}<span class="hq-dot-sep">·</span><span>${esc(state)}</span>` +
    (routine.lastTicketId ? `<span class="hq-dot-sep">·</span><button type="button" class="hq-ref" data-hq-ticket="${esc(routine.lastTicketId)}">${esc(routine.lastTicketId)}</button><span>${esc(String(routine.lastTicketStatus || '').replace('_', ' '))}</span>` : '') + `</div>` +
    (actions ? `<div class="hq-routine-actions">${actions}</div>` : '') + handOver + `</div>`
}

/** Recurring work: each routine opens a ticket for its agent on a schedule. */
export function routinesHtml(hq) {
  const routines = hq.routines || []
  const agents = agentMap(hq)
  const hireable = (hq.agents || []).filter(agent => agent.status !== 'terminated')
  const live = routines.filter(routine => routine.status !== 'retired').length
  return `<h3 class="hq-panel-head">Routines <span>${live}</span></h3>` +
    (hireable.length ? `<form id="hq-routine-form" class="hq-form hq-routine-form" autocomplete="off"><label class="hq-field"><span>Recurring work</span><input name="title" maxlength="140" required placeholder="Check the dependency advisories"></label>` +
      `<div class="hq-routine-fields"><label class="hq-field"><span>For</span><select name="assigneeId">${hireable.map(agent => `<option value="${esc(agent.id)}">${esc(agent.name)}</option>`).join('')}</select></label>` +
      `<label class="hq-field"><span>Every</span><select name="every"><option value="1h">hour</option><option value="6h">6 hours</option><option value="1d" selected>day</option><option value="1w">week</option></select></label>` +
      `<button type="submit" class="hq-btn primary">Add routine</button></div></form>` : '') +
    (routines.length ? routines.map(routine => routineRow(routine, agents, hireable)).join('') : '') +
    '<p class="hq-hint">A routine opens a ticket for its agent on a schedule, and skips its turn while the last one is still open. The run itself still asks you first, unless the agent is autonomous.</p>'
}

export function goalsHtml(hq) {
  const goals = hq.goals || []
  return `<form id="hq-goal-form" class="hq-inline-form" autocomplete="off"><input name="title" maxlength="160" placeholder="New goal — what is the company trying to achieve?"><button type="submit" class="hq-btn primary">Add goal</button></form>` +
    (goals.length ? goals.map(goal => {
      const pct = goal.progress.total ? Math.round((goal.progress.done / goal.progress.total) * 100) : 0
      return `<div class="hq-goal status-${esc(goal.status)}"><div class="hq-card-row"><span class="hq-ticket-id">${esc(goal.id)}</span><b>${esc(goal.title)}</b><span class="hq-goal-count">${goal.progress.done}/${goal.progress.total}</span></div><div class="hq-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="--pct:${pct}%"></i></div>${goal.description ? `<p>${esc(clip(goal.description, 200))}</p>` : ''}</div>`
    }).join('') : '<p class="hq-hint">No goals yet. Tickets trace up to a goal, so the company knows why it is doing what it is doing.</p>') +
    routinesHtml(hq)
}

export function budgetHtml(hq) {
  const agents = (hq.agents || []).filter(agent => agent.status !== 'terminated')
  const t = hq.totals || {}
  return `<div class="hq-budget-total">${budgetRing({ state: t.limitUsd && t.spentUsd >= t.limitUsd ? 'over' : 'ok', pct: t.limitUsd ? Math.round((t.spentUsd / t.limitUsd) * 100) : 0, spentUsd: t.spentUsd, limitUsd: t.limitUsd }, 58)}<div><b>${money(t.spentUsd)}</b><small>recorded of ${money(t.limitUsd)} in caps · ${esc(t.month || '')} (UTC)</small>${t.unpricedRuns ? `<small class="hq-warn-text">${t.unpricedRuns} run(s) reported no price and are not counted</small>` : ''}</div></div>` +
    agents.map(agent => `<button type="button" class="hq-budget-row" data-hq-agent="${esc(agent.id)}">${avatarHtml(agent, 26)}<span class="hq-row-copy"><b>${esc(agent.name)}</b><small>${agent.budget.state === 'uncapped' ? `${money(agent.budget.spentUsd)} · no cap` : `${money(agent.budget.spentUsd)} of ${money(agent.budget.limitUsd)}`}${agent.budget.unpricedRuns ? ` · ${agent.budget.unpricedRuns} unpriced` : ''}</small></span>${budgetRing(agent.budget, 30)}</button>`).join('') +
    '<p class="hq-hint">A run is priced when it exits, so one run can carry an agent past its cap before the next is refused. Codex reports no price; its runs are counted, not costed.</p>'
}

export function activityHtml(hq, ui) {
  const v = ui.verify
  const recovered = v ? [...(v.recovered || []).map(item => `recovered a torn last line in ${item.file} (kept in archive/)`), ...(v.corrupt ? [`an unreadable hq.json was kept at ${v.corrupt.file}`] : [])] : []
  const verify = v ? `<div class="hq-verify ${v.ok ? 'ok' : 'bad'}">${v.ok ? `Log intact · ${esc(v.messages.verified)} signed messages · ${esc(v.activity.total)} chained entries` : `Log check failed · ${esc(v.messages.failed.length)} message signature(s) failed${v.activity.brokenAt !== null ? ` · chain broken at #${esc(v.activity.brokenAt)}` : ''}`}${recovered.map(line => `<br><small>${esc(line)}</small>`).join('')}</div>` : ''
  return `<div class="hq-card-row"><button type="button" class="hq-btn" data-hq-action="verify">Verify signatures + chain</button></div>${verify}` +
    `<ol class="hq-activity">${(hq.activity || []).map(entry => `<li><span class="hq-seq">#${esc(entry.seq)}</span><span class="hq-activity-actor actor-${esc(entry.actor?.kind)}">${esc(entry.actor?.kind === 'agent' ? entry.actor.id : entry.actor?.kind)}</span><code>${esc(entry.action)}</code>${entry.target ? `<b>${esc(entry.target)}</b>` : ''}<small>${esc(clip(entry.detail, 140))}</small><time datetime="${esc(entry.at)}">${esc(clock(entry.at))}</time></li>`).join('')}</ol>`
}

export function inboxHtml(hq) {
  const agents = agentMap(hq)
  const pending = (hq.approvals || []).filter(item => item.status === 'pending')
  const blocked = (hq.tickets || []).filter(ticket => ticket.status === 'blocked')
  const paused = (hq.agents || []).filter(agent => agent.status === 'paused')
  const section = (title, body) => `<h3 class="hq-panel-head">${title}</h3>${body}`
  return section(`Approvals <span>${pending.length}</span>`, pending.length ? pending.map(approval => {
    const agent = agents.get(approval.agentId)
    return `<div class="hq-inbox-item">${agent ? avatarHtml(agent, 26) : systemAvatar(26)}<div><span class="hq-card-kicker">${esc(approval.kind)} · ${esc(approval.id)}${approval.ticketId ? ` · <button type="button" class="hq-ref" data-hq-ticket="${esc(approval.ticketId)}">${esc(approval.ticketId)}</button>` : ''}</span><p>${esc(approval.summary)}</p>${proposalHtml(approval)}${approvalButtons(approval)}</div></div>`
  }).join('') : '<p class="hq-hint">Nothing is waiting on you.</p>') +
    section(`Blocked <span>${blocked.length}</span>`, blocked.length ? blocked.map(ticket => `<button type="button" class="hq-ticket" data-hq-ticket="${esc(ticket.id)}"><span class="hq-ticket-id">${esc(ticket.id)}</span><span class="hq-ticket-title">${esc(clip(ticket.title, 90))}</span></button>`).join('') : '<p class="hq-hint">No blocked tickets.</p>') +
    (paused.length ? section(`Paused <span>${paused.length}</span>`, paused.map(agent => `<button type="button" class="hq-budget-row" data-hq-agent="${esc(agent.id)}">${avatarHtml(agent, 26)}<span class="hq-row-copy"><b>${esc(agent.name)}</b><small>${esc(agent.pausedReason === 'budget' ? 'monthly budget reached' : 'paused by the board')}</small></span></button>`).join('')) : '')
}

export function agentHtml(hq, ui) {
  const agents = agentMap(hq)
  const agent = agents.get(ui.agentId)
  if (!agent) return '<p class="hq-hint">That agent is not on the team.</p>'
  const manager = agent.reportsTo ? agents.get(agent.reportsTo) : null
  const tickets = (hq.tickets || []).filter(ticket => ticket.assigneeId === agent.id && !['done', 'cancelled'].includes(ticket.status))
  const rooms = new Map((hq.rooms || []).map(room => [room.id, room]))
  const active = agent.status === 'active'
  const row = (label, value) => `<div class="hq-kv"><span>${label}</span><span>${value}</span></div>`
  const heartbeat = agent.heartbeat.enabled ? `every ${agent.heartbeat.everyMinutes}m${agent.heartbeat.nextAt ? ` · next ${esc(clock(new Date(agent.heartbeat.nextAt).toISOString()))}` : ''}` : 'off'
  return `<div class="hq-profile presence-${esc(agent.presence?.state)}"><div class="hq-portrait">${drawCharacter(member(agent), { size: 96, state: agent.presence?.state === 'working' ? 'busy' : 'idle' })}</div>` +
    `<div class="hq-profile-copy"><h3>${esc(agent.name)}</h3><p>${esc(agent.title)}</p><span class="hq-presence-label presence-${esc(agent.presence?.state)}">${esc(PRESENCE[agent.presence?.state] || agent.presence?.state)}${agent.presence?.ticketId ? ` · ${esc(agent.presence.ticketId)}` : ''}${agent.pausedReason ? ` · ${esc(agent.pausedReason)}` : ''}</span></div></div>` +
    `<div class="hq-profile-actions"><button type="button" class="hq-btn primary" data-hq-dm="${esc(agent.id)}">Message</button>` +
    (active ? `<button type="button" class="hq-btn" data-hq-action="wake" data-id="${esc(agent.id)}">Wake now</button><button type="button" class="hq-btn" data-hq-action="pause" data-id="${esc(agent.id)}">Pause</button>` : '') +
    (agent.status === 'paused' ? `<button type="button" class="hq-btn" data-hq-action="resume" data-id="${esc(agent.id)}">Resume</button>` : '') +
    (agent.status !== 'terminated' ? `<button type="button" class="hq-btn danger" data-hq-action="terminate" data-id="${esc(agent.id)}">Terminate</button>` : '') + '</div>' +
    `<div class="hq-budget-block">${budgetRing(agent.budget, 64)}<div><b>${agent.budget.state === 'uncapped' ? money(agent.budget.spentUsd) : `${money(agent.budget.spentUsd)} <span class="hq-of">of ${money(agent.budget.limitUsd)}</span>`}</b><small>${esc(agent.budget.month)} · resets ${esc(String(agent.budget.resetsAt || '').slice(0, 10))}${agent.budget.unpricedRuns ? ` · ${agent.budget.unpricedRuns} unpriced` : ''}</small>` +
    `<form class="hq-inline-form hq-budget-form" data-id="${esc(agent.id)}" autocomplete="off"><label><span class="sr-only">Monthly cap in dollars</span><input name="monthlyUsd" type="number" min="0" step="1" value="${Number(agent.budget.limitUsd) || 0}"></label><button type="submit" class="hq-btn">Set cap</button></form></div></div>` +
    row('Reports to', manager ? `<button type="button" class="hq-link" data-hq-agent="${esc(manager.id)}">${esc(manager.name)}</button>` : 'the board') +
    row('Team', agent.reports?.length ? agent.reports.map(id => `<button type="button" class="hq-link" data-hq-agent="${esc(id)}">${esc(agents.get(id)?.name || id)}</button>`).join(', ') : '—') +
    row('Harness', `<span class="hq-runtime runtime-${esc(agent.runtime)}">${esc(agent.runtime)}</span> ${esc(agent.modelRef)}${agent.runtimeAvailable === false ? ' <span class="hq-warn-text">not installed</span>' : ''}`) +
    row('Pack', `${esc(agent.packId)} · ${esc(agent.role)}`) +
    row('Workspace', esc(agent.roomId ? rooms.get(agent.roomId)?.label || agent.roomId : 'company default')) +
    row('Heartbeat', `${heartbeat} <button type="button" class="hq-link" data-hq-action="toggle-heartbeat" data-id="${esc(agent.id)}">${agent.heartbeat.enabled ? 'turn off' : 'turn on'}</button>`) +
    row('Autonomy', agent.autonomy === 'autonomous' || agent.priced
      ? `${esc(agent.autonomy)} <button type="button" class="hq-link" data-hq-action="toggle-autonomy" data-id="${esc(agent.id)}">${agent.autonomy === 'autonomous' ? 'ask me first' : 'let them start runs'}</button>`
      : `${esc(agent.autonomy)} <span class="hq-warn-text">${esc(agent.runtime)} runs report no price, so a cap cannot see them — this agent always asks first</span>`) +
    (agent.instructions ? `<p class="hq-instructions">${esc(agent.instructions)}</p>` : '') +
    `<h3 class="hq-panel-head">Open tickets <span>${tickets.length}</span></h3>` +
    (tickets.length ? tickets.map(ticket => `<button type="button" class="hq-ticket" data-hq-ticket="${esc(ticket.id)}"><span class="hq-ticket-id">${esc(ticket.id)}</span><span class="hq-ticket-title">${esc(clip(ticket.title, 80))}</span>${statusPill(ticket.status)}</button>`).join('') : '<p class="hq-hint">Nothing assigned.</p>')
}

export function ticketHtml(hq, ui, ctx = {}) {
  const ticket = (hq.tickets || []).find(item => item.id === ui.ticketId) || ui.detail?.ticket
  if (!ticket) return '<p class="hq-hint">Loading ticket…</p>'
  const agents = agentMap(hq)
  const assignee = ticket.assigneeId ? agents.get(ticket.assigneeId) : null
  const goal = (hq.goals || []).find(item => item.id === ticket.goalId)
  const pending = (hq.approvals || []).find(item => item.ticketId === ticket.id && item.status === 'pending')
  const known = new Set((hq.agents || []).map(agent => agent.id))
  const ids = new Set((hq.tickets || []).map(item => item.id))
  const thread = ui.detail?.ticket?.id === ticket.id ? ui.detail.thread : (hq.messages || []).filter(message => message.threadId === ticket.id)
  const row = (label, value) => `<div class="hq-kv"><span>${label}</span><span>${value}</span></div>`
  const live = Boolean(ticket.checkout)
  const verify = ticket.verifyCommand ? [ticket.verifyCommand.command, ...(ticket.verifyCommand.args || [])].join(' ') : ''
  return `<div class="hq-ticket-head"><span class="hq-ticket-id">${esc(ticket.id)}</span>${statusPill(ticket.status)}<span class="priority-${esc(ticket.priority)}">${esc(ticket.priority)}</span>${ticket.verified ? '<span class="hq-verified">verified</span>' : ''}</div>` +
    `<h3 class="hq-ticket-title-lg">${esc(ticket.title)}</h3>` +
    (ticket.body && ticket.body !== ticket.title ? `<div class="hq-ticket-body">${formatText(ticket.body, known, ids)}</div>` : '') +
    (pending ? `<div class="hq-card-ask">${esc(pending.summary)} ${approvalButtons(pending)}</div>` : '') +
    `<div class="hq-profile-actions">` +
    (!live && assignee && ['todo', 'blocked'].includes(ticket.status) ? `<button type="button" class="hq-btn primary" data-hq-action="dispatch" data-id="${esc(ticket.id)}">Start run</button>` : '') +
    (live ? `<button type="button" class="hq-btn danger" data-hq-action="cancel-run" data-id="${esc(ticket.id)}">Cancel run</button>` : '') +
    (!live && ticket.status !== 'done' ? `<button type="button" class="hq-btn" data-hq-action="close" data-id="${esc(ticket.id)}">Close</button>` : '') +
    (!live && ['done', 'cancelled', 'blocked', 'backlog'].includes(ticket.status) ? `<button type="button" class="hq-btn" data-hq-action="reopen" data-id="${esc(ticket.id)}">Reopen</button>` : '') +
    `</div>` +
    (ticket.waiting ? `<div class="hq-card-ask hq-waiting">Waiting: ${esc(ticket.waiting.reason)}. It starts on its own once that clears.</div>` : '') +
    row('Assignee', assignee ? `<button type="button" class="hq-link" data-hq-agent="${esc(assignee.id)}">${avatarHtml(assignee, 18)} ${esc(assignee.name)}</button>` : 'nobody') +
    row('Goal', goal ? `${esc(goal.id)} · ${esc(clip(goal.title, 60))}` : '—') +
    (ticket.routineId ? row('Opened by', `routine ${esc(ticket.routineId)}`) : '') +
    row('Waits on', ticket.blockedBy?.length ? ticket.blockedBy.map(id => `<button type="button" class="hq-ref" data-hq-ticket="${esc(id)}">${esc(id)}</button>`).join(' ') : '—') +
    row('Channel', `<button type="button" class="hq-link" data-hq-channel="${esc(ticket.channelId)}">#${esc(ticket.channelId)}</button>${ticket.branch ? ` · ⎇ ${esc(ticket.branch)}` : ''}`) +
    (verify ? row('Verified by', `<code>${esc(verify)}</code>`) : '') +
    (ticket.runs?.length ? `<h3 class="hq-panel-head">Runs <span>${ticket.runs.length}</span></h3>${ticket.runs.slice().reverse().map(run => `<div class="hq-run"><span>#${run.attempt}</span><code>${esc(run.runtime)}</code><span class="hq-status status-${esc(run.status === 'completed' ? 'done' : run.status === 'running' ? 'in_progress' : 'blocked')}">${esc(run.status)}</span><span>${run.costUsd !== null && run.costUsd !== undefined ? money(run.costUsd) : run.finishedAt ? 'unpriced' : '…'}</span></div>`).join('')}` : '') +
    `<h3 class="hq-panel-head">Thread <span>${thread.length}</span></h3><div class="hq-thread">${thread.length ? messagesHtml({ ...hq, messages: thread.map(message => ({ ...message, channelId: '__thread' })) }, { ...ui, channel: '__thread' }, ctx) : '<p class="hq-hint">No replies yet.</p>'}</div>`
}

export function hireHtml(hq) {
  const agents = (hq.agents || []).filter(agent => agent.status !== 'terminated')
  const rooms = hq.rooms || []
  const runtimes = hq.runtimes || []
  return `<form id="hq-hire-form" class="hq-form" autocomplete="off"><h3 class="hq-panel-head">Hire an agent</h3>` +
    `<label class="hq-field"><span>Name</span><input name="name" maxlength="40" required placeholder="Nova"></label>` +
    `<label class="hq-field"><span>Title</span><input name="title" maxlength="60" required placeholder="Content Lead"></label>` +
    `<label class="hq-field"><span>Job</span><select name="packId"><option value="builder">Builder — implement and verify</option><option value="scout">Scout — research, read-only</option><option value="review">Reviewer — find risks</option><option value="qa">QA — exercise, never mutate</option><option value="release">Release — notes, tags, rollback</option></select></label>` +
    `<label class="hq-field"><span>Harness</span><select name="runtime">${runtimes.map(runtime => `<option value="${esc(runtime.id)}">${esc(runtime.id)}${runtime.available === false ? ' (not installed)' : ''}</option>`).join('')}</select></label>` +
    `<label class="hq-field"><span>Reports to</span><select name="reportsTo"><option value="">the board</option>${agents.map(agent => `<option value="${esc(agent.id)}">${esc(agent.name)} — ${esc(agent.title)}</option>`).join('')}</select></label>` +
    `<label class="hq-field"><span>Workspace</span><select name="roomId"><option value="">company default</option>${rooms.map(room => `<option value="${esc(room.id)}">${esc(room.label)}</option>`).join('')}</select></label>` +
    `<label class="hq-field"><span>Monthly cap ($)</span><input name="budgetUsd" type="number" min="0" step="1" value="10"></label>` +
    `<label class="hq-field"><span>Instructions</span><textarea name="instructions" rows="3" maxlength="2000" placeholder="What does good work look like for this role?"></textarea></label>` +
    `<p class="hq-hint">New hires start supervised: their first run in every ticket waits for your approval. Heartbeats start off.</p>` +
    `<button type="submit" class="hq-btn primary">Hire</button></form>`
}

export function onboardingHtml(hq) {
  const templates = hq?.templates || []
  const rooms = hq?.rooms || []
  return `<form id="hq-onboarding-form" class="hq-onboarding-card" autocomplete="off">` +
    `<span class="eyebrow">QUORUM HQ</span><h1>Found your company.</h1>` +
    `<p>An org chart of agents with titles, managers and monthly budgets. A room where you hand them work with an @mention and they report back — signed, in the thread. You're the board: nothing spends money until you approve it.</p>` +
    (hq?.corrupt ? `<div class="hq-corrupt" role="alert"><b>A saved company exists but could not be read.</b>` +
      `<span>${hq.corrupt.kept ? 'It was kept, unchanged, at' : 'It is still at'} <code>${esc(hq.corrupt.file)}</code>. Repair it and restart Quorum to get it back${hq.corrupt.kept ? ', or found a new company in its place.' : '. It could not be moved aside, so a new company cannot be founded until you move it.'}</span>` +
      `<small>${esc(hq.corrupt.error)}</small>` +
      (hq.corrupt.kept ? `<label class="hq-check"><input type="checkbox" name="force" value="1"> Found a new company anyway</label>` : '') + `</div>` : '') +
    `<div class="hq-onboarding-grid"><label class="hq-field"><span>Company name</span><input name="name" maxlength="80" required placeholder="Acme Robotics"></label>` +
    `<label class="hq-field"><span>Default workspace</span><select name="roomId"><option value="">choose later</option>${rooms.map(room => `<option value="${esc(room.id)}">${esc(room.label)}</option>`).join('')}</select></label></div>` +
    `<label class="hq-field"><span>Mission</span><textarea name="mission" rows="2" maxlength="600" placeholder="What is this company for?"></textarea></label>` +
    `<fieldset class="hq-templates"><legend>Start with</legend>${templates.map((template, index) => `<label class="hq-template"><input type="radio" name="template" value="${esc(template.id)}"${index === 0 ? ' checked' : ''}><span><b>${esc(template.label)}</b><small>${esc(template.summary)}</small><span class="hq-template-team">${template.agents.map(agent => `<em>${esc(agent.name)} · ${esc(agent.title)}</em>`).join('') || '<em>no one yet</em>'}</span></span></label>`).join('')}</fieldset>` +
    `<button type="submit" class="hq-btn primary large">Found company</button><span id="hq-onboarding-status" class="form-status"></span></form>`
}

/** `text` escaped, with each search term wrapped in <mark>. */
function highlight(text, terms = []) {
  // Longest first, so "authentication" is marked whole rather than as "auth".
  const words = terms.filter(Boolean).sort((a, b) => b.length - a.length).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length) return esc(text)
  const pattern = new RegExp(words.join('|'), 'gi')
  let out = ''
  let at = 0
  for (const match of String(text).matchAll(pattern)) {
    if (!match[0]) continue
    out += `${esc(String(text).slice(at, match.index))}<mark>${esc(match[0])}</mark>`
    at = match.index + match[0].length
  }
  return out + esc(String(text).slice(at))
}

/** Search results: tickets first, then every matching message in the whole history. */
export function searchHtml(hq, ui) {
  const search = ui.search
  if (!search) return '<p class="hq-hint">Search every message ever posted and every ticket. Words and "phrases" must all appear; <code>in:#channel</code> and <code>from:@agent</code> narrow it.</p>'
  if (search.loading) return `<p class="hq-hint">Searching for “${esc(search.q)}”…</p>`
  if (search.error) return `<p class="hq-hint hq-warn-text">${esc(search.error)}</p>`
  const result = search.result || {}
  const terms = result.query?.terms || []
  const agents = agentMap(hq)
  const who = message => message.author?.kind === 'board' ? 'You' : message.author?.kind === 'agent' ? agents.get(message.author.id)?.name || message.author.id : 'Quorum'
  const tickets = result.tickets || []
  const messages = (result.messages || []).slice().reverse()
  return `<p class="hq-hint">“${esc(search.q)}” · ${messages.length} message(s) · ${tickets.length} ticket(s)${result.scanned ? ` · ${result.scanned} searched` : ''}${result.note ? ` · ${esc(result.note)}` : ''}</p>` +
    (tickets.length ? `<h3 class="hq-panel-head">Tickets <span>${tickets.length}</span></h3>${tickets.map(ticket => `<button type="button" class="hq-ticket" data-hq-ticket="${esc(ticket.id)}"><span class="hq-ticket-id">${esc(ticket.id)}</span><span class="hq-ticket-title">${highlight(clip(ticket.title, 90), terms)}</span>${statusPill(ticket.status)}</button>`).join('')}` : '') +
    `<h3 class="hq-panel-head">Messages <span>${messages.length}</span></h3>` +
    (messages.length ? `<ol class="hq-search-results">${messages.map(message => {
      const open = message.threadId ? `data-hq-ticket="${esc(message.threadId)}"` : `data-hq-channel="${esc(message.channelId)}"`
      return `<li><button type="button" class="hq-search-hit" ${open}><span class="hq-search-where">#${esc(message.channelId)}${message.threadId ? ` · ${esc(message.threadId)}` : ''} · ${esc(whenOf(Date.parse(message.at)))}</span><b>${esc(who(message))}</b><span class="hq-search-text">${highlight(clip(message.text, 280), terms)}</span></button></li>`
    }).join('')}</ol>` : '<p class="hq-hint">No message matched.</p>')
}

export function panelHtml(hq, ui, ctx = {}) {
  if (ui.panel === 'search') return searchHtml(hq, ui)
  if (ui.panel === 'agent') return agentHtml(hq, ui)
  if (ui.panel === 'ticket') return ticketHtml(hq, ui, ctx)
  if (ui.panel === 'tickets') return ticketsHtml(hq)
  if (ui.panel === 'goals') return goalsHtml(hq)
  if (ui.panel === 'budget') return budgetHtml(hq)
  if (ui.panel === 'activity') return activityHtml(hq, ui)
  if (ui.panel === 'inbox') return inboxHtml(hq)
  if (ui.panel === 'hire') return hireHtml(hq)
  return orgHtml(hq)
}

// ── the live page ─────────────────────────────────────────────────────────

const STORE_KEY = 'quorum-hq-ui'
function loadUi() {
  try { return { channel: 'general', panel: 'org', ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } } catch { return { channel: 'general', panel: 'org' } }
}
export const ui = Object.assign(loadUi(), { detail: null, verify: null, flash: null, scrollToEnd: true })
const saveUi = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ channel: ui.channel, panel: ['agent', 'ticket', 'hire', 'search'].includes(ui.panel) ? 'org' : ui.panel })) } catch { /* private mode */ } }

function write(el, html) {
  if (!el || el.__hq === html) return false
  el.__hq = html
  el.innerHTML = html
  return true
}

/**
 * Rewrite a region that holds form fields without eating what the operator was
 * typing. Values are keyed by their form (its id, or the record it edits), so
 * a half-typed cap survives a live presence update but never follows the
 * operator from one agent's profile to another's.
 */
function writePreserving(el, html) {
  if (!el || el.__hq === html) return false
  const formKey = field => { const form = field.closest('form'); return form ? form.id || `${form.className}#${form.dataset?.id || ''}` : '' }
  const fieldKey = field => `${formKey(field)}:${field.name}:${field.type === 'radio' ? field.value : ''}`
  // Only what the operator changed is carried over. A field still showing the
  // value it was rendered with takes the new render's value, so a cap raised
  // from the CLI or another tab shows up here instead of being written back.
  const edited = field => {
    if (field.type === 'radio' || field.type === 'checkbox') return field.checked !== field.defaultChecked
    if (field.options) {
      const initial = [...field.options].find(option => option.defaultSelected) || field.options[0]
      return field.value !== (initial ? initial.value : '')
    }
    return field.value !== field.defaultValue
  }
  const values = new Map()
  for (const field of el.querySelectorAll?.('input[name], select[name], textarea[name]') || []) {
    if (edited(field)) values.set(fieldKey(field), field.type === 'radio' || field.type === 'checkbox' ? field.checked : field.value)
  }
  const focused = el.contains?.(globalThis.document?.activeElement) ? globalThis.document.activeElement : null
  const focusKey = focused?.name ? fieldKey(focused) : null
  el.__hq = html
  el.innerHTML = html
  for (const field of el.querySelectorAll?.('input[name], select[name], textarea[name]') || []) {
    const key = fieldKey(field)
    if (values.has(key)) {
      if (field.type === 'radio' || field.type === 'checkbox') field.checked = values.get(key)
      else field.value = values.get(key)
    }
    if (key === focusKey) field.focus()
  }
  return true
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api/hq${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `HQ answered ${response.status}`)
  return data
}

let context = { S: null, rerender: () => {}, setView: () => {} }
let searchSeq = 0
let detailLoading = null

function flash(text, level = 'info') {
  ui.flash = { text, level, at: Date.now() }
  context.rerender()
  setTimeout(() => { if (ui.flash && Date.now() - ui.flash.at >= 5500) { ui.flash = null; context.rerender() } }, 6000)
}

async function loadDetail(ticketId) {
  if (detailLoading === ticketId) return
  detailLoading = ticketId
  try { ui.detail = await api(`/tickets/${encodeURIComponent(ticketId)}`) } catch (error) { ui.detail = null; flash(error.message, 'error') }
  detailLoading = null
  context.rerender()
}

export function renderHqView(S, doc = globalThis.document) {
  const $ = id => doc.getElementById(id)
  const root = $('view-hq')
  if (!root) return
  const hq = S.hq
  const ready = Boolean(hq?.ready)
  root.classList.toggle('hq-ready', ready)
  $('hq-onboarding')?.classList.toggle('hidden', ready)
  if (!ready) {
    writePreserving($('hq-onboarding'), onboardingHtml(hq || {}))
    return
  }
  const ctx = { mascot: S.castById?.get?.('nib') || null, cast: S.castById || new Map() }
  if (!(hq.channels || []).some(channel => channel.id === ui.channel)) ui.channel = 'general'
  write($('hq-sidebar'), sidebarHtml(hq, ui))
  write($('hq-channel-head'), channelHeadHtml(hq, ui))
  write($('hq-pulse'), pulseHtml(hq))
  const box = $('hq-messages')
  const nearBottom = box ? box.scrollHeight - box.scrollTop - box.clientHeight < 120 : true
  if (write(box, messagesHtml(hq, ui, ctx)) && box && (nearBottom || ui.scrollToEnd)) { box.scrollTop = box.scrollHeight; ui.scrollToEnd = false }
  write($('hq-typing'), typingHtml(hq, ui))
  const flashBox = $('hq-flash')
  if (flashBox) { flashBox.className = `hq-flash${ui.flash ? ` show level-${ui.flash.level}` : ''}`; flashBox.textContent = ui.flash?.text || '' }
  const input = $('hq-input')
  const channel = (hq.channels || []).find(item => item.id === ui.channel)
  if (input) input.placeholder = channel?.kind === 'dm' ? `Message ${channel.name} — anything you write here becomes their ticket` : `Message #${ui.channel} — @mention an agent to hand them work, / for commands`
  write($('hq-tabs'), tabsHtml(ui))
  if (ui.panel === 'ticket' && ui.ticketId) {
    const ticket = (hq.tickets || []).find(item => item.id === ui.ticketId)
    const replies = (hq.messages || []).filter(message => message.threadId === ui.ticketId).length
    const stamp = `${ticket?.updatedAt || ''}:${replies}`
    if (ui.detail?.ticket?.id !== ui.ticketId || ui.detailStamp !== stamp) { ui.detailStamp = stamp; void loadDetail(ui.ticketId) }
  }
  writePreserving($('hq-panel-body'), panelHtml(hq, ui, ctx))
  $('hq-thread-composer')?.classList.toggle('hidden', !(ui.panel === 'ticket' && ui.ticketId))
}

// Composer suggestions: @agents and /commands, from the live snapshot.
const COMMAND_HINTS = [['/ticket', 'open an unassigned ticket'], ['/assign', 'T-n @agent'], ['/goal', 'add a company goal'], ['/wake', '@agent — heartbeat now'], ['/close', 'T-n — mark done'], ['/convene', 'argue it out: turns + cost shown first'], ['/routine', '1d @agent <title> — recurring ticket'], ['/help', 'list commands']]

export function suggestions(text, caret, hq) {
  const before = String(text).slice(0, caret)
  const mention = before.match(/(^|\s)@([\w-]{0,31})$/)
  if (mention) {
    const query = mention[2].toLowerCase()
    return (hq?.agents || []).filter(agent => agent.status !== 'terminated' && (agent.id.startsWith(query) || agent.name.toLowerCase().startsWith(query))).slice(0, 6)
      .map(agent => ({ insert: `@${agent.id} `, replace: mention[2].length + 1, label: agent.name, detail: `${agent.title} · ${PRESENCE[agent.presence?.state] || ''}`, agent }))
  }
  const command = before.match(/^\/(\w*)$/)
  if (command) return COMMAND_HINTS.filter(([name]) => name.slice(1).startsWith(command[1].toLowerCase())).map(([name, detail]) => ({ insert: `${name} `, replace: command[1].length + 1, label: name, detail }))
  return []
}

export function wireHq({ S, rerender, setView, doc = globalThis.document }) {
  context = { S, rerender, setView }
  const $ = id => doc.getElementById(id)
  const root = $('view-hq')
  if (!root) return
  const refresh = () => rerender()
  const act = async (fn, ok) => { try { const result = await fn(); if (ok) flash(typeof ok === 'function' ? ok(result) : ok); return result } catch (error) { flash(error.message, 'error'); return null } }

  let picks = []
  let pickIndex = 0
  const input = $('hq-input')
  const suggestBox = $('hq-suggest')
  const closeSuggest = () => { picks = []; suggestBox?.classList.add('hidden') }
  const showSuggest = () => {
    if (!input || !suggestBox) return
    picks = suggestions(input.value, input.selectionStart ?? input.value.length, S.hq)
    pickIndex = 0
    if (!picks.length) return closeSuggest()
    suggestBox.innerHTML = picks.map((pick, i) => `<button type="button" class="hq-suggestion${i === pickIndex ? ' on' : ''}" data-pick="${i}">${pick.agent ? avatarHtml(pick.agent, 20) : ''}<b>${esc(pick.label)}</b><small>${esc(pick.detail)}</small></button>`).join('')
    suggestBox.classList.remove('hidden')
  }
  const applyPick = index => {
    const pick = picks[index]
    if (!pick || !input) return
    const caret = input.selectionStart ?? input.value.length
    input.value = input.value.slice(0, caret - pick.replace) + pick.insert + input.value.slice(caret)
    const at = caret - pick.replace + pick.insert.length
    input.setSelectionRange?.(at, at)
    closeSuggest()
    input.focus()
  }
  input?.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; showSuggest() })
  input?.addEventListener('keydown', event => {
    if (picks.length && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(event.key)) {
      event.preventDefault()
      if (event.key === 'Escape') return closeSuggest()
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        pickIndex = (pickIndex + (event.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length
        for (const [i, el] of [...suggestBox.children].entries()) el.classList.toggle('on', i === pickIndex)
        return
      }
      return applyPick(pickIndex)
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('hq-composer')?.requestSubmit() }
  })
  suggestBox?.addEventListener('mousedown', event => { const pick = event.target.closest('[data-pick]'); if (pick) { event.preventDefault(); applyPick(Number(pick.dataset.pick)) } })

  root.addEventListener('submit', async event => {
    const form = event.target
    event.preventDefault()
    const data = Object.fromEntries(new FormData(form).entries())
    if (form.id === 'hq-composer') {
      const text = input.value.trim()
      if (!text) return
      const sent = await act(() => api(`/channels/${encodeURIComponent(ui.channel)}/messages`, { method: 'POST', body: { text } }), result => result.tickets?.length ? `${result.tickets.map(ticket => ticket.id).join(', ')} handed off` : null)
      if (sent) { input.value = ''; input.style.height = ''; ui.scrollToEnd = true; closeSuggest() }
      if (ui.flash && !ui.flash.text) ui.flash = null
    } else if (form.id === 'hq-thread-composer') {
      const box = $('hq-thread-input')
      const text = box.value.trim()
      if (!text || !ui.ticketId) return
      if (await act(() => api(`/tickets/${encodeURIComponent(ui.ticketId)}/comment`, { method: 'POST', body: { text } }))) { box.value = ''; ui.detailStamp = null; refresh() }
    } else if (form.id === 'hq-onboarding-form') {
      const status = $('hq-onboarding-status')
      if (status) status.textContent = 'founding…'
      const result = await act(() => api('/init', { method: 'POST', body: { name: data.name, mission: data.mission, template: data.template, roomId: data.roomId || null, force: data.force === '1' } }))
      if (result) { S.hq = result; ui.channel = 'general'; ui.panel = 'org'; saveUi(); refresh() } else if (status) status.textContent = ''
    } else if (form.id === 'hq-hire-form') {
      const result = await act(() => api('/agents', { method: 'POST', body: { name: data.name, title: data.title, packId: data.packId, runtime: data.runtime, reportsTo: data.reportsTo || null, roomId: data.roomId || null, budgetUsd: Number(data.budgetUsd), instructions: data.instructions } }), result => `Hired ${result.agent?.name || data.name}`)
      if (result?.agent) { ui.panel = 'agent'; ui.agentId = result.agent.id; refresh() }
    } else if (form.id === 'hq-goal-form') {
      if (await act(() => api('/goals', { method: 'POST', body: { title: data.title } }))) form.reset()
    } else if (form.id === 'hq-routine-form') {
      if (await act(() => api('/routines', { method: 'POST', body: { title: data.title, assigneeId: data.assigneeId, every: data.every } }), result => `${result.routine.id}: every ${result.routine.every} for @${result.routine.assigneeId}`)) form.reset()
    } else if (form.id === 'hq-search') {
      const q = String($('hq-search-input')?.value || '').trim()
      if (!q) return
      // Only the newest search may fill the panel: an older one that answers
      // late must not replace it.
      const seq = ++searchSeq
      ui.panel = 'search'
      ui.search = { q, loading: true }
      refresh()
      let next
      try { next = { q, result: await api(`/search?q=${encodeURIComponent(q)}`) } } catch (error) { next = { q, error: error.message } }
      if (seq !== searchSeq) return
      ui.search = next
      refresh()
    } else if (form.classList.contains('hq-routine-assign')) {
      const id = form.dataset.id
      if (await act(() => api(`/routines/${encodeURIComponent(id)}`, { method: 'PATCH', body: { assigneeId: data.assigneeId } }), result => `${id} is now for @${result.routine.assigneeId} — resume it when you are ready`)) refresh()
    } else if (form.classList.contains('hq-budget-form')) {
      await act(() => api(`/agents/${encodeURIComponent(form.dataset.id)}`, { method: 'PATCH', body: { budget: { monthlyUsd: Number(data.monthlyUsd) } } }), 'Budget updated')
    }
  })

  root.addEventListener('click', async event => {
    const target = event.target.closest('[data-hq-channel], [data-hq-dm], [data-hq-agent], [data-hq-ticket], [data-hq-panel], [data-hq-approve], [data-hq-deny], [data-hq-action], [data-hq-convene], [data-hq-view]')
    if (!target || !root.contains(target)) return
    const d = target.dataset
    if (d.hqApprove) {
      const approval = (S.hq?.approvals || []).find(item => item.id === d.hqApprove)
      const brief = String(approval?.proposal?.instructions || '')
      const question = approval?.kind === 'hire'
        ? `Approve: ${approval.summary}?${brief ? `\n\nTheir brief, which goes into every run they make:\n${brief.length > 1200 ? `${brief.slice(0, 1200)}… (${brief.length} chars — read it all in the inbox)` : brief}` : ''}`
        : `Approve ${d.hqApprove}? This starts a real run that spends money on the agent's harness.\n\n${approval?.summary || ''}`
      if (!globalThis.confirm?.(question)) return
      return act(() => api(`/approvals/${encodeURIComponent(d.hqApprove)}/approve`, { method: 'POST', body: {} }), `${d.hqApprove} approved`)
    }
    if (d.hqDeny) return act(() => api(`/approvals/${encodeURIComponent(d.hqDeny)}/deny`, { method: 'POST', body: { reason: 'denied from HQ' } }), `${d.hqDeny} denied`)
    if (d.hqConvene) {
      const message = (S.hq?.messages || []).find(item => item.id === d.hqConvene)
      const card = message?.card
      if (!card) return
      if (!globalThis.confirm?.(`Convene ${card.participants.join(', ')} on “${card.question}”?\n${card.turns} turns · ${card.local ? 'local, no API cost' : `est. ~${money(card.estimateUsd)}`}`)) return
      return act(() => api('/convene', { method: 'POST', body: { channelId: message.channelId, question: card.question, participants: card.participants, model: card.model, confirm: true } }), 'Roundtable convened')
    }
    if (d.hqView) return context.setView(d.hqView)
    if (d.hqChannel) { ui.channel = d.hqChannel; ui.scrollToEnd = true; saveUi(); return refresh() }
    if (d.hqDm) { ui.channel = `dm-${d.hqDm}`; ui.scrollToEnd = true; saveUi(); refresh(); return $('hq-input')?.focus() }
    if (d.hqTicket) { ui.panel = 'ticket'; ui.ticketId = d.hqTicket; ui.detail = null; ui.detailStamp = null; return refresh() }
    if (d.hqAgent) { ui.panel = 'agent'; ui.agentId = d.hqAgent; return refresh() }
    if (d.hqPanel) { ui.panel = d.hqPanel; if (d.hqPanel !== 'activity') ui.verify = null; saveUi(); return refresh() }
    const id = d.id
    const agent = id ? (S.hq?.agents || []).find(item => item.id === id) : null
    switch (d.hqAction) {
      case 'hire': ui.panel = 'hire'; return refresh()
      case 'compose': { const box = $('hq-input'); if (box) { box.value = d.text || ''; box.focus(); showSuggest() } return }
      case 'new-channel': {
        const name = globalThis.prompt?.('Channel name (lowercase, dashes):')
        if (!name) return
        const result = await act(() => api('/channels', { method: 'POST', body: { name } }))
        if (result?.channel) { ui.channel = result.channel.id; saveUi(); refresh() }
        return
      }
      case 'verify': ui.verify = await act(() => api('/verify')); return refresh()
      case 'wake': return act(() => api(`/agents/${encodeURIComponent(id)}/wake`, { method: 'POST', body: {} }), result => `${agent?.name || id}: ${result.wakeup?.result || 'woken'}`)
      case 'pause': return act(() => api(`/agents/${encodeURIComponent(id)}/pause`, { method: 'POST', body: {} }), `${agent?.name || id} paused`)
      case 'resume': return act(() => api(`/agents/${encodeURIComponent(id)}/resume`, { method: 'POST', body: {} }), `${agent?.name || id} resumed`)
      case 'terminate':
        if (!globalThis.confirm?.(`Terminate ${agent?.name || id}? Their history and signatures are kept; open tickets go back to the backlog.`)) return
        return act(() => api(`/agents/${encodeURIComponent(id)}/terminate`, { method: 'POST', body: {} }), `${agent?.name || id} terminated`)
      case 'toggle-heartbeat': return act(() => api(`/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: { heartbeat: { enabled: !agent?.heartbeat?.enabled } } }), `Heartbeat ${agent?.heartbeat?.enabled ? 'off' : 'on'}`)
      case 'toggle-autonomy': {
        const next = agent?.autonomy === 'autonomous' ? 'supervised' : 'autonomous'
        if (next === 'autonomous' && !globalThis.confirm?.(`Let ${agent?.name || id} start runs without asking? Runs stay inside their monthly cap and the daily cloud ceiling.`)) return
        return act(() => api(`/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: { autonomy: next } }), `${agent?.name || id} is ${next}`)
      }
      case 'routine-run': return act(() => api(`/routines/${encodeURIComponent(id)}/run`, { method: 'POST', body: {} }), result => result.ticket ? `${id} opened ${result.ticket.id}` : `${id} skipped its turn: ${result.skipped}`)
      case 'routine-pause': return act(() => api(`/routines/${encodeURIComponent(id)}/pause`, { method: 'POST', body: {} }), `${id} paused`)
      case 'routine-resume': return act(() => api(`/routines/${encodeURIComponent(id)}/resume`, { method: 'POST', body: {} }), `${id} resumed`)
      case 'routine-retire':
        if (!globalThis.confirm?.(`Retire ${id}? It stops opening tickets. Its history is kept.`)) return
        return act(() => api(`/routines/${encodeURIComponent(id)}/retire`, { method: 'POST', body: {} }), `${id} retired`)
      case 'close': return act(() => api(`/tickets/${encodeURIComponent(id)}/close`, { method: 'POST', body: {} }), `${id} closed`)
      case 'reopen': return act(() => api(`/tickets/${encodeURIComponent(id)}/reopen`, { method: 'POST', body: {} }), `${id} reopened`)
      case 'cancel-run':
        if (!globalThis.confirm?.(`Cancel the run on ${id}? The provider process is stopped.`)) return
        return act(() => api(`/tickets/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }), `Cancelling ${id}`)
      case 'dispatch': {
        const preview = await act(() => api(`/tickets/${encodeURIComponent(id)}/dispatch`, { method: 'POST', body: {} }))
        if (!preview) return
        const p = preview.preview
        if (!p.ready) return flash(p.transient ? `Not yet: ${p.reason}` : p.reason, p.transient ? 'warn' : 'error')
        if (!globalThis.confirm?.(`Start ${id} now?\n${p.agentId} · ${p.runtime} (${p.modelRef}) in ${p.room?.label}${p.branch ? ` on ${p.branch}` : ''}${p.verify ? `\nChecked by: ${p.verify}` : ''}\nBudget: ${money(p.budget.spentUsd)} of ${money(p.budget.limitUsd)} this month.\n${p.note}`)) return
        // `expect` ties the confirm to the plan in this dialog: if anything
        // changed while it was open, the server refuses instead of running it.
        return act(() => api(`/tickets/${encodeURIComponent(id)}/dispatch`, { method: 'POST', body: { confirm: true, expect: p.planHash } }), `${id} started`)
      }
      default: return undefined
    }
  })
  root.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const card = event.target.closest?.('.hq-card-ticket')
    if (card && event.target === card) { event.preventDefault(); card.click() }
  })
}
