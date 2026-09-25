// The HQ half of the `quorum` CLI. Every command is a call to the running
// cockpit's /api/hq — the same API the dashboard uses — so the terminal and
// the browser are two views of one company, never two copies of it.
//
// Output is for people by default (colour on a TTY, plain in a pipe) and
// machine-readable with --json. Anything that spends money previews first and
// needs --yes; approving an approval is itself the confirmation.
//
// Run from inside a managed run, the CLI sends QUORUM_AGENT_RUN_ID with every
// write, and the cockpit acts as that run's agent — with an agent's rights,
// not the board's.

import {
  formatActivity, formatBudget, formatInbox, formatMessages, formatOrg, formatOverview, formatRoutines, formatSearch, formatTeam,
  formatTicketDetail, formatTickets, money, painter, renderTopFrame, safeDeep,
} from './format.js'

export const HQ_COMMANDS = new Set(['hq', 'org', 'team', 'hire', 'pause', 'resume', 'terminate', 'wake', 'goal', 'routine', 'ticket', 'say', 'chat', 'search', 'inbox', 'approve', 'deny', 'budget', 'activity', 'convene', 'channel', 'top'])
const BOOLEANS = new Set(['json', 'yes', 'follow', 'once', 'autonomous', 'help', 'force'])

export const HQ_USAGE = [
  'HQ — your agent company:',
  '  quorum hq [init <name> --mission M --template studio|solo|blank --room R [--force] | verify]',
  '  quorum org | team | inbox | budget | activity | top [--once]',
  '  quorum hire <name> --title T [--pack builder|scout|review|qa|release] [--runtime claude|codex] [--reports-to id] [--budget USD] [--room id] [--heartbeat MIN] [--autonomous]',
  '  quorum pause|resume|wake <agent>   ·   quorum terminate <agent> --yes',
  '  quorum goal list | goal add <title> [--description D]',
  '  quorum routine list | add <title> --assign <agent> --every <6h|1d|1w> [--body B] [--channel #c] [--priority p] [--verify "npm test"]',
  '  quorum routine edit <R-n> [--assign a] [--every e] [--title T] [--body B] [--priority p] | run|pause|resume|retire <R-n>',
  '  quorum ticket list [--status s] [--assignee a] | new <title> [--assign a] [--body B] [--goal G] [--priority p] [--blocked-by T-1,T-2] [--verify "npm test"]',
  '  quorum ticket show|close|reopen|cancel <T-n> | assign <T-n> <agent> | start <T-n> [--yes]',
  '  quorum say <#channel|@agent|T-n> <text>   ·   quorum chat [#channel|@agent|T-n] [--follow]',
  '  quorum search <words | "a phrase" | in:#channel | from:@agent> [--limit N]',
  '  quorum approve <A-n> | deny <A-n> [reason]   ·   quorum convene <#channel> <question> [--seats vex,bolt] [--yes]',
  '  quorum channel list | channel new <name> [--room id --branch B] [--topic T]',
  '  add --json to any of these for machine-readable output',
].join('\n')

export function parseArgs(args) {
  const flags = {}
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i])
    if (arg === '--') { positional.push(...args.slice(i + 1).map(String)); break }
    if (!arg.startsWith('--') || arg === '--') { positional.push(arg); continue }
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue }
    if (BOOLEANS.has(body) || i + 1 >= args.length || String(args[i + 1]).startsWith('--')) flags[body] = true
    else flags[body] = String(args[++i])
  }
  return { flags, positional }
}

class UsageError extends Error {}
const usage = message => { throw new UsageError(message) }

/** `#general` / `general` → channel, `@codey` → that agent's DM, `T-5` → a ticket thread. */
export function parseTarget(value) {
  const text = String(value || '').trim()
  const ticket = text.match(/^T-?(\d{1,6})$/i)
  if (ticket) return { kind: 'ticket', id: `T-${Number(ticket[1])}` }
  if (text.startsWith('@')) return { kind: 'channel', id: `dm-${text.slice(1).toLowerCase()}` }
  const channel = text.replace(/^#/, '').toLowerCase()
  return channel ? { kind: 'channel', id: channel } : null
}

export async function runHq(command, args, { base, env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, fetchImpl = globalThis.fetch } = {}) {
  const { flags, positional } = parseArgs(args)
  const color = (Boolean(stdout.isTTY) && !env.NO_COLOR) || env.FORCE_COLOR === '1'
  const c = painter(color)
  const width = Math.max(60, Number(stdout.columns) || 100)
  const out = lines => stdout.write(`${Array.isArray(lines) ? lines.join('\n') : String(lines)}\n`)
  const json = value => { stdout.write(`${JSON.stringify(value, null, 2)}\n`); return 0 }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (method !== 'GET' && env.QUORUM_AGENT_RUN_ID) headers['x-quorum-run'] = env.QUORUM_AGENT_RUN_ID
    let response
    try { response = await fetchImpl(`${base}/api/hq${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }) }
    catch { throw new Error(`cannot reach the Quorum cockpit at ${base} — start it with \`quorum start\``) }
    // Everything the cockpit returns is printed to a terminal somewhere, so it
    // is made safe once, here, rather than at each of the printing sites.
    const data = safeDeep(await response.json().catch(() => ({})))
    if (!response.ok) throw new Error(data.error || `Quorum returned HTTP ${response.status}`)
    return data
  }
  const snapshot = async () => {
    const hq = await api('')
    if (!hq.ready) throw new Error('HQ is not set up yet — run `quorum hq init "<company name>" --mission "<what it is for>"`')
    return hq
  }
  const encode = value => encodeURIComponent(String(value))

  try {
    if (flags.help) { out(HQ_USAGE); return 0 }

    if (command === 'hq') {
      const sub = positional[0] || 'status'
      if (sub === 'init') {
        const name = positional.slice(1).join(' ') || flags.name
        if (!name) usage('usage: quorum hq init <company name> [--mission M] [--template studio|solo|blank] [--room <room id>] [--force]')
        const hq = await api('/init', { method: 'POST', body: { name, mission: flags.mission || '', template: flags.template || 'studio', roomId: flags.room || null, force: flags.force === true } })
        if (flags.json) return json(hq)
        out([...formatOverview(hq, { c, width }), '', c.gray(`Dashboard: ${base}/?view=hq  ·  live terminal view: quorum top`)])
        return 0
      }
      if (sub === 'verify') {
        const report = await api('/verify')
        if (flags.json) { json(report); return report.ok ? 0 : 1 }
        if (report.ok) out(c.green(`✓ log intact — ${report.messages.verified} signed messages verified, ${report.activity.total} activity entries chained (head ${report.activity.head.slice(0, 12)}…)`))
        else out([
          c.red('✗ log check failed'),
          report.messages.failed.length ? `  ${report.messages.failed.length} message signature(s) do not verify: ${report.messages.failed.slice(0, 10).join(', ')}` : null,
          report.activity.brokenAt !== null ? `  activity chain broken at entry #${report.activity.brokenAt}` : null,
          report.messages.torn || report.activity.torn ? `  torn lines: ${report.messages.torn} in messages, ${report.activity.torn} in activity` : null,
        ].filter(Boolean))
        // Recoveries made at load are reported even when the log is intact now.
        for (const item of report.recovered || []) out(c.yellow(`  recovered a torn last line in ${item.file} (${item.bytes} bytes) — kept at ${item.keptAt}`))
        if (report.corrupt) out(c.yellow(`  the saved company could not be read (${report.corrupt.error}) — kept at ${report.corrupt.file}`))
        return report.ok ? 0 : 1
      }
      if (sub !== 'status') usage(HQ_USAGE)
      const hq = await api('')
      if (flags.json) return json(hq)
      if (!hq.ready) {
        out([
          `${c.cyan(c.bold('QUORUM HQ'))}  ${c.gray('not founded yet')}`,
          ...(hq.corrupt ? ['', c.yellow(`  A saved company exists but could not be read (${hq.corrupt.error}).`), c.yellow(`  It was kept at ${hq.corrupt.file}. Repair it and restart Quorum, or found a new company with --force.`)] : []),
          '',
          `  quorum hq init "Acme" --mission "What the company is for" ${c.gray('[--template studio|solo|blank] [--room <id>]')}`,
          '',
          c.gray(`  templates: ${(hq.templates || []).map(template => `${template.id} (${template.agents.length} agents)`).join(', ')}`),
          c.gray(`  rooms: ${(hq.rooms || []).map(room => room.id).join(', ') || 'none discovered yet'}`),
        ])
        return 0
      }
      out([...formatOverview(hq, { c, width }), '', c.gray(`Dashboard: ${base}/?view=hq  ·  live terminal view: quorum top`)])
      return 0
    }

    if (command === 'org') {
      const hq = await snapshot()
      if (flags.json) return json(await api('/org'))
      out(formatOrg(hq, { c }))
      return 0
    }

    if (command === 'team') {
      const hq = await snapshot()
      if (flags.json) return json({ agents: hq.agents })
      out(formatTeam(hq, { c }))
      return 0
    }

    if (command === 'hire') {
      const name = positional.join(' ') || flags.name
      if (!name || !flags.title) usage('usage: quorum hire <name> --title <title> [--pack builder] [--runtime claude|codex] [--reports-to <id>] [--budget <usd>] [--room <id>] [--heartbeat <minutes>] [--autonomous]')
      const body = {
        name, id: flags.id, title: flags.title, packId: flags.pack, runtime: flags.runtime, modelRef: flags.model,
        reportsTo: flags['reports-to'] || null, roomId: flags.room || null, instructions: flags.instructions,
        budgetUsd: flags.budget === undefined ? undefined : Number(flags.budget),
        heartbeat: flags.heartbeat === undefined ? undefined : { enabled: true, everyMinutes: Number(flags.heartbeat) },
        autonomy: flags.autonomous ? 'autonomous' : undefined,
      }
      const result = await api('/agents', { method: 'POST', body })
      if (flags.json) return json(result)
      if (result.approval) out(`${c.yellow(result.approval.id)} ${result.approval.summary} — the board decides.`)
      else out(`Hired ${c.bold(result.agent.name)} (${result.agent.id}) as ${result.agent.title} · ${result.agent.runtime} · ${result.agent.budget.state === 'uncapped' ? 'no monthly cap' : `${money(result.agent.budget.limitUsd)}/mo`} · ${result.agent.autonomy}${result.agent.dispatchable ? '' : c.yellow(`  (${result.agent.runtime} cannot take HQ work on this machine yet)`)}`)
      return 0
    }

    if (['pause', 'resume', 'terminate', 'wake'].includes(command)) {
      const id = positional[0]
      if (!id) usage(`usage: quorum ${command} <agent>${command === 'terminate' ? ' --yes' : ''}`)
      if (command === 'terminate' && !flags.yes) {
        out(`Terminating ${id} keeps their history and signatures; their open tickets go back to the backlog and the id is never reused.\nRe-run with --yes to do it.`)
        return 1
      }
      const result = await api(`/agents/${encode(id)}/${command}`, { method: 'POST', body: {} })
      if (flags.json) return json(result)
      if (command === 'wake') out(`${id}: ${result.wakeup?.result || result.wakeup?.status || 'woken'}`)
      else if (command === 'terminate') out(`${result.agent.name} terminated.${result.released?.length ? ` Back in the backlog: ${result.released.join(', ')}.` : ''}`)
      else out(`${result.agent.name} is ${result.agent.status}.`)
      return 0
    }

    if (command === 'goal') {
      const sub = positional[0] || 'list'
      if (sub === 'add') {
        const title = positional.slice(1).join(' ')
        if (!title) usage('usage: quorum goal add <title> [--description D]')
        const { goal } = await api('/goals', { method: 'POST', body: { title, description: flags.description || '' } })
        if (flags.json) return json({ goal })
        out(`${c.bold(goal.id)} ${goal.title}`)
        return 0
      }
      if (sub !== 'list') usage('usage: quorum goal list | goal add <title>')
      const { goals } = await api('/goals')
      if (flags.json) return json({ goals })
      out(goals.length ? goals.map(goal => `${c.bold(goal.id)} ${goal.title}  ${c.gray(`${goal.progress.done}/${goal.progress.total} done · ${goal.status}`)}`) : c.gray('No goals yet — quorum goal add "<what the company is trying to achieve>"'))
      return 0
    }

    if (command === 'routine') {
      const sub = positional[0] || 'list'
      if (sub === 'add') {
        const title = positional.slice(1).join(' ')
        if (!title || !flags.assign || !flags.every) usage('usage: quorum routine add <title> --assign <agent> --every <30m|6h|1d|1w> [--body B] [--channel #c] [--priority p] [--verify "npm test"]')
        const { routine } = await api('/routines', { method: 'POST', body: { title, assigneeId: String(flags.assign).replace(/^@/, ''), every: String(flags.every), body: flags.body || '', channelId: flags.channel ? String(flags.channel).replace(/^#/, '') : undefined, priority: flags.priority, verifyCommand: flags.verify } })
        if (flags.json) return json({ routine })
        out(formatRoutines([routine], { c }))
        return 0
      }
      if (sub === 'edit') {
        if (!positional[1]) usage('usage: quorum routine edit <R-n> [--assign a] [--every e] [--title T] [--body B] [--priority p] [--channel #c] [--verify "cmd"]')
        const patch = {}
        if (flags.assign) patch.assigneeId = String(flags.assign).replace(/^@/, '')
        if (flags.every) patch.every = String(flags.every)
        if (flags.title) patch.title = String(flags.title)
        if (flags.body !== undefined) patch.body = String(flags.body)
        if (flags.priority) patch.priority = String(flags.priority)
        if (flags.channel) patch.channelId = String(flags.channel).replace(/^#/, '')
        if (flags.verify !== undefined) patch.verifyCommand = flags.verify === true ? '' : String(flags.verify)
        if (!Object.keys(patch).length) usage('nothing to change — pass --assign, --every, --title, --body, --priority, --channel or --verify')
        const { routine } = await api(`/routines/${encode(positional[1])}`, { method: 'PATCH', body: patch })
        if (flags.json) return json({ routine })
        out(formatRoutines([routine], { c }))
        return 0
      }
      if (['run', 'pause', 'resume', 'retire'].includes(sub)) {
        if (!positional[1]) usage(`usage: quorum routine ${sub} <R-n>`)
        const result = await api(`/routines/${encode(positional[1])}/${sub}`, { method: 'POST', body: {} })
        if (flags.json) return json(result)
        out(sub !== 'run' ? `${result.routine.id} is ${result.routine.status}.` : result.ticket ? `${result.routine.id} opened ${result.ticket.id} for @${result.ticket.assigneeId}.` : `${result.routine.id} skipped its turn: ${result.skipped}.`)
        return 0
      }
      if (sub !== 'list') usage('usage: quorum routine list | add | edit | run | pause | resume | retire')
      const { routines } = await api('/routines')
      if (flags.json) return json({ routines })
      out(formatRoutines(routines, { c }))
      return 0
    }

    if (command === 'search') {
      // A shell already removed the quotes, so an argument with a space in it
      // was a phrase: it is quoted again to stay one — unless it carries its
      // own in: or from: filter, which a phrase would swallow.
      const query = positional.map(item => (/\s/.test(item) && !/(^|\s)(in|from):/i.test(item) ? `"${item.replace(/"/g, '')}"` : item)).join(' ')
      if (!query) usage('usage: quorum search <words | "a phrase" | in:#channel | from:@agent> [--limit N]')
      const result = await api(`/search?q=${encodeURIComponent(query)}${flags.limit ? `&limit=${encodeURIComponent(flags.limit)}` : ''}`)
      if (flags.json) return json(result)
      out(formatSearch(result, await api(''), { c, width }))
      return 0
    }

    if (command === 'ticket') {
      const sub = positional[0] || 'list'
      const id = positional[1]
      if (sub === 'list') {
        const query = new URLSearchParams()
        if (flags.status) query.set('status', flags.status)
        if (flags.assignee) query.set('assignee', flags.assignee)
        const [{ tickets }, hq] = await Promise.all([api(`/tickets${query.size ? `?${query}` : ''}`), snapshot()])
        if (flags.json) return json({ tickets })
        out(formatTickets(tickets, hq, { c }))
        return 0
      }
      if (sub === 'new') {
        const title = positional.slice(1).join(' ')
        if (!title) usage('usage: quorum ticket new <title> [--assign agent] [--body B] [--goal G-1] [--priority low|normal|high|urgent] [--blocked-by T-1,T-2] [--verify "npm test"]')
        const { ticket } = await api('/tickets', { method: 'POST', body: {
          title, body: flags.body || '', assigneeId: flags.assign || null, goalId: flags.goal || null, priority: flags.priority,
          blockedBy: flags['blocked-by'] ? String(flags['blocked-by']).split(',') : [], verifyCommand: flags.verify || null,
          channelId: flags.channel ? String(flags.channel).replace(/^#/, '') : undefined, roomId: flags.room || null, branch: flags.branch || null,
        } })
        if (flags.json) return json({ ticket })
        out(`${c.bold(ticket.id)} opened${ticket.assigneeId ? ` for @${ticket.assigneeId}` : ''}: ${ticket.title}`)
        return 0
      }
      if (!id) usage(`usage: quorum ticket ${sub} <T-n>${sub === 'assign' ? ' <agent>' : ''}`)
      if (sub === 'show') {
        const [detail, hq] = await Promise.all([api(`/tickets/${encode(id)}`), snapshot()])
        if (flags.json) return json(detail)
        out(formatTicketDetail(detail, hq, { c, width }))
        return 0
      }
      if (sub === 'assign') {
        if (!positional[2]) usage('usage: quorum ticket assign <T-n> <agent>')
        const { ticket } = await api(`/tickets/${encode(id)}/assign`, { method: 'POST', body: { agentId: positional[2] } })
        if (flags.json) return json({ ticket })
        out(`${ticket.id} → @${ticket.assigneeId}`)
        return 0
      }
      if (sub === 'start') {
        // Always preview first. With --yes the previewed plan is confirmed by
        // its hash, so what starts is exactly what was just printed.
        const { preview: p } = await api(`/tickets/${encode(id)}/dispatch`, { method: 'POST', body: {} })
        const lines = [
          `${c.bold(p.ticketId)} → ${p.agentId} on ${p.runtime} (${p.modelRef})${p.room ? ` in ${p.room.label}` : ''}${p.branch ? ` on ${p.branch}` : ''}`,
          p.verify ? `checked by: ${p.verify}` : null,
          p.ready ? c.green('ready to start') : c[p.transient ? 'yellow' : 'red'](`${p.transient ? 'not yet' : 'cannot start'}: ${p.reason}`),
          `budget: ${money(p.budget.spentUsd)} of ${money(p.budget.limitUsd)} this month${p.dailyCeiling ? ` · daily ceiling: ${p.dailyCeiling}` : ''}`,
          c.gray(p.note),
        ].filter(Boolean)
        if (flags.yes !== true || !p.ready) {
          if (flags.json) return json({ requiresConfirmation: true, preview: p })
          out([...lines, p.ready ? 'Re-run with --yes to start it.' : null].filter(Boolean))
          return p.ready ? 0 : 1
        }
        const result = await api(`/tickets/${encode(id)}/dispatch`, { method: 'POST', body: { confirm: true, expect: p.planHash } })
        if (flags.json) return json(result)
        out([...lines, `${result.ticket.id} started — run ${result.run.runId} (mission ${result.run.missionId}). Watch: quorum chat ${result.ticket.id} --follow`])
        return 0
      }
      if (['close', 'reopen', 'cancel'].includes(sub)) {
        const result = await api(`/tickets/${encode(id)}/${sub}`, { method: 'POST', body: {} })
        if (flags.json) return json(result)
        out(sub === 'cancel' ? `Cancelling the run on ${result.ticket.id}.` : `${result.ticket.id} is ${result.ticket.status}${sub === 'close' ? ' (closed by the board, not verified by a run)' : ''}.`)
        return 0
      }
      usage('usage: quorum ticket list|new|show|assign|start|close|reopen|cancel')
    }

    if (command === 'say') {
      const target = parseTarget(positional[0])
      const text = positional.slice(1).join(' ')
      if (!target || !text) usage('usage: quorum say <#channel|@agent|T-n> <text>')
      const result = target.kind === 'ticket'
        ? await api(`/tickets/${encode(target.id)}/comment`, { method: 'POST', body: { text } })
        : await api(`/channels/${encode(target.id)}/messages`, { method: 'POST', body: { text } })
      if (flags.json) return json(result)
      const where = target.kind === 'ticket' ? target.id : target.id.startsWith('dm-') ? `@${target.id.slice(3)}` : `#${target.id}`
      out([
        `posted to ${where}`,
        ...(result.tickets || []).map(ticket => `  ${c.bold(ticket.id)} opened for @${ticket.assigneeId}: ${ticket.title}`),
        result.result?.error ? c.red(`  ${result.result.error}`) : null,
      ].filter(Boolean))
      return 0
    }

    if (command === 'chat') {
      const target = parseTarget(positional[0] || '#general')
      const limit = Math.max(1, Math.min(Number(flags.limit) || 30, 500))
      const load = async () => target.kind === 'ticket'
        ? (await api(`/tickets/${encode(target.id)}`)).thread.slice(-limit)
        : (await api(`/channels/${encode(target.id)}/messages?limit=${limit}`)).messages
      const [messages, hq] = await Promise.all([load(), snapshot()])
      if (flags.json) return json({ messages })
      out(formatMessages(messages, hq, { c, width }))
      if (!flags.follow) return 0
      const seen = new Set(messages.map(message => message.id))
      return await new Promise(resolve => {
        const timer = setInterval(async () => {
          try {
            const [fresh, current] = await Promise.all([load(), snapshot()])
            const unseen = fresh.filter(message => !seen.has(message.id))
            for (const message of unseen) seen.add(message.id)
            if (unseen.length) out(formatMessages(unseen, current, { c, width }))
          } catch (error) { stderr.write(`quorum: ${error.message}\n`) }
        }, Math.max(1, Number(flags.interval) || 2) * 1000)
        const stop = () => { clearInterval(timer); resolve(0) }
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      })
    }

    if (command === 'inbox') {
      const hq = await snapshot()
      if (flags.json) return json({ approvals: hq.approvals.filter(item => item.status === 'pending'), blocked: hq.tickets.filter(ticket => ticket.status === 'blocked'), paused: hq.agents.filter(agent => agent.status === 'paused') })
      out(formatInbox(hq, { c }))
      return 0
    }

    if (command === 'approve' || command === 'deny') {
      const id = positional[0]
      if (!id) usage(`usage: quorum ${command} <A-n>${command === 'deny' ? ' [reason]' : ''}`)
      const result = command === 'approve'
        ? await api(`/approvals/${encode(id)}/approve`, { method: 'POST', body: {} })
        : await api(`/approvals/${encode(id)}/deny`, { method: 'POST', body: { reason: positional.slice(1).join(' ') } })
      if (flags.json) return json(result)
      if (command === 'deny') out(`${result.approval.id} denied.`)
      else if (result.agent) out(`${result.approval.id} approved — hired ${result.agent.name} as ${result.agent.title}.`)
      else if (result.run) out(`${result.approval.id} approved — ${result.ticket.id} started, run ${result.run.runId}. Watch: quorum chat ${result.ticket.id} --follow`)
      else out(`${result.approval.id} approved.`)
      return 0
    }

    if (command === 'budget') {
      const budgets = await api('/budget')
      if (flags.json) return json(budgets)
      out(formatBudget(budgets, { c }))
      return 0
    }

    if (command === 'activity') {
      const { activity } = await api(`/activity?limit=${Math.max(1, Math.min(Number(flags.limit) || 30, 200))}`)
      if (flags.json) return json({ activity })
      out(activity.length ? formatActivity(activity, { c }) : c.gray('No activity yet.'))
      return 0
    }

    if (command === 'convene') {
      const target = parseTarget(positional[0])
      const question = positional.slice(1).join(' ')
      if (!target || target.kind !== 'channel' || !question) usage('usage: quorum convene <#channel> <question> [--seats vex,bolt] [--model claude:sonnet] [--yes]')
      const result = await api('/convene', { method: 'POST', body: { channelId: target.id, question, participants: flags.seats ? String(flags.seats).split(',') : undefined, model: flags.model || 'claude:sonnet', confirm: flags.yes === true } })
      if (flags.json) return json(result)
      if (result.requiresConfirmation) {
        const p = result.preview
        out([`Roundtable on “${p.question}” — ${p.participants.join(', ')}`, `${p.turns} turns · ${p.local ? 'local model, no API cost' : `est. ~${money(p.estimateUsd)}`} on ${p.label}${p.available ? '' : c.red(' (not available in this environment)')}`, 'Re-run with --yes to convene it. The verdict posts to the channel and #decisions.'])
        return 0
      }
      out(`Roundtable ${result.debate.id} convened in #${target.id}. The verdict will post there.`)
      return 0
    }

    if (command === 'channel') {
      const sub = positional[0] || 'list'
      if (sub === 'new') {
        const name = positional[1]
        if (!name) usage('usage: quorum channel new <name> [--room <id> --branch <branch>] [--topic T]')
        const { channel } = await api('/channels', { method: 'POST', body: { name, topic: flags.topic || '', roomId: flags.room || null, branch: flags.branch || null } })
        if (flags.json) return json({ channel })
        out(`#${channel.id} created${channel.branch ? ` — the room for ${channel.branch} in ${channel.roomId}` : ''}.`)
        return 0
      }
      const { channels } = await api('/channels')
      if (flags.json) return json({ channels })
      out(channels.filter(channel => channel.kind !== 'dm').map(channel => `${c.bold(`#${channel.id}`)}${channel.branch ? c.magenta(`  ⎇ ${channel.branch}`) : ''}${channel.roomId ? c.gray(`  ▣ ${channel.roomId}`) : ''}  ${c.gray(channel.topic || '')}`))
      return 0
    }

    if (command === 'top') return await runTop({ api, base, flags, stdout, stdin, color, fetchImpl, out })

    usage(HQ_USAGE)
  } catch (error) {
    if (error instanceof UsageError) { stderr.write(`${error.message}\n`); return 2 }
    stderr.write(`quorum: ${error.message}\n`)
    return 1
  }
  return 0
}

/** `quorum top`: the company, live, in the terminal. */
async function runTop({ api, base, flags, stdout, stdin, color, fetchImpl, out }) {
  const channel = String(flags.channel || 'general').replace(/^#/, '')
  const load = async () => {
    const [hq, health] = await Promise.all([
      api('').catch(() => null),
      fetchImpl(`${base}/health`).then(response => response.json()).catch(() => null),
    ])
    return { hq, health }
  }
  const frame = (state, tick) => renderTopFrame(state.hq, state.health, { width: Number(stdout.columns) || 100, height: Number(stdout.rows) || 32, tick, color, channel })

  if (flags.once || !stdout.isTTY) {
    const state = await load()
    out(frame(state, 0))
    return state.hq ? 0 : 1
  }

  let state = await load()
  let tick = 0
  const draw = () => stdout.write(`\x1b[H${frame(state, tick)}\x1b[J`)
  stdout.write('\x1b[?1049h\x1b[?25l')
  draw()
  return await new Promise(resolve => {
    const animate = setInterval(() => { tick += 1; draw() }, 200)
    const poll = setInterval(async () => { state = await load() }, Math.max(1, Number(flags.interval) || 2) * 1000)
    const onKey = key => {
      const text = String(key)
      if (text === 'q' || text === '\u0003' || text === '\u001b') finish()
      if (text === 'r') void load().then(next => { state = next; draw() })
    }
    const finish = () => {
      clearInterval(animate)
      clearInterval(poll)
      stdout.off?.('resize', draw)
      stdin.off?.('data', onKey)
      try { stdin.setRawMode?.(false) } catch { /* not a TTY after all */ }
      stdin.pause?.()
      stdout.write('\x1b[?25h\x1b[?1049l')
      resolve(0)
    }
    stdout.on?.('resize', draw)
    try { stdin.setRawMode?.(true) } catch { /* keys still arrive line-buffered */ }
    stdin.resume?.()
    stdin.on?.('data', onKey)
    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
  })
}
