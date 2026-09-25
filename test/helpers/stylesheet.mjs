/* A small CSS reader for the UI tests.
 *
 * The visual tests used to assert on raw stylesheet TEXT (`assert.match(css,
 * /perspective:/)`), which passes when the string appears anywhere — including
 * inside a comment or an unrelated rule — and fails on any cosmetic edit. These
 * helpers parse the stylesheet into rules and declarations instead, so a test
 * can say "the `.deck-node` rule declares `transform`" and mean it.
 *
 * It is not a CSS engine. It understands comments, nested at-rules, selector
 * lists and declarations, which is all the cockpit's no-build stylesheets use.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const readCss = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Parse into a flat list of `{ selector, media, declarations }`, where `media`
 * is the chain of enclosing at-rule preludes (`@media …`, `@supports …`).
 * Declarations are kept as an array of `[property, value]` so duplicates — the
 * ones that actually decide the cascade — survive.
 */
export function parseCss(css) {
  const src = stripComments(css)
  const rules = []
  const stack = []
  let buffer = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') {
      stack.push(buffer.trim())
      buffer = ''
    } else if (ch === '}') {
      const prelude = stack.pop() ?? ''
      const body = buffer.trim()
      buffer = ''
      if (body && !prelude.startsWith('@')) {
        rules.push({
          selector: prelude,
          selectors: prelude.split(',').map(s => s.trim()).filter(Boolean),
          media: stack.filter(s => s.startsWith('@')),
          declarations: parseDeclarations(body),
        })
      }
    } else {
      buffer += ch
    }
  }
  return rules
}

function parseDeclarations(body) {
  const out = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ';' && depth === 0) { push(current); current = '' } else current += ch
  }
  push(current)
  return out

  function push(text) {
    const trimmed = text.trim()
    if (!trimmed) return
    const at = trimmed.indexOf(':')
    if (at < 0) return
    out.push([trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim()])
  }
}

/** Every rule whose selector list contains `selector` exactly. */
export const rulesFor = (rules, selector) =>
  rules.filter(rule => rule.selectors.includes(selector))

/** Every declared value of `property` across the rules matching `selector`. */
export function declared(rules, selector, property) {
  return rulesFor(rules, selector)
    .flatMap(rule => rule.declarations.filter(([prop]) => prop === property).map(([, value]) => value))
}

/** True when some rule matching `selector` declares `property` at all. */
export const declares = (rules, selector, property) => declared(rules, selector, property).length > 0

/* ── tokens ───────────────────────────────────────────────────────── */

/** Custom properties declared on `:root` (in any of its selector forms). */
export function rootTokens(rules) {
  const out = new Map()
  for (const rule of rules) {
    if (!rule.selectors.some(s => s === ':root' || s.startsWith(':root['))) continue
    for (const [prop, value] of rule.declarations) {
      if (prop.startsWith('--')) out.set(prop, value)
    }
  }
  return out
}

/** Every `var(--x)` referenced in a blob of CSS, JS or HTML. */
export const referencedTokens = text =>
  new Set([...text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map(m => m[1]))

/**
 * Expand a token's value, following `var()` chains. Throws on a dangling
 * reference or a cycle — which is the point: "defined" is not the same as
 * "resolves", and a token that points at a deleted token is a broken theme.
 */
export function resolveToken(tokens, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`token cycle through ${name}`)
  if (!tokens.has(name)) throw new Error(`token ${name} is referenced but never defined`)
  seen.add(name)
  return tokens.get(name).replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,([^)]*))?\)/gi, (_, ref) =>
    resolveToken(tokens, ref, new Set(seen)))
}

/* ── colour ───────────────────────────────────────────────────────── */

export function parseHex(value) {
  const match = String(value).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!match) return null
  const body = match[1].length === 3 ? match[1].split('').map(c => c + c).join('') : match[1]
  return [0, 2, 4].map(i => parseInt(body.slice(i, i + 2), 16) / 255)
}

const channel = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

export function luminance(hex) {
  const rgb = parseHex(hex)
  if (!rgb) throw new Error(`not a hex colour: ${hex}`)
  const [r, g, b] = rgb.map(channel)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 relative contrast ratio, 1–21. */
export function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/* CSS named colours. `transparent` and `currentColor` are deliberately absent:
 * they are keywords that carry no palette value and are legitimate anywhere.
 * Without this list a `color: white` slipped straight through the function
 * ("style.css contains zero colour literals") — a `mask-image: …, black, …`
 * did exactly that until 2026-09-22. */
export const NAMED_COLOURS = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
  'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
  'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta',
  'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen',
  'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow',
  'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon',
  'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
  'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
  'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
  'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple',
  'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen',
  'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow',
  'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet',
  'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen',
]

/* A named colour only counts when it stands alone as a value token — not
 * inside an identifier (`--surface-white`), a url() or a font family. */
const NAMED = new RegExp(String.raw`(?<![\w-])(?:${NAMED_COLOURS.join('|')})(?![\w-])`, 'gi')

/**
 * Colour literals sitting in a declaration VALUE — `#abc`, `rgb()/rgba()`,
 * `hsl()/hsla()`, `oklch()`, and CSS named colours such as `black` or `white`.
 * Id selectors like `#deck-space` are not values and are never reported, which
 * is why this walks parsed declarations rather than grepping the file.
 */
export function colourLiterals(rules) {
  const pattern = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d[^)]*\)|hsla?\(\s*\d[^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|lch\([^)]*\)/g
  const found = []
  for (const rule of rules) {
    for (const [prop, value] of rule.declarations) {
      for (const hit of value.match(pattern) || []) found.push({ selector: rule.selector, prop, literal: hit })
      // Strip url(…) and quoted strings first: a font family named "White" or
      // an asset path is not a colour declaration.
      const bare = value.replace(/url\([^)]*\)/gi, '').replace(/"[^"]*"|'[^']*'/g, '')
      for (const hit of bare.match(NAMED) || []) found.push({ selector: rule.selector, prop, literal: hit })
    }
  }
  return found
}
