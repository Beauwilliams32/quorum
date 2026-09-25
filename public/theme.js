/* Runtime bridge between public/tokens.css and the code that cannot use
 * `var(--token)`: the WebGL city (three.js wants 0xRRGGBB ints), the SVG
 * character art (fill attributes), the 2D canvases (xterm, the memory chart,
 * the decision-record export).
 *
 * Before this existed the city carried thirteen hardcoded state colours and the
 * characters carried their own palettes, so a theme change repainted the UI and
 * left the 3D scene and the crew in the old one. Everything now resolves the
 * same tokens at init.
 *
 * FALLBACKS are the literal values from tokens.css. They are used when
 * getComputedStyle cannot answer — stylesheet not applied yet, or a headless
 * test harness with no CSSOM. test/style.test.mjs asserts every fallback here
 * equals the token's resolved value in tokens.css, so the two cannot drift.
 */
'use strict'

export const FALLBACK = {
  '--bg': '#0b0f14',
  '--bg0': '#070a0e',
  '--bg1': '#111821',
  '--bg2': '#1a232e',
  /* The stage aliases are separate entries rather than a lookup through
   * --bg0/1/2: public/art.js asks for them BY NAME, and before this a missing
   * entry fell all the way through to #000000 on the first frame — a black
   * room until the stylesheet applied. test/runtime-theme.test.mjs renders the
   * room with no CSSOM to keep that hole shut. */
  '--stage-wall': '#070a0e',
  '--stage-mid': '#111821',
  '--stage-floor': '#1a232e',
  '--stage-edge': '#24303d',
  '--fg0': '#e8f0f6',
  '--fg1': '#cbd8e3',
  '--fg2': '#93a6b6',
  '--muted': '#7e909f',
  '--ghost': '#768996',
  '--accent': '#3fd0e0',
  '--accent-strong': '#7ee6f2',
  '--warn': '#f2b544',
  '--ok': '#46d6a0',
  '--error': '#ff7a85',
  '--info': '#8fb4ff',
  '--purple': '#b39dff',
}

/* Only #rgb / #rrggbb survive. getComputedStyle can hand back `oklch(...)`,
 * `color-mix(...)` or an empty string depending on the browser and on whether
 * the stylesheet has applied; three.js and SVG fill attributes need a literal,
 * so anything else falls back rather than being passed through broken. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function expand(hex) {
  const body = hex.slice(1)
  return body.length === 3 ? `#${body.split('').map(c => c + c).join('')}` : `#${body.toLowerCase()}`
}

/** Resolve one token to a `#rrggbb` string, falling back to the baked literal. */
export function token(name, fallback) {
  const backstop = fallback || FALLBACK[name] || '#000000'
  try {
    const root = globalThis.document?.documentElement
    if (!root || typeof globalThis.getComputedStyle !== 'function') return expand(backstop)
    const value = String(globalThis.getComputedStyle(root).getPropertyValue(name) || '').trim()
    return HEX.test(value) ? expand(value) : expand(backstop)
  } catch {
    return expand(backstop)
  }
}

/** Same, as a three.js-friendly 0xRRGGBB integer. */
export function tokenInt(name, fallback) {
  return Number.parseInt(token(name, fallback).slice(1), 16)
}

/** `rgba()` from a token plus an alpha, for canvas fills and glows. */
export function tokenAlpha(name, alpha, fallback) {
  const hex = token(name, fallback)
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** The active theme name, for anything that wants to branch on it later. */
export function themeName() {
  try {
    return globalThis.document?.documentElement?.getAttribute('data-theme') || 'mission-control'
  } catch {
    return 'mission-control'
  }
}

/* One read of the whole palette. Callers that build a scene or a chart take a
 * snapshot at init instead of hitting the CSSOM per object. */
export function palette() {
  const out = {}
  for (const name of Object.keys(FALLBACK)) out[name.slice(2)] = token(name)
  return out
}
