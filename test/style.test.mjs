import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, readCss, parseCss, rootTokens, referencedTokens, resolveToken,
  declared, declares, contrast, parseHex, colourLiterals,
} from './helpers/stylesheet.mjs'
import { FALLBACK, token } from '../public/theme.js'

/* Until 2026-09-22 this file asserted on stylesheet and app.js SOURCE TEXT
 * (`assert.match(app, /background: '#08090d'/)`), so every one of the three
 * stacked `:root` palettes could disagree with the others and the test would
 * still pass as long as one literal string survived somewhere in the file.
 *
 * It now parses what ships and checks the properties that actually matter:
 * tokens are declared in exactly one file, every referenced token resolves,
 * text clears WCAG AA against the surfaces it sits on, the component sheet
 * contains no raw colour at all, and the runtime bridge that paints the 3D
 * city and the SVG crew agrees with the stylesheet. */

const tokensCss = readCss('public/tokens.css')
const styleCss = readCss('public/style.css')
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')

const tokenRules = parseCss(tokensCss)
const styleRules = parseCss(styleCss)
const allRules = [...tokenRules, ...styleRules]
const TOKENS = rootTokens(allRules)

const cssFiles = fs.readdirSync(path.join(ROOT, 'public')).filter(name => name.endsWith('.css'))

test('design tokens are declared in exactly one file', () => {
  assert.deepEqual(cssFiles.sort(), ['style.css', 'tokens.css'],
    'public/ ships one token file and one component file')

  // A component rule may *set* a token for its subtree (`.pet-mini {
  // --runtime-tint: … }`) — that is choosing a value, not declaring a palette.
  // Declaring one on :root is what made three palettes fight, so only
  // tokens.css may do it.
  const rogue = styleRules
    .filter(rule => rule.selectors.some(s => s === ':root' || s.startsWith(':root[')))
    .flatMap(rule => rule.declarations.filter(([prop]) => prop.startsWith('--')).map(([prop]) => prop))
  assert.deepEqual(rogue, [], 'public/style.css must not redeclare :root tokens')
  assert.ok(TOKENS.size > 80, `tokens.css defines the scale (${TOKENS.size} tokens)`)
})

test('every token referenced anywhere in the UI resolves to a concrete value', () => {
  const referenced = new Set([
    ...referencedTokens(tokensCss),
    ...referencedTokens(styleCss),
    ...referencedTokens(html),
    ...referencedTokens(app),
  ])
  // Tokens a component sets for its own subtree (`.pet-mini { --runtime-tint }`)
  // are scoped, not palette entries, so they resolve from the component rule.
  const scoped = new Set(allRules
    .filter(rule => !rule.selectors.some(s => s.startsWith(':root')))
    .flatMap(rule => rule.declarations.filter(([prop]) => prop.startsWith('--')).map(([prop]) => prop)))

  const broken = []
  for (const name of referenced) {
    if (scoped.has(name) && !TOKENS.has(name)) continue
    try {
      const value = resolveToken(TOKENS, name)
      if (/var\(/.test(value)) broken.push(`${name} still contains var() after resolution`)
      if (!value.trim()) broken.push(`${name} resolves to nothing`)
    } catch (error) {
      broken.push(`${name}: ${error.message}`)
    }
  }
  assert.deepEqual(broken, [])
})

test('the token scale keeps the contract the components are built on', () => {
  const required = [
    '--bg', '--bg0', '--bg1', '--bg2', '--surface', '--surface-strong',
    '--line', '--line-soft', '--fg0', '--fg1', '--fg2', '--muted',
    '--accent', '--accent-soft', '--accent-strong', '--warn', '--ok', '--error',
    '--sans', '--mono', '--topbar-h', '--radius-card', '--radius-control',
    '--duration-fast', '--duration-base', '--ease-standard', '--shadow-card-inner',
    '--state-command', '--state-ok', '--state-roundtable', '--state-memory',
    '--char-glow', '--stage-wall', '--stage-mid', '--leading-tight', '--border-subtle',
  ]
  const missing = required.filter(name => !TOKENS.has(name))
  assert.deepEqual(missing, [])

  // The three anchors the owner picked for "mission control".
  assert.equal(resolveToken(TOKENS, '--bg'), '#0b0f14')
  assert.equal(resolveToken(TOKENS, '--accent'), '#3fd0e0')
  assert.equal(resolveToken(TOKENS, '--warn'), '#f2b544')
})

test('body text and status labels clear WCAG AA on the theme surfaces', () => {
  const surfaces = ['--bg', '--bg0', '--bg1'].map(name => resolveToken(TOKENS, name))
  const text = ['--fg0', '--fg1', '--fg2', '--muted', '--ghost']
  const status = ['--accent', '--accent-strong', '--warn', '--ok', '--error', '--info', '--purple', '--pink']

  const failures = []
  for (const name of [...text, ...status]) {
    const colour = resolveToken(TOKENS, name)
    assert.ok(parseHex(colour), `${name} resolves to a hex colour (got ${colour})`)
    for (const surface of surfaces) {
      const ratio = contrast(colour, surface)
      if (ratio < 4.5) failures.push(`${name} on ${surface} is ${ratio.toFixed(2)}:1`)
    }
  }
  assert.deepEqual(failures, [], 'every text and status token needs 4.5:1')
})

test('the theme stays dark and is addressable by data-theme for a second palette', () => {
  assert.ok(declared(tokenRules, ':root', 'color-scheme').includes('dark'))
  assert.match(html, /<html[^>]*\sdata-theme="mission-control"/)

  // The palette is attached to both `:root` and `:root[data-theme="…"]`, so a
  // future theme is a sibling attribute block and no component CSS changes.
  // There is exactly one theme today and no switcher; this asserts the hook is
  // real, not that a second theme exists.
  const themed = tokenRules.filter(rule => rule.selectors.includes(':root[data-theme="mission-control"]'))
  assert.equal(themed.length, 1)
  const bare = tokenRules.filter(rule => rule.selectors.includes(':root'))
  assert.equal(bare.length, 1)
  assert.equal(themed[0], bare[0], 'the default and the named theme are the same declaration block')
})

test('the component stylesheet contains no raw colour literal', () => {
  const literals = colourLiterals(styleRules)
  assert.deepEqual(literals, [],
    'colours belong in tokens.css; style.css may only reference them')

  // …and tokens.css is allowed literals only where a token is *defined*.
  const outsideRoot = colourLiterals(tokenRules.filter(r => !r.selectors.some(s => s.startsWith(':root'))))
  assert.deepEqual(outsideRoot, [])
})

test('the colour-literal guard catches named colours, not CSS keywords', () => {
  // The claim above is only worth as much as the detector. `mask-image:
  // linear-gradient(180deg, black, …)` sat in style.css and passed, because
  // the pattern only knew #hex / rgb() / hsl() / oklch(). Pin the behaviour so
  // the hole does not reopen.
  const probe = parseCss(`
    .a { color: white; }
    .b { mask-image: linear-gradient(180deg, black, transparent 72%); }
    .c { background: var(--surface); border-color: transparent; color: currentColor; }
    .d { white-space: nowrap; overflow-wrap: anywhere; }
    .e { --surface-white: var(--fg0); font-family: "Whitney", var(--sans); }
  `)
  assert.deepEqual(colourLiterals(probe).map(hit => `${hit.selector} ${hit.prop} ${hit.literal}`),
    ['.a color white', '.b mask-image black'])
})

test('the monitor and command surfaces keep their layout contract', () => {
  for (const selector of ['#view-deck', '#view-board', '#view-command']) {
    assert.ok(declares(styleRules, selector, 'grid-template-columns'), `${selector} is a grid`)
  }
  // The deck is genuinely 3D, not a flat mock of one.
  assert.ok(declared(styleRules, '#deck-space', 'perspective').length > 0)
  assert.ok(declared(styleRules, '#deck-nodes', 'transform-style').includes('preserve-3d'))
  assert.ok(declares(styleRules, '.deck-node', 'transform'))
  assert.ok(declares(styleRules, '.deck-node:hover', 'transform'))
})

test('reduced motion is still honoured on every surface that animates', () => {
  const reduced = styleRules.filter(rule => rule.media.some(q => /prefers-reduced-motion/.test(q)))
  assert.ok(reduced.length >= 3, 'more than one surface opts out of motion')

  // Every rule inside a reduced-motion block must actually neutralise motion.
  for (const rule of reduced) {
    const neutralises = rule.declarations.some(([prop, value]) =>
      ((prop === 'animation' || prop === 'transform' || prop === 'transition') && /none/.test(value)) ||
      (prop === 'animation-duration' && /^\s*\.?0/.test(value)) ||
      (prop === 'transition-duration' && /^\s*\.?0/.test(value)) ||
      (prop === 'animation-iteration-count' && /^\s*1\b/.test(value)))
    assert.ok(neutralises, `${rule.selector} is inside a reduced-motion block but does not stop motion`)
  }
  const covered = reduced.flatMap(rule => rule.selectors)
  assert.ok(covered.includes('.hud-scanline.active'), 'the live scanline stops')
  assert.ok(covered.some(s => s.includes(':hover')), 'hover lifts stop')
})

test('the 3D city and the SVG crew read the same palette as the UI', () => {
  // public/theme.js paints three.js and the character art. Its baked fallbacks
  // are what the city uses before the stylesheet applies, so a drift between
  // the two is a visibly two-toned cockpit.
  const drift = []
  for (const [name, fallback] of Object.entries(FALLBACK)) {
    if (!TOKENS.has(name)) { drift.push(`${name} is not a token`); continue }
    const resolved = resolveToken(TOKENS, name)
    if (resolved.toLowerCase() !== fallback.toLowerCase()) drift.push(`${name}: css ${resolved} vs theme.js ${fallback}`)
  }
  assert.deepEqual(drift, [])
})

test('the terminal takes its colours from the tokens, not from literals', () => {
  // Lift xtermTheme() out of app.js and run it with no CSSOM, which is exactly
  // what happens before the stylesheet applies: it must still hand xterm the
  // theme's colours rather than a hardcoded scheme.
  const start = app.indexOf('function xtermTheme()')
  assert.ok(start > 0, 'xtermTheme exists')
  const src = app.slice(start, app.indexOf('\n}\n', start) + 3)
  const theme = new Function('token', `${src}\nreturn xtermTheme()`)(token)

  assert.equal(theme.background, resolveToken(TOKENS, '--bg0'))
  assert.equal(theme.foreground, resolveToken(TOKENS, '--fg1'))
  assert.equal(theme.cursor, resolveToken(TOKENS, '--accent'))
  assert.equal(theme.selectionBackground, `${resolveToken(TOKENS, '--accent')}33`)
})

test('the memory chart legend still names what each band measures', () => {
  // The chart draws three bands; the legend is the only thing that says which
  // is which, so it is a correctness assertion, not a cosmetic one.
  const legend = app.match(/ctx\.fillText\((.*cyan=used.*?)\, 4, 10\)/)
  assert.ok(legend, 'the memory chart still labels its bands')
  assert.match(legend[1], /cyan=used/)
  assert.match(legend[1], /violet=\+comp/)
  assert.match(legend[1], /red=pressure/)
})

/* ── served artwork ───────────────────────────────────────
 * The three atlases were shipped as 2.3–2.6 MB PNGs — 7.45 MB of art for
 * three CSS backgrounds, on a cockpit whose entire job is to be cheap to leave
 * open. They are WebP now, and the PNG masters are kept under
 * archive/assets-png/ rather than thrown away.
 *
 * These are the two things that can silently go wrong: a stylesheet pointing
 * at a file that is no longer there (an invisible background, no error), and
 * the weight creeping back. */

const assetRefs = [...styleCss.matchAll(/url\('\/(assets\/[^']+)'\)/g)].map(match => match[1])

test('every asset the stylesheet paints with is actually served', () => {
  assert.ok(assetRefs.length >= 3, 'the deck art is still referenced')
  const missing = assetRefs.filter(rel => !fs.existsSync(path.join(ROOT, 'public', rel)))
  assert.deepEqual(missing, [], `public/style.css points at files that are not there: ${missing.join(', ')}`)
})

test('the served artwork stays inside the budget its own manifest states', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/manifest.json'), 'utf8'))
  const budget = manifest.policy.maxDisplayBytes
  const served = fs.readdirSync(path.join(ROOT, 'public/assets'))
    .filter(name => !name.endsWith('.json'))
    .map(name => fs.statSync(path.join(ROOT, 'public/assets', name)).size)
    .reduce((total, size) => total + size, 0)
  assert.ok(served <= budget, `public/assets is ${served}B against a ${budget}B budget`)
  // The point of the conversion was an order of magnitude, not a rounding.
  assert.ok(served < budget / 4, `public/assets is ${served}B; the PNG masters were 7,453,157B`)

  // Every asset the manifest claims to ship is on disk under the name it claims.
  for (const asset of manifest.assets) {
    if (!asset.path) continue
    assert.ok(fs.existsSync(path.join(ROOT, 'public', asset.path.replace(/^\//, ''))), `${asset.path} is missing`)
  }
})

// `archive/` is deliberately not in the open-core allow-list, so the published
// tree has no masters to check. In the repo that owns them, it is checked: art
// is archived, never deleted.
test('the PNG masters are archived, not deleted', { skip: fs.existsSync(path.join(ROOT, 'archive')) ? false : 'archive/ is not part of the published tree' }, () => {
  for (const rel of assetRefs) {
    const master = path.join(ROOT, 'archive/assets-png', path.basename(rel).replace(/\.webp$/, '.png'))
    assert.ok(fs.existsSync(master), `the master for ${rel} is not in archive/assets-png/`)
  }
})
