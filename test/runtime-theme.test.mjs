/* The runtime half of the one-token claim.
 *
 * test/style.test.mjs proves the STYLESHEETS are one palette. It cannot prove
 * the surfaces that do not get to write `var(--token)` — the WebGL city
 * (three.js wants 0xRRGGBB ints) and the SVG character art (fill attributes) —
 * actually read that palette, and until this file existed nothing did: a
 * regression to a hardcoded `0x56d6b3` in public/city.js or a literal fill in
 * public/art.js passed the entire gate.
 *
 * So this drives the real code:
 *   · `stateColors()` is lifted out of city.js and run against real theme.js
 *     with a stubbed `:root`, twice, with two DIFFERENT palettes — a baked
 *     constant cannot pass both.
 *   · public/art.js is imported under a stubbed `:root` and `drawRoom()` /
 *     `drawCharacter()` are rendered; the emitted fills are compared to the
 *     stub values.
 *   · the documented fallback path (no CSSOM at all) is asserted separately,
 *     because that is what paints the first frame before the stylesheet lands.
 *   · the statuses the missions list and the 3D deck BOTH paint must resolve
 *     the same token, which is the "colour means one thing everywhere" claim.
 *
 * city.js is lifted rather than imported because it opens with
 * `import * as THREE from '/vendor/three.module.js'` — a server-absolute URL
 * node cannot resolve. Lifting and EXECUTING the function is still behavioural:
 * the assertions are on returned values, not on source text.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, readCss, parseCss, rootTokens, resolveToken, declared } from './helpers/stylesheet.mjs'
import { elements } from './helpers/markup.mjs'

const TOKENS = rootTokens([...parseCss(readCss('public/tokens.css')), ...parseCss(readCss('public/style.css'))])
const resolved = name => resolveToken(TOKENS, name)
const asInt = hex => Number.parseInt(hex.slice(1), 16)

const citySrc = fs.readFileSync(path.join(ROOT, 'public/city.js'), 'utf8')
const artSrc = fs.readFileSync(path.join(ROOT, 'public/art.js'), 'utf8')
const styleRules = parseCss(readCss('public/style.css'))

/* Install a fake `:root` that answers getPropertyValue with `palette`, exactly
 * as a browser would once tokens.css has applied. `null` removes the CSSOM
 * entirely, which is the fallback path theme.js documents. */
function withRoot(palette) {
  const document = globalThis.document
  const gcs = globalThis.getComputedStyle
  if (palette === null) {
    delete globalThis.document
    delete globalThis.getComputedStyle
  } else {
    globalThis.document = { documentElement: { getAttribute: () => 'mission-control' } }
    globalThis.getComputedStyle = () => ({ getPropertyValue: name => palette[name] ?? '' })
  }
  return () => {
    if (document === undefined) delete globalThis.document; else globalThis.document = document
    if (gcs === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = gcs
  }
}

/** The real tokens.css palette, as a browser would report it. */
const SHIPPED = Object.fromEntries([...TOKENS.keys()]
  .map(name => [name, (() => { try { return resolved(name) } catch { return '' } })()])
  .filter(([, value]) => /^#[0-9a-f]{3,6}$/i.test(value)))

/** A palette nothing could have baked in, to prove the read is live. */
const ALIEN = {
  '--accent': '#112233', '--ok': '#445566', '--warn': '#778899', '--error': '#aabbcc',
  '--info': '#ddeeff', '--purple': '#0f1e2d', '--muted': '#3c4d5e',
  '--bg0': '#010203', '--bg1': '#040506', '--bg2': '#070809', '--stage-edge': '#0a0b0c',
  '--stage-wall': '#010203', '--stage-mid': '#040506', '--stage-floor': '#070809',
}

/** Lift `stateColors()` out of city.js and bind it to the real theme.js. */
async function loadStateColors() {
  const theme = await import('../public/theme.js')
  const start = citySrc.indexOf('export function stateColors() {')
  assert.ok(start > 0, 'city.js still defines stateColors()')
  const end = citySrc.indexOf('\n}\n', start) + 3
  const src = citySrc.slice(start, end).replace('export function', 'function')
  assert.equal(citySrc.split('function stateColors(').length - 1, 1, 'exactly one definition to lift')
  return new Function('tokenInt', `${src}\nreturn stateColors`)(theme.tokenInt)
}

test('the 3D city resolves every state colour from the tokens at runtime', async () => {
  const stateColors = await loadStateColors()

  let restore = withRoot(SHIPPED)
  const shipped = stateColors()
  restore()

  restore = withRoot(ALIEN)
  const alien = stateColors()
  restore()

  // Every state maps to a token, and the SAME token in both palettes — which
  // is only possible if the value is read rather than baked.
  const expected = {
    monitoring: '--ok', completed: '--ok',
    active: '--accent', working: '--accent', testing: '--accent',
    attention: '--warn', recovering: '--warn',
    thinking: '--info', reading: '--info',
    coding: '--purple',
    blocked: '--error', failed: '--error',
    sleeping: '--muted',
  }
  assert.deepEqual(Object.keys(shipped).sort(), Object.keys(expected).sort(),
    'the state table is the documented set')

  const wrong = []
  for (const [state, name] of Object.entries(expected)) {
    if (shipped[state] !== asInt(SHIPPED[name])) wrong.push(`${state} is not ${name} under the shipped palette`)
    if (alien[state] !== asInt(ALIEN[name])) wrong.push(`${state} did not follow ${name} when the palette changed`)
  }
  assert.deepEqual(wrong, [])

  // A three.js colour is an int, never a string or NaN.
  for (const [state, value] of Object.entries(shipped)) {
    assert.equal(typeof value, 'number', `${state} is a three.js int`)
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffff, `${state} is in range (${value})`)
  }
})

test('the city falls back to the baked palette when there is no CSSOM', async () => {
  const stateColors = await loadStateColors()
  const restore = withRoot(null)
  const first = stateColors()
  restore()

  // This is the first frame, before the stylesheet applies. It must still be
  // the theme's colours — theme.js's FALLBACK table — not black or NaN.
  assert.equal(first.failed, asInt(SHIPPED['--error']))
  assert.equal(first.working, asInt(SHIPPED['--accent']))
  assert.equal(first.sleeping, asInt(SHIPPED['--muted']))
  assert.deepEqual(Object.values(first).filter(v => !Number.isInteger(v)), [])
})

test('no colour survives as a literal inside the city scene', () => {
  // Thirteen state colours and ~20 scene ints used to live here as `0x56d6b3`.
  // Every one is a token read now; this keeps the next one out.
  const hexInts = [...citySrc.matchAll(/0x[0-9a-fA-F]{6}\b/g)].map(m => m[0])
  assert.deepEqual(hexInts, [], 'city.js must read colours through theme.js')
  const cssHex = [...citySrc.matchAll(/'#[0-9a-fA-F]{3,8}'|"#[0-9a-fA-F]{3,8}"/g)].map(m => m[0])
  assert.deepEqual(cssHex, [])
})

test('the SVG crew and its stage recolour with the tokens', async () => {
  const restore = withRoot(ALIEN)
  // art.js resolves at import (it calls refreshArtTheme() at module scope), so
  // the stub has to be in place before the module is evaluated.
  const art = await import(`../public/art.js?alien=${Date.now()}`)
  const room = art.drawRoom('roundtable')
  const rects = elements(room).filter(el => el.tag === 'rect')
  restore()

  assert.equal(rects.length, 3, 'backdrop, upper band, floor band')
  // The names now match the tokens: wall floods the viewBox, mid is the upper
  // band, floor is the band the crew stands on.
  assert.equal(rects[0].attrs.fill, ALIEN['--stage-wall'])
  assert.equal(rects[1].attrs.fill, ALIEN['--stage-mid'])
  assert.equal(rects[2].attrs.fill, ALIEN['--stage-floor'])
  const line = elements(room).find(el => el.tag === 'path' && el.attrs.stroke)
  assert.equal(line.attrs.stroke, ALIEN['--stage-edge'])
  // The lit wash is the roundtable token, not a hardcoded amber.
  const lit = elements(room).filter(el => el.tag === 'circle')
  assert.ok(lit.length > 0 && lit.every(el => el.attrs.fill === ALIEN['--warn']), 'the roundtable light is --warn')

  // The ink outline on a character is the stage wall, and the persona's own
  // server-validated colours pass straight through untouched.
  const persona = { id: 'x', name: 'Sable', palette: { body: '#123456', trim: '#654321', glow: '#abcdef' }, visor: 'calm', crest: 'nib' }
  const restore2 = withRoot(ALIEN)
  const svg = art.drawCharacter(persona, { size: 160 })
  restore2()
  assert.ok(svg.includes(`stroke="${ALIEN['--stage-wall']}"`), 'the ink outline is themed')
  assert.ok(svg.includes('#123456'), 'the persona body colour is untouched')
})

test('the crew falls back to the baked palette with no CSSOM', async () => {
  const restore = withRoot(null)
  const art = await import(`../public/art.js?bare=${Date.now()}`)
  const room = art.drawRoom('idle')
  restore()

  const rects = elements(room).filter(el => el.tag === 'rect')
  assert.equal(rects[0].attrs.fill.toLowerCase(), SHIPPED['--stage-wall'].toLowerCase())
  assert.equal(rects[1].attrs.fill.toLowerCase(), SHIPPED['--stage-mid'].toLowerCase())
  assert.equal(rects[2].attrs.fill.toLowerCase(), SHIPPED['--stage-floor'].toLowerCase())
})

test("art.js's pre-refresh literals do not drift from the tokens they stand in for", () => {
  // These initialisers are only visible if refreshArtTheme() ever stops running
  // at import, but a stale value there is exactly the two-toned bug this whole
  // layer exists to prevent.
  const literal = name => {
    const m = artSrc.match(new RegExp(`${name}:\\s*'(#[0-9a-f]{3,6})'`, 'i')) || artSrc.match(new RegExp(`let ${name} = '(#[0-9a-f]{3,6})'`, 'i'))
    assert.ok(m, `${name} still has a baked literal`)
    return m[1].toLowerCase()
  }
  assert.equal(literal('INK'), SHIPPED['--bg0'].toLowerCase())
  assert.equal(literal('wall'), SHIPPED['--stage-wall'].toLowerCase())
  assert.equal(literal('mid'), SHIPPED['--stage-mid'].toLowerCase())
  assert.equal(literal('floor'), SHIPPED['--stage-floor'].toLowerCase())
  assert.equal(literal('line'), SHIPPED['--stage-edge'].toLowerCase())
})

test('the missions list and the 3D deck paint a shared status the same colour', async () => {
  // This is the branch's central claim, and it was false: `.mission-status.failed`
  // was amber while city.js mapped `failed` to --error, so one task was two
  // colours on two surfaces the operator sees at once.
  const stateColors = await loadStateColors()
  const restore = withRoot(SHIPPED)
  const city = stateColors()
  restore()

  // What the stylesheet paints each status, resolved through the token chain.
  const cssStatus = new Map()
  for (const rule of styleRules) {
    for (const selector of rule.selectors) {
      const m = selector.match(/^\.mission-status\.([a-z-]+)$/)
      if (!m) continue
      for (const [prop, value] of rule.declarations) {
        if (prop !== 'background') continue
        const token = value.match(/var\(\s*(--[a-z0-9-]+)\s*\)/i)
        assert.ok(token, `.mission-status.${m[1]} must use a token, got ${value}`)
        cssStatus.set(m[1], resolved(token[1]).toLowerCase())
      }
    }
  }
  const shared = [...cssStatus.keys()].filter(status => status in city)
  assert.ok(shared.length >= 5, `the two surfaces share statuses (${shared.join(', ')})`)
  assert.ok(shared.includes('failed') && shared.includes('blocked') && shared.includes('working'),
    'the statuses that used to disagree are covered')

  const disagreements = shared
    .filter(status => asInt(cssStatus.get(status)) !== city[status])
    .map(status => `${status}: css ${cssStatus.get(status)} vs city #${city[status].toString(16).padStart(6, '0')}`)
  assert.deepEqual(disagreements, [])

  // And the semantics themselves: a failure is red, not amber.
  assert.equal(cssStatus.get('failed'), resolved('--error').toLowerCase())
  assert.equal(cssStatus.get('completed'), resolved('--ok').toLowerCase())
  assert.ok(declared(styleRules, '.mission-status', 'background').length > 0, 'the unknown-status default still exists')
})
