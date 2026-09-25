// Pet identities for HQ agents, drawn by public/art.js with the crew's shared
// silhouette. An agent differs only by palette, visor, crest and prop — the
// same rule the roundtable cast follows, so the office and the org chart read
// as one crew.
//
// Palettes are server-side hex values, exactly like src/cast.js: the art layer
// receives resolved colours, and nothing a browser sends can become a fill
// attribute without passing through `validateAvatar` here.

export const AVATAR_PALETTES = {
  gold: { body: '#facc15', trim: '#a16207', glow: '#fff1a8' },
  sky: { body: '#60a5fa', trim: '#1d4ed8', glow: '#cfe3ff' },
  mint: { body: '#34d399', trim: '#047857', glow: '#c3f7e2' },
  rose: { body: '#f472b6', trim: '#be185d', glow: '#ffd1ea' },
  violet: { body: '#a78bfa', trim: '#6d28d9', glow: '#ddd0ff' },
  ember: { body: '#fb923c', trim: '#c2410c', glow: '#ffd3b0' },
  cyan: { body: '#22d3ee', trim: '#0e7490', glow: '#b6f3ff' },
  lime: { body: '#a3e635', trim: '#4d7c0f', glow: '#e4ffb8' },
  coral: { body: '#f87171', trim: '#b91c1c', glow: '#ffd0d0' },
  slate: { body: '#94a3b8', trim: '#475569', glow: '#e2e8f0' },
}
export const VISORS = ['dot', 'slit', 'wide', 'narrow', 'curve', 'square']
export const CRESTS = ['nib', 'antenna', 'spark', 'horns', 'plume', 'bolt']
export const PROPS = ['clipboard', 'compass', 'wrench', 'magnifier', 'brush', 'lantern']

const PACK_PROP = { scout: 'magnifier', review: 'compass', builder: 'wrench', qa: 'lantern', recovery: 'lantern', release: 'clipboard' }

function hash(text) {
  let h = 2166136261
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0 }
  return h
}

/** A deterministic look for an agent that did not pick one. */
export function defaultAvatar(seed, { packId = '', title = '' } = {}) {
  const h = hash(seed)
  const palettes = Object.keys(AVATAR_PALETTES)
  const designer = /design|ux|ui|brand|art/i.test(title)
  return {
    palette: palettes[h % palettes.length],
    visor: VISORS[(h >>> 4) % VISORS.length],
    crest: CRESTS[(h >>> 8) % CRESTS.length],
    prop: designer ? 'brush' : PACK_PROP[packId] || PROPS[(h >>> 12) % PROPS.length],
  }
}

/** Keep only known parts; anything else falls back to the default look for this seed. */
export function validateAvatar(input, seed, hints = {}) {
  const base = defaultAvatar(seed, hints)
  const value = input && typeof input === 'object' ? input : {}
  return {
    palette: Object.hasOwn(AVATAR_PALETTES, value.palette) ? value.palette : base.palette,
    visor: VISORS.includes(value.visor) ? value.visor : base.visor,
    crest: CRESTS.includes(value.crest) ? value.crest : base.crest,
    prop: PROPS.includes(value.prop) ? value.prop : base.prop,
  }
}

/** What the art layer needs: the resolved palette plus the part names. */
export function publicAvatar(avatar) {
  const palette = AVATAR_PALETTES[avatar?.palette] || AVATAR_PALETTES.slate
  return { paletteName: avatar?.palette || 'slate', palette: { ...palette }, visor: avatar?.visor || 'dot', crest: avatar?.crest || 'spark', prop: avatar?.prop || 'clipboard' }
}
