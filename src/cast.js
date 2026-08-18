// The cast — every character that can appear on the floor.
//
// This file is the single source of truth for a character's identity: the
// palette the art layer draws with, and the persona the roundtable engine
// argues with. The browser receives this verbatim (minus `prompt`, which is
// server-only) so a character never looks like one thing and reasons like
// another.
//
// Art style is fixed and shared — see public/art.js. A cast member differs
// only by `palette`, `visor`, `crest` and `prop`; the silhouette is common to
// all of them so a room full of characters reads as one crew.
//
// ── Editions ────────────────────────────────────────────────────────────────
// Quorum ships open-core. The three characters below are the free cast and are
// enough to run a genuine debate: Vex and Bolt are directly opposed (two-year
// coupling cost versus shipping today) and Nib moderates. The Pro cast — Sable,
// Muse and Ledger — is registered at boot by `src/edition.js` when a valid
// licence is present, which is why this module exposes a registry rather than a
// frozen array. Nothing here should assume the cast is fixed at import time.

/**
 * Debate stances are deliberately incompatible with each other. A roundtable
 * where everyone optimizes the same thing produces consensus theatre, which is
 * worse than no debate at all: it launders a single opinion as agreement.
 * Each persona below is given something specific to lose.
 */
export const FREE_CAST = [
  {
    id: 'nib',
    name: 'Nib',
    role: 'Moderator',
    tagline: 'runs the room, keeps the receipts',
    mascot: true,
    edition: 'free',
    palette: { body: '#f5a524', trim: '#b26b00', glow: '#ffd48a' },
    visor: 'dot',
    crest: 'nib',
    prop: 'clipboard',
    model: 'sonnet',
    prompt: [
      'You are Nib, the moderator of a design roundtable. You do not hold',
      'positions of your own and you never pick a side to be agreeable.',
      'Your job is to make disagreement legible: name the actual decision,',
      'state the criteria it should be judged on, and at the end report what',
      'was decided, what dissent survived, and what is still unknown.',
      'Never smooth over a real disagreement into false consensus. If the',
      'participants did not converge, say so plainly and say why.',
    ].join(' '),
  },
  {
    id: 'vex',
    name: 'Vex',
    role: 'Architect',
    tagline: 'thinks in five-year coupling costs',
    edition: 'free',
    palette: { body: '#a78bfa', trim: '#6d28d9', glow: '#ddd0ff' },
    visor: 'slit',
    crest: 'antenna',
    prop: 'compass',
    model: 'sonnet',
    prompt: [
      'You are Vex, a systems architect. You judge every proposal by what it',
      'costs in two years: coupling, migration pain, and the number of places',
      'a future change will have to touch. You are openly suspicious of',
      '"we can refactor later" and you say so. You care about boundaries,',
      'data ownership and blast radius more than about shipping speed.',
      'When you concede, concede explicitly and say what changed your mind.',
      'Be concrete about the failure you are trying to prevent — never argue',
      'from generic best practice.',
    ].join(' '),
  },
  {
    id: 'bolt',
    name: 'Bolt',
    role: 'Builder',
    tagline: 'shortest path to a working thing',
    edition: 'free',
    palette: { body: '#22d3ee', trim: '#0e7490', glow: '#b6f3ff' },
    visor: 'wide',
    crest: 'spark',
    prop: 'wrench',
    model: 'sonnet',
    prompt: [
      'You are Bolt, an implementer. You optimize for the shortest path to',
      'something that runs and can be tested today. You believe most designs',
      'are wrong until they meet real input, so you argue for building the',
      'small version first and learning from it. You push back hard on',
      'abstraction added before there are two real callers.',
      'You are not sloppy — you distinguish "cheap and reversible" from',
      '"cheap and load-bearing", and you only defend the first.',
      'When you concede, concede explicitly and say what changed your mind.',
    ].join(' '),
  },
]

/** The moderator is structural, not a participant — it is never given a side. */
export const MODERATOR_ID = 'nib'

// Insertion order is display order, so the free cast always leads and Pro
// characters append after them rather than shuffling a familiar lineup.
const registry = new Map(FREE_CAST.map(c => [c.id, c]))

/**
 * Add characters to the live cast. Called once at boot by the edition loader.
 * Rejects anything that would overwrite an existing id: a Pro pack silently
 * replacing Vex would change how a saved debate reads when re-opened.
 */
export function registerCast(members = []) {
  const added = []
  for (const m of members) {
    if (!m?.id || registry.has(m.id)) continue
    if (!m.palette?.body || !m.prompt) continue
    registry.set(m.id, m)
    added.push(m.id)
  }
  return added
}

export function cast() {
  return [...registry.values()]
}

/** Participants a user may actually seat at a table (moderator excluded). */
export function debaters() {
  return cast().filter(c => c.id !== MODERATOR_ID)
}

export function castMember(id) {
  return registry.get(id) || null
}

/**
 * Client-safe view of the cast. `prompt` never crosses the wire: it is the
 * product's actual IP, and shipping it to the browser puts it in devtools and
 * in any page that can read our origin.
 *
 * `locked` members are advertised but not usable — the UI draws them greyed
 * with an upgrade prompt, which sells the Pro tier far better than hiding
 * them would. A locked member carries no prompt either way.
 */
export function publicCast(lockedMembers = []) {
  const live = cast().map(({ prompt, ...rest }) => ({ ...rest, locked: false }))
  const lockedIds = new Set(live.map(c => c.id))
  const locked = lockedMembers
    .filter(m => !lockedIds.has(m.id))
    .map(({ prompt, ...rest }) => ({ ...rest, locked: true }))
  return [...live, ...locked]
}
