/* Quorum frontend — no framework, one websocket, targeted renders. */
'use strict'

import { drawCharacter, drawMascot, drawRoom, LOD, ROOM_FLOOR } from './art.js'
import { token, tokenAlpha } from './theme.js'
import { renderHqView, wireHq } from './hq.js'

// Rendered height of an avatar sprite: the SVG is drawn at 1.2× its width.
const AVATAR_H = Math.round(LOD.avatar * 1.2)

const S = {
  processes: null, sessions: null, services: null, openclaw: null, system: null, projects: null,
  tasks: null, composio: null, agents: null, memory: null, artifacts: null, missions: null, city: null, standingJobs: null, hq: null,
  hist: [], feed: [], selected: null, follow: true,
  terms: new Map(), activeTerm: null,
  // ?view= wins over the remembered view, so a view is linkable and a wedged
  // stored value can be overridden without clearing site data.
  view: new URLSearchParams(location.search).get('view') || localStorage.getItem('quorum-view') || 'office',
  selectedRoom: null,
  selectedCwd: null,
  selectedProjectId: null,
  deckSelection: { kind: null, id: null },
  chatTarget: null,
  chatPending: null,

  // ── cast + roundtable ──
  cast: [],
  castById: new Map(),
  edition: { tier: 'free', reason: '' },
  // Launchable agent CLIs, sent by the server from config. Seeded with the
  // built-ins so the buttons are never empty between load and the first frame.
  runtimes: [
    { id: 'claude', label: 'claude', builtin: true },
    { id: 'codex', label: 'codex', builtin: true },
    { id: 'hermes', label: 'hermes', builtin: true },
    { id: 'shell', label: 'zsh', builtin: true },
  ],
  estCostPerTurn: 0.08,
  modelOptions: [],
  // Which characters are seated at the table being configured. Persisted so a
  // reload does not silently re-seat a different, more expensive lineup.
  seated: new Set(JSON.parse(localStorage.getItem('quorum-seated') || '["vex","bolt","sable"]')),
  debate: null,          // the live (or last-viewed) debate snapshot
  speaking: null,        // { speaker, phase } while a turn is in flight
  archive: [],
  catalog: null, agentControl: null,
  commandPreview: null,
  commandSelection: { packId: null, runtimeId: null },
  operatorTab: 'attention', operatorRegistry: null, operatorLoading: false,
  artifactResults: null, artifactDetail: null, missionSelection: null, missionPreview: null, runtimeRuns: null, memoryBridge: null, recallContext: null,
}

const DEFAULT_MODEL_OPTIONS = [
  { id: 'claude:sonnet', label: 'Claude · sonnet — balanced', provider: 'claude', model: 'sonnet', estimatedCostUsd: 0.08, available: true },
  { id: 'claude:opus', label: 'Claude · opus — deepest, priciest', provider: 'claude', model: 'opus', estimatedCostUsd: 0.4, available: true },
  { id: 'claude:haiku', label: 'Claude · haiku — fastest, cheapest', provider: 'claude', model: 'haiku', estimatedCostUsd: 0.024, available: true },
  { id: 'ollama:gemma3:latest', label: 'Ollama · gemma3:latest — local', provider: 'ollama', model: 'gemma3:latest', local: true, available: false },
]
const currentModelOptions = () => S.modelOptions.length ? S.modelOptions : DEFAULT_MODEL_OPTIONS

/* ── the 3D city, loaded on demand ─────────────────────────
 * three.js is 2.0 MB of the cockpit's 2.4 MB of vendored JS and only the Agent
 * City on the Deck uses it, so it is fetched the first time the Deck is opened
 * rather than on every page load. Callers go through `withCity`, which runs the
 * callback now if the module is already here and after the import if it is not;
 * if the import fails the city stays absent and says so, and the rest of the
 * Deck still renders. */
let cityApi = null
let cityLoad = null
function withCity(fn) {
  if (cityApi) return fn(cityApi)
  cityLoad ||= import('./city.js').then(module => { cityApi = module; return module }).catch(error => {
    cityLoad = null
    console.warn('[quorum] the 3D city could not be loaded', error)
    const label = document.getElementById('city-live-label')
    if (label) label.textContent = '3D city unavailable — the list below is the full model'
    return null
  })
  cityLoad.then(module => { if (module) fn(module) })
  return undefined
}

const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const rel = ms => {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return `${s | 0}s`
  if (s < 3600) return `${s / 60 | 0}m`
  if (s < 86400) return `${s / 3600 | 0}h`
  return `${s / 86400 | 0}d`
}
const gb = mb => (mb / 1024).toFixed(1) + 'G'

/* ── age labels that stay honest ───────────────────────────
 * "3m ago" is a function of the wall clock, not of anything the server sends.
 * The cockpit used to repaint it by accident — every collector tick re-ran
 * every renderer — and that storm is gone: `State#publish` sends nothing at all
 * when a key's payload is byte-identical, and a transcript that has stopped
 * being written has a constant `mtimeMs` forever. Left alone, a session that
 * went quiet four minutes ago would sit at "1m" for the rest of the day, which
 * is a cockpit claiming to be fresher than it is — the one lie this surface
 * must never tell.
 *
 * So every age is rendered through `relLabel`, which carries the ABSOLUTE
 * instant in `data-rel` (and the full local timestamp in `title`, so the truth
 * is one hover away even between ticks), and one ticker repaints the text.
 * `relTick` writes only when the rendered text actually changed, so a label
 * reading "4h" costs nothing until the hour turns — this is a repaint of a few
 * text nodes, not a return of the render storm. */
const REL_TICK_MS = 10_000
const relSuffix = el => el.dataset.relSuffix || ''
function relLabel(ms, { tag = 'span', cls = '', suffix = '' } = {}) {
  const at = Number(ms)
  const open = `<${tag}${cls ? ` class="${cls}"` : ''}`
  if (!Number.isFinite(at) || at <= 0) return `${open}>—</${tag}>`
  const stamp = new Date(at)
  return `${open} data-rel="${at}"${suffix ? ` data-rel-suffix="${esc(suffix)}"` : ''}` +
    ` datetime="${stamp.toISOString()}" title="${esc(stamp.toLocaleString())}">${rel(at)}${suffix}</${tag}>`
}
function relTick() {
  for (const el of document.querySelectorAll('[data-rel]')) {
    const at = Number(el.dataset.rel)
    if (!Number.isFinite(at)) continue
    const next = rel(at) + relSuffix(el)
    if (el.textContent !== next) el.textContent = next
  }
}
setInterval(relTick, REL_TICK_MS)

/* Rebuilding a list into the same markup costs an innerHTML parse, a layout,
 * and a re-wire of every handler inside it — for no visible change. Most
 * collector ticks move one number in one row, or nothing at all, so the hot
 * containers write through here and re-wire only when the markup really moved.
 *
 * Only for containers whose renderer is their sole writer: the remembered
 * markup would go stale under anyone else's innerHTML. */
function writeIfChanged(element, html) {
  if (!element || element.__quorumHtml === html) return false
  element.__quorumHtml = html
  element.innerHTML = html
  return true
}

/* ── websocket ─────────────────────────────────────────── */
let ws
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`)
  ws.onopen = () => $('tb-conn').className = 'dot up'
  ws.onclose = () => { $('tb-conn').className = 'dot down'; setTimeout(connect, 1500) }
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    const h = handlers[m.type]
    if (h) h(m)
  }
}
const send = m => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)) }

/* ── server state: snapshots, patches, resync ──────────────
 * The server used to push the whole value of every key on every collector
 * tick. It now sends a full value once and per-property patches after that,
 * each naming the version it applies to. `wire` holds this client's copy of
 * the last full value per key — patches are applied to it and the result is
 * handed to exactly the same per-key logic a full update always used, so the
 * rendering path below does not know or care which arrived.
 *
 * A patch whose `from` does not match the version we hold means we missed a
 * message. That is never swallowed: the client says so in the event feed and
 * in the console, then asks the server for the whole key back. */
const wire = {}
const wireVersion = {}
const resyncPending = new Set()

function requestResync(key, why) {
  if (resyncPending.has(key)) return
  resyncPending.add(key)
  console.warn(`[quorum] "${key}" state is out of sync (${why}); requesting a full copy`)
  S.feed.push({ kind: 'sync', text: `${key} state fell behind (${why}); asked the server for a full copy`, ts: Date.now() })
  if (S.feed.length > 200) S.feed.shift()
  paint('renderFeed')
  send({ type: 'state.resync', key })
}

/** Apply one row-array delta in place, preserving order unless the server sent a new one. */
function applyRows(list, delta) {
  const byId = new Map((Array.isArray(list) ? list : []).map(row => [String(row?.id), row]))
  for (const id of delta.remove || []) byId.delete(String(id))
  for (const row of delta.upsert || []) byId.set(String(row.id), row)
  return delta.order ? delta.order.map(id => byId.get(String(id))).filter(Boolean) : [...byId.values()]
}

const handlers = {
  snapshot(m) {
    const data = m.data || {}
    // `wire` carries the broadcast payload for keys whose stored value is
    // heavier than what the browser is sent (processes keeps a 1200-row
    // inventory server-side; system keeps 300 samples of history).
    const light = m.wire || {}
    resyncPending.clear()
    for (const key of Object.keys(wire)) delete wire[key]
    for (const key of new Set([...Object.keys(data), ...Object.keys(light)])) {
      wire[key] = key in light ? light[key] : data[key]
      wireVersion[key] = (m.versions || {})[key] ?? 0
    }
    S.processes = wire.processes || null
    S.sessions = wire.sessions || null
    S.services = wire.services || null
    S.openclaw = wire.openclaw || null
    S.projects = wire.projects || null
    S.tasks = wire.tasks || null
    S.composio = wire.composio || null
    S.agents = wire.agents || null
    S.memory = wire.memory || null
    S.artifacts = wire.artifacts || null
    S.missions = wire.missions || null
    S.agentControl = wire.agentControl || null
    S.runtimeRuns = wire.runtimeRuns || null
    S.memoryBridge = wire.memoryBridge || null
    S.city = wire.city || null
    S.standingJobs = wire.standingJobs || null
    S.hq = wire.hq || null
    S.system = data.system?.latest || null
    S.hist = data.system?.hist ? [...data.system.hist] : []
    S.feed = m.feed || []
    renderAll()
  },
  update(m) {
    wire[m.key] = m.data
    if (m.v != null) wireVersion[m.key] = m.v
    resyncPending.delete(m.key)
    applyUpdate(m.key, m.data)
  },
  patch(m) {
    const base = wire[m.key]
    if (!base || typeof base !== 'object') return requestResync(m.key, 'no local copy')
    if (wireVersion[m.key] !== m.from) return requestResync(m.key, `expected v${m.from}, hold v${wireVersion[m.key]}`)
    for (const prop of m.del || []) delete base[prop]
    for (const prop of Object.keys(m.set || {})) base[prop] = m.set[prop]
    for (const prop of Object.keys(m.rows || {})) base[prop] = applyRows(base[prop], m.rows[prop])
    wireVersion[m.key] = m.v
    applyUpdate(m.key, base)
  },
  event(m) {
    S.feed.push(m.item)
    if (S.feed.length > 200) S.feed.shift()
    paint('renderFeed')
  },
  transcript(m) {
    const box = $('transcript')
    if (m.reset) box.innerHTML = ''
    for (const ev of m.events) box.appendChild(evNode(ev))
    if (S.follow) box.scrollTop = box.scrollHeight
  },
  error(m) {
    console.warn('[server]', m.error)
    const estimate = $('rt-estimate')
    if (estimate && m.error) { estimate.className = 'rt-estimate warn'; estimate.textContent = m.error }
    // Errors only ever answer a message this client just sent, so a chat.open
    // that threw server-side must not leave the composer disabled forever.
    if (S.chatPending) clearChatPending()
  },

  // Answer to chat.open, carrying the pty id of the resumed session. The message
  // goes to *that* pty: pty.attach never switches tabs, so S.activeTerm may still
  // point at an unrelated terminal — typing there would run the text in the
  // user's shell instead of sending it to the agent.
  'chat.opened'(m) {
    const p = S.chatPending
    if (!p || p.requestId !== m.requestId) return
    clearChatPending()
    ensureTerm(m.id, 'claude')
    activateTerm(m.id)
    setTimeout(() => send({ type: 'pty.input', id: m.id, data: p.text + '\r' }), CHAT_SEND_DELAY_MS)
  },

  cast(m) {
    S.cast = m.cast || []
    S.castById = new Map(S.cast.map(c => [c.id, c]))
    S.edition = m.edition || { tier: 'free', reason: '' }
    S.catalog = m.catalog || S.catalog
    S.modelOptions = Array.isArray(m.modelOptions) ? m.modelOptions : S.modelOptions
    if (Array.isArray(m.runtimes) && m.runtimes.length) S.runtimes = m.runtimes
    if (m.estCostPerTurnUsd) S.estCostPerTurn = m.estCostPerTurnUsd
    // A stored lineup from a previous Pro session must not survive a licence
    // lapsing, or "convene" fails server-side with no visible cause.
    for (const id of [...S.seated]) {
      const c = S.castById.get(id)
      if (!c || c.locked) S.seated.delete(id)
    }
    persistSeated()
    paint('renderMascot', 'renderCrew', 'renderCastPicker', 'renderRoundtable', 'renderEdition', 'renderRuntimes', 'renderMissions')
    paint('renderCommand', 'renderConnectionMap', 'renderHq')
  },
  'command.preview'(m) { S.commandPreview = m.preview; paint('renderCommand') },
  'command.done'(m) { S.commandPreview = null; paint('renderCommand', 'renderFeed') },

  'rt.list'(m) {
    S.archive = m.recent || []
    // A debate survives a browser reload: the server is the owner, so a client
    // that reconnects mid-debate rejoins the live one rather than showing an
    // empty table next to a terminal that is visibly spending money.
    if (m.live?.length) S.debate = m.live[0]
    else if (!S.debate && S.archive.length) S.debate = S.archive[0]
    paint('renderRoundtable', 'renderArchive')
  },

  'rt.update'(m) { S.debate = m.debate; paint('renderRoundtable') },
  'rt.turn'(m) { if (S.debate?.id === m.debateId) S.speaking = null; paint('renderRoundtable') },
  'rt.speaking'(m) {
    if (S.debate?.id !== m.debateId) return
    S.speaking = { speaker: m.speaker, phase: m.phase }
    paint('renderStage')
  },
  'rt.done'(m) {
    S.debate = m.debate
    S.speaking = null
    S.archive = [m.debate, ...S.archive.filter(d => d.id !== m.debate.id)].slice(0, 8)
    paint('renderRoundtable', 'renderArchive')
  },

  'pty.list'(m) { syncTabs(m.ptys) },
  'pty.attach'(m) {
    const t = ensureTerm(m.id, m.profile)
    t.term.reset()
    if (m.data) t.term.write(m.data)
  },
  'pty.data'(m) { S.terms.get(m.id)?.term.write(m.data) },
  'pty.exit'(m) {
    const t = S.terms.get(m.id)
    if (t) { t.dead = true; t.term.write(`\r\n\x1b[31m[exited ${m.code}]\x1b[0m\r\n`); renderTabs() }
  },
}

/* ── view-scoped rendering ─────────────────────────────────
 * Every renderer below writes into exactly one view's subtree, and every view
 * but the current one is `display:none`. Running a hidden view's renderer is a
 * full innerHTML rebuild (and, for the Deck, a three.js scene update) that
 * nobody can see — renderDeck and renderOffice were each doing that several
 * times a second whatever was on screen.
 *
 * `paint()` runs a renderer when its view is visible and otherwise remembers
 * it; `flushPendingRenders()` runs what the newly visible view missed, so the
 * pixels are the same either way. Renderers not listed here — the topbar, the
 * mascot, the edition badge, the terminal tabs — are always-visible chrome and
 * always run.
 *
 * Gating the Deck also fixes a latent bug: renderDeck lays its nodes out from
 * `deck-space.clientWidth`, which is 0 while the view is hidden, so a hidden
 * render positioned everything for a fabricated 900px stage. */
const RENDER_VIEW = {
  renderCommand: 'command', renderOperatorConsole: 'command', renderConnectionMap: 'command', renderAgentControl: 'command',
  renderOffice: 'office', renderRoomDetail: 'office', renderAvatars: 'office', renderCrew: 'office',
  renderDeck: 'deck',
  renderSessions: 'radar', renderSystem: 'radar', renderServices: 'radar', renderProcs: 'radar', renderFeed: 'radar',
  renderBoard: 'board', renderComposio: 'board', renderMemory: 'board', renderAgents: 'board',
  renderCastPicker: 'table', renderRoundtable: 'table', renderArchive: 'table', renderStage: 'table',
  renderMissions: 'missions',
  renderMemoryRing: 'memory',
  renderHq: 'hq',
}
// Function declarations are hoisted, so this literal is safe this early and
// keeps the whole dispatch table in one readable place.
const RENDERERS = {
  renderTopbar, renderEdition, renderMascot, renderRuntimes,
  renderCommand, renderOperatorConsole, renderConnectionMap, renderAgentControl,
  renderOffice, renderRoomDetail, renderAvatars, renderCrew,
  renderDeck,
  renderSessions, renderSystem, renderServices, renderProcs, renderFeed,
  renderBoard, renderComposio, renderMemory, renderAgents,
  renderCastPicker, renderRoundtable, renderArchive, renderStage,
  renderMissions, renderMemoryRing, renderHq,
}
const pendingRenders = new Set()
// Renders actually executed since load. Exposed for measurement, not for the UI.
let renderCount = 0

function paint(...names) {
  for (const name of names) {
    const view = RENDER_VIEW[name]
    if (view && view !== S.view) { pendingRenders.add(name); continue }
    pendingRenders.delete(name)
    renderCount += 1
    RENDERERS[name]()
  }
}

function flushPendingRenders() {
  for (const name of [...pendingRenders]) {
    if (RENDER_VIEW[name] !== S.view) continue
    pendingRenders.delete(name)
    renderCount += 1
    RENDERERS[name]()
  }
}

/** One incoming key, one fan-out. Shared by full updates and applied patches. */
function applyUpdate(key, data) {
  if (key === 'system') {
    S.system = data.latest
    S.hist.push(data.latest)
    if (S.hist.length > 300) S.hist.shift()
    paint('renderSystem', 'renderTopbar', 'renderDeck')
    return
  }
  S[key] = data
  if (key === 'sessions') paint('renderSessions', 'renderOffice', 'renderRoomDetail', 'renderDeck')
  if (key === 'processes') paint('renderTopbar', 'renderProcs', 'renderOffice', 'renderDeck')
  if (key === 'services') paint('renderTopbar', 'renderServices', 'renderOffice', 'renderDeck', 'renderConnectionMap')
  if (key === 'openclaw') paint('renderDeck', 'renderConnectionMap')
  if (key === 'projects') paint('renderOffice', 'renderRoomDetail', 'renderAvatars', 'renderDeck')
  if (key === 'tasks') paint('renderBoard', 'renderTopbar', 'renderAvatars', 'renderDeck')
  if (key === 'composio') paint('renderComposio')
  if (key === 'agents') paint('renderAgents', 'renderAvatars', 'renderDeck')
  if (key === 'memory') paint('renderMemory', 'renderTopbar', 'renderDeck')
  if (key === 'artifacts') { S.artifactResults = null; paint('renderMemoryRing') }
  if (key === 'missions') paint('renderMissions')
  if (key === 'agentControl') paint('renderAgentControl')
  if (key === 'runtimeRuns') paint('renderMissions', 'renderTopbar')
  if (key === 'city') paint('renderDeck')
  if (key === 'standingJobs') paint('renderCommand', 'renderDeck')
  if (key === 'memoryBridge') paint('renderMemory', 'renderConnectionMap')
  if (key === 'hq') paint('renderHq', 'renderTopbar')
}

/* ── view toggle ───────────────────────────────────────── */
// One map rather than a line per view: adding a view should mean adding a key,
// not remembering to add a matching toggle call three lines down.
const VIEWS = {
  hq: 'view-hq',
  office: 'view-office',
  command: 'view-command',
  table: 'view-table',
  deck: 'view-deck',
  board: 'view-board',
  missions: 'view-missions',
  memory: 'view-memory',
  radar: 'view-radar',
}

function setView(view) {
  if (!VIEWS[view]) view = 'office'
  S.view = view
  localStorage.setItem('quorum-view', view)
  for (const [name, id] of Object.entries(VIEWS)) $(id).classList.toggle('hidden', name !== view)
  for (const b of document.querySelectorAll('#view-toggle button'))
    b.classList.toggle('on', b.dataset.view === view)
  // The city's animation loop belongs to the Deck. Off the Deck it stops, so
  // it is not rendering frames into a pane nobody can see.
  if (view === 'deck') withCity(module => module.setCityRunning(true))
  else if (cityApi) cityApi.setCityRunning(false)
  if (view === 'radar') paint('renderSystem')
  if (view === 'deck') paint('renderDeck')
  if (view === 'office') paint('renderOffice', 'renderAvatars')
  if (view === 'command') { paint('renderCommand'); hydrateOperatorRegistry() }
  if (view === 'table') paint('renderRoundtable', 'renderArchive')
  if (view === 'board') paint('renderBoard', 'renderComposio', 'renderAgents')
  if (view === 'missions') paint('renderMissions')
  if (view === 'memory') paint('renderMemoryRing')
  if (view === 'hq') paint('renderHq')
  // Whatever this view missed while it was hidden.
  flushPendingRenders()
}

for (const b of document.querySelectorAll('#view-toggle button'))
  b.onclick = () => setView(b.dataset.view)

document.getElementById('command-roundtable')?.addEventListener('click', () => setView('table'))
document.getElementById('tb-hq')?.addEventListener('click', () => setView('hq'))

/* ── HQ ────────────────────────────────────────────────────
 * The company and the room live in public/hq.js; this is the seam. HQ owns
 * its own subtree and talks to /api/hq; the `hq` state key repaints it. */
function renderHq() { renderHqView(S) }
wireHq({ S, rerender: () => paint('renderHq'), setView })

// Apply the requested or remembered view immediately. The websocket snapshot can
// arrive after first paint; direct links like ?view=table must not flash or stay
// pinned to the default Studio markup while the local collectors warm up.
setView(S.view)

/* ── top bar ───────────────────────────────────────────── */
function renderTopbar() {
  const g = S.processes?.groups || {}
  const sv = S.services || {}
  const liveRun = (S.runtimeRuns?.runs || []).some(run => ['starting', 'running', 'paused'].includes(run.status))
    || (S.agentControl?.runs || []).some(run => run.status === 'active')
  $('topbar-scanline')?.classList.toggle('active', !!(liveRun || (S.debate && !S.debate.endedAt)))
  const dot = up => `<span class="dot ${up ? 'up' : 'down'}"></span>`
  $('tb-agents').innerHTML =
    `<span class="tb-item">${dot((g.claude || 0) > 0)}claude <b>${g.claude || 0}</b></span>` +
    `<span class="tb-item">${dot(sv.hermes?.up)}hermes</span>` +
    `<span class="tb-item">${dot((g.codex || 0) > 0)}codex <b>${g.codex || 0}</b></span>` +
    `<span class="tb-item">${dot(sv.comfy?.up)}comfy${comfyDl() ? ' <b>⇣dl</b>' : ''}</span>` +
    `<span class="tb-item">${dot(S.memory?.ok)}memory <b>${S.memory?.ledger?.counts?.pending ?? '—'}</b></span>`
  // The task counter lives in the always-visible topbar, so the topbar owns it:
  // renderBoard only runs while the Board view is on screen.
  // HQ chip: only what the server counted — who is working, what waits on you.
  const hqChip = $('tb-hq')
  if (hqChip) {
    const t = S.hq?.ready ? S.hq.totals || {} : null
    hqChip.classList.toggle('hidden', !t)
    hqChip.classList.toggle('attention', Boolean(t?.pendingApprovals))
    if (t) hqChip.innerHTML = `HQ <b>${t.working || 0}</b> working${t.pendingApprovals ? ` · <b>${t.pendingApprovals}</b> need you` : ''}`
  }
  const tasks = S.tasks?.counts || { pending: 0, in_progress: 0 }
  $('tb-tasks').innerHTML = `<span class="tb-item">tasks <b>${tasks.in_progress}</b>/${tasks.in_progress + tasks.pending}</span>`
  const sys = S.system
  if (sys) {
    const pressure = sys.freeMB < 500 ? 'style="color:var(--red)"' : sys.freeMB < 1500 ? 'style="color:var(--yellow)"' : ''
    $('tb-mem').innerHTML =
      `<span class="tb-item" ${pressure}>free <b>${gb(sys.freeMB)}</b></span>` +
      `<span class="tb-item">comp <b>${gb(sys.compMB)}</b></span>` +
      `<span class="tb-item">swap <b>${gb(sys.swapUsedMB)}</b></span>` +
      `<span class="tb-item">load <b>${sys.load}</b></span>`
  }
}

/* The Command view's status line.
 *
 * It reports only what was measured: how many catalogued runtimes actually
 * answered, and how many project rooms were discovered. It used to end with a
 * hardcoded claim about secrets — a sentence, not a measurement — and the
 * stylesheet painted the whole line green unconditionally, so it read healthy
 * at 0/6 runtimes ready. The tone IS the measurement now, and the caller sets
 * the colour inline the way #deck-connection already does.
 *
 * test/operator-console.test.mjs asserts the tones and that no unmeasured
 * claim reappears anywhere in this file. */
function commandReadiness(catalog, rooms) {
  const runtimes = catalog?.runtimes || []
  const ready = runtimes.filter(runtime => runtime.available).length
  const tone = runtimes.length === 0 ? 'unknown'
    : ready === 0 ? 'down'
    : ready < runtimes.length ? 'partial'
    : 'ready'
  return { ready, total: runtimes.length, rooms: rooms.length, tone, text: `${ready}/${runtimes.length} runtimes ready · ${rooms.length} discovered rooms` }
}

const READINESS_COLOR = { ready: 'var(--ok)', partial: 'var(--warn)', down: 'var(--error)', unknown: 'var(--muted)' }

function renderCommand() {
  const box = $('command-library')
  if (!box) return
  const catalog = S.catalog
  if (!catalog) { box.innerHTML = '<div class="empty">waiting for Quorum catalog…</div>'; return }
  const available = catalog.runtimes.filter(r => r.available).length
  const rooms = S.projects?.rooms || []
  const readiness = commandReadiness(catalog, rooms)
  $('command-connection').textContent = readiness.text
  $('command-connection').style.color = READINESS_COLOR[readiness.tone]
  $('command-pulse').innerHTML = `<div class="command-stat"><b>${rooms.length}</b><span>project rooms</span></div><div class="command-stat"><b>${(S.sessions?.cards || []).filter(s => s.active).length}</b><span>active sessions</span></div><div class="command-stat"><b>${catalog.models.length}</b><span>catalog models</span></div><div class="command-stat"><b>${S.feed.length}</b><span>audit events</span></div>`
  const active = (S.agents?.agents || []).filter(agent => ['busy', 'working', 'active'].includes(agent.status))
  const lead = active[0] || (S.agents?.agents || [])[0]
  const leadProject = lead?.projectId || S.selectedRoom || rooms[0]?.id || 'no room selected'
  const selectedPack = catalog.agentPacks?.find(pack => pack.id === S.commandSelection.packId) || catalog.agentPacks?.[0]
  $('command-now').innerHTML = `<div class="command-now-copy"><span class="eyebrow">OPERATOR SIGNAL</span><strong>${esc(lead ? `${lead.name} has the floor.` : 'The floor is quiet.')}</strong><p>${esc(lead ? `${leadProject} · ${lead.status || 'live'} · route the next move when the evidence is ready.` : 'Give a concrete brief a room and a runtime. Quorum will keep the handoff inspectable.')}</p></div><div class="command-now-context"><span>current stance</span><b>${esc(selectedPack?.label || 'choose a pack')}</b><small>${esc(selectedPack?.role || 'waiting for a task')}</small></div><div id="command-quick-actions" class="command-quick-actions"><button type="button" data-quick-pack="scout" data-quick-task="Map the relevant code, docs, history, and evidence before anyone edits.">map the ground</button><button type="button" data-quick-pack="review" data-quick-task="Find correctness, security, and maintainability risks with focused proof.">find the risk</button><button type="button" data-quick-pack="qa" data-quick-task="Exercise the current product and report reproducible failures with exact evidence.">shake the build</button></div>`
  renderAgentWorkbench(catalog, rooms)
  renderOperatorConsole()
  renderConnectionMap()
  box.innerHTML = catalog.runtimes.map(runtime => `<article class="command-card ${runtime.available ? 'ready' : 'offline'} ${S.commandSelection.runtimeId === runtime.id ? 'selected' : ''}" data-command-runtime="${esc(runtime.id)}" tabindex="0" title="Select ${esc(runtime.label)} as the next route"><div class="pet-mini ${esc(runtime.id)}" aria-hidden="true">${esc(runtime.id.slice(0, 2).toUpperCase())}</div><div class="command-card-copy"><h3>${esc(runtime.label)} <span>${runtime.available ? 'ready' : 'offline'}</span></h3><p>${esc(runtime.kind)} · ${esc(runtime.capabilities.join(' · '))}</p><small>${runtime.authReady ? 'auth available via local environment' : 'auth not reported / optional'}</small></div><button type="button" data-command-launch="${esc(runtime.id)}" ${runtime.available && runtime.command && rooms.length ? '' : 'disabled'}>preview launch</button></article>`).join('')
  const selectRuntime = runtimeId => {
    S.commandSelection.runtimeId = runtimeId
    const runtimeSelect = $('agent-runtime')
    if (runtimeSelect?.querySelector(`option[value="${CSS.escape(runtimeId)}"]`)) runtimeSelect.value = runtimeId
    renderCommand()
  }
  for (const card of box.querySelectorAll('[data-command-runtime]')) {
    card.onclick = event => { if (!event.target.closest('button')) selectRuntime(card.dataset.commandRuntime) }
    card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectRuntime(card.dataset.commandRuntime) } }
  }
  for (const button of box.querySelectorAll('[data-command-launch]')) button.onclick = () => {
    S.commandSelection.runtimeId = button.dataset.commandLaunch
    const roomId = S.selectedRoom || rooms[0]?.id
    if (!roomId) return
    send({ type: 'command.preview', action: 'launch', runtimeId: button.dataset.commandLaunch, roomId })
    $('command-preview').textContent = `preparing ${button.dataset.commandLaunch} → ${roomId}`
    $('command-actions').innerHTML = `<button type="button" id="command-confirm">confirm launch</button><button type="button" id="command-cancel" class="danger">cancel</button>`
    $('command-confirm').onclick = () => send({ type: 'command.execute', action: 'launch', runtimeId: button.dataset.commandLaunch, roomId, confirm: true })
    $('command-cancel').onclick = () => { $('command-actions').innerHTML = ''; $('command-preview').textContent = 'action cancelled' }
  }
  for (const button of document.querySelectorAll('[data-quick-pack]')) button.onclick = () => {
    S.commandSelection.packId = button.dataset.quickPack
    const task = $('agent-task')
    if (task) task.value = button.dataset.quickTask
    renderCommand()
    $('agent-task')?.focus()
  }
  if (S.commandPreview) { $('command-preview').textContent = S.commandPreview.summary; $('command-actions').innerHTML = `<button type="button" id="command-confirm">confirm action</button>`; $('command-confirm').onclick = () => send({ type: 'command.execute', ...S.commandPreview, confirm: true }) }
}

async function hydrateOperatorRegistry(force = false) {
  if (S.operatorLoading || (S.operatorRegistry && !force)) return
  S.operatorLoading = true
  renderOperatorConsole()
  try {
    const paths = ['/api/workspaces', '/api/tools', '/api/mcp', '/api/agent-control/doctor']
    const responses = await Promise.all(paths.map(path => fetch(path)))
    const payloads = await Promise.all(responses.map(async response => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }))
    S.operatorRegistry = { workspaces: payloads[0], tools: payloads[1], mcp: payloads[2], doctor: payloads[3], checkedAt: Date.now() }
  } catch (error) {
    S.operatorRegistry = { error: error.message, checkedAt: Date.now() }
  } finally {
    S.operatorLoading = false
    renderOperatorConsole()
  }
}

function registryRow(label, ready, detail, flag = '') {
  return `<div class="registry-row ${ready ? 'ready' : 'offline'}"><span class="node-signal"></span><span><b>${esc(label)}</b><small>${esc(detail || 'not reported')}</small></span>${flag ? `<em>${esc(flag)}</em>` : ''}</div>`
}

function renderOperatorConsole() {
  const surface = $('operator-surface')
  const tabs = $('operator-tabs')
  if (!surface || !tabs) return
  for (const button of tabs.querySelectorAll('[data-operator-tab]')) {
    const selected = button.dataset.operatorTab === S.operatorTab
    button.classList.toggle('on', selected)
    button.setAttribute('aria-selected', String(selected))
    button.onclick = () => { S.operatorTab = button.dataset.operatorTab; renderOperatorConsole() }
  }
  const refresh = $('operator-refresh')
  if (refresh && !refresh.dataset.wired) { refresh.dataset.wired = '1'; refresh.onclick = () => hydrateOperatorRegistry(true) }
  if (S.operatorLoading && !S.operatorRegistry) { surface.innerHTML = '<div class="empty">reading local registries…</div>'; return }
  const registry = S.operatorRegistry || {}
  if (registry.error) { surface.innerHTML = `<div class="operator-alert"><b>Registry unavailable</b><span>${esc(registry.error)}</span></div>`; return }
  const workspaces = registry.workspaces?.workspaces || registry.workspaces?.rooms || []
  const tools = registry.tools?.tools || []
  const mcps = registry.mcp?.servers || registry.mcp?.mcp || []
  const doctor = registry.doctor || {}
  const sessions = S.sessions?.cards || []
  const agents = S.agents?.agents || []
  const pending = (S.agentControl?.actions || []).filter(action => action.status === 'pending-approval')
  const problemMissions = (S.missions?.missions || []).filter(mission => ['blocked', 'failed'].includes(mission.status))

  if (S.operatorTab === 'attention') {
    const notices = [
      ...pending.map(action => ({ tone: 'warn', title: `${action.action} needs approval`, detail: action.id, action })),
      ...problemMissions.map(mission => ({ tone: 'bad', title: mission.title, detail: `mission ${mission.status}` })),
      ...(doctor.blockers || []).map(blocker => ({ tone: 'warn', title: 'Provider blocker', detail: typeof blocker === 'string' ? blocker : blocker.detail || blocker.message })),
    ]
    surface.innerHTML = `<div class="operator-summary"><div><b>${agents.filter(agent => ['busy','working','active'].includes(agent.status)).length}</b><span>working agents</span></div><div><b>${pending.length}</b><span>approvals</span></div><div><b>${problemMissions.length}</b><span>blocked runs</span></div><div><b>${workspaces.length}</b><span>workspaces</span></div></div><div class="operator-notices">${notices.length ? notices.map(item => `<article class="operator-notice ${item.tone}"><span class="node-signal"></span><div><b>${esc(item.title)}</b><small>${esc(item.detail || '')}</small></div>${item.action ? `<button type="button" data-console-approve="${esc(item.action.id)}">approve</button><button type="button" data-console-cancel="${esc(item.action.id)}">cancel</button>` : ''}</article>`).join('') : '<div class="operator-clear"><span class="node-signal"></span><div><b>No intervention required</b><small>Live runs and local services have not raised an operator gate.</small></div></div>'}</div>`
  } else if (S.operatorTab === 'agents') {
    const profiles = agents.length ? agents : (S.catalog?.agentPacks || []).map(pack => ({ sessionId: `pack:${pack.id}`, name: pack.label, status: 'ready', projectId: 'route when assigned', summary: pack.summary }))
    surface.innerHTML = `<div class="operator-grid">${profiles.map(agent => `<button type="button" class="operator-profile" data-console-agent="${esc(agent.sessionId || agent.id)}"><span class="profile-mark">${esc((agent.name || 'AG').slice(0, 2).toUpperCase())}</span><span><b>${esc(agent.name || agent.role || 'agent')}</b><small>${esc(agent.summary || agent.projectId || 'available for a bounded task')}</small></span><em>${esc(agent.status || 'idle')}</em></button>`).join('') || '<div class="empty">No agent profiles reported.</div>'}</div>`
  } else if (S.operatorTab === 'workspaces') {
    surface.innerHTML = `<div class="operator-grid workspace-grid">${workspaces.map(room => `<article class="operator-workspace"><div><b>${esc(room.label || room.name || room.id)}</b><small>${esc(room.path || room.cwd || '')}</small></div><span>${room.sessionCount ?? room.sessions?.length ?? 0} sessions · ${room.missionCount ?? room.missions?.length ?? 0} missions</span><div><button type="button" data-console-room="${esc(room.id)}">focus</button><button type="button" data-console-terminal="${esc(room.id)}">terminal</button></div></article>`).join('') || '<div class="empty">No workspace registry entries.</div>'}</div>`
  } else if (S.operatorTab === 'tools') {
    const providers = doctor.providers?.catalog || doctor.providers || doctor.registry || []
    surface.innerHTML = `<div class="registry-columns"><div><div class="section-label">TOOLS</div>${tools.map(tool => registryRow(tool.name || tool.id, tool.connected ?? tool.available, `${tool.risk || 'local'} · ${(tool.capabilities || []).join(', ')}`, tool.approval ? 'approval' : '')).join('') || '<div class="empty-sm">—</div>'}</div><div><div class="section-label">MCP + PROVIDERS</div>${mcps.map(item => registryRow(item.name || item.id, item.connected ?? item.available, item.detail || item.command || 'configured')).join('')}${providers.slice(0, 12).map(item => registryRow(item.label || item.name || item.id, item.ready ?? item.available, item.detail || item.authReference || item.state || '')).join('')}</div></div>`
  } else {
    surface.innerHTML = `<div class="operator-feed">${[...S.feed].slice(-24).reverse().map(item => `<div><span>${esc(item.type || item.kind || 'event')}</span><b>${esc(item.detail || item.message || item.summary || '')}</b><small>${esc(item.at || item.time || '')}</small></div>`).join('') || '<div class="empty">No audit events yet.</div>'}</div>`
  }
  for (const button of surface.querySelectorAll('[data-console-approve],[data-console-cancel]')) button.onclick = async () => {
    const id = button.dataset.consoleApprove || button.dataset.consoleCancel
    await controlPost(`/api/agent-control/actions/${encodeURIComponent(id)}/${button.dataset.consoleApprove ? 'approve' : 'cancel'}`)
  }
  for (const button of surface.querySelectorAll('[data-console-room]')) button.onclick = () => { selectDeckProject(button.dataset.consoleRoom); setView('office') }
  for (const button of surface.querySelectorAll('[data-console-terminal]')) button.onclick = () => {
    const room = workspaces.find(item => item.id === button.dataset.consoleTerminal)
    if (!room) return
    $('drawer').classList.remove('collapsed')
    send({ type: 'pty.create', profile: 'shell', cwd: room.path || room.cwd, projectId: room.id, cols: 120, rows: 30 })
  }
  for (const button of surface.querySelectorAll('[data-console-agent]')) button.onclick = () => {
    const id = button.dataset.consoleAgent
    const session = sessions.find(item => item.id === id || item.sessionId === id)
    if (session) { selectSession(session.file, session.agent, session.cwd); setView('radar') }
    else { S.commandSelection.packId = id.replace('pack:', ''); renderCommand(); $('agent-task')?.focus() }
  }
}

function connectionRecord(id, label, state, detail, action = '') {
  const normalized = state === 'ready' || state === 'connected' ? 'ready' : ['reachable', 'connecting'].includes(state) ? 'reachable' : ['auth-required', 'degraded', 'protocol-error', 'unknown'].includes(state) ? state : 'offline'
  return `<div class="connection-row ${normalized}" data-connection-id="${esc(id)}"><span class="connection-dot"></span><span class="connection-copy"><b>${esc(label)}</b><small>${esc(detail)}</small></span><span class="connection-state">${esc(normalized)}</span>${action ? `<button type="button" class="connection-action" data-connection-action="${esc(action)}" title="${esc(action)}">${action === 'sync' ? 'sync' : 'probe'}</button>` : ''}</div>`
}

function renderConnectionMap() {
  const box = $('connection-map')
  if (!box) return
  const catalog = S.catalog
  const runtime = id => catalog?.runtimes?.find(item => item.id === id)
  const service = id => S.services?.[id]
  const openclaw = S.openclaw || service('openclaw') || {}
  const mem = S.memoryBridge?.claudeMem || {}
  const obs = S.memoryBridge?.obsidian || {}
  const rows = [
    connectionRecord('claude-mem', 'claude-mem', mem.state || (mem.configured ? 'unknown' : 'offline'), mem.reachable ? `${mem.endpoint || '/health'} · ${mem.latencyMs ?? '—'}ms` : (mem.error || 'loopback service unavailable'), 'probe'),
    connectionRecord('obsidian', 'Obsidian vault', obs.state || (obs.configured ? 'ready' : 'offline'), obs.writable ? `${obs.writeScope} · writable` : (obs.vault || 'vault not found'), 'sync'),
    connectionRecord('codex', 'Codex', runtime('codex')?.available ? 'ready' : 'offline', runtime('codex')?.available ? 'managed launch available' : 'CLI not found on Quorum PATH'),
    connectionRecord('claude', 'Claude', runtime('claude')?.available ? 'ready' : 'offline', runtime('claude')?.available ? 'managed launch available' : 'CLI not found on Quorum PATH'),
    connectionRecord('hermes', 'Hermes gateway', service('hermes')?.up ? 'ready' : 'offline', service('hermes')?.up ? `port ${service('hermes').port}` : 'gateway not detected'),
    connectionRecord('openclaw', 'OpenClaw', openclaw.connectionState || (openclaw.up ? 'reachable' : 'offline'), openclaw.connectionState === 'connected' ? `port ${openclaw.port || 18789} · authenticated` : openclaw.connectionState === 'auth-required' || openclaw.authState === 'required' ? `port ${openclaw.port || 18789} · auth required · credential reference only` : openclaw.up ? `port ${openclaw.port || 18789} · ${openclaw.connectionState || 'reachable'}` : 'optional adapter offline', 'probe'),
  ]
  const ready = rows.filter(row => row.includes('connection-row ready')).length
  box.innerHTML = `<div class="connection-summary"><b>${ready}/${rows.length}</b><span>live paths</span><small>${mem.checkedAt ? `checked ${relLabel(new Date(mem.checkedAt).getTime(), { suffix: ' ago' })}` : 'awaiting probe'}</small></div>${rows.join('')}`
  const refresh = $('connection-refresh')
  if (refresh && !refresh.dataset.wired) {
    refresh.dataset.wired = '1'
    refresh.onclick = () => refreshMemoryBridge()
  }
  for (const button of box.querySelectorAll('[data-connection-action]')) {
    button.onclick = () => {
      if (button.closest('[data-connection-id]')?.dataset.connectionId === 'openclaw') {
        button.disabled = true
        fetch('/api/openclaw/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => fetch('/api/openclaw/status')).then(response => response.json()).then(status => { S.openclaw = status; renderConnectionMap(); renderDeck() }).catch(error => { $('artifact-status').textContent = error.message }).finally(() => { button.disabled = false })
        return
      }
      button.dataset.connectionAction === 'sync' ? syncMemoryBridge() : refreshMemoryBridge()
    }
  }
}

async function refreshMemoryBridge() {
  const refresh = $('connection-refresh')
  if (refresh) refresh.disabled = true
  try {
    const response = await fetch('/api/memory/status')
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'memory probe failed')
    S.memoryBridge = data
    renderMemory(); renderConnectionMap()
  } catch (error) { $('artifact-status').textContent = error.message } finally { if (refresh) refresh.disabled = false }
}

async function syncMemoryBridge() {
  const status = $('artifact-status')
  try {
    status.textContent = 'syncing index and bridge…'
    const result = await postJson('/api/memory/sync', {})
    S.artifacts = result.artifacts
    S.memoryBridge = result.bridge
    S.artifactResults = null
    const bridgeLabel = result.sync?.ok ? `bridge +${result.sync.newItems || 0} new` : `bridge ${result.bridge.claudeMem.state}`
    const blindRoots = (result.artifacts.roots || []).filter(root => root.readable === false).length
    status.textContent = `indexed ${result.artifacts.stats.total} artifacts${blindRoots ? ` · ${blindRoots} root${blindRoots === 1 ? '' : 's'} unreadable` : ''} · ${bridgeLabel}`
    renderMemory(); renderMemoryRing(); renderConnectionMap()
  } catch (error) { status.textContent = error.message }
}

function renderAgentWorkbench(catalog, rooms) {
  const form = $('agent-form')
  if (!form) return
  const packs = catalog.agentPacks || []
  const packSelect = $('agent-pack')
  const runtimeSelect = $('agent-runtime')
  const modelSelect = $('agent-model')
  if (!packs.length) { form.innerHTML = '<div class="empty">agent packs unavailable</div>'; return }
  const previousPack = S.commandSelection.packId || packSelect.value
  packSelect.innerHTML = packs.map(pack => `<option value="${esc(pack.id)}">${esc(pack.label)} · ${esc(pack.role)}</option>`).join('')
  packSelect.value = packs.some(pack => pack.id === previousPack) ? previousPack : packs[0].id
  S.commandSelection.packId = packSelect.value
  const pack = packs.find(item => item.id === packSelect.value) || packs[0]
  const candidates = catalog.runtimes.filter(runtime => pack.runtimes?.includes(runtime.id) && runtime.command && runtime.id !== 'shell')
  const ready = candidates.filter(runtime => runtime.available)
  const runtimeChoices = ready.length ? ready : candidates
  const oldRuntime = S.commandSelection.runtimeId || runtimeSelect.value
  runtimeSelect.innerHTML = runtimeChoices.map(runtime => `<option value="${esc(runtime.id)}">${esc(runtime.label)}${runtime.available ? '' : ' · offline'}</option>`).join('')
  runtimeSelect.value = runtimeChoices.some(runtime => runtime.id === oldRuntime) ? oldRuntime : runtimeChoices[0]?.id || ''
  S.commandSelection.runtimeId = runtimeSelect.value
  const runtimeId = runtimeSelect.value
  const options = (pack.models || []).filter(model => model.provider === runtimeId)
  if (!options.length) options.push({ id: `${runtimeId}:auto`, label: `${runtimeId} · runtime default`, provider: runtimeId, model: 'auto', available: true })
  const oldModel = modelSelect.value
  modelSelect.innerHTML = options.map(model => `<option value="${esc(model.id)}">${esc(model.label)}</option>`).join('')
  modelSelect.value = options.some(model => model.id === oldModel) ? oldModel : options[0].id
  $('agent-brief').innerHTML = `<strong>${esc(pack.summary)}</strong><span>${esc(pack.gates.join(' · '))}</span><small>role ${esc(pack.role)} · pack contract ${pack.promptAvailable ? 'loaded' : 'missing'}</small>`
  packSelect.onchange = () => { S.commandSelection.packId = packSelect.value; renderCommand() }
  runtimeSelect.onchange = () => { S.commandSelection.runtimeId = runtimeSelect.value; renderCommand() }
  form.onsubmit = event => {
    event.preventDefault()
    const roomId = S.selectedRoom || rooms[0]?.id
    const task = $('agent-task').value.trim()
    if (!roomId || !runtimeId || !task) { $('agent-brief').classList.add('warn'); $('agent-brief').insertAdjacentHTML('beforeend', '<span>Choose a room and write a bounded task brief.</span>'); return }
    send({ type: 'command.preview', action: 'launch', packId: pack.id, runtimeId, modelRef: modelSelect.value, roomId, task })
    $('command-preview').textContent = `preparing ${pack.label} → ${runtimeId} · ${roomId}`
    $('command-actions').innerHTML = '<button type="button" id="command-cancel" class="danger">cancel</button>'
    $('command-cancel').onclick = () => { S.commandPreview = null; $('command-actions').innerHTML = ''; $('command-preview').textContent = 'action cancelled' }
  }
}

async function controlPost(path, body = {}) {
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    return data
  } catch (error) { console.warn('[agent-control]', error.message); return null }
}

function renderAgentControl() {
  const box = $('agent-control-card')
  if (!box) return
  const control = S.agentControl
  if (!control) { box.innerHTML = '<div class="empty-sm">control plane warming up…</div>'; return }
  const runs = (control.runs || []).slice(0, 8)
  const pending = (control.actions || []).filter(action => action.status === 'pending-approval')
  const lease = control.policy?.lease?.ttlSeconds ? `${Math.round(control.policy.lease.ttlSeconds / 60)}m lease` : 'lease active'
  box.innerHTML = `<div class="control-summary"><span><b>${runs.filter(run => run.status === 'active').length}</b> active</span><span><b>${pending.length}</b> pending</span><span>${esc(lease)}</span></div>` +
    (runs.length ? runs.map(run => `<div class="control-run"><span class="dot ${run.status === 'active' ? 'up' : ''}"></span><span class="control-run-copy"><b>${esc(run.packId || run.runtime)} · ${esc(run.role)}</b><small>${esc(run.phase || run.status)} · ${esc(run.worktree)}</small></span><span class="control-run-actions"><small>${run.leaseExpiresAt ? relLabel(run.leaseExpiresAt, { suffix: ' lease' }) : 'closed'}</small>${run.status === 'active' ? `<button type="button" data-control-run-cancel="${esc(run.runId)}">stop</button>` : ''}${run.status === 'stale' ? `<button type="button" data-control-run-recover="${esc(run.runId)}">recover</button>` : ''}</span></div>`).join('') : '<div class="empty-sm">no claimed runs</div>') +
    (pending.length ? `<div class="control-pending"><b>EXTERNAL APPROVALS</b>${pending.map(action => `<div><span>${esc(action.action)} · ${esc(action.id)}</span><button type="button" data-control-approve="${esc(action.id)}">approve</button><button type="button" data-control-cancel="${esc(action.id)}">cancel</button></div>`).join('')}</div>` : '')
  for (const button of box.querySelectorAll('[data-control-approve],[data-control-cancel]')) button.onclick = async () => {
    await controlPost(`/api/agent-control/actions/${encodeURIComponent(button.dataset.controlApprove || button.dataset.controlCancel)}/${button.dataset.controlApprove ? 'approve' : 'cancel'}`)
  }
  for (const button of box.querySelectorAll('[data-control-run-cancel],[data-control-run-recover]')) button.onclick = async () => {
    const runId = button.dataset.controlRunCancel || button.dataset.controlRunRecover
    const suffix = button.dataset.controlRunCancel ? 'cancel' : 'recover'
    await controlPost(`/api/agent-control/runs/${encodeURIComponent(runId)}/${suffix}`)
  }
}
const comfyDl = () => (S.processes?.procs || []).some(p => p.group === 'comfy' && p.name?.startsWith('hf ⇣'))

/* ── office floor ──────────────────────────────────────── */
function renderOffice() {
  const proj = S.projects
  if (!proj) {
    // Through writeIfChanged, not around it: these two containers are guarded,
    // and a raw innerHTML here would leave `__quorumHtml` holding the previous
    // room markup. The next tick with an unchanged room set would then compare
    // equal, skip the write, and leave the Office stuck on "loading rooms…".
    writeIfChanged($('team-desks'), '<div class="empty-sm">loading team…</div>')
    writeIfChanged($('rooms-grid'), '<div class="empty">loading rooms…</div>')
    return
  }

  const DRAGGABLE_RUNTIME = new Set(['claude', 'codex', 'hermes'])
  const deskMarkup = (proj.team || []).map(t =>
    `<div class="desk ${t.alive ? 'alive' : 'idle'}" data-agent="${esc(t.id)}"
          ${DRAGGABLE_RUNTIME.has(t.id) ? 'draggable="true" title="drag onto a room to open a terminal there"' : ''}>
      <span class="desk-pulse"></span>
      <span class="desk-name">${esc(t.label)}</span>
      <span class="desk-count">${t.count || (t.alive ? 'up' : '—')}</span>
    </div>`).join('')
  if (writeIfChanged($('team-desks'), deskMarkup)) {
    for (const el of $('team-desks').querySelectorAll('.desk[draggable]'))
      el.ondragstart = e => e.dataTransfer.setData('text/plain', 'runtime:' + el.dataset.agent)
  }

  const rooms = proj.rooms || []
  const cfg = proj.config
  $('room-count').textContent = `· ${rooms.length}` +
    (cfg ? ` · ${cfg.discovered} discovered` : '')
  const head = document.querySelector('#office-floor .col-head')
  if (head && cfg) {
    head.title = cfg.malformed
      ? `${cfg.path} is not valid JSON — using auto-discovery`
      : `rooms come from ${cfg.exists ? cfg.path : 'auto-discovery'} · scanning ${(cfg.roots || []).join(', ')}`
  }
  const debatingRoom = S.debate && !S.debate.endedAt ? S.debate.roomId : null

  const roomMarkup = rooms.map(r => {
    const mode = r.id === debatingRoom ? 'roundtable' : r.active ? 'focus' : 'idle'
    const badges = (r.agents || []).map(a =>
      `<span class="badge ${a === 'codex' ? 'cx' : a === 'hermes' ? 'hm' : 'cl'}">${a === 'codex' ? 'CX' : a === 'hermes' ? 'HM' : 'CL'}</span>`
    ).join('')
    return `<div class="room mode-${mode} ${r.active ? 'active' : ''} ${S.selectedRoom === r.id ? 'selected' : ''}" data-id="${esc(r.id)}">
      ${drawRoom(mode)}
      <div class="room-body">
        <div class="room-top">
          ${r.active ? '<span class="pulse"></span>' : '<span class="idle-dot"></span>'}
          <span class="room-label">${esc(r.label)}</span>
          ${badges}
        </div>
        <div class="room-sum">${esc(r.summary || (r.sessionCount ? `${r.sessionCount} session(s)` : 'empty desk'))}</div>
        <div class="room-path">${esc(r.cwd.split('/').slice(-2).join('/'))}</div>
      </div>
      ${mode === 'roundtable' ? '<span class="room-flag">roundtable in session</span>' : ''}
    </div>`
  }).join('') || setupCard(cfg)
  if (writeIfChanged($('rooms-grid'), roomMarkup)) {
    for (const el of $('rooms-grid').querySelectorAll('.room')) {
      el.onclick = () => selectRoom(el.dataset.id)
      wireRoomDrop(el)
    }
  }
}

/* The empty floor is a teaching moment, not an error. Tell the user exactly
 * where rooms come from and the one file that changes it. */
function setupCard(cfg) {
  const p = cfg?.path || '~/.quorum/config.json'
  return `<div class="setup-card">
    <h3>No project rooms yet</h3>
    <p>Quorum scans for projects automatically${cfg?.roots?.length ? ` under <code>${esc(cfg.roots.join('</code>, <code>'))}</code>` : ''} —
    any folder with a <code>.git</code>, <code>package.json</code> or similar marker becomes a room.</p>
    <p>To point it somewhere else, create <code>${esc(p)}</code>:</p>
    <pre>{
  "roots": ["~/code"],
  "projects": [{ "id": "api", "label": "Billing API", "path": "~/code/api" }]
}</pre>
    <p class="hint">The floor refreshes within 30 seconds of the edit — no restart needed.</p>
  </div>`
}

/* ── steering: drag a character into a room ────────────────────────────
 *
 * Two different things can be dropped and they mean different things, so the
 * drag payload is namespaced rather than being a bare id:
 *   runtime:<profile>  → seat a real CLI (spawns a PTY in that room's cwd)
 *   cast:<id>          → put a character on the roundtable for that room
 * Conflating them would make "drag Vex into the portal" ambiguous between
 * "start a terminal" and "have Vex argue about the portal".
 */
function wireRoomDrop(el) {
  el.ondragover = e => { e.preventDefault(); el.classList.add('drop-target') }
  el.ondragleave = () => el.classList.remove('drop-target')
  el.ondrop = e => {
    e.preventDefault()
    el.classList.remove('drop-target')
    const payload = e.dataTransfer.getData('text/plain') || ''
    const [kind, id] = payload.split(':')
    const room = (S.projects?.rooms || []).find(r => r.id === el.dataset.id)
    if (!room) return
    selectRoom(room.id)

    if (kind === 'runtime') {
      $('drawer').classList.remove('collapsed')
      send({ type: 'pty.create', profile: id, cwd: room.cwd, projectId: room.id, cols: 120, rows: 30 })
      return
    }
    if (kind === 'cast' && S.castById.has(id)) {
      if (id !== 'nib') S.seated.add(id)
      persistSeated()
      $('rt-room').value = room.id
      setView('table')
      $('rt-topic')?.focus()
    }
  }
}

const persistSeated = () => localStorage.setItem('quorum-seated', JSON.stringify([...S.seated]))

/* ── crew strip ────────────────────────────────────────────────────────── */
function renderCrew() {
  const box = $('crew-list')
  if (!box) return
  box.innerHTML = S.cast.map(c => `
    <div class="crew ${S.seated.has(c.id) ? 'seated' : ''} ${c.locked ? 'locked' : ''}" data-id="${esc(c.id)}"
         ${c.locked ? '' : 'draggable="true"'}
         title="${esc(c.name)} — ${esc(c.tagline)}${c.locked ? ' · Quorum Pro' : ''}">
      <span class="crew-art">${drawCharacter(c, { size: LOD.avatar })}</span>
      <span class="crew-meta">
        <span class="crew-name">${esc(c.name)}</span>
        <span class="crew-role">${esc(c.role)}</span>
      </span>
      ${c.locked ? '<span class="crew-tag pro">pro</span>'
        : c.mascot ? '<span class="crew-tag">host</span>'
        : S.seated.has(c.id) ? '<span class="crew-tag on">seated</span>' : ''}
    </div>`).join('')

  for (const el of box.querySelectorAll('.crew')) {
    el.ondragstart = e => e.dataTransfer.setData('text/plain', 'cast:' + el.dataset.id)
    el.onclick = () => {
      const id = el.dataset.id
      const c = S.castById.get(id)
      if (c?.locked) return showUpgrade(c)
      if (id === 'nib') return          // the moderator is structural, not seatable
      S.seated.has(id) ? S.seated.delete(id) : S.seated.add(id)
      persistSeated()
      renderCrew(); renderCastPicker(); renderEstimate()
    }
  }
}

/* Where a locked character sends you. The funnel depends on greyed-out seats
 * driving clicks, so the click has to land somewhere: this is the landing page
 * that carries the current price, not a price baked into a shipped build.
 * Swap it for the direct Gumroad product URL once that listing is published. */
const PRO_URL = 'https://tridentsocial.net/quorum/#pricing'

/* A locked character is advertised, not hidden — seeing Sable greyed out with
 * "paid to find the way it breaks" underneath is what sells the upgrade. */
function showUpgrade(c) {
  const box = $('rt-estimate')
  setView('table')
  if (!box) return
  box.className = 'rt-estimate warn'
  box.innerHTML = `<b>${esc(c.name)}</b> — ${esc(c.role)} — is part of Quorum Pro. ` +
    `The free edition seats Nib, Vex and Bolt, which is enough for a real debate. ` +
    `Pro adds the full six-character crew and lets you write your own specialists. ` +
    `<a class="upgrade-link" href="${PRO_URL}" target="_blank" rel="noopener noreferrer">See what Pro adds →</a>`
}

function renderEdition() {
  const el = $('edition-badge')
  if (!el) return
  const pro = S.edition?.tier === 'pro'
  el.className = 'edition ' + (pro ? 'pro' : 'free')
  el.textContent = pro ? 'PRO' : 'FREE'
  // An expired update window is not a lockout: the badge stays PRO and the
  // tooltip says when updates ended rather than pretending the licence is gone.
  el.title = pro
    ? `Quorum Pro${S.edition.licence?.registeredTo ? ' — ' + S.edition.licence.registeredTo : ''}` +
      (S.edition.updatesExpired && S.edition.updatesUntil ? ` — updates ended ${S.edition.updatesUntil}` : '')
    : `Free edition — ${S.edition?.reason || 'no licence'}`
}

function renderMascot() {
  const slot = $('mascot-slot')
  const nib = S.castById.get('nib')
  if (!slot || !nib) return
  const busy = S.debate && !S.debate.endedAt
  const alert = !!S.debate?.error
  slot.innerHTML = drawMascot(nib, alert ? 'alert' : busy ? 'busy' : 'idle')
}

function selectRoom(id) {
  const room = (S.projects?.rooms || []).find(r => r.id === id)
    || (S.projects?.catalog || []).find(r => r.id === id)
  if (!room) return
  S.selectedRoom = id
  S.selectedProjectId = id
  S.selectedCwd = room.cwd
  S.deckSelection = { kind: 'project', id }
  renderOffice()
  renderRoomDetail()

  const cards = (S.sessions?.cards || []).filter(c => c.projectId === id)
  const top = cards.find(c => c.active) || cards[0]
  if (top) {
    S.selected = top.file
    send({ type: 'watch', file: top.file, agent: top.agent })
  }
}

function renderRoomDetail() {
  const room = (S.projects?.rooms || []).find(r => r.id === S.selectedRoom)
  const spawnBtns = $('room-spawn-actions')?.querySelectorAll('button') || []
  for (const b of spawnBtns) b.disabled = !S.selectedCwd

  if (!room) {
    $('room-detail-head').textContent = 'select a room'
    $('room-detail').innerHTML = '<div class="empty">⌁ pick a project room — teammates light up when sessions sit in that cwd</div>'
    $('room-sessions').innerHTML = '—'
    $('room-sessions').className = 'empty-sm'
    return
  }

  $('room-detail-head').textContent = room.label
  $('room-detail').innerHTML =
    `<div class="kv">` +
    row('status', room.active ? '<span style="color:var(--green)">occupied</span>' : '<span style="color:var(--dim)">idle</span>') +
    row('sessions', String(room.sessionCount)) +
    row('agents', (room.agents || []).join(', ') || '—') +
    row('cwd', `<code title="${esc(room.cwd)}">${esc(room.cwd)}</code>`) +
    `</div>` +
    (room.summary ? `<p class="room-live-sum">${esc(room.summary)}</p>` : '')

  const cards = (S.sessions?.cards || []).filter(c => c.projectId === room.id)
  if (!cards.length) {
    $('room-sessions').className = 'empty-sm'
    $('room-sessions').textContent = 'no recent sessions in this room'
    return
  }
  $('room-sessions').className = ''
  $('room-sessions').innerHTML = cards.slice(0, 12).map(c =>
    `<div class="room-sess ${S.selected === c.file ? 'selected' : ''}" data-file="${esc(c.file)}" data-agent="${c.agent}" data-cwd="${esc(c.cwd || '')}">
      ${c.active ? '<span class="pulse"></span>' : '<span class="idle-dot"></span>'}
      <span class="badge ${c.agent === 'codex' ? 'cx' : 'cl'}">${c.agent === 'codex' ? 'CX' : 'CL'}</span>
      <span class="room-sess-sum">${esc(c.summary || c.id)}</span>
      ${relLabel(c.mtimeMs, { cls: 'sess-time' })}
    </div>`
  ).join('')
  for (const el of $('room-sessions').querySelectorAll('.room-sess'))
    el.onclick = () => {
      S.selectedCwd = el.dataset.cwd || S.selectedCwd
      selectSession(el.dataset.file, el.dataset.agent, el.dataset.cwd)
      renderRoomDetail()
    }
}

// Delegated, not bound per button: the button set is re-rendered whenever the
// runtime list changes, and per-element handlers would be orphaned by that.
$('room-spawn-actions').addEventListener('click', e => {
  const b = e.target.closest('button[data-profile]')
  if (b) {
    if (!S.selectedCwd) return
    $('drawer').classList.remove('collapsed')
    send({
      type: 'pty.create',
      profile: b.dataset.profile,
      cwd: S.selectedCwd,
      projectId: S.selectedProjectId || undefined,
      cols: 120,
      rows: 30,
    })
  }
})

/* ── 3D command deck ───────────────────────────────────── */
function renderCityControls(model) {
  const index = $('city-index'), search = $('city-search'), filter = $('city-filter'), toggle = $('city-list-toggle')
  if (!index || !search || !filter || !toggle) return
  const entities = [...(model.buildings || []), ...(model.characters || []), ...(model.workers || [])]
  index._cityEntities = new Map(entities.map(item => [item.id, item]))
  const paint = () => {
    const query = search.value.trim().toLowerCase(), kind = filter.value
    const visible = entities.filter(item => (kind === 'all' || item.entityType === kind) && (!query || `${item.label} ${item.projectId || ''} ${item.kind || ''}`.toLowerCase().includes(query))).slice(0, 120)
    const markup = visible.map(item => `<button type="button" data-city-entity="${esc(item.id)}"><span class="node-signal"></span><b>${esc(item.label)}</b><small>${esc(item.entityType)} · ${esc(item.state || item.status || 'monitoring')}</small></button>`).join('') || '<div class="empty-sm">No matching city entities.</div>'
    if (index.dataset.signature !== markup) { index.innerHTML = markup; index.dataset.signature = markup }
  }
  if (!search.dataset.wired) {
    search.dataset.wired = '1'; search.oninput = paint; filter.onchange = paint
    index.onclick = event => { const button = event.target.closest('[data-city-entity]'); if (!button) return; const item = index._cityEntities?.get(button.dataset.cityEntity); withCity(module => module.focusCityEntity(button.dataset.cityEntity)); if (item) selectCityEntity(item) }
    toggle.onclick = () => { const hidden = index.classList.toggle('hidden'); toggle.setAttribute('aria-expanded', String(!hidden)) }
  }
  paint()
}

function selectCityEntity(entity) {
  if (entity.entityType === 'building' && entity.projectId) selectDeckProject(entity.projectId)
  else if (entity.entityType === 'agent' && entity.sessionId) selectDeckAgent(entity.sessionId)
  else if (entity.entityType === 'infrastructure') {
    S.deckSelection = { kind: 'infrastructure', id: entity.id }
    $('deck-detail-kind').textContent = entity.district || 'infrastructure'
    $('deck-detail').innerHTML = `<b>${esc(entity.label)}</b><div class="kv"><div>state <b>${esc(entity.status || 'monitoring')}</b></div>${entity.connectionState ? `<div>connection <b>${esc(entity.connectionState)}</b></div>` : ''}${entity.authState ? `<div>auth <b>${esc(entity.authState)}</b></div>` : ''}${entity.port ? `<div>loopback <b>127.0.0.1:${esc(entity.port)}</b></div>` : ''}</div>`
    if (entity.id === 'building:gateway:openclaw') {
      const connected = entity.connectionState === 'connected'
      $('deck-actions').innerHTML = `<button type="button" id="openclaw-refresh">refresh status</button><button type="button" id="openclaw-preview-restart" ${connected ? '' : 'disabled'}>preview gateway restart</button><span class="hint">${entity.authState === 'required' ? 'credentials stay in the gateway · Quorum stores only the environment reference' : connected ? 'mutating gateway actions require confirmation' : 'authenticate the gateway before mutating actions'}</span>`
      $('openclaw-refresh').onclick = async () => { try { await fetch('/api/openclaw/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const response = await fetch('/api/openclaw/status'); if (!response.ok) throw new Error(`OpenClaw status ${response.status}`); S.openclaw = await response.json(); renderConnectionMap(); renderDeck() } catch (error) { $('deck-actions').innerHTML = `<span class="warn">${esc(error.message)}</span>` } }
      $('openclaw-preview-restart').onclick = () => previewOpenClawAction('gateway.restart', { reason: 'operator request from Agent City' })
    } else $('deck-actions').innerHTML = '<span class="hint">read-only infrastructure status</span>'
  }
  else if (entity.entityType === 'process') {
    S.deckSelection = { kind: 'process', id: entity.id }
    $('deck-detail-kind').textContent = entity.kind || 'process'
    $('deck-detail').innerHTML = `<b>${esc(entity.label)}</b><div class="kv"><div>pid <b>${esc(entity.pid)}</b></div><div>state <b>${esc(entity.state)}</b></div><div>ownership <b>${esc(entity.ownership)}</b></div></div>`
    $('deck-actions').innerHTML = entity.ownership === 'user-owned' || entity.ownership === 'quorum-launched' ? `<button type="button" data-process-preview="pause" data-pid="${esc(entity.pid)}">pause</button><button type="button" data-process-preview="terminate" data-pid="${esc(entity.pid)}" class="danger">terminate</button>` : '<span class="hint">protected · privileged approval required</span>'
    for (const button of $('deck-actions').querySelectorAll('[data-process-preview]')) button.onclick = () => previewProcessAction(button.dataset.pid, button.dataset.processPreview)
  }
}

async function previewProcessAction(pid, action) {
  try { const result = await postJson('/api/process-actions/preview', { pid: Number(pid), action, reason: 'operator request from Agent City' }); $('deck-actions').innerHTML = `<div class="process-preview"><span>${esc(result.preview.action)} ${esc(result.preview.target.name)}?</span><button type="button" id="process-confirm">confirm</button><button type="button" id="process-cancel">cancel</button></div>`; $('process-confirm').onclick = async () => { await postJson('/api/process-actions/confirm', { previewId: result.preview.id }); $('deck-actions').innerHTML = '<span class="hint">action sent and audited</span>' }; $('process-cancel').onclick = () => { $('deck-actions').innerHTML = '<span class="hint">action cancelled</span>' } } catch (error) { $('deck-actions').innerHTML = `<span class="warn">${esc(error.message)}</span>` }
}

async function previewOpenClawAction(method, input = {}) {
  try {
    const result = await postJson('/api/openclaw/actions/preview', { method, params: input.params || {}, reason: input.reason || 'operator request from Agent City' })
    $('deck-actions').innerHTML = `<div class="process-preview"><span>${esc(method)}?</span><button type="button" id="openclaw-confirm">confirm</button><button type="button" id="openclaw-cancel">cancel</button></div>`
    $('openclaw-confirm').onclick = async () => { await postJson('/api/openclaw/actions/confirm', { previewId: result.preview.id }); $('deck-actions').innerHTML = '<span class="hint">gateway action sent and audited</span>' }
    $('openclaw-cancel').onclick = async () => { try { await postJson('/api/openclaw/actions/cancel', { previewId: result.preview.id }); $('deck-actions').innerHTML = '<span class="hint">gateway action cancelled and audited</span>' } catch (error) { $('deck-actions').innerHTML = `<span class="warn">${esc(error.message)}</span>` } }
  } catch (error) { $('deck-actions').innerHTML = `<span class="warn">${esc(error.message)}</span>` }
}

function renderDeck() {
  const space = $('deck-space')
  const nodes = $('deck-nodes')
  if (!space || !nodes) return

  const rooms = S.projects?.rooms || []
  const agents = (S.agents?.agents || []).slice(0, 16)
  const sessions = S.sessions?.cards || []
  const activeSessions = sessions.filter(s => s.active).length
  const sys = S.system || {}
  const w = space.clientWidth || 900
  const h = space.clientHeight || 560
  const pressure = sys.freeMB < 500 || sys.swapUsedMB > 2048 ? 'HIGH' : sys.freeMB < 1500 ? 'WATCH' : 'NOMINAL'
  const pressureColor = pressure === 'HIGH' ? 'var(--red)' : pressure === 'WATCH' ? 'var(--yellow)' : 'var(--green)'

  $('deck-count').textContent = `· ${rooms.length} rooms · ${agents.length} agents`
  $('deck-connection').textContent = `LIVE LINK · ${ws?.readyState === 1 ? 'CONNECTED' : 'RECONNECTING'}`
  $('deck-connection').style.color = ws?.readyState === 1 ? 'var(--green)' : 'var(--red)'
  $('deck-pressure-label').textContent = pressure
  $('deck-pressure-label').style.color = pressureColor
  $('deck-core-stats').textContent = `${activeSessions} live · ${S.terms.size} CLI`
  writeIfChanged($('deck-stats'), [
    deckStat('free', sys.freeMB == null ? '—' : gb(sys.freeMB)),
    deckStat('load', sys.load == null ? '—' : sys.load),
    deckStat('sessions', `${activeSessions}/${sessions.length}`),
    deckStat('processes', String(S.processes?.procs?.length || 0)),
    deckStat('rooms', String(rooms.length)),
    deckStat('memory', S.memory?.ledger?.counts ? `${S.memory.ledger.counts.pending} pending` : '—'),
    deckStat('websocket', ws?.readyState === 1 ? 'live' : 'wait'),
  ].join(''))
  const cityModel = S.city || { buildings: rooms.map((room, index) => ({ id: `building:${room.id}`, entityType: 'building', projectId: room.id, label: room.label, status: room.active ? 'active' : 'monitoring', index, sessionCount: sessions.filter(item => item.projectId === room.id).length })), characters: agents.map(agent => ({ id: `agent:${agent.sessionId}`, entityType: 'agent', label: agent.name, state: agent.status || 'monitoring', projectId: agent.projectId, sessionId: agent.sessionId })), workers: [] }
  withCity(module => module.updateAgentCity(cityModel, { onSelect: selectCityEntity }))
  renderCityControls(cityModel)
  $('city-live-label').textContent = `${cityModel.buildings?.length || 0} buildings · ${cityModel.characters?.length || 0} agents · ${cityModel.workers?.length || 0} workers`

  const rankedRooms = [...rooms].sort((a, b) => Number(b.active) - Number(a.active) || sessions.filter(s => s.projectId === b.id).length - sessions.filter(s => s.projectId === a.id).length)
  const visibleRooms = rankedRooms.slice(0, Math.min(16, rankedRooms.length))
  const roomNodes = visibleRooms.map((room, i) => {
    const inner = i < Math.min(8, visibleRooms.length)
    const band = inner ? visibleRooms.slice(0, 8) : visibleRooms.slice(8)
    const bandIndex = inner ? i : i - 8
    const angle = (bandIndex / Math.max(1, band.length)) * Math.PI * 2 - Math.PI / 2 + (inner ? 0 : .18)
    const roomRadiusX = Math.max(inner ? 170 : 260, Math.min(w * (inner ? .27 : .4), inner ? 285 : 430))
    const roomRadiusY = Math.max(inner ? 92 : 150, Math.min(h * (inner ? .2 : .34), inner ? 145 : 235))
    const x = Math.cos(angle) * roomRadiusX
    const y = Math.sin(angle) * roomRadiusY
    const z = room.active ? 105 : 35 + (i % 3) * 12
    const selected = S.deckSelection.kind === 'project' && S.deckSelection.id === room.id
    const cards = sessions.filter(s => s.projectId === room.id)
    return `<div class="deck-node project ${room.active ? 'active' : ''} ${selected ? 'selected' : ''}" data-kind="project" data-id="${esc(room.id)}" tabindex="0" style="--x:${x}px;--y:${y}px;--z:${z}px">
      <div class="node-top"><span class="node-signal"></span><span class="node-title">${esc(room.label)}</span></div>
      <div class="node-meta">${cards.length} session${cards.length === 1 ? '' : 's'} · ${esc(room.agents?.join(', ') || 'idle')}</div>
    </div>`
  }).join('')

  const agentRadiusX = Math.max(125, Math.min(w * .27, 300))
  const agentRadiusY = Math.max(80, Math.min(h * .23, 160))
  const agentNodes = agents.map((agent, i) => {
    const angle = (i / Math.max(1, agents.length)) * Math.PI * 2 + Math.PI / 5
    const x = Math.cos(angle) * agentRadiusX
    const y = Math.sin(angle) * agentRadiusY
    const selected = S.deckSelection.kind === 'agent' && S.deckSelection.id === agent.sessionId
    return `<div class="deck-node agent ${agent.status === 'busy' ? 'busy' : ''} ${selected ? 'selected' : ''}" data-kind="agent" data-id="${esc(agent.sessionId)}" tabindex="0" style="--x:${x}px;--y:${y}px;--z:150px">
      <div class="node-top"><span class="node-signal"></span><span class="node-title">${esc(agent.name)}</span></div>
      <div class="node-meta">${esc(agent.projectId || 'unassigned')} · ${esc(agent.status || 'idle')}</div>
    </div>`
  }).join('')

  const nodesChanged = writeIfChanged(nodes, roomNodes + agentNodes + (rooms.length > visibleRooms.length ? `<button type="button" class="deck-more" data-deck-more>${rooms.length - visibleRooms.length} more rooms<br><small>open workspace index</small></button>` : ''))
  const activateDeckNode = (node, doubleClick = false) => {
    if (!node) return
    if (!doubleClick) {
      if (node.dataset.kind === 'project') selectDeckProject(node.dataset.id)
      else selectDeckAgent(node.dataset.id)
      return
    }
    if (node.dataset.kind === 'project') {
      const card = sessions.find(s => s.projectId === node.dataset.id && s.active) || sessions.find(s => s.projectId === node.dataset.id)
      if (card) { selectSession(card.file, card.agent, card.cwd); setView('radar') }
      else selectDeckProject(node.dataset.id)
    } else {
      selectChat(node.dataset.id)
      setView('office')
    }
  }
  nodes.onclick = event => activateDeckNode(event.target.closest('.deck-node'))
  nodes.ondblclick = event => activateDeckNode(event.target.closest('.deck-node'), true)
  nodes.onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activateDeckNode(event.target.closest('.deck-node'))
    }
  }
  // The overflow control is a fresh element only when the markup was rewritten.
  if (nodesChanged) nodes.querySelector('[data-deck-more]')?.addEventListener('click', event => { event.stopPropagation(); S.operatorTab = 'workspaces'; setView('command') })
  // Delegation keeps the live matrix clickable through collector refreshes.
  $('deck-core').onclick = () => setView('radar')
  renderDeckDetail()
  renderDeckSessions()
}

function deckStat(label, value) {
  return `<div class="deck-stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`
}

function selectDeckProject(id) {
  const room = (S.projects?.rooms || []).find(r => r.id === id)
  if (!room) return
  S.deckSelection = { kind: 'project', id }
  S.selectedRoom = id
  S.selectedProjectId = id
  S.selectedCwd = room.cwd
  renderDeck()
}

function selectDeckAgent(id) {
  const agent = (S.agents?.agents || []).find(a => a.sessionId === id)
  if (!agent) return
  S.deckSelection = { kind: 'agent', id }
  selectChat(id)
  renderDeck()
}

function renderDeckDetail() {
  const detail = $('deck-detail')
  const actions = $('deck-actions')
  const kind = $('deck-detail-kind')
  if (!detail || !actions || !kind) return
  const selected = S.deckSelection
  actions.innerHTML = ''
  if (!selected.kind) {
    kind.textContent = '—'
    detail.innerHTML = '<div class="empty-sm">Select a project or agent in the room.</div>'
    return
  }
  if (selected.kind === 'project') {
    const room = (S.projects?.rooms || []).find(r => r.id === selected.id)
    if (!room) return
    const cards = (S.sessions?.cards || []).filter(c => c.projectId === room.id)
    kind.textContent = 'PROJECT'
    detail.innerHTML = `<div class="kv">${row('name', esc(room.label))}${row('status', room.active ? '<span style="color:var(--green)">occupied</span>' : 'idle')}${row('sessions', cards.length)}${row('cwd', `<code>${esc(room.cwd)}</code>`)}</div><p class="room-live-sum">${esc(room.summary || 'No active summary.')}</p>`
    actions.innerHTML = '<button data-deck-action="open-project">open folder</button><button data-deck-action="reveal-project">reveal</button><button data-deck-action="seat" data-profile="claude">+ claude</button><button data-deck-action="seat" data-profile="codex">+ codex</button><button data-deck-action="office">open room</button>'
  } else {
    const agent = (S.agents?.agents || []).find(a => a.sessionId === selected.id)
    if (!agent) return
    kind.textContent = 'AGENT'
    detail.innerHTML = `<div class="kv">${row('name', esc(agent.name))}${row('status', esc(agent.status || 'idle'))}${row('project', esc(agent.projectId || '—'))}${row('cwd', `<code>${esc(agent.cwd || '—')}</code>`)}</div>`
    actions.innerHTML = '<button data-deck-action="chat">chat</button><button data-deck-action="radar">open transcript</button>'
  }
  for (const button of actions.querySelectorAll('button')) {
    button.onclick = () => {
      if (button.dataset.deckAction === 'seat') {
        $('drawer').classList.remove('collapsed')
        send({ type: 'pty.create', profile: button.dataset.profile, cwd: S.selectedCwd, projectId: S.selectedProjectId, cols: 120, rows: 30 })
      }
      if (button.dataset.deckAction === 'office') setView('office')
      if (button.dataset.deckAction === 'open-project' || button.dataset.deckAction === 'reveal-project') projectAction(selected.id, button.dataset.deckAction === 'reveal-project' ? 'reveal' : 'open')
      if (button.dataset.deckAction === 'chat') { selectChat(selected.id); setView('office') }
      if (button.dataset.deckAction === 'radar') setView('radar')
    }
  }
}

async function projectAction(id, action) {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `${action} project failed`)
    $('deck-detail')?.insertAdjacentHTML('beforeend', `<small class="action-confirmation">${action === 'reveal' ? 'revealed in Finder' : 'opened in the default app'}</small>`)
  } catch (error) { $('deck-detail')?.insertAdjacentHTML('beforeend', `<small class="action-error">${esc(error.message)}</small>`) }
}

function renderDeckSessions() {
  const box = $('deck-sessions')
  const count = $('deck-session-count')
  if (!box || !count) return
  const selectedProject = S.deckSelection.kind === 'project' ? S.deckSelection.id : null
  const cards = (S.sessions?.cards || []).filter(c => !selectedProject || c.projectId === selectedProject).slice(0, 20)
  count.textContent = String(cards.length)
  const markup = cards.map(c => `<div class="deck-session" data-file="${esc(c.file)}" data-agent="${esc(c.agent)}" data-cwd="${esc(c.cwd || '')}">${c.active ? '<span class="pulse"></span>' : '<span class="idle-dot"></span>'}<span>${esc(c.summary || c.id || c.file.split('/').pop())}</span><small>${esc(c.agent)}</small></div>`).join('') || '<div class="empty-sm">No matching sessions.</div>'
  if (writeIfChanged(box, markup)) {
    for (const item of box.querySelectorAll('.deck-session')) {
      item.onclick = () => selectSession(item.dataset.file, item.dataset.agent, item.dataset.cwd)
      item.ondblclick = () => { selectSession(item.dataset.file, item.dataset.agent, item.dataset.cwd); setView('radar') }
    }
  }
}

/* ── runtimes + models come from config, never a hardcoded list ────────
 *
 * This is the whole "integrate any agent" story: a `runtimes` entry in
 * ~/.quorum/config.json (gemini, aider, goose, an internal wrapper) becomes a
 * button here, and a `models` entry becomes a roundtable option. The server
 * validates the command before it ever reaches this list — see src/validate.js.
 */
function renderRuntimes() {
  const btns = S.runtimes.map(r =>
    `<button type="button" data-profile="${esc(r.id)}"${r.builtin ? '' : ' class="custom" title="from your config"'}>+ ${esc(r.label)}</button>`
  ).join('')

  // Room spawn buttons keep their disabled state — they need a selected room.
  const room = $('room-spawn-actions')
  if (room) {
    room.innerHTML = btns
    for (const b of room.querySelectorAll('button')) b.disabled = !S.selectedCwd
  }
  const term = $('term-actions')
  if (term) term.innerHTML = btns

  // The model picker is deliberately NOT touched here: renderRoundtable owns
  // #rt-model through currentModelOptions(), which is provider-aware and drives
  // the auth-mode row. Two writers to one select is a race, not a feature.
}

/* ── sessions ──────────────────────────────────────────── */
function renderSessions() {
  const cards = S.sessions?.cards || []
  $('sess-count').textContent = `· ${cards.length}`
  const list = $('sessions-list')
  list.innerHTML = cards.map(c => {
    const cwdTail = c.cwd ? c.cwd.split('/').slice(-2).join('/') : c.id.slice(0, 8)
    return `<div class="sess ${S.selected === c.file ? 'selected' : ''}" data-file="${esc(c.file)}" data-agent="${c.agent}" data-cwd="${esc(c.cwd || '')}">
      <div class="sess-top">
        ${c.active ? '<span class="pulse"></span>' : '<span class="idle-dot"></span>'}
        <span class="badge ${c.agent === 'codex' ? 'cx' : 'cl'}">${c.agent === 'codex' ? 'CX' : 'CL'}</span>
        ${c.kind === 'bg' ? '<span class="badge bg">BG</span>' : ''}
        ${c.projectId ? `<span class="badge proj">${esc(c.projectId)}</span>` : ''}
        <span class="sess-cwd">${esc(cwdTail)}</span>
        ${relLabel(c.mtimeMs, { cls: 'sess-time' })}
      </div>
      <div class="sess-sum">${esc(c.summary || '…')}</div>
      ${c.branch ? `<div class="sess-branch">⎇ ${esc(c.branch)}</div>` : ''}
    </div>`
  }).join('') || '<div class="empty">no recent sessions</div>'

  for (const el of list.querySelectorAll('.sess'))
    el.onclick = () => selectSession(el.dataset.file, el.dataset.agent, el.dataset.cwd)
}

function selectSession(file, agent, cwd) {
  S.selected = file
  S.selectedCwd = cwd
  renderSessions()
  $('transcript').innerHTML = ''
  $('detail-head').innerHTML =
    `<span>${esc(file.split('/').pop())}</span>` +
    `<span class="follow ${S.follow ? 'on' : ''}" id="follow-btn">${S.follow ? '⤓ following' : '⤓ follow off'}</span>`
  $('follow-btn').onclick = () => {
    S.follow = !S.follow
    $('follow-btn').className = `follow ${S.follow ? 'on' : ''}`
    $('follow-btn').textContent = S.follow ? '⤓ following' : '⤓ follow off'
  }
  send({ type: 'watch', file, agent })
}

function evNode(ev) {
  const div = document.createElement('div')
  const err = ev.kind === 'result' && ev.error ? ' err' : ''
  div.className = `ev ev-${ev.kind}${err}`
  const label = { assistant: 'assistant', user: 'user', tool: `⚙ ${ev.label || 'tool'}`, result: ev.error ? '✗ result' : '⇠ result', thinking: '∴ thinking', system: '◈ system' }[ev.kind] || ev.kind
  const time = ev.ts ? new Date(ev.ts).toLocaleTimeString() : ''
  div.innerHTML = `<span class="lbl">${esc(label)} ${time}</span><pre></pre>`
  div.querySelector('pre').textContent = ev.body || ''
  return div
}

/* ── system charts ─────────────────────────────────────── */
function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1
  const w = c.clientWidth, h = c.clientHeight
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr }
  const ctx = c.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return [ctx, w, h]
}

function renderSystem() {
  const sys = S.system
  if (!sys || !$('memchart')) return
  $('sys-load').textContent = `load ${sys.load}`
  $('sys-nums').innerHTML =
    row('free', gb(sys.freeMB)) + row('active+wired', gb(sys.usedMB)) +
    row('compressed', gb(sys.compMB)) + row('swap used', gb(sys.swapUsedMB)) +
    row('swapout rate', sys.soRate + '/s')

  const [ctx, w, h] = setupCanvas($('memchart'))
  ctx.clearRect(0, 0, w, h)
  const hist = S.hist
  if (hist.length > 1) {
    const total = hist[hist.length - 1].totalMB || 24576
    const x = i => i / (hist.length - 1) * w
    const y = v => h - (v / total) * h
    area(ctx, hist, x, i => y(hist[i].usedMB), tokenAlpha('--accent', 0.32))
    area(ctx, hist, x, i => y(hist[i].usedMB + hist[i].compMB), tokenAlpha('--purple', 0.2))
    line(ctx, hist, x, i => y(total - hist[i].freeMB), tokenAlpha('--error', 0.62))
    ctx.fillStyle = token('--muted'); ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(gb(total) + ' total · cyan=used violet=+comp red=pressure', 4, 10)
  }

  const [ctx2, w2, h2] = setupCanvas($('swapchart'))
  ctx2.clearRect(0, 0, w2, h2)
  if (hist.length > 1) {
    const max = Math.max(10, ...hist.map(s => s.soRate))
    const bw = w2 / hist.length
    ctx2.fillStyle = tokenAlpha('--warn', 0.55)
    hist.forEach((s, i) => {
      if (!s.soRate) return
      const bh = (s.soRate / max) * (h2 - 10)
      ctx2.fillRect(i * bw, h2 - bh, Math.max(1, bw - .5), bh)
    })
    ctx2.fillStyle = token('--muted'); ctx2.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx2.fillText(`swapouts/s (peak ${max | 0})`, 4, 9)
  }
}
const row = (k, v) => `<div class="row"><span>${k}</span><span>${v}</span></div>`

function area(ctx, hist, x, yf, fill) {
  ctx.beginPath()
  ctx.moveTo(0, ctx.canvas.clientHeight)
  hist.forEach((_, i) => ctx.lineTo(x(i), yf(i)))
  ctx.lineTo(x(hist.length - 1), ctx.canvas.clientHeight)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
}
function line(ctx, hist, x, yf, stroke) {
  ctx.beginPath()
  hist.forEach((_, i) => i ? ctx.lineTo(x(i), yf(i)) : ctx.moveTo(x(i), yf(i)))
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1
  ctx.stroke()
}

/* ── services + procs + feed ───────────────────────────── */
function renderServices() {
  const sv = S.services || {}
  const c = sv.comfy || {}
  $('comfy-card').innerHTML = c.up
    ? row('engine', '<span style="color:var(--green)">up :' + c.port + '</span>') +
      row('running', c.running) + row('queued', c.pending) +
      (c.device ? row('device', esc(c.device)) : '')
    : row('engine', '<span style="color:var(--dim)">down</span>') +
      (comfyDl() ? row('model dl', '<span style="color:var(--yellow)">in progress ⇣</span>') : '')

  const hm = sv.hermes || {}
  const hprocs = (S.processes?.procs || []).filter(p => p.group === 'hermes').length
  $('hermes-card').innerHTML =
    row('gateway', hm.up ? '<span style="color:var(--green)">ok :' + hm.port + '</span>' : '<span style="color:var(--red)">down</span>') +
    row('platform', esc(hm.detail?.platform || '—')) + row('processes', hprocs)

  const a = sv.auth || {}
  const runtimeState = info => !info?.cli
    ? '<span style="color:var(--red)">CLI missing</span>'
    : !info.configured
      ? '<span style="color:var(--yellow)">sign in required</span>'
      : '<span style="color:var(--green)">ready</span>'
  $('auth-card').innerHTML =
    row('claude', runtimeState(a.claude)) +
    row('API key', a.anthropic?.apiKeyAvailable
      ? '<span style="color:var(--green)">available to this local process</span>'
      : '<span style="color:var(--dim)">not in this process environment</span>') +
    row('codex', runtimeState(a.codex) + (a.codex?.configured ? ` · ${esc(a.codex.mode)}` : '')) +
    (a.codex?.lastRefresh ? row('codex refresh', relLabel(Date.parse(a.codex.lastRefresh), { suffix: ' ago' })) : '') +
    row('hermes', runtimeState(a.hermes)) +
    row('recovery', !a.claude?.cli ? 'install Claude Code to convene a table' : !a.claude.configured && !a.anthropic?.apiKeyAvailable ? 'sign in to Claude Code or restart Quorum with an API key' : 'local runtime checks only')
}

function renderProcs() {
  const top = S.processes?.topRss || []
  const markup = top.map(p =>
    `<div class="proc-row">
      ${p.group ? `<span class="grp">${p.group}</span>` : '<span class="grp">·</span>'}
      <span class="proc-name" title="pid ${p.pid}">${esc(p.name)}</span>
      <span class="proc-mem">${gb(p.rssMB)} ${p.cpu > 5 ? '· ' + p.cpu + '%' : ''}</span>
      ${p.group ? `<button class="kill" data-pid="${p.pid}" data-name="${esc(p.name)}" title="SIGTERM">✕</button>` : ''}
    </div>`).join('')
  if (writeIfChanged($('top-procs'), markup)) {
    for (const b of $('top-procs').querySelectorAll('.kill'))
      b.onclick = () => {
        if (confirm(`Stop ${b.dataset.name} (pid ${b.dataset.pid})? Quorum will send SIGTERM to this tracked AI process.`))
          send({ type: 'proc.kill', pid: +b.dataset.pid })
      }
  }
}

function renderFeed() {
  writeIfChanged($('feed-list'), [...S.feed].reverse().slice(0, 60).map(f =>
    `<div class="feed-item feed-${f.kind}"><span class="t">${new Date(f.ts).toLocaleTimeString()}</span><span>${esc(f.text)}</span></div>`
  ).join(''))
}

/* ── terminals ─────────────────────────────────────────── */

/* xterm.js takes literal colours, not CSS custom properties, so the terminal
 * used to be the one surface that ignored the theme. It now reads the same
 * tokens as everything else at the moment a terminal is created. The selection
 * colour is the accent at 20% — xterm wants an 8-digit hex, so the alpha is
 * appended rather than mixed. */
function xtermTheme() {
  return {
    background: token('--bg0'),
    foreground: token('--fg1'),
    cursor: token('--accent'),
    selectionBackground: `${token('--accent')}33`,
  }
}

function ensureTerm(id, profile) {
  let t = S.terms.get(id)
  if (t) return t
  const mount = document.createElement('div')
  mount.className = 'term-mount'
  mount.id = 'mount-' + id
  $('terms').appendChild(mount)
  const term = new Terminal({
    fontSize: 12,
    fontFamily: 'SF Mono, ui-monospace, Menlo, Monaco, Consolas, monospace',
    theme: xtermTheme(),
    scrollback: 4000,
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open(mount)
  term.onData(data => send({ type: 'pty.input', id, data }))
  t = { id, profile, term, fit, mount, dead: false }
  S.terms.set(id, t)
  if (!S.activeTerm) activateTerm(id)
  renderTabs()
  return t
}

function activateTerm(id) {
  S.activeTerm = id
  for (const t of S.terms.values()) t.mount.classList.toggle('active', t.id === id)
  renderTabs()
  const t = S.terms.get(id)
  if (t) requestAnimationFrame(() => { fitTerm(t); t.term.focus() })
}

function fitTerm(t) {
  if (!t.mount.classList.contains('active') || $('drawer').classList.contains('collapsed')) return
  try {
    t.fit.fit()
    send({ type: 'pty.resize', id: t.id, cols: t.term.cols, rows: t.term.rows })
  } catch { }
}

function syncTabs(ptys) {
  const live = new Set(ptys.map(p => p.id))
  for (const [id, t] of S.terms) {
    if (!live.has(id)) { t.mount.remove(); t.term.dispose(); S.terms.delete(id) }
  }
  for (const p of ptys) {
    if (!S.terms.has(p.id)) {
      ensureTerm(p.id, p.profile)
      send({ type: 'pty.attach', id: p.id })
    }
    if (p.exited) { const t = S.terms.get(p.id); if (t) t.dead = true }
  }
  if (S.activeTerm && !S.terms.has(S.activeTerm)) S.activeTerm = [...S.terms.keys()][0] || null
  if (S.activeTerm) activateTerm(S.activeTerm)
  // With no terminals open the drawer was still reserving its full height for
  // an empty box, which costs the floor and the roundtable stage ~260px of the
  // window. This is separate from `.collapsed` so it never fights ctrl+`.
  $('drawer').classList.toggle('empty', ptys.length === 0)
  renderTabs()
}

function renderTabs() {
  $('term-tabs').innerHTML = [...S.terms.values()].map(t =>
    `<span class="tab ${t.id === S.activeTerm ? 'active' : ''} ${t.dead ? 'dead' : ''}" data-id="${t.id}">
      ${t.profile}<span class="x" data-id="${t.id}">✕</span>
    </span>`).join('')
  for (const tab of $('term-tabs').querySelectorAll('.tab'))
    tab.onclick = e => {
      if (e.target.classList.contains('x')) { send({ type: 'pty.kill', id: e.target.dataset.id }); return }
      activateTerm(tab.dataset.id)
    }
}

$('term-actions').addEventListener('click', e => {
  const b = e.target.closest('button[data-profile]')
  if (b) {
    $('drawer').classList.remove('collapsed')
    send({
      type: 'pty.create',
      profile: b.dataset.profile,
      cwd: S.selectedCwd || undefined,
      projectId: S.selectedProjectId || undefined,
      cols: 120,
      rows: 30,
    })
  }
})

/* drawer resize + toggle */
{
  const drawer = $('drawer')
  const saved = localStorage.getItem('mc-drawer-h')
  if (saved) document.documentElement.style.setProperty('--drawer-h', saved + 'px')
  $('drawer-handle').onmousedown = e => {
    e.preventDefault()
    const startY = e.clientY
    const startH = $('terms').clientHeight
    const move = ev => {
      const h = Math.max(80, Math.min(window.innerHeight - 200, startH + (startY - ev.clientY)))
      document.documentElement.style.setProperty('--drawer-h', h + 'px')
      localStorage.setItem('mc-drawer-h', h)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      for (const t of S.terms.values()) fitTerm(t)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === '`') {
      drawer.classList.toggle('collapsed')
      if (!drawer.classList.contains('collapsed'))
        for (const t of S.terms.values()) fitTerm(t)
    }
  })
  window.addEventListener('resize', () => { for (const t of S.terms.values()) fitTerm(t); renderSystem(); renderDeck() })
}

/* ── global task board ─────────────────────────────────── */
function renderBoard() {
  const t = S.tasks
  const c = t?.counts || { pending: 0, in_progress: 0, completed: 0 }
  $('board-count').textContent = `${c.in_progress} running · ${c.pending} open · ${c.completed} done`

  const groups = { in_progress: [], pending: [], completed: [] }
  for (const task of t?.tasks || []) (groups[task.status] || groups.pending).push(task)

  for (const status of Object.keys(groups)) {
    const list = groups[status]
    const box = $('board-' + status)
    if (!box) continue
    if (!list.length) { box.innerHTML = '<div class="empty-sm">—</div>'; continue }
    box.innerHTML = list.map(task => {
      const room = task.projectId ? `<span class="proj">${esc(task.projectId)}</span>` : ''
      const blocked = task.blockedBy?.length ? `<span class="blocked">⛔ ${task.blockedBy.length}</span>` : ''
      const live = task.sessionActive ? '<span class="pulse"></span>' : ''
      // activeForm is the agent's own description of what it is doing right now.
      const sub = task.status === 'in_progress' && task.activeForm ? task.activeForm : task.description
      return `<div class="task clickable" data-sid="${esc(task.sessionId)}" title="open this session's transcript">
        <div class="task-head">${live}${room}${blocked}<span class="task-sid">${esc(task.sessionId.slice(0, 8))}</span></div>
        <div class="task-subj">${esc(task.subject)}</div>
        <div class="task-desc">${esc(String(sub || '').slice(0, 160))}</div>
      </div>`
    }).join('')

    // A task names the session doing it, and we can usually show that session
    // live — a board card that answers "what is this?" with a click beats one
    // that just sits there.
    for (const el of box.querySelectorAll('.task.clickable'))
      el.onclick = () => openSessionById(el.dataset.sid)
  }
}

/** Jump from anything that knows a sessionId to that session's live transcript. */
function openSessionById(sessionId) {
  const card = (S.sessions?.cards || []).find(c => c.id === sessionId || sessionId.startsWith(c.id) || c.id.startsWith(sessionId))
  if (!card) return
  setView('radar')
  selectSession(card.file, card.agent, card.cwd)
}

/* ── composio connections ──────────────────────────────── */
function renderComposio() {
  const c = S.composio
  const head = $('composio-summary')
  const box = $('composio-card')
  if (!c) { head.textContent = ''; box.innerHTML = '<div class="empty-sm">—</div>'; return }

  const cn = c.connections
  head.innerHTML = cn
    ? `<b>${cn.counts.active}</b> active · ${cn.counts.expired} expired`
    : (c.error ? '<span class="warn">unreachable</span>' : '…')

  const rows = []
  rows.push(row('cli', c.cliPresent ? 'installed' : 'MISSING'))
  // A fingerprint, not the key — but show only a short prefix so it never reads
  // as a credential worth copying.
  if (c.keyFingerprint) rows.push(row('key fp', String(c.keyFingerprint).slice(0, 12) + '…'))
  rows.push(row('tool defs', String(c.toolDefs)))
  if (c.pendingLogin) rows.push(row('auth', 'login in progress'))
  if (c.error) rows.push(row('error', c.error))

  if (cn) {
    if (cn.ambiguous.length) {
      // Two accounts on one toolkit means an unpinned call can hit the wrong
      // identity — worth showing, since that is a silent-wrong-answer failure.
      rows.push(row('ambiguous', cn.ambiguous.map(esc).join(', ')))
    }
    const byStatus = {}
    for (const a of cn.accounts) (byStatus[a.status] ||= []).push(a.toolkit)
    for (const st of ['ACTIVE', 'EXPIRED', 'FAILED']) {
      if (!byStatus[st]) continue
      rows.push(row(st.toLowerCase(), [...new Set(byStatus[st])].map(esc).join(', ')))
    }
  }
  box.innerHTML = rows.join('')
}

/* ── shared agent memory control ───────────────────────── */
function renderMemory() {
  const m = S.memory
  const head = $('memory-summary')
  const box = $('memory-card')
  if (!head || !box) return
  if (!m) { head.textContent = ''; box.innerHTML = '<div class="empty-sm">—</div>'; return }

  const counts = m.ledger?.counts || { pending: 0, promoted: 0, archived: 0, total: 0 }
  head.innerHTML = m.ok
    ? `<b>${counts.pending}</b> pending · ${counts.promoted} promoted`
    : `<span class="warn">${esc((m.health || []).join(', ') || 'check')}</span>`

  const rows = []
  rows.push(row('policy', esc(m.policy || 'review-first')))
  rows.push(row('source', `${m.source?.localOnly ? 'loopback' : 'CHECK'} ${esc(m.source?.url || '—')}`))
  rows.push(row('Quorum bridges', `${S.memoryBridge?.claudeMem?.configured ? 'claude-mem ready' : 'claude-mem off'} · ${S.memoryBridge?.obsidian?.configured ? 'Obsidian ready' : 'vault unavailable'}`))
  rows.push(row('allowlist', esc((m.projects || []).join(', ') || '—')))
  rows.push(row('ledger', `${counts.total} total · cursor ${esc(m.ledger?.cursorHighestId ?? 0)}`))
  rows.push(row('inbox', `${m.inbox?.observationMarkers ?? 0} markers · ${m.inbox?.exists ? 'present' : 'missing'}`))
  rows.push(row('status note', m.statusNote?.exists ? `updated ${esc(m.statusNote.updatedAt || '—')}` : '<span class="warn">missing</span>'))
  if (m.health?.length) rows.push(row('health', `<span class="warn">${esc(m.health.join(', '))}</span>`))
  box.innerHTML = rows.join('')
}

/* ── live agents ───────────────────────────────────────── */
function renderAgents() {
  const list = S.agents?.agents || []
  const box = $('agents-card')
  if (!box) return
  if (!list.length) { box.innerHTML = '<div class="empty-sm">no live sessions</div>'; return }
  box.innerHTML = list.map(a => `
    <div class="agent-row" data-sid="${esc(a.sessionId)}">
      <span class="dot ${a.status === 'busy' ? 'up' : ''}"></span>
      <span class="agent-name">${esc(a.name)}</span>
      <span class="proj">${esc(a.projectId || '—')}</span>
      <span class="agent-status">${esc(a.status || 'idle')}</span>
      ${a.chatCapable ? '<button type="button" class="chat-btn">chat</button>' : ''}
    </div>`).join('')
  for (const el of box.querySelectorAll('.agent-row')) {
    const btn = el.querySelector('.chat-btn')
    if (btn) btn.onclick = () => selectChat(el.dataset.sid)
  }
}

/* ── avatars: agents that walk between rooms ───────────── */
//
// The rooms grid is re-innerHTML'd every couple of seconds, so avatars live in a
// sibling overlay that is never wholesale-replaced. Each avatar is keyed by
// sessionId and only has its transform updated, which is what lets the CSS
// transition actually run when an agent's room changes.
/**
 * Give a live session a stable face.
 *
 * The mapping is a hash of the session id rather than a counter, because the
 * agent list is re-sorted by `statusUpdatedAt` on every 2s tick — an index-based
 * assignment would shuffle every character's identity whenever one of them did
 * something, which reads as the crew teleporting between bodies.
 */
function castFor(sessionId) {
  // Locked characters are excluded: a face on the floor implies a character you
  // can click through to, and a free user tapping Sable would hit a paywall
  // they never asked about.
  const pool = S.cast.filter(c => !c.mascot && !c.locked)
  if (!pool.length) return { name: '?', role: '', palette: { body: token('--muted'), trim: token('--bg2'), glow: token('--fg2') }, visor: 'dot', crest: 'spark', prop: '' }
  let h = 0
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0
  return pool[h % pool.length]
}

function renderAvatars() {
  const layer = $('avatar-layer')
  const stage = $('floor-stage')
  if (!layer || !stage || S.view !== 'office') return

  const agents = S.agents?.agents || []
  const stageRect = stage.getBoundingClientRect()
  const seen = new Set()
  const perRoom = new Map()

  for (const a of agents) {
    const roomEl = a.projectId ? stage.querySelector(`.room[data-id="${CSS.escape(a.projectId)}"]`) : null
    if (!roomEl) continue
    seen.add(a.sessionId)

    let el = layer.querySelector(`.avatar[data-sid="${CSS.escape(a.sessionId)}"]`)
    if (!el) {
      el = document.createElement('div')
      el.className = 'avatar'
      el.dataset.sid = a.sessionId
      el.innerHTML = '<span class="avatar-art"></span><span class="avatar-name"></span>'
      el.onclick = () => selectChat(a.sessionId)
      layer.appendChild(el)
    }

    // The sprite is redrawn only when the resolved face actually changes, not
    // on every 2s tick — but it MUST be able to change once. The agents
    // collector fires before the cast arrives over the websocket, so the first
    // draw of every avatar happens while castFor() can only return the grey
    // fallback; without this the whole crew stays grey for the session.
    const face = castFor(a.sessionId)
    if (el.dataset.face !== face.id) {
      el.dataset.face = face.id || ''
      el.querySelector('.avatar-art').innerHTML = drawCharacter(face, { size: LOD.avatar })
    }

    const n = perRoom.get(a.projectId) || 0
    perRoom.set(a.projectId, n + 1)

    // Characters stand with their feet on the room's floor line (ROOM_FLOOR is
    // the same constant the room art draws it at). Extra rows step back and up,
    // so a busy room reads as a crowd rather than one overlapping blob.
    const r = roomEl.getBoundingClientRect()
    const perRow = Math.max(2, Math.floor((r.width - 16) / 26))
    const row = Math.floor(n / perRow)
    const x = r.left - stageRect.left + 8 + (n % perRow) * 26
    const y = r.top - stageRect.top + r.height * ROOM_FLOOR - AVATAR_H - row * 13

    el.style.transform = `translate(${x}px, ${y}px)`
    // Nearer rows paint over further ones, which is what sells the depth.
    el.style.zIndex = String(20 - row)
    el.classList.toggle('busy', a.status === 'busy')
    el.classList.toggle('selected', S.chatTarget === a.sessionId)
    el.title = `${face.name} · ${a.name} — ${a.projectId} — ${a.status || 'idle'}`
    // Rooms hold several agents and full session names collide, so the label is
    // the character's name and expands to the session on hover via CSS.
    el.querySelector('.avatar-name').textContent = face.name
  }

  for (const el of layer.querySelectorAll('.avatar'))
    if (!seen.has(el.dataset.sid)) el.remove()
}

/* ── chat with a running agent ─────────────────────────── */
// The resumed CLI needs a moment to boot before it will take a keystroke; if the
// server never answers the chat.open at all, unwedge the composer anyway.
const CHAT_SEND_DELAY_MS = 2500
const CHAT_OPEN_TIMEOUT_MS = 8000
let chatSeq = 0

function clearChatPending() {
  S.chatPending = null
  const input = $('chat-input'), btn = $('chat-send')
  if (input) input.disabled = !S.chatTarget
  if (btn) btn.disabled = !S.chatTarget
}

function selectChat(sessionId) {
  const a = (S.agents?.agents || []).find(x => x.sessionId === sessionId)
  S.chatTarget = a ? sessionId : null
  const input = $('chat-input')
  const btn = $('chat-send')
  if (!a) {
    $('chat-target').textContent = '— no agent selected'
    input.disabled = btn.disabled = true
    return
  }
  $('chat-target').textContent = `→ ${a.name} (${a.projectId || '—'})`
  $('chat-hint').textContent = a.chatCapable
    ? 'Opens a terminal resuming this session; your message is sent as the next turn.'
    : 'This session exposes no messaging socket (desktop-launched) — resume may still work.'
  input.disabled = btn.disabled = !!S.chatPending
  input.focus()
  renderAvatars()
}

const chatForm = $('chat-form')
if (chatForm) chatForm.onsubmit = e => {
  e.preventDefault()
  const input = $('chat-input')
  const btn = $('chat-send')
  const text = input.value.trim()
  // A second submit while the first chat.open is in flight would spawn a second
  // `claude --resume` racing the first against the same transcript.
  if (!text || !S.chatTarget || S.chatPending) return
  const log = $('chat-log')
  if (log.classList.contains('empty-sm')) { log.classList.remove('empty-sm'); log.innerHTML = '' }
  const line = document.createElement('div')
  line.className = 'chat-line'
  line.textContent = '❯ ' + text
  log.appendChild(line)
  log.scrollTop = log.scrollHeight

  // Resume the session in a PTY, then type the message into *that* pty — the
  // server echoes its id back under this requestId (see the chat.opened
  // handler). The drawer opens so the agent's reply is visible where it happens.
  const requestId = 'c' + (++chatSeq)
  S.chatPending = { requestId, text }
  input.disabled = btn.disabled = true
  send({ type: 'chat.open', sessionId: S.chatTarget, requestId, cols: 120, rows: 30 })
  input.value = ''
  $('drawer')?.classList.remove('collapsed')
  setTimeout(() => { if (S.chatPending?.requestId === requestId) clearChatPending() }, CHAT_OPEN_TIMEOUT_MS)
}

/* ── roundtable ────────────────────────────────────────────────────────
 *
 * The stage exists to make one thing visible that a chat log cannot: who is
 * actually arguing with whom, and whether anyone moved. Positions and
 * confidence are carried on every turn, so a character's bubble is their
 * current stance and the movement table is the proof the debate did work.
 */

const PHASE_ORDER = ['brief', 'opening', 'clash', 'converge', 'verdict']
const PHASE_COPY = {
  brief: 'framing the decision',
  opening: 'opening statements — written blind, in parallel',
  clash: 'cross-examination — each must engage the strongest counter',
  converge: 'final positions — say what moved you',
  verdict: 'decision record',
  done: 'concluded',
  cancelled: 'cancelled',
  failed: 'failed',
  idle: 'the table is empty',
}

function renderCastPicker() {
  const box = $('rt-cast')
  if (!box) return
  box.innerHTML = S.cast.filter(c => !c.mascot).map(c => `
    <button type="button" class="pick ${S.seated.has(c.id) ? 'on' : ''} ${c.locked ? 'locked' : ''}"
            data-id="${esc(c.id)}" title="${esc(c.tagline)}${c.locked ? ' · Quorum Pro' : ''}">
      ${drawCharacter(c, { size: LOD.avatar })}
      <span class="pick-name">${esc(c.name)}</span>
      <span class="pick-role">${c.locked ? 'PRO' : esc(c.role)}</span>
    </button>`).join('')
  for (const b of box.querySelectorAll('.pick'))
    b.onclick = () => {
      const id = b.dataset.id
      const c = S.castById.get(id)
      if (c?.locked) return showUpgrade(c)
      S.seated.has(id) ? S.seated.delete(id) : S.seated.add(id)
      persistSeated()
      renderCastPicker(); renderCrew(); renderEstimate()
    }
  renderEstimate()
}

function renderRoomSelect() {
  const sel = $('rt-room')
  if (!sel) return
  const rooms = S.projects?.catalog?.filter(r => r.exists) || []
  const current = sel.value
  sel.innerHTML = rooms.map(r => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('')
  if (current && rooms.some(r => r.id === current)) sel.value = current
  else if (S.selectedRoom) sel.value = S.selectedRoom
}

function renderModelSelect() {
  const select = $('rt-model')
  if (!select) return
  const options = currentModelOptions()
  const previous = select.value
  select.innerHTML = options.map(option => {
    const note = option.local ? ' · on-device' : option.provider === 'claude' ? '' : ` · ${option.provider}`
    const unavailable = option.available === false ? ' — runtime unavailable' : ''
    return `<option value="${esc(option.id)}" ${option.available === false ? 'disabled' : ''}>${esc(option.label + note + unavailable)}</option>`
  }).join('')
  if ([...select.options].some(option => option.value === previous && !option.disabled)) select.value = previous
  else if ([...select.options].some(option => !option.disabled)) select.value = [...select.options].find(option => !option.disabled).value
}

function renderAuthMode() {
  const select = $('rt-auth-mode')
  if (!select) return
  const selected = currentModelOptions().find(option => option.id === $('rt-model')?.value)
  if (selected && selected.provider !== 'claude') {
    select.innerHTML = '<option value="local">local provider — no credentials required</option>'
    select.value = 'local'
    select.disabled = true
    return
  }
  select.disabled = false
  const auth = S.services?.auth || {}
  const cliReady = auth.claude?.cli && auth.claude?.configured
  const apiKeyReady = auth.claude?.cli && auth.anthropic?.apiKeyAvailable
  const previous = select.value || 'auto'
  select.innerHTML =
    `<option value="auto" ${!cliReady && !apiKeyReady ? 'disabled' : ''}>automatic — ${cliReady ? 'signed-in CLI preferred' : apiKeyReady ? 'API key fallback' : 'unavailable'}</option>` +
    `<option value="cli" ${cliReady ? '' : 'disabled'}>Claude Code account${cliReady ? '' : ' — sign-in required'}</option>` +
    `<option value="api-key" ${apiKeyReady ? '' : 'disabled'}>API key from Quorum’s environment${apiKeyReady ? '' : ' — unavailable'}</option>`
  select.value = [...select.options].some(o => o.value === previous && !o.disabled)
    ? previous
    : 'auto'
}

/**
 * A pre-flight number, not a bill. Turn count is exact (1 brief + 3 per
 * participant + 1 verdict); the dollar figure is a measured average and is
 * labelled as an estimate because opus turns cost several times a sonnet one.
 */
function renderEstimate() {
  const box = $('rt-estimate')
  if (!box) return
  const n = S.seated.size
  const model = $('rt-model')?.value || 'claude:sonnet'
  const option = currentModelOptions().find(item => item.id === model)
  const estimate = option?.estimatedCostUsd
  const turns = 1 + n * 3 + 1
  const cost = turns * (estimate ?? 0)
  const local = option?.local === true
  const ok = n >= 2 && n <= 5 && option?.available !== false
  box.className = 'rt-estimate' + (ok ? '' : ' warn')
  if (n < 2 || n > 5) box.textContent = `seat between 2 and 5 characters — you have ${n}`
  else if (option?.available === false) box.textContent = `${option.label} is unavailable in the Quorum launch environment`
  else box.innerHTML = local
    ? `<b>${turns}</b> local agent turns · <b>no API cost</b> on ${esc(option?.model || model)} · runs ${n} specialists in parallel per phase`
    : `<b>${turns}</b> agent turns · est. <b>~$${cost.toFixed(2)}</b> on ${esc(option?.label || model)} · runs ${n} specialists in parallel per phase`
  const start = $('rt-start')
  if (start) start.disabled = !ok || !!(S.debate && !S.debate.endedAt)
}

function renderRoundtable() {
  if (S.view !== 'table') { renderMascot(); return }
  renderRoomSelect(); renderModelSelect(); renderAuthMode(); renderEstimate(); renderMascot()

  const d = S.debate
  const live = d && !d.endedAt
  $('rt-cancel')?.classList.toggle('hidden', !live)

  const head = $('rt-phase-head')
  if (head) {
    head.textContent = d
      ? `${d.topic.slice(0, 70)}${d.topic.length > 70 ? '…' : ''} — ${PHASE_COPY[d.phase] || d.phase}`
      : 'the table is empty'
  }
  $('rt-cost').textContent = d ? `$${Number(d.costUsd || 0).toFixed(3)}` : ''

  renderPhaseRail()
  renderStage()
  renderMovement()
  renderLog()
}

function renderPhaseRail() {
  const box = $('rt-phases')
  if (!box) return
  const d = S.debate
  if (!d) { box.innerHTML = ''; return }
  const idx = PHASE_ORDER.indexOf(d.phase)
  box.innerHTML = PHASE_ORDER.map((p, i) => {
    const done = idx === -1 ? d.phase === 'done' : i < idx
    const on = p === d.phase
    return `<span class="ph ${on ? 'on' : ''} ${done || d.phase === 'done' ? 'done' : ''}">${p}</span>`
  }).join('<span class="ph-sep">→</span>')
}

function renderStage() {
  const stage = $('rt-stage')
  if (!stage) return
  const d = S.debate

  if (!d) {
    const nib = S.castById.get('nib')
    const art = $('rt-empty-art')
    if (art && nib && !art.innerHTML) art.innerHTML = drawCharacter(nib, { size: LOD.portrait })
    stage.querySelector('.rt-empty')?.classList.remove('hidden')
    return
  }

  const ids = d.participants || []
  const latest = new Map()
  for (const t of d.turns || []) if (!t.failed) latest.set(t.speaker, t)

  // Seats sit on an ellipse so the table reads as a table. Two participants
  // face each other; five spread evenly. Angles start at the top so the first
  // seated character is always in the same place across debates.
  const seats = ids.map((id, i) => {
    const a = -Math.PI / 2 + (i / ids.length) * Math.PI * 2
    return { id, x: 50 + Math.cos(a) * 33, y: 50 + Math.sin(a) * 30 }
  })

  const mod = S.castById.get('nib')
  const modTurn = [...(d.turns || [])].reverse().find(t => t.speaker === 'nib' && !t.failed)

  stage.innerHTML =
    `<div class="rt-table">` +
      `<div class="rt-center">` +
        (mod ? drawCharacter(mod, { size: LOD.bust, state: S.speaking?.speaker === 'nib' ? 'speaking' : 'idle' }) : '') +
        `<span class="rt-center-label">${esc(d.phase === 'verdict' || d.phase === 'done' ? 'verdict' : 'moderator')}</span>` +
        // The moderator's `position` is a one-line summary of a verdict whose
        // body runs to paragraphs. Putting the body on the stage buries the
        // characters under a wall of text that the transcript pane already
        // shows in full, so the stage gets the summary and only falls back to
        // the body when the model gave us no position.
        (modTurn && (d.phase === 'brief' || d.phase === 'verdict' || d.phase === 'done')
          ? `<div class="bubble mod">${esc(clip(modTurn.position || modTurn.body, 240))}</div>` : '') +
      `</div>` +
      seats.map(s => {
        const c = S.castById.get(s.id)
        if (!c) return ''
        const t = latest.get(s.id)
        const speaking = S.speaking?.speaker === s.id
        const state = speaking ? 'speaking' : t?.conceded ? 'conceded' : 'idle'
        const conf = t?.confidence
        const bubble = speaking
          ? `<div class="bubble thinking"><span></span><span></span><span></span></div>`
          : t
            ? `<div class="bubble ${t.conceded ? 'conceded' : ''}">${esc(clip(t.position || t.body, 200))}</div>`
            : ''
        return `<div class="seat" style="left:${s.x}%;top:${s.y}%">
          ${bubble}
          <div class="seat-char">${drawCharacter(c, { size: LOD.bust, state })}</div>
          <div class="seat-name">${esc(c.name)}${conf != null ? `<em>${conf}</em>` : ''}</div>
        </div>`
      }).join('') +
    `</div>`
}

const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s }

function renderMovement() {
  const box = $('rt-movement')
  if (!box) return
  const d = S.debate
  const finals = (d?.turns || []).filter(t => t.phase === 'converge' && !t.failed)
  if (!finals.length) { box.innerHTML = ''; return }
  const openings = (d.turns || []).filter(t => t.phase === 'opening' && !t.failed)
  box.innerHTML = `<div class="mv-head">MOVEMENT</div>` + finals.map(f => {
    const o = openings.find(x => x.speaker === f.speaker)
    const a = o?.confidence, b = f.confidence
    const delta = a != null && b != null ? b - a : null
    const cls = delta == null ? '' : delta < 0 ? 'down' : delta > 0 ? 'up' : 'flat'
    return `<div class="mv">
      <span class="mv-name">${esc(f.speakerName)}</span>
      <span class="mv-bar"><i style="width:${b ?? 0}%"></i></span>
      <span class="mv-delta ${cls}">${a != null && b != null ? `${a}→${b}` : '—'}</span>
      ${f.conceded ? '<span class="mv-con">conceded</span>' : ''}
    </div>`
  }).join('')
}

function renderLog() {
  const box = $('rt-log')
  if (!box) return
  const d = S.debate
  const turns = d?.turns || []
  if (!turns.length) {
    box.className = 'empty-sm'
    box.textContent = d ? 'waiting for the first turn…' : '—'
    return
  }
  box.className = ''
  let lastPhase = null
  const parts = []
  for (const t of turns) {
    if (t.phase !== lastPhase) {
      lastPhase = t.phase
      parts.push(`<div class="log-phase">${esc(t.phase)} — ${esc(PHASE_COPY[t.phase] || '')}</div>`)
    }
    const c = S.castById.get(t.speaker)
    parts.push(`<div class="log-turn ${t.failed ? 'failed' : ''}" style="--c:${c?.palette.body || 'var(--fg2)'}">
      <div class="log-top">
        <span class="log-name">${esc(t.speakerName)}</span>
        <span class="log-role">${esc(t.speakerRole)}</span>
        ${t.conceded ? '<span class="log-flag con">conceded</span>' : ''}
        ${t.confidence != null ? `<span class="log-flag">conf ${t.confidence}</span>` : ''}
        ${t.targets?.length ? `<span class="log-flag at">→ ${esc(t.targets.join(', '))}</span>` : ''}
        <span class="log-ms">${t.ms ? (t.ms / 1000).toFixed(1) + 's' : ''}</span>
      </div>
      ${t.position ? `<div class="log-pos">${esc(t.position)}</div>` : ''}
      <div class="log-body">${esc(t.body || '')}</div>
    </div>`)
  }
  if (d && d.endedAt && !d.cancelled && !d.error)
    parts.push(`<span class="log-export">
      <a href="/api/roundtable/${esc(d.id)}.md" download>⤓ .md</a> ·
      <a href="/api/roundtable/${esc(d.id)}.html" download>polished .html</a> ·
      <button type="button" id="rt-save-repo" data-id="${esc(d.id)}">save to repo</button> ·
      <button type="button" id="rt-export-card" data-id="${esc(d.id)}">export card</button>
    </span>`)
  box.innerHTML = parts.join('')
  if (d && d.endedAt) {
    const saveBtn = $('rt-save-repo')
    if (saveBtn) saveBtn.onclick = async () => {
      const path = prompt('Target path for ADR (e.g. docs/adr/decision-1.md):', `docs/adr/decision-${d.id.slice(0, 8)}.md`)
      if (!path) return
      try {
        const res = await postJson(`/api/roundtable/save`, { debateId: d.id, targetPath: path })
        if (res.success) alert('Decision record saved to repo: ' + res.path)
      } catch (e) { alert('Save failed: ' + e.message) }
    }
    const cardBtn = $('rt-export-card')
    if (cardBtn) cardBtn.onclick = () => exportDebateCard(d)
  }
  box.scrollTop = box.scrollHeight
}

function renderArchive() {
  const box = $('rt-archive')
  if (!box) return
  if (!S.archive.length) { box.className = 'empty-sm'; box.textContent = 'no debates yet'; return }
  box.className = ''
  box.innerHTML = S.archive.map(d => `
    <div class="arc" data-id="${esc(d.id)}">
      <div class="arc-topic">${esc(clip(d.topic, 70))}</div>
      <div class="arc-meta">
        <span>${esc(d.roomLabel || '—')}</span>
        <span>${(d.participants || []).length} seats</span>
        <span>$${Number(d.costUsd || 0).toFixed(2)}</span>
        ${d.cancelled ? '<span class="warn">cancelled</span>' : d.error ? '<span class="warn">failed</span>'
          : `<a class="arc-dl" href="/api/roundtable/${esc(d.id)}.md" download title="export decision record">⤓ .md</a> · <a class="arc-dl" href="/api/roundtable/${esc(d.id)}.html" download title="export polished review">.html</a>`}
      </div>
    </div>`).join('')
  for (const el of box.querySelectorAll('.arc'))
    el.onclick = e => {
      if (e.target.classList.contains('arc-dl')) return   // let the download be a download
      S.debate = S.archive.find(d => d.id === el.dataset.id) || S.debate
      S.speaking = null
      renderRoundtable()
    }
}

{
  const form = $('rt-form')
  if (form) {
    form.onsubmit = e => {
      e.preventDefault()
      const topic = $('rt-topic').value.trim()
      if (!topic || S.seated.size < 2) return
      if (S.debate && !S.debate.endedAt) return
      S.debate = null
      S.speaking = null
      send({
        type: 'rt.start',
        topic,
        roomId: $('rt-room').value || null,
        participants: [...S.seated],
        model: $('rt-model').value,
        authMode: $('rt-auth-mode').value,
      })
      renderRoundtable()
    }
  }
  $('rt-model')?.addEventListener('change', () => { renderAuthMode(); renderEstimate() })
  const cancel = $('rt-cancel')
  if (cancel) cancel.onclick = () => {
    if (S.debate && confirm('Cancel this roundtable? Turns already spent are not refunded.'))
      send({ type: 'rt.cancel', id: S.debate.id })
  }
}

/* ── durable missions ───────────────────────────────────────────────── */
async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

function missionProgress(mission) {
  const tasks = mission?.tasks || []
  const complete = tasks.filter(task => task.status === 'completed').length
  return tasks.length ? Math.round(complete / tasks.length * 100) : mission?.status === 'completed' ? 100 : 0
}

function renderMissionForm() {
  const room = $('mission-room')
  const runtime = $('mission-runtime')
  if (!room || !runtime) return
  const rooms = S.projects?.rooms || []
  const roomValue = room.value
  room.innerHTML = rooms.map(item => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join('') || '<option value="">no project rooms</option>'
  if (rooms.some(item => item.id === roomValue)) room.value = roomValue
  const runtimes = (S.catalog?.runtimes || S.runtimes || []).filter(item => item.command && item.id !== 'shell')
  const runtimeValue = runtime.value
  runtime.innerHTML = runtimes.map(item => `<option value="${esc(item.id)}">${esc(item.label || item.id)}${item.available === false ? ' · offline' : ''}</option>`).join('') || '<option value="">no runtimes detected</option>'
  if (runtimes.some(item => item.id === runtimeValue)) runtime.value = runtimeValue
}

function renderMissions() {
  const list = $('mission-list')
  const detail = $('mission-detail')
  if (!list || !detail) return
  renderMissionForm()
  const missionsList = S.missions?.missions || []
  $('mission-count').textContent = `${missionsList.length} durable`
  const form = $('mission-form')
  if (form && !form.dataset.wired) {
    form.dataset.wired = '1'
    form.onsubmit = async event => {
      event.preventDefault()
      const status = $('mission-form-status')
      try {
        status.textContent = 'creating…'
        const template = form.querySelector('input[name="mission-template"]:checked')?.value || 'build'
        const title = $('mission-title').value
        const objective = $('mission-objective').value
        const firstTask = $('mission-task').value || title
        const common = { roomId: $('mission-room').value || null, runtimeId: $('mission-runtime').value || null }
        const tasks = template === 'single'
          ? [{ id: 'execute', title: firstTask, description: objective, packId: 'builder', ...common }]
          : template === 'audit'
            ? [{ id: 'inspect', title: firstTask, description: `Inspect current state and collect evidence. ${objective}`, packId: 'scout', ...common }, { id: 'verify', title: 'Verify findings', description: 'Reproduce the important findings and record exact evidence.', dependsOn: ['inspect'], packId: 'qa', ...common }]
            : [{ id: 'discover', title: firstTask, description: `Map the relevant system before editing. ${objective}`, packId: 'scout', ...common }, { id: 'build', title: 'Implement the objective', description: objective, dependsOn: ['discover'], packId: 'builder', ...common }, { id: 'verify', title: 'Test and document evidence', description: 'Run focused and full checks, then record the result and remaining gates.', dependsOn: ['build'], packId: 'qa', ...common }]
        const result = await postJson('/api/missions', { title, objective, tasks })
        S.missionSelection = result.mission.id
        $('mission-title').value = ''; $('mission-objective').value = ''; $('mission-task').value = ''
        status.textContent = 'mission created'
        renderMissions()
      } catch (error) { status.textContent = error.message }
    }
  }
  if (!missionsList.length) {
    list.innerHTML = '<div class="empty">No missions yet. Create one with a concrete objective and a first task.</div>'
    detail.innerHTML = '<div class="empty">Select a mission to inspect its task graph.</div>'
    return
  }
  if (!S.missionSelection || !missionsList.some(item => item.id === S.missionSelection)) S.missionSelection = missionsList[0].id
  list.innerHTML = missionsList.map(mission => `<button type="button" class="mission-row ${mission.id === S.missionSelection ? 'selected' : ''}" data-mission-id="${esc(mission.id)}">
    <span class="mission-status ${esc(mission.status)}"></span><span class="mission-row-copy"><b>${esc(mission.title)}</b><small>${esc(mission.objective)}</small></span><span class="mission-progress">${missionProgress(mission)}%</span>
  </button>`).join('')
  for (const row of list.querySelectorAll('[data-mission-id]')) row.onclick = () => { S.missionSelection = row.dataset.missionId; S.missionPreview = null; renderMissions() }
  const mission = missionsList.find(item => item.id === S.missionSelection)
  if (!mission) return
  const ready = new Set((mission.tasks || []).filter(task => task.status === 'queued' && task.dependsOn.every(dep => (mission.tasks || []).find(item => item.id === dep)?.status === 'completed')).map(task => task.id))
  const managedRuns = S.runtimeRuns?.runs || []
  const missionRooms = [...new Set((mission.tasks || []).map(task => task.roomId).filter(Boolean))]
  const missionAgents = [...new Set((mission.tasks || []).map(task => task.agentId || task.packId).filter(Boolean))]
  detail.innerHTML = `<div class="mission-detail-head"><span class="eyebrow">${esc(mission.status)}</span><h2>${esc(mission.title)}</h2><p>${esc(mission.objective)}</p><div class="progress-line"><span style="width:${missionProgress(mission)}%"></span></div><small>${missionProgress(mission)}% complete · updated ${esc(mission.updatedAt)}</small><div class="mission-evidence"><span><b>${mission.tasks?.length || 0}</b> tasks</span><span><b>${missionAgents.length}</b> agents</span><span><b>${mission.artifacts?.length || 0}</b> artifacts</span><span><b>${mission.events?.length || 0}</b> events</span></div><div class="mission-context">${missionRooms.map(id => `<button type="button" data-mission-room="${esc(id)}">${esc((S.projects?.rooms || []).find(room => room.id === id)?.label || id)}</button>`).join('')}</div></div>
    <div class="mission-tasks"><div class="section-label">TASK GRAPH</div>${(mission.tasks || []).map(task => { const run = managedRuns.find(item => item.missionId === mission.id && item.taskId === task.id && !['completed', 'failed', 'cancelled'].includes(item.status)); const controls = run ? `<span class="task-live">${esc(run.status)} · ${esc(run.phase)}</span><div class="runtime-controls"><button type="button" data-runtime-action="${run.status === 'paused' ? 'resume' : 'pause'}" data-runtime-run="${esc(run.runId)}">${run.status === 'paused' ? 'resume' : 'pause'}</button><button type="button" data-runtime-action="cancel" data-runtime-run="${esc(run.runId)}">cancel</button></div>` : ''; return `<article class="mission-task ${esc(task.status)}"><div><span class="mission-status ${esc(task.status)}"></span><b>${esc(task.title)}</b></div><small>${esc(task.description || 'No task brief')}</small><div class="mission-task-meta">${task.agentId ? esc(task.agentId) : 'unassigned'} · ${task.runtimeId ? esc(task.runtimeId) : 'runtime on dispatch'}${task.dependsOn.length ? ` · waits for ${esc(task.dependsOn.join(', '))}` : ''}</div>${(task.verification || []).length ? `<div class="mission-task-meta">${esc((task.verification || []).join(' · '))}</div>` : ''}${task.error ? `<div class="mission-task-meta">${esc(task.error)}</div>` : ''}${ready.has(task.id) ? `<button type="button" data-task-preview="${esc(task.id)}">preview dispatch</button>` : task.status === 'working' ? (controls || '<span class="task-live">running in a managed session</span>') : ''}</article>` }).join('') || '<div class="empty-sm">No tasks defined.</div>'}</div>
    <div class="mission-events"><div class="section-label">RECENT EVENTS</div>${(mission.events || []).slice(-8).reverse().map(event => `<div><span>${esc(event.type)}</span><small>${esc(event.detail)} · ${esc(event.at)}</small></div>`).join('') || '<div class="empty-sm">—</div>'}</div>
    ${S.missionPreview?.missionId === mission.id ? `<div class="mission-preview"><div class="section-label">DISPATCH PREVIEW</div><p>${esc(S.missionPreview.preview.summary)}</p><code>${esc(S.missionPreview.preview.launch?.shellCommand || S.missionPreview.preview.command || 'guarded runtime launch')}</code><button type="button" id="mission-confirm-dispatch">confirm dispatch</button><button type="button" id="mission-cancel-dispatch" class="danger">cancel</button></div>` : ''}`
  for (const button of detail.querySelectorAll('[data-task-preview]')) button.onclick = () => previewMissionTask(mission, button.dataset.taskPreview)
  for (const button of detail.querySelectorAll('[data-runtime-action]')) button.onclick = () => runtimeAction(button.dataset.runtimeRun, button.dataset.runtimeAction)
  for (const button of detail.querySelectorAll('[data-mission-room]')) button.onclick = () => { selectDeckProject(button.dataset.missionRoom); setView('office') }
  $('mission-confirm-dispatch')?.addEventListener('click', () => dispatchMissionTask(mission, S.missionPreview?.taskId, true))
  $('mission-cancel-dispatch')?.addEventListener('click', () => { S.missionPreview = null; renderMissions() })
}

async function previewMissionTask(mission, taskId) {
  const task = mission.tasks.find(item => item.id === taskId)
  if (!task) return
  try {
    const runtimeId = task.runtimeId || $('mission-runtime')?.value || 'codex'
    const result = await postJson(`/api/missions/${encodeURIComponent(mission.id)}/tasks/${encodeURIComponent(taskId)}/dispatch`, { runtimeId, managed: ['claude', 'codex'].includes(runtimeId), roomId: task.roomId || $('mission-room')?.value, packId: task.packId || 'builder', modelRef: task.modelRef || undefined, task: task.description || task.title })
    S.missionPreview = { missionId: mission.id, taskId, preview: result.preview }
    renderMissions()
  } catch (error) { $('mission-form-status').textContent = error.message }
}

async function dispatchMissionTask(mission, taskId, confirm) {
  const task = mission.tasks.find(item => item.id === taskId)
  if (!task) return
  try {
    const runtimeId = task.runtimeId || $('mission-runtime')?.value || 'codex'
    const result = await postJson(`/api/missions/${encodeURIComponent(mission.id)}/tasks/${encodeURIComponent(taskId)}/dispatch`, { runtimeId, managed: ['claude', 'codex'].includes(runtimeId), roomId: task.roomId || $('mission-room')?.value, packId: task.packId || 'builder', modelRef: task.modelRef || undefined, task: task.description || task.title, confirm })
    S.missionPreview = null
    S.missionSelection = result.mission?.id || mission.id
    renderMissions()
  } catch (error) { $('mission-form-status').textContent = error.message }
}

async function runtimeAction(runId, action) {
  try { await postJson(`/api/runtime-runs/${encodeURIComponent(runId)}/${action}`, {}); renderMissions() }
  catch (error) { $('mission-form-status').textContent = error.message }
}

/* ── indexed memory ring ────────────────────────────────────────────── */
function artifactList() { return S.artifactResults !== null ? S.artifactResults : S.artifacts?.entries || [] }

function renderArtifactDetail() {
  const box = $('artifact-detail')
  if (!box) return
  const item = S.artifactDetail
  $('artifact-detail-source').textContent = item ? item.source : ''
  if (!item) { box.innerHTML = '<div class="empty">Select an indexed artifact. Previews are bounded and secret-redacted.</div>'; return }
  box.innerHTML = `<div class="artifact-detail-head"><span class="eyebrow">${esc(item.sourceLabel || item.source)}</span><h2>${esc(item.title)}</h2><p>${esc(item.path)}</p><small>${esc(item.updatedAt)} · ${item.bytes} bytes${item.truncated ? ' · preview clipped' : ''}</small>${item.openable === false ? '<small>Protected artifact: opening is disabled.</small>' : '<div class="artifact-actions"><button type="button" id="artifact-open">open file</button><button type="button" id="artifact-reveal">reveal</button></div>'}</div><pre id="artifact-content"></pre>`
  $('artifact-content').textContent = item.content || item.summary || ''
  $('artifact-open')?.addEventListener('click', () => artifactAction(item.id, 'open'))
  $('artifact-reveal')?.addEventListener('click', () => artifactAction(item.id, 'reveal'))
}

async function openArtifact(id) {
  try {
    const response = await fetch(`/api/artifacts/${encodeURIComponent(id)}`)
    const item = await response.json()
    if (!response.ok) throw new Error(item.error || 'artifact unavailable')
    S.artifactDetail = item
    renderMemoryRing()
  } catch (error) { $('artifact-status').textContent = error.message }
}

async function artifactAction(id, action) {
  try {
    const response = await fetch(`/api/artifacts/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `${action} failed`)
    $('artifact-status').textContent = action === 'reveal' ? 'revealed in Finder' : 'opened in the default app'
  } catch (error) { $('artifact-status').textContent = error.message }
}

function renderMemoryRing() {
  const ring = $('memory-ring')
  const resultsBox = $('artifact-results')
  if (!ring || !resultsBox) return
  // The ring is a navigational overview, not the whole corpus. Keeping the
  // orbit sparse gives each recent artifact a real hit target; the complete
  // bounded result list remains below for exhaustive search.
  const entries = artifactList().slice(0, 12)
  const stats = S.artifacts?.stats || { total: entries.length, bySource: {} }
  // A root Quorum could not read is not an empty root. Saying "full index"
  // over an unreadable vault is exactly the kind of green this cockpit must
  // never show.
  const unreadableRoots = (S.artifacts?.roots || []).filter(root => root.readable === false)
  const indexScope = unreadableRoots.length
    ? `${unreadableRoots.length} root${unreadableRoots.length === 1 ? '' : 's'} unreadable`
    : stats.degraded ? 'partly unreadable' : stats.truncated ? 'partial' : 'full index'
  $('artifact-count').textContent = `${stats.total || entries.length} indexed · ${indexScope}`
  $('artifact-count').title = unreadableRoots.length ? unreadableRoots.map(root => `${root.label}: ${root.error || 'unreadable'}`).join('\n') : ''
  const sourceSelect = $('artifact-source')
  if (sourceSelect) {
    const selectedSource = sourceSelect.value
    const sources = (S.artifacts?.roots || []).filter(root => (stats.bySource?.[root.id] || 0) > 0)
    sourceSelect.innerHTML = '<option value="">all sources</option>' + sources.map(root => `<option value="${esc(root.id)}">${esc(root.label)}</option>`).join('')
    sourceSelect.value = sources.some(root => root.id === selectedSource) ? selectedSource : ''
  }
  const count = Math.max(1, entries.length)
  ring.innerHTML = `<div class="ring-center"><span class="eyebrow">LOCAL RECALL</span><strong>${stats.total || 0}</strong><small>${Object.entries(stats.bySource || {}).map(([key, value]) => `${esc(key)} ${value}`).join(' · ')}</small><span data-ring-message>${esc(S.artifactDetail ? `${S.artifactDetail.sourceLabel || S.artifactDetail.source} · ${S.artifactDetail.title}` : 'hover a node to inspect its trail')}</span></div>${entries.map((entry, index) => `<button type="button" class="artifact-node source-${esc(entry.source)} ${S.artifactDetail?.id === entry.id ? 'selected' : ''}" style="--i:${index};--count:${count}" data-artifact-id="${esc(entry.id)}" title="${esc(entry.path)}"><span>${esc(entry.source.slice(0, 3).toUpperCase())}</span><b>${esc(entry.title.slice(0, 30))}</b>${relLabel(entry.mtimeMs, { tag: 'small' })}</button>`).join('')}`
  const recallOutput = $('memory-recall-output')
  if (recallOutput) {
    recallOutput.classList.toggle('hidden', !S.recallContext)
    recallOutput.textContent = S.recallContext ? `RECALLED CONTEXT · ${S.recallContext.query}\n\n${S.recallContext.context || 'No matching long-term context.'}` : ''
  }
  const ringMessage = ring.querySelector('[data-ring-message]')
  for (const node of ring.querySelectorAll('[data-artifact-id]')) {
    const entry = entries.find(item => item.id === node.dataset.artifactId)
    node.onmouseenter = () => { if (ringMessage && entry) ringMessage.textContent = `${entry.sourceLabel || entry.source} · ${entry.title}` }
    node.onmouseleave = () => { if (ringMessage) ringMessage.textContent = S.artifactDetail ? `${S.artifactDetail.sourceLabel || S.artifactDetail.source} · ${S.artifactDetail.title}` : 'hover a node to inspect its trail' }
    node.title = `${entry?.path || 'artifact'} · click to preview · double-click to open`
    node.onclick = () => openArtifact(node.dataset.artifactId)
    node.ondblclick = () => artifactAction(node.dataset.artifactId, 'open')
  }
  resultsBox.innerHTML = entries.length ? entries.map(entry => `<button type="button" class="artifact-result ${S.artifactDetail?.id === entry.id ? 'selected' : ''}" data-artifact-id="${esc(entry.id)}"><span class="source-mark source-${esc(entry.source)}">${esc(entry.source.slice(0, 3).toUpperCase())}</span><span><b>${esc(entry.title)}</b><small>${esc(entry.relativePath)} · ${esc(entry.summary || 'indexed artifact')}</small></span>${relLabel(entry.mtimeMs, { tag: 'time' })}</button>`).join('') : '<div class="empty">No indexed artifacts yet. Reindex after starting Quorum.</div>'
  for (const item of resultsBox.querySelectorAll('[data-artifact-id]')) {
    item.onclick = () => openArtifact(item.dataset.artifactId)
    item.ondblclick = () => artifactAction(item.dataset.artifactId, 'open')
  }
  renderArtifactDetail()
  const searchForm = $('artifact-search-form')
  if (searchForm && !searchForm.dataset.wired) {
    searchForm.dataset.wired = '1'
    searchForm.onsubmit = async event => {
      event.preventDefault()
      const status = $('artifact-status')
      try {
        status.textContent = 'searching…'
        const query = $('artifact-query').value
        const source = $('artifact-source').value
        const response = await fetch(`/api/artifacts/search?q=${encodeURIComponent(query)}&source=${encodeURIComponent(source)}`)
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'search failed')
        S.artifactResults = data.results || []
        S.artifactDetail = null
        S.recallContext = null
        status.textContent = `${data.total} matches`
        renderMemoryRing()
      } catch (error) { status.textContent = error.message }
    }
  }
  const reindex = $('artifact-reindex')
  if (reindex && !reindex.dataset.wired) {
    reindex.dataset.wired = '1'
    reindex.onclick = async () => {
      try { reindex.disabled = true; $('artifact-status').textContent = 'indexing…'; const response = await postJson('/api/artifacts/reindex', {}); S.artifacts = response; S.artifactResults = null; $('artifact-status').textContent = `indexed ${response.stats.total} files`; renderMemoryRing() } catch (error) { $('artifact-status').textContent = error.message } finally { reindex.disabled = false }
    }
  }
  const sync = $('memory-sync')
  if (sync && !sync.dataset.wired) { sync.dataset.wired = '1'; sync.onclick = syncMemoryBridge }
  const recall = $('memory-recall')
  if (recall && !recall.dataset.wired) {
    recall.dataset.wired = '1'
    recall.onclick = async () => {
      const status = $('artifact-status')
      const query = $('artifact-query').value.trim() || 'operator'
      try {
        recall.disabled = true; status.textContent = 'recalling bounded context…'
        const response = await fetch(`/api/memory/recall?q=${encodeURIComponent(query)}`)
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'recall failed')
        S.recallContext = data
        status.textContent = `${(data.context || '').length} characters recalled · ${data.bridge.claudeMem.state}`
        renderMemoryRing()
      } catch (error) { status.textContent = error.message } finally { recall.disabled = false }
    }
  }
}

// A fresh snapshot invalidates every surface. Only the visible view is drawn
// now; the rest are queued and drawn when they are switched to, which is the
// same pixels for a fraction of the work on a page that opens on one view.
function renderAll() {
  paint('renderRuntimes')
  setView(S.view)
  paint('renderTopbar', 'renderSessions', 'renderSystem', 'renderServices', 'renderProcs', 'renderFeed')
  paint('renderOffice', 'renderRoomDetail', 'renderDeck', 'renderCommand', 'renderAgentControl')
  paint('renderBoard', 'renderComposio', 'renderMemory', 'renderConnectionMap', 'renderAgents', 'renderAvatars', 'renderMissions', 'renderMemoryRing')
  paint('renderMascot', 'renderCrew', 'renderCastPicker', 'renderRoundtable', 'renderArchive')
  paint('renderEdition')
}

connect()

/* ── guided tour ───────────────────────────────────────────────────────
 *
 * Seven steps, each pinned to a real element in the live UI rather than to
 * screenshots — the tour shows *this machine's* rooms and sessions, which is
 * far more convincing than a canned demo. Steps may switch views: the target
 * is resolved after the switch so the highlight lands on something visible.
 */
const TOUR = [
  {
    view: 'office', target: '#mascot-slot', title: 'This is Quorum',
    body: 'A cockpit for the AI activity on this machine — and a table where AI specialists argue your decisions properly. The tour is seven steps and takes a minute.',
  },
  {
    view: 'office', target: '#crew-list', title: 'The crew',
    body: 'Each character argues from a different priority — the architect from long-term cost, the builder from shipping today. Click to seat them for a debate; drag one onto a room to argue about that project.',
  },
  {
    view: 'office', target: '#rooms-grid', title: 'Project rooms',
    body: 'Every room is a real folder on this machine, discovered automatically. Live AI sessions stand in the room matching their working directory. Click a room to inspect it; drop a runtime on it to open a terminal there.',
  },
  {
    view: 'table', target: '#rt-form', title: 'Call a roundtable',
    body: 'Pose a genuinely contested question, seat 2–5 of the crew, convene. Openings are written blind and in parallel, then each specialist must engage the strongest argument against them. Cost is shown before you spend.',
  },
  {
    view: 'table', target: '#rt-stage', title: 'Watch the argument',
    body: 'Characters speak on the stage; confidence is tracked across phases so you can see a mind actually change. The moderator ends with a decision record — including the dissent that survived.',
  },
  {
    view: 'table', target: '#rt-archive', title: 'Keep the record',
    body: 'Every finished debate is archived and exports as a markdown decision record you can commit next to the code it argues about. The argument is disposable; the record is not.',
  },
  {
    view: 'office', target: '#term-actions', title: 'Real terminals',
    body: 'These spawn actual PTYs — claude, codex, hermes or a shell — in the selected room’s directory. They live server-side, so a page reload doesn’t kill them. Ctrl+` toggles the drawer. That’s the tour — the ? button replays it.',
  },
]

let tourStep = -1

function tourStart() {
  tourStep = 0
  tourShow()
}

function tourShow() {
  const step = TOUR[tourStep]
  if (!step) return tourEnd()
  if (S.view !== step.view) setView(step.view)
  const el = document.querySelector(step.target)
  $('tour').classList.remove('hidden')
  $('tour-step-label').textContent = `${tourStep + 1} / ${TOUR.length}`
  $('tour-title').textContent = step.title
  $('tour-body').textContent = step.body
  $('tour-back').disabled = tourStep === 0
  $('tour-next').textContent = tourStep === TOUR.length - 1 ? 'done' : 'next'

  const ring = $('tour-ring')
  const card = $('tour-card')
  if (el) {
    const r = el.getBoundingClientRect()
    const pad = 6
    ring.style.cssText = `display:block;left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`
    // Card goes beside the ring, flipping to whichever half of the window has room.
    const below = r.bottom + 190 < window.innerHeight
    card.style.top = below ? `${Math.min(r.bottom + 14, window.innerHeight - 210)}px` : `${Math.max(10, r.top - 200)}px`
    card.style.left = `${Math.max(10, Math.min(r.left, window.innerWidth - 360))}px`
  } else {
    ring.style.display = 'none'
    card.style.top = '25%'
    card.style.left = 'calc(50% - 170px)'
  }
}

function tourEnd() {
  tourStep = -1
  $('tour').classList.add('hidden')

async function exportDebateCard(d) {
  const canvas = document.createElement('canvas')
  canvas.width = 1200; canvas.height = 1600
  const ctx = canvas.getContext('2d')

  // Background
  const grad = ctx.createLinearGradient(0, 0, 1200, 1600)
  grad.addColorStop(0, token('--bg2')); grad.addColorStop(1, token('--bg0'))
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 1200, 1600)

  // Branding
  ctx.fillStyle = token('--accent'); ctx.font = 'bold 32px Inter, sans-serif'
  ctx.fillText('QUORUM DECISION RECORD', 60, 80)
  ctx.strokeStyle = token('--stage-edge'); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(60, 100); ctx.lineTo(1140, 100); ctx.stroke()

  // Topic
  ctx.fillStyle = token('--fg0'); ctx.font = 'bold 64px Inter, sans-serif'
  const words = d.topic.split(' ')
  let line = '', y = 200
  for (const w of words) {
    if ((line + ' ' + w).length > 30) {
      ctx.fillText(line, 60, y); y += 80; line = w
    } else line += (line ? ' ' : '') + w
  }
  ctx.fillText(line, 60, y)

  // Verdict
  const verdict = (d.turns || []).filter(t => t.phase === 'verdict' && !t.failed).pop()
  if (verdict) {
    y += 120
    ctx.fillStyle = token('--accent'); ctx.font = 'bold 32px Inter, sans-serif'
    ctx.fillText('THE DECISION', 60, y)
    y += 40
    ctx.fillStyle = token('--fg0'); ctx.font = '32px Inter, sans-serif'
    let vLine = '', vY = y
    const vBody = verdict.body || '_no verdict recorded_'
    for (const w of vBody.split(' ')) {
      if ((vLine + ' ' + w).length > 60) {
        ctx.fillText(vLine, 60, vY); vY += 40; vLine = w
      } else vLine += (vLine ? ' ' : '') + w
    }
    ctx.fillText(vLine, 60, vY)
    y = vY + 80
  }

  // Movement Table
  const openings = (d.turns || []).filter(t => t.phase === 'opening' && !t.failed)
  const finals = (d.turns || []).filter(t => t.phase === 'converge' && !t.failed)
  const moved = [...(d.participants || [])].map(id => {
    const o = openings.find(x => x.speaker === id)
    const f = finals.find(x => x.speaker === id)
    return { name: f?.speakerName || o?.speakerName || id, role: f?.speakerRole || o?.speakerRole || 'specialist', opening: o?.position || '—', final: f?.position || '—', shift: (o?.confidence != null && f?.confidence != null) ? `${o.confidence}→${f.confidence}` : '—', conceded: !!f?.conceded }
  })

  if (moved.length) {
    y += 40
    ctx.fillStyle = token('--accent'); ctx.font = 'bold 32px Inter, sans-serif'
    ctx.fillText('MOVEMENT & DISSENT', 60, y)
    y += 60
    ctx.fillStyle = token('--fg2'); ctx.font = 'bold 24px Inter, sans-serif'
    ctx.fillText('Participant', 60, y); ctx.fillText('Opening', 300, y); ctx.fillText('Final', 600, y); ctx.fillText('Shift', 900, y)
    y += 40
    ctx.strokeStyle = token('--stage-edge'); ctx.beginPath(); ctx.moveTo(60, y); ctx.lineTo(1140, y); ctx.stroke()
    y += 40
    ctx.fillStyle = token('--fg0'); ctx.font = '24px Inter, sans-serif'
    for (const m of moved) {
      ctx.fillText(m.name, 60, y)
      ctx.fillText(m.opening.slice(0, 20), 300, y)
      ctx.fillText(m.final.slice(0, 20), 600, y)
      ctx.fillText(m.shift, 900, y)
      y += 50
    }
  }

  const link = document.createElement('a')
  link.download = `quorum-decision-${d.id.slice(0, 8)}.png`
  link.href = canvas.toDataURL('image/png')
  link.click()
}
  localStorage.setItem('quorum-tour-done', '1')
}

{
  $('tb-help').onclick = tourStart
  $('tour-skip').onclick = tourEnd
  $('tour-next').onclick = () => { tourStep++; tourShow() }
  $('tour-back').onclick = () => { tourStep = Math.max(0, tourStep - 1); tourShow() }
  window.addEventListener('keydown', e => {
    if (tourStep === -1) return
    if (e.key === 'Escape') tourEnd()
    if (e.key === 'ArrowRight' || e.key === 'Enter') { tourStep++; tourShow() }
    if (e.key === 'ArrowLeft') { tourStep = Math.max(0, tourStep - 1); tourShow() }
  })
  window.addEventListener('resize', () => { if (tourStep >= 0) tourShow() })
  // First visit only. The snapshot handler fires once real data is on screen,
  // so the tour points at populated rooms rather than loading spinners.
  if (!localStorage.getItem('quorum-tour-done') && S.view === 'office') setTimeout(tourStart, 1200)
}
