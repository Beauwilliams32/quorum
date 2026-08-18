/* Character art — one silhouette, six identities.
 *
 * Everything here is hand-authored SVG generated from the cast palette. That is
 * a deliberate choice over shipping raster art or generating it: the operator
 * runs offline on loopback, the characters must recolour with the theme, and an
 * avatar is drawn at 28px in a room and 160px in a portrait from the same
 * source. Raster assets would need six sizes each and would not tint.
 *
 * The style is fixed so a floor full of characters reads as one crew:
 *   · a single dark ink outline, never a lighter one
 *   · flat body fill plus exactly one soft highlight
 *   · no mouth — expression lives entirely in the visor shape
 *   · no arms; hands float, which is what makes the poses cheap to vary
 *
 * A character differs ONLY by palette, visor, crest and prop (see src/cast.js).
 * Resist adding per-character body shapes: the shared silhouette is the reason
 * the set looks designed rather than assembled.
 */
'use strict'

const INK = '#12141c'

/* Level of detail. A 34px avatar with a held prop reads as mud, so detail is
 * added by size rather than drawn once and scaled down.
 *
 * The crest is the exception and is drawn at every size: colour alone does not
 * separate six characters standing in a dim room, and the crest is the only
 * part of the silhouette that differs between them. Hands and props are what
 * actually turn to mud, so those are the ones gated on size. */
const LOD = { avatar: 34, bust: 72, portrait: 160 }

/* ── crests: sit on top of the head, y ≈ 18 ─────────────────────────── */
const CRESTS = {
  nib: p => `<path d="M50 2 L58 18 L50 15 L42 18 Z" fill="${p.glow}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`,
  antenna: p => `<path d="M50 18 L50 6" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>` +
    `<circle cx="50" cy="4" r="4.5" fill="${p.glow}" stroke="${INK}" stroke-width="3"/>`,
  spark: p => `<path d="M50 3 L53 13 L63 10 L55 18 M50 3 L47 13 L37 10 L45 18" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="50" cy="13" r="3" fill="${p.glow}"/>`,
  horns: p => `<path d="M34 20 L30 6 L42 16 Z M66 20 L70 6 L58 16 Z" fill="${p.trim}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`,
  plume: p => `<path d="M50 18 C50 8 56 2 66 2 C66 12 60 18 50 18 Z" fill="${p.glow}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`,
  bolt: p => `<path d="M52 2 L40 16 L49 16 L46 26 L60 11 L51 11 Z" fill="${p.glow}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`,
}

/* ── visors: the entire emotional range of the cast ─────────────────── */
const VISORS = {
  dot: () => `<circle cx="42" cy="37" r="4.5" fill="${INK}"/><circle cx="58" cy="37" r="4.5" fill="${INK}"/>`,
  slit: () => `<rect x="33" y="34" width="34" height="6" rx="3" fill="${INK}"/>`,
  wide: p => `<rect x="31" y="29" width="38" height="16" rx="8" fill="${INK}"/>` +
    `<circle cx="42" cy="37" r="3" fill="${p.glow}"/><circle cx="57" cy="37" r="3" fill="${p.glow}"/>`,
  narrow: () => `<path d="M33 32 L48 37 L33 41 Z M67 32 L52 37 L67 41 Z" fill="${INK}"/>`,
  curve: p => `<path d="M32 34 Q50 46 68 34" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>` +
    `<circle cx="41" cy="34" r="2.5" fill="${p.glow}"/><circle cx="59" cy="34" r="2.5" fill="${p.glow}"/>`,
  square: p => `<rect x="32" y="30" width="15" height="14" rx="3" fill="${INK}"/>` +
    `<rect x="53" y="30" width="15" height="14" rx="3" fill="${INK}"/>` +
    `<path d="M47 37 L53 37" stroke="${INK}" stroke-width="3"/>` +
    `<circle cx="39" cy="37" r="2.5" fill="${p.glow}"/><circle cx="60" cy="37" r="2.5" fill="${p.glow}"/>`,
}

/* ── props: portrait size only, held at the right hand ──────────────── */
const PROPS = {
  clipboard: p => `<g transform="translate(78 68) rotate(12)"><rect x="-8" y="-11" width="17" height="22" rx="2.5" fill="${p.glow}" stroke="${INK}" stroke-width="3"/>` +
    `<rect x="-4" y="-14" width="9" height="5" rx="2" fill="${p.trim}" stroke="${INK}" stroke-width="2.5"/>` +
    `<path d="M-4 -3 H5 M-4 3 H2" stroke="${INK}" stroke-width="2" stroke-linecap="round"/></g>`,
  compass: p => `<g transform="translate(78 68)"><circle r="11" fill="${p.glow}" stroke="${INK}" stroke-width="3"/>` +
    `<path d="M-4 5 L2 -6 L5 -2 Z" fill="${INK}"/></g>`,
  wrench: p => `<g transform="translate(78 68) rotate(-35)"><path d="M-2 10 L-2 -4 M-6 -6 a6 6 0 1 1 8 0 L2 -2 L-6 -2 Z" fill="${p.glow}" stroke="${INK}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></g>`,
  magnifier: p => `<g transform="translate(78 68) rotate(20)"><circle cy="-3" r="8" fill="none" stroke="${INK}" stroke-width="3.5"/>` +
    `<circle cy="-3" r="8" fill="${p.glow}" opacity=".45"/><path d="M5 4 L11 11" stroke="${INK}" stroke-width="4" stroke-linecap="round"/></g>`,
  brush: p => `<g transform="translate(78 68) rotate(30)"><path d="M0 11 L0 -3" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>` +
    `<path d="M-5 -3 L5 -3 L3 -12 L-3 -12 Z" fill="${p.glow}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/></g>`,
  lantern: p => `<g transform="translate(78 68)"><path d="M0 -13 a5 5 0 0 1 5 5" fill="none" stroke="${INK}" stroke-width="3"/>` +
    `<rect x="-8" y="-8" width="16" height="18" rx="3" fill="${p.glow}" stroke="${INK}" stroke-width="3"/>` +
    `<circle cy="1" r="4" fill="${p.trim}"/></g>`,
}

/**
 * Render one cast member.
 * @param {object} member  cast entry (needs palette/visor/crest/prop)
 * @param {object} opts    { size, state } — state ∈ idle|busy|speaking|conceded
 */
export function drawCharacter(member, opts = {}) {
  const size = opts.size || LOD.bust
  const state = opts.state || 'idle'
  const p = member.palette
  const detailed = size >= LOD.portrait
  const mid = size >= LOD.bust

  const body =
    `<path d="M36 54 C30 68 23 84 23 93 Q23 102 33 102 L67 102 Q77 102 77 93 C77 84 70 68 64 54 Z" ` +
    `fill="${p.body}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>` +
    // The single permitted highlight: a soft left-side sheen.
    `<path d="M40 60 C34 74 30 86 30 93 Q30 96 34 96" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity=".22"/>`

  const head =
    `<rect x="27" y="17" width="46" height="40" rx="13" fill="${p.body}" stroke="${INK}" stroke-width="4"/>` +
    `<rect x="33" y="23" width="14" height="7" rx="3.5" fill="#ffffff" opacity=".25"/>`

  const hands = mid
    ? `<circle cx="17" cy="72" r="7" fill="${p.trim}" stroke="${INK}" stroke-width="3.5"/>` +
      `<circle cx="83" cy="72" r="7" fill="${p.trim}" stroke="${INK}" stroke-width="3.5"/>`
    : ''

  const collar = mid
    ? `<path d="M36 56 Q50 63 64 56" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>`
    : ''

  const crest = (CRESTS[member.crest] || CRESTS.spark)(p)
  const visor = (VISORS[member.visor] || VISORS.dot)(p)
  // `PROPS[x] || ''` would build an empty string and then call it — a character
  // with an unrecognised prop must degrade to no prop, not to a TypeError that
  // takes the whole render pass down with it.
  const propFn = PROPS[member.prop]
  const prop = detailed && propFn ? propFn(p) : ''

  // Ground shadow anchors the float. Without it the characters read as pasted on.
  const shadow = `<ellipse cx="50" cy="110" rx="24" ry="5" fill="${INK}" opacity=".28"/>`

  const aura = state === 'speaking'
    ? `<circle cx="50" cy="60" r="46" fill="${p.glow}" opacity=".13"/>`
    : ''

  return `<svg class="char char-${state}" viewBox="0 0 100 120" width="${size}" height="${size * 1.2}" ` +
    `role="img" aria-label="${escapeAttr(member.name)}, ${escapeAttr(member.role)}" ` +
    `style="--char-glow:${p.glow};--char-body:${p.body}">` +
    aura + shadow +
    `<g class="char-float">` + body + collar + hands + head + visor + crest + prop + `</g>` +
    (state === 'conceded' ? concedeMark() : '') +
    `</svg>`
}

/* A conceded participant gets a visible mark — changing your mind is the point
 * of the exercise, so it should be legible on the floor, not buried in text. */
const concedeMark = () =>
  `<g transform="translate(74 22)"><circle r="11" fill="#0b0e14" stroke="${INK}" stroke-width="3"/>` +
  `<path d="M-5 0 L-1 4 L6 -4" fill="none" stroke="#4ade80" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></g>`

/**
 * The product mascot lockup — Nib plus the wordmark. Used in the topbar and as
 * the empty-state host, so it takes a `mood` rather than a debate state.
 */
export function drawMascot(nib, mood = 'idle') {
  const p = nib.palette
  const eye = mood === 'busy'
    ? `<rect x="33" y="34" width="34" height="6" rx="3" fill="${INK}"/>`
    : mood === 'alert'
      ? `<path d="M36 33 L46 39 M64 33 L54 39" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`
      : `<circle cx="42" cy="37" r="4.5" fill="${INK}"/><circle cx="58" cy="37" r="4.5" fill="${INK}"/>`
  return `<svg class="mascot mascot-${mood}" viewBox="0 0 100 120" width="30" height="36" aria-hidden="true">` +
    `<ellipse cx="50" cy="110" rx="20" ry="4" fill="${INK}" opacity=".3"/>` +
    `<g class="char-float">` +
    `<path d="M36 54 C30 68 23 84 23 93 Q23 102 33 102 L67 102 Q77 102 77 93 C77 84 70 68 64 54 Z" fill="${p.body}" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>` +
    `<rect x="27" y="17" width="46" height="40" rx="13" fill="${p.body}" stroke="${INK}" stroke-width="4"/>` +
    eye +
    `<path d="M50 2 L58 18 L50 15 L42 18 Z" fill="${p.glow}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` +
    `</g></svg>`
}

/**
 * Room art. A room is a stage the characters stand on, so it is drawn as a
 * back wall + floor rather than a card border — the depth is what makes an
 * avatar look *inside* something.
 */
export function drawRoom(mode = 'idle') {
  const lit = mode === 'roundtable' ? '#f5a524' : mode === 'focus' ? '#22d3ee' : '#2a3348'
  const active = mode !== 'idle'

  // FLOOR_Y is shared with the avatar layer, which stands characters' feet on
  // this line — see renderAvatars(). Changing one without the other lifts the
  // whole crew off the ground.
  const FLOOR_Y = 88

  // No <defs>: the same room art is emitted a dozen times on one page, and
  // repeated gradient ids are invalid and resolve unpredictably. Two flat
  // rects with opacity give the same depth with no shared id namespace.
  return `<svg class="room-art" viewBox="0 0 200 110" preserveAspectRatio="none" aria-hidden="true">` +
    `<rect width="200" height="110" fill="#0d111b"/>` +
    `<rect width="200" height="${FLOOR_Y}" fill="#161b28"/>` +
    // The floor the characters stand on.
    `<rect y="${FLOOR_Y}" width="200" height="${110 - FLOOR_Y}" fill="#10151f"/>` +
    `<path d="M0 ${FLOOR_Y} H200" stroke="#232c40" stroke-width="2"/>` +
    // Light source lives in the top-right corner, clear of the room title. It
    // is a wash rather than a lamp shape: an object drawn up there competes
    // with the label text for the same few pixels and always loses.
    (active
      ? `<path d="M200 0 L200 ${FLOOR_Y} L120 ${FLOOR_Y} Z" fill="${lit}" opacity=".07"/>` +
        `<circle cx="196" cy="6" r="14" fill="${lit}" opacity=".13"/>` +
        `<circle cx="196" cy="6" r="4" fill="${lit}" opacity=".55"/>`
      : '') +
    `</svg>`
}

/** Where a character's feet sit inside a room, as a fraction of room height. */
export const ROOM_FLOOR = 88 / 110

const escapeAttr = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

export { LOD }
