// The brief an HQ agent receives when it picks up a ticket.
//
// Structured handoff, not a transcript dump: who you are, who you report to,
// the goal the ticket serves, the ticket itself, the last few thread messages,
// and how to report back. Bounded so the runtime manager's 8,000-character
// packet limit never has to cut the instructions off the end.

import { clip, clipBlock } from './parse.js'

const MAX_PROMPT = 7_500

/** A stored verify command as the words a person would type. */
export function verifyText(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  return [value.command, ...(Array.isArray(value.args) ? value.args : [])].filter(Boolean).join(' ')
}

export function buildWorkPrompt({ company, agent, manager = null, reports = [], goal = null, ticket, thread = [], blockers = [], cli = 'quorum' }) {
  const head = [
    `You are ${agent.name}, ${agent.title} at ${company?.name || 'this company'}.`,
    agent.instructions ? clipBlock(agent.instructions, 1200) : '',
    company?.mission ? `Company mission: ${clip(company.mission, 500)}` : '',
    manager ? `You report to ${manager.name} (${manager.title}).` : 'You report to the board — the human operator of this Quorum.',
    goal ? `This ticket serves goal ${goal.id}: ${clip(goal.title, 160)}${goal.description ? ` — ${clip(goal.description, 400)}` : ''}` : '',
  ].filter(Boolean)

  const work = [
    `Ticket ${ticket.id} (${ticket.priority} priority): ${clip(ticket.title, 160)}`,
    ticket.body && ticket.body !== ticket.title ? clipBlock(ticket.body, 2500) : '',
    ticket.branch ? `Work on branch: ${clip(ticket.branch, 120)}` : '',
    blockers.length ? `Resolved prerequisites: ${blockers.map(item => `${item.id} ${clip(item.title, 80)}`).join('; ')}` : '',
    ticket.verifyCommand ? `Quorum will verify this ticket by running: ${verifyText(ticket.verifyCommand)}` : '',
  ].filter(Boolean)

  const recent = thread.filter(message => message.text && message.card?.type !== 'ticket').slice(-8)
  let budget = 1500
  const lines = []
  for (const message of recent.reverse()) {
    const who = message.author?.kind === 'board' ? 'board' : message.author?.kind === 'agent' ? message.author.id : 'system'
    const line = `- ${who}: ${clip(message.text, 400)}`
    if (line.length > budget) break
    budget -= line.length
    lines.unshift(line)
  }

  // The final summary always arrives: Quorum reads it from the run itself.
  // The CLI callbacks only work when the harness is allowed to run shell
  // commands, so they are offered as an extra, never as the way to report.
  const delegate = reports.length
    ? `If you can run shell commands, hand follow-up work to someone who reports to you with: ${cli} ticket new "<title>" --assign <id> --body "<details>". Your reports: ${reports.map(item => `${item.id} (${item.title})`).join(', ')}.`
    : 'Nobody reports to you; do the work yourself or say what is blocking you.'

  const report = [
    'How to report:',
    '- Finish with a short summary of what you did, how you checked it, and what is left. Quorum posts it to the ticket thread under your name; this is the report that always arrives.',
    `- If your harness lets you run shell commands, you can also post an update while you work: ${cli} say ${ticket.id} "<update>"`,
    `- ${delegate}`,
    '- Approving spend, deploying, publishing and hiring are the board\'s decisions. Ask for them in your summary; do not do them.',
  ]

  const sections = [head.join('\n'), work.join('\n'), lines.length ? `Recent thread (newest last):\n${lines.join('\n')}` : '', report.join('\n')].filter(Boolean)
  const text = sections.join('\n\n')
  return text.length > MAX_PROMPT ? `${text.slice(0, MAX_PROMPT - 1)}…` : text
}
