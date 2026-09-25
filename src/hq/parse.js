// Pure parsing for HQ chat: agent ids, @mentions, /commands, ticket titles.
//
// Kept free of state so the rules a message is judged by are testable on their
// own: what counts as a mention, which commands exist, and how a mention turns
// into a ticket title. Nothing here guesses — an @word that is not a known
// agent is plain text, and an unknown /command is reported, not ignored.

export const AGENT_ID = /^[a-z][a-z0-9-]{1,31}$/
export const TICKET_ID = /^T-\d{1,6}$/
export const GOAL_ID = /^G-\d{1,6}$/
export const CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
export const APPROVAL_ID = /^A-\d{1,6}$/
export const ROUTINE_ID = /^R-\d{1,6}$/

export const COMMANDS = {
  ticket: { usage: '/ticket <title>', summary: 'open an unassigned ticket in this channel' },
  assign: { usage: '/assign T-<n> @agent', summary: 'assign a ticket and wake the assignee' },
  goal: { usage: '/goal <title>', summary: 'add a company goal' },
  wake: { usage: '/wake @agent', summary: 'queue a heartbeat for an agent now' },
  close: { usage: '/close T-<n>', summary: 'mark a ticket done' },
  convene: { usage: '/convene <question>', summary: 'propose a roundtable here (shows turns and cost before anything runs)' },
  routine: { usage: '/routine <every> @agent <title>', summary: 'open a ticket for that agent on a schedule — every 6h, 1d, 1w…' },
  help: { usage: '/help', summary: 'list commands' },
}

/** A stable agent id from a display name: "Codey Two" → "codey-two". */
export function slugify(value) {
  const slug = String(value || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32).replace(/-$/, '')
  return AGENT_ID.test(slug) ? slug : ''
}

/**
 * Agent ids mentioned in `text`, in first-mention order, deduplicated.
 * `known` maps a lowercase handle (id or name) to an agent id.
 */
export function parseMentions(text, known) {
  const out = []
  for (const match of String(text || '').matchAll(/(^|[^\w@])@([a-z][\w-]{0,31})/gi)) {
    const id = known.get(match[2].toLowerCase())
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** `{ name, rest, known }` for a message that starts with "/", else null. */
export function parseCommand(text) {
  const match = String(text || '').trim().match(/^\/([a-z]+)\b\s*([\s\S]*)$/i)
  if (!match) return null
  const name = match[1].toLowerCase()
  return { name, rest: match[2].trim(), known: Object.hasOwn(COMMANDS, name) }
}

/** The first ticket id mentioned in `text`, normalised to "T-12". */
export function parseTicketRef(text) {
  const match = String(text || '').match(/\bT-?(\d{1,6})\b/i)
  return match ? `T-${Number(match[1])}` : null
}

/** A ticket title from a message: mentions removed, whitespace collapsed, bounded. */
export function ticketTitleFrom(text, max = 120) {
  const stripped = String(text || '').replace(/(^|\s)@[a-z][\w-]{0,31}\b[,:]?/gi, ' ').replace(/\s+/g, ' ').trim()
  if (!stripped) return ''
  const sentence = stripped.match(/^(.{8,}?[.!?])(\s|$)/)?.[1] || stripped
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence
}

/**
 * Control characters removed, tab and newline kept. Stored text is printed to
 * terminals by the CLI and `quorum top`; an ESC sequence in a message or an
 * agent's name could otherwise rewrite the screen, set the clipboard (OSC 52)
 * or forge a line such as "approved by the board".
 */
export const stripControl = value => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')

export const clip = (value, max) => {
  const text = stripControl(value).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** Multi-line text kept readable: trims each line, caps line count and length. */
export function clipBlock(value, max = 4000, maxLines = 60) {
  const lines = stripControl(value).split('\n').map(line => line.replace(/[ \t]+/g, ' ').trimEnd())
  const text = lines.slice(0, maxLines).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

// ── schedules ─────────────────────────────────────────────────────────────

export const EVERY_MIN_MINUTES = 15
export const EVERY_MAX_MINUTES = 30 * 24 * 60
const EVERY_WORDS = { hourly: 60, daily: 1440, weekly: 10080 }
const EVERY_UNITS = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: 1440, day: 1440, days: 1440, w: 10080, wk: 10080, week: 10080, weeks: 10080 }

/**
 * How often a routine fires, in minutes: a number of minutes, `30m`, `6h`,
 * `1d`, `2w`, or `hourly` / `daily` / `weekly`. Null for anything else, or
 * for a schedule outside 15 minutes to 30 days.
 */
export function parseEvery(value) {
  let minutes = null
  if (typeof value === 'number') minutes = value
  else {
    const text = String(value ?? '').trim().toLowerCase()
    if (Object.hasOwn(EVERY_WORDS, text)) minutes = EVERY_WORDS[text]
    else {
      const match = text.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/)
      if (match) minutes = Number(match[1]) * (match[2] ? (Object.hasOwn(EVERY_UNITS, match[2]) ? EVERY_UNITS[match[2]] : NaN) : 1)
    }
  }
  if (!Number.isFinite(minutes)) return null
  minutes = Math.round(minutes)
  return minutes >= EVERY_MIN_MINUTES && minutes <= EVERY_MAX_MINUTES ? minutes : null
}

/** `1440` → `1d`, `90` → `90m`: the shortest exact way to say a schedule. */
export function formatEvery(minutes) {
  const n = Number(minutes) || 0
  if (n && n % 10080 === 0) return `${n / 10080}w`
  if (n && n % 1440 === 0) return `${n / 1440}d`
  if (n && n % 60 === 0) return `${n / 60}h`
  return `${n}m`
}

// ── search ────────────────────────────────────────────────────────────────

/**
 * A search box's text as `{ terms, channel, author }`. Words and "quoted
 * phrases" must all appear (case-insensitive); `in:#channel` and
 * `from:@agent` (or `from:board`, `from:system`, `from:"Two Words"`) narrow
 * where and who. Every term is kept: a caller that cannot honour them all
 * says so rather than quietly searching for fewer.
 */
export function parseSearch(query) {
  const text = stripControl(query).slice(0, 300)
  const out = { terms: [], channel: null, author: null }
  let tokens = 0
  for (const match of text.matchAll(/(in|from):"([^"]*)"|"([^"]*)"|(\S+)/gi)) {
    if (++tokens > 40) break
    if (match[1]) {
      const value = match[2].trim().toLowerCase().replace(/^[#@]/, '') || null
      if (match[1].toLowerCase() === 'in') out.channel = value
      else out.author = value
      continue
    }
    const token = (match[3] ?? match[4] ?? '').trim()
    if (!token) continue
    const lower = token.toLowerCase()
    if (match[4] !== undefined && lower.startsWith('in:')) { out.channel = lower.slice(3).replace(/^#/, '') || null; continue }
    if (match[4] !== undefined && lower.startsWith('from:')) { out.author = lower.slice(5).replace(/^@/, '') || null; continue }
    out.terms.push(lower)
  }
  out.terms = [...new Set(out.terms)]
  return out
}
