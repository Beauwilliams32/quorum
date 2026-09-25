// Company templates: a starting org chart and channels for `quorum hq init`.
//
// A template hires configured agents; it does not start anything. Every agent
// begins idle, supervised (its first run waits for your approval), with its
// heartbeat off and a monthly budget cap. Nothing in a template spends money
// until you hand an agent a ticket and approve the run.

export const DEFAULT_CHANNELS = {
  general: { name: 'general', topic: 'Company-wide. @mention an agent to hand them work; /help lists commands.' },
  decisions: { name: 'decisions', topic: 'Roundtable verdicts land here, with the dissent that survived.' },
  ops: { name: 'ops', topic: 'Budgets, heartbeats, approvals and system notices.' },
}

export const TEMPLATES = {
  studio: {
    label: 'Studio',
    summary: 'A chief of staff with research, engineering, design, QA and release reports.',
    channels: ['general', 'decisions', 'ops'],
    agents: [
      { id: 'atlas', name: 'Atlas', title: 'Chief of Staff', packId: 'scout', runtime: 'claude', modelRef: 'claude:sonnet', reportsTo: null, budgetUsd: 20,
        instructions: 'Break goals into small, verifiable tickets and hand each one to the report best placed to do it. Prefer delegating over doing.',
        avatar: { palette: 'gold', visor: 'wide', crest: 'nib', prop: 'clipboard' } },
      { id: 'scout', name: 'Scout', title: 'Research Lead', packId: 'scout', runtime: 'claude', modelRef: 'claude:haiku', reportsTo: 'atlas', budgetUsd: 10,
        instructions: 'Map the code, docs and history before anyone edits. Cite files and commits.',
        avatar: { palette: 'sky', visor: 'dot', crest: 'antenna', prop: 'magnifier' } },
      { id: 'codey', name: 'Codey', title: 'Lead Engineer', packId: 'builder', runtime: 'codex', modelRef: 'codex:auto', reportsTo: 'atlas', budgetUsd: 25,
        instructions: 'Implement the ticket, run the project gates, and leave an auditable change.',
        avatar: { palette: 'mint', visor: 'square', crest: 'spark', prop: 'wrench' } },
      { id: 'pixel', name: 'Pixel', title: 'Product Designer', packId: 'builder', runtime: 'claude', modelRef: 'claude:sonnet', reportsTo: 'atlas', budgetUsd: 15,
        instructions: 'Own the interface: naming, defaults, empty states and the path a first-time user takes.',
        avatar: { palette: 'rose', visor: 'curve', crest: 'plume', prop: 'brush' } },
      { id: 'sentry', name: 'Sentry', title: 'QA Engineer', packId: 'qa', runtime: 'codex', modelRef: 'codex:auto', reportsTo: 'codey', budgetUsd: 10,
        instructions: 'Exercise the product and report reproducible failures. Never mutate what you test.',
        avatar: { palette: 'violet', visor: 'narrow', crest: 'horns', prop: 'lantern' } },
      { id: 'milo', name: 'Milo', title: 'Release Engineer', packId: 'release', runtime: 'claude', modelRef: 'claude:sonnet', reportsTo: 'codey', budgetUsd: 10,
        instructions: 'Prepare release notes, tags and the rollback path. External releases stay with the board.',
        avatar: { palette: 'ember', visor: 'slit', crest: 'bolt', prop: 'compass' } },
    ],
  },
  solo: {
    label: 'Solo',
    summary: 'One engineer who reports straight to you.',
    channels: ['general', 'decisions'],
    agents: [
      { id: 'codey', name: 'Codey', title: 'Engineer', packId: 'builder', runtime: 'claude', modelRef: 'claude:sonnet', reportsTo: null, budgetUsd: 20,
        instructions: 'Implement the ticket, run the project gates, and leave an auditable change.',
        avatar: { palette: 'mint', visor: 'square', crest: 'spark', prop: 'wrench' } },
    ],
  },
  blank: {
    label: 'Blank',
    summary: 'Just the #general channel. Hire your own team.',
    channels: ['general'],
    agents: [],
  },
}

export function publicTemplates() {
  return Object.entries(TEMPLATES).map(([id, template]) => ({
    id, label: template.label, summary: template.summary,
    agents: template.agents.map(agent => ({ id: agent.id, name: agent.name, title: agent.title, runtime: agent.runtime })),
    channels: [...template.channels],
  }))
}
