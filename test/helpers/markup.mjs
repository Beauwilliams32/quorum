/* Enough of a DOM for the render tests.
 *
 * public/app.js is a browser script with renderers that build markup strings
 * and assign them to `innerHTML`. Tests used to assert that app.js's SOURCE
 * contained certain strings; these helpers let a test run the renderer against
 * stub state and assert on the ELEMENTS it produced — tag, classes, dataset,
 * inline custom properties and text — so re-styling a node does not fail a test
 * but dropping its `data-kind` does.
 *
 * Deliberately small: the cockpit emits well-formed, quoted, non-self-closing
 * markup, so a tag-level scan is enough and pulling in a DOM library for it
 * would be a dependency the no-build cockpit does not otherwise need.
 */

const TAG = /<([a-z][a-z0-9-]*)((?:\s+[^<>]*?)?)(\/?)>/gi
const ATTR = /([a-z_:][-a-z0-9_:.]*)\s*=\s*"([^"]*)"|([a-z_:][-a-z0-9_:.]*)(?=[\s/>]|$)/gi

const decode = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** Parse attributes out of one start tag's attribute text. */
function attributes(text) {
  const out = {}
  for (const m of text.matchAll(ATTR)) {
    if (m[1] !== undefined) out[m[1].toLowerCase()] = decode(m[2])
    else if (m[3] !== undefined) out[m[3].toLowerCase()] = ''
  }
  return out
}

/** Every element in a markup string, in document order. */
export function elements(html) {
  const out = []
  for (const m of String(html || '').matchAll(TAG)) {
    const attrs = attributes(m[2] || '')
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean))
    const dataset = {}
    // Same shape the DOM gives: `data-operator-tab` → `dataset.operatorTab`.
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('data-')) dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
    }
    const styleProps = {}
    for (const part of (attrs.style || '').split(';')) {
      const at = part.indexOf(':')
      if (at > 0) styleProps[part.slice(0, at).trim()] = part.slice(at + 1).trim()
    }
    out.push({ tag: m[1].toLowerCase(), attrs, classes, dataset, styleProps, index: m.index })
  }
  return out
}

/** Elements carrying every class in `classNames`. */
export const byClass = (html, ...classNames) =>
  elements(html).filter(el => classNames.every(name => el.classes.has(name)))

/** Elements carrying the attribute `name` (optionally with an exact value). */
export const byAttr = (html, name, value) =>
  elements(html).filter(el => name.toLowerCase() in el.attrs && (value === undefined || el.attrs[name.toLowerCase()] === value))

/** Plain text with every tag removed, whitespace collapsed. */
export const text = html => decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/**
 * A stub element good enough for the cockpit's renderers: innerHTML, textContent,
 * class list, dataset, inline style, handler assignment and event listeners.
 */
export function stubNode(overrides = {}) {
  const node = {
    tagName: 'DIV',
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    hidden: false,
    clientWidth: 900,
    clientHeight: 560,
    dataset: {},
    style: new Proxy({}, { get: (t, k) => t[k] ?? '', set: (t, k, v) => { t[k] = v; return true } }),
    children: [],
    listeners: {},
    classList: {
      _set: new Set(),
      add(...names) { for (const n of names) this._set.add(n) },
      remove(...names) { for (const n of names) this._set.delete(n) },
      toggle(name, on) { if (on === undefined) { this._set.has(name) ? this._set.delete(name) : this._set.add(name) } else if (on) this._set.add(name); else this._set.delete(name) },
      contains(name) { return this._set.has(name) },
    },
    setAttribute(name, value) { node.attrs[name] = String(value) },
    getAttribute(name) { return node.attrs[name] ?? null },
    removeAttribute(name) { delete node.attrs[name] },
    attrs: {},
    appendChild(child) { node.children.push(child); return child },
    focus() {},
    addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn) },
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
    ...overrides,
  }
  return node
}

/** A `$(id)` lookup that lazily creates a stub for any id the renderer asks for. */
export function stubDocument(seed = {}) {
  const nodes = new Map(Object.entries(seed))
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, stubNode())
    return nodes.get(id)
  }
  return { $, nodes }
}
