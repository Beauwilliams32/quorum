/* Quorum frontend — no framework, one websocket, targeted renders. */
'use strict'

import { drawCharacter, drawMascot, drawRoom, LOD, ROOM_FLOOR } from './art.js'

// Rendered height of an avatar sprite: the SVG is drawn at 1.2× its width.
const AVATAR_H = Math.round(LOD.avatar * 1.2)

const S = {
  processes: null, sessions: null, services: null, system: null, projects: null,
  tasks: null, composio: null, agents: null, memory: null,
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
}

const DEFAULT_MODEL_OPTIONS = [
  { id: 'claude:sonnet', label: 'Claude · sonnet — balanced', provider: 'claude', model: 'sonnet', estimatedCostUsd: 0.08, available: true },
  { id: 'claude:opus', label: 'Claude · opus — deepest, priciest', provider: 'claude', model: 'opus', estimatedCostUsd: 0.4, available: true },
  { id: 'claude:haiku', label: 'Claude · haiku — fastest, cheapest', provider: 'claude', model: 'haiku', estimatedCostUsd: 0.024, available: true },
  { id: 'ollama:gemma3:latest', label: 'Ollama · gemma3:latest — local', provider: 'ollama', model: 'gemma3:latest', local: true, available: false },
]
const currentModelOptions = () => S.modelOptions.length ? S.modelOptions : DEFAULT_MODEL_OPTIONS

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

const handlers = {
  snapshot(m) {
    S.processes = m.data.processes || null
    S.sessions = m.data.sessions || null
    S.services = m.data.services || null
    S.projects = m.data.projects || null
    S.tasks = m.data.tasks || null
    S.composio = m.data.composio || null
    S.agents = m.data.agents || null
    S.memory = m.data.memory || null
    S.agentControl = m.data.agentControl || null
    S.system = m.data.system?.latest || null
    S.hist = m.data.system?.hist ? [...m.data.system.hist] : []
    S.feed = m.feed || []
    renderAll()
  },
  update(m) {
    if (m.key === 'system') {
      S.system = m.data.latest
      S.hist.push(m.data.latest)
      if (S.hist.length > 300) S.hist.shift()
      renderSystem(); renderTopbar(); renderDeck()
    } else {
      S[m.key] = m.data
      if (m.key === 'sessions') { renderSessions(); renderOffice(); renderRoomDetail(); renderDeck() }
      if (m.key === 'processes') { renderTopbar(); renderProcs(); renderOffice(); renderDeck() }
      if (m.key === 'services') { renderTopbar(); renderServices(); renderOffice(); renderDeck() }
      if (m.key === 'projects') { renderOffice(); renderRoomDetail(); renderAvatars(); renderDeck() }
      if (m.key === 'tasks') { renderBoard(); renderTopbar(); renderAvatars(); renderDeck() }
      if (m.key === 'composio') renderComposio()
      if (m.key === 'agents') { renderAgents(); renderAvatars(); renderDeck() }
      if (m.key === 'memory') { renderMemory(); renderTopbar(); renderDeck() }
      if (m.key === 'agentControl') renderAgentControl()
    }
  },
  event(m) {
    S.feed.push(m.item)
    if (S.feed.length > 200) S.feed.shift()
    renderFeed()
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
    renderMascot(); renderCrew(); renderCastPicker(); renderRoundtable(); renderEdition(); renderRuntimes()
    renderCommand()
  },
  'command.preview'(m) { S.commandPreview = m.preview; renderCommand() },
  'command.done'(m) { S.commandPreview = null; renderCommand(); renderFeed() },

  'rt.list'(m) {
    S.archive = m.recent || []
    // A debate survives a browser reload: the server is the owner, so a client
    // that reconnects mid-debate rejoins the live one rather than showing an
    // empty table next to a terminal that is visibly spending money.
    if (m.live?.length) S.debate = m.live[0]
    else if (!S.debate && S.archive.length) S.debate = S.archive[0]
    renderRoundtable(); renderArchive()
  },

  'rt.update'(m) { S.debate = m.debate; renderRoundtable() },
  'rt.turn'(m) { if (S.debate?.id === m.debateId) S.speaking = null; renderRoundtable() },
  'rt.speaking'(m) {
    if (S.debate?.id !== m.debateId) return
    S.speaking = { speaker: m.speaker, phase: m.phase }
    renderStage()
  },
  'rt.done'(m) {
    S.debate = m.debate
    S.speaking = null
    S.archive = [m.debate, ...S.archive.filter(d => d.id !== m.debate.id)].slice(0, 8)
    renderRoundtable(); renderArchive()
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

/* ── view toggle ───────────────────────────────────────── */
// One map rather than a line per view: adding a view should mean adding a key,
// not remembering to add a matching toggle call three lines down.
const VIEWS = {
  office: 'view-office',
  command: 'view-command',
  table: 'view-table',
  deck: 'view-deck',
  board: 'view-board',
  radar: 'view-radar',
}

function setView(view) {
  if (!VIEWS[view]) view = 'office'
  S.view = view
  localStorage.setItem('quorum-view', view)
  for (const [name, id] of Object.entries(VIEWS)) $(id).classList.toggle('hidden', name !== view)
  for (const b of document.querySelectorAll('#view-toggle button'))
    b.classList.toggle('on', b.dataset.view === view)
  if (view === 'radar') renderSystem()
  if (view === 'deck') renderDeck()
  if (view === 'office') { renderOffice(); renderAvatars() }
  if (view === 'command') renderCommand()
  if (view === 'table') { renderRoundtable(); renderArchive() }
  if (view === 'board') { renderBoard(); renderComposio(); renderAgents() }
}

for (const b of document.querySelectorAll('#view-toggle button'))
  b.onclick = () => setView(b.dataset.view)

document.getElementById('command-roundtable')?.addEventListener('click', () => setView('table'))

// Apply the requested or remembered view immediately. The websocket snapshot can
// arrive after first paint; direct links like ?view=table must not flash or stay
// pinned to the default Studio markup while the local collectors warm up.
setView(S.view)

/* ── top bar ───────────────────────────────────────────── */
function renderTopbar() {
  const g = S.processes?.groups || {}
  const sv = S.services || {}
  const dot = up => `<span class="dot ${up ? 'up' : 'down'}"></span>`
  $('tb-agents').innerHTML =
    `<span class="tb-item">${dot((g.claude || 0) > 0)}claude <b>${g.claude || 0}</b></span>` +
    `<span class="tb-item">${dot(sv.hermes?.up)}hermes</span>` +
    `<span class="tb-item">${dot((g.codex || 0) > 0)}codex <b>${g.codex || 0}</b></span>` +
    `<span class="tb-item">${dot(sv.comfy?.up)}comfy${comfyDl() ? ' <b>⇣dl</b>' : ''}</span>` +
    `<span class="tb-item">${dot(S.memory?.ok)}memory <b>${S.memory?.ledger?.counts?.pending ?? '—'}</b></span>`
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

function renderCommand() {
  const box = $('command-library')
  if (!box) return
  const catalog = S.catalog
  if (!catalog) { box.innerHTML = '<div class="empty">waiting for Quorum catalog…</div>'; return }
  const available = catalog.runtimes.filter(r => r.available).length
  $('command-connection').textContent = `${available}/${catalog.runtimes.length} runtimes ready · ${catalog.config.projectCount} project roots · no secrets exposed`
  const rooms = S.projects?.rooms || []
  $('command-pulse').innerHTML = `<div class="command-stat"><b>${rooms.length}</b><span>project rooms</span></div><div class="command-stat"><b>${(S.sessions?.cards || []).filter(s => s.active).length}</b><span>active sessions</span></div><div class="command-stat"><b>${catalog.models.length}</b><span>catalog models</span></div><div class="command-stat"><b>${S.feed.length}</b><span>audit events</span></div>`
  renderAgentWorkbench(catalog, rooms)
  box.innerHTML = catalog.runtimes.map(runtime => `<article class="command-card ${runtime.available ? 'ready' : 'offline'}"><div class="pet-mini ${esc(runtime.id)}">✦</div><div class="command-card-copy"><h3>${esc(runtime.label)} <span>${runtime.available ? 'ready' : 'offline'}</span></h3><p>${esc(runtime.kind)} · ${esc(runtime.capabilities.join(' · '))}</p><small>${runtime.authReady ? 'auth available via local environment' : 'auth not reported / optional'}</small></div><button type="button" data-command-launch="${esc(runtime.id)}" ${runtime.available && runtime.command && rooms.length ? '' : 'disabled'}>preview launch</button></article>`).join('')
  for (const button of box.querySelectorAll('[data-command-launch]')) button.onclick = () => {
    const roomId = S.selectedRoom || rooms[0]?.id
    if (!roomId) return
    send({ type: 'command.preview', action: 'launch', runtimeId: button.dataset.commandLaunch, roomId })
    $('command-preview').textContent = `preparing ${button.dataset.commandLaunch} → ${roomId}`
    $('command-actions').innerHTML = `<button type="button" id="command-confirm">confirm launch</button><button type="button" id="command-cancel" class="danger">cancel</button>`
    $('command-confirm').onclick = () => send({ type: 'command.execute', action: 'launch', runtimeId: button.dataset.commandLaunch, roomId, confirm: true })
    $('command-cancel').onclick = () => { $('command-actions').innerHTML = ''; $('command-preview').textContent = 'action cancelled' }
  }
  if (S.commandPreview) { $('command-preview').textContent = S.commandPreview.summary; $('command-actions').innerHTML = `<button type="button" id="command-confirm">confirm action</button>`; $('command-confirm').onclick = () => send({ type: 'command.execute', ...S.commandPreview, confirm: true }) }
}

function renderAgentWorkbench(catalog, rooms) {
  const form = $('agent-form')
  if (!form) return
  const packs = catalog.agentPacks || []
  const packSelect = $('agent-pack')
  const runtimeSelect = $('agent-runtime')
  const modelSelect = $('agent-model')
  if (!packs.length) { form.innerHTML = '<div class="empty">agent packs unavailable</div>'; return }
  const previousPack = packSelect.value
  packSelect.innerHTML = packs.map(pack => `<option value="${esc(pack.id)}">${esc(pack.label)} · ${esc(pack.role)}</option>`).join('')
  packSelect.value = packs.some(pack => pack.id === previousPack) ? previousPack : packs[0].id
  const pack = packs.find(item => item.id === packSelect.value) || packs[0]
  const candidates = catalog.runtimes.filter(runtime => pack.runtimes?.includes(runtime.id) && runtime.command && runtime.id !== 'shell')
  const ready = candidates.filter(runtime => runtime.available)
  const runtimeChoices = ready.length ? ready : candidates
  const oldRuntime = runtimeSelect.value
  runtimeSelect.innerHTML = runtimeChoices.map(runtime => `<option value="${esc(runtime.id)}">${esc(runtime.label)}${runtime.available ? '' : ' · offline'}</option>`).join('')
  runtimeSelect.value = runtimeChoices.some(runtime => runtime.id === oldRuntime) ? oldRuntime : runtimeChoices[0]?.id || ''
  const runtimeId = runtimeSelect.value
  const options = (pack.models || []).filter(model => model.provider === runtimeId)
  if (!options.length) options.push({ id: `${runtimeId}:auto`, label: `${runtimeId} · runtime default`, provider: runtimeId, model: 'auto', available: true })
  const oldModel = modelSelect.value
  modelSelect.innerHTML = options.map(model => `<option value="${esc(model.id)}">${esc(model.label)}</option>`).join('')
  modelSelect.value = options.some(model => model.id === oldModel) ? oldModel : options[0].id
  $('agent-brief').innerHTML = `<strong>${esc(pack.summary)}</strong><span>${esc(pack.gates.join(' · '))}</span><small>role ${esc(pack.role)} · pack contract ${pack.promptAvailable ? 'loaded' : 'missing'}</small>`
  packSelect.onchange = () => renderCommand()
  runtimeSelect.onchange = () => renderCommand()
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
    (runs.length ? runs.map(run => `<div class="control-run"><span class="dot ${run.status === 'active' ? 'up' : ''}"></span><span class="control-run-copy"><b>${esc(run.packId || run.runtime)} · ${esc(run.role)}</b><small>${esc(run.phase || run.status)} · ${esc(run.worktree)}</small></span><span class="control-run-actions"><small>${run.leaseExpiresAt ? rel(run.leaseExpiresAt) + ' lease' : 'closed'}</small>${run.status === 'active' ? `<button type="button" data-control-run-cancel="${esc(run.runId)}">stop</button>` : ''}${run.status === 'stale' ? `<button type="button" data-control-run-recover="${esc(run.runId)}">recover</button>` : ''}</span></div>`).join('') : '<div class="empty-sm">no claimed runs</div>') +
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
    $('team-desks').innerHTML = '<div class="empty-sm">loading team…</div>'
    $('rooms-grid').innerHTML = '<div class="empty">loading rooms…</div>'
    return
  }

  const DRAGGABLE_RUNTIME = new Set(['claude', 'codex', 'hermes'])
  $('team-desks').innerHTML = (proj.team || []).map(t =>
    `<div class="desk ${t.alive ? 'alive' : 'idle'}" data-agent="${esc(t.id)}"
          ${DRAGGABLE_RUNTIME.has(t.id) ? 'draggable="true" title="drag onto a room to open a terminal there"' : ''}>
      <span class="desk-pulse"></span>
      <span class="desk-name">${esc(t.label)}</span>
      <span class="desk-count">${t.count || (t.alive ? 'up' : '—')}</span>
    </div>`).join('')

  for (const el of $('team-desks').querySelectorAll('.desk[draggable]'))
    el.ondragstart = e => e.dataTransfer.setData('text/plain', 'runtime:' + el.dataset.agent)

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

  $('rooms-grid').innerHTML = rooms.map(r => {
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

  for (const el of $('rooms-grid').querySelectorAll('.room')) {
    el.onclick = () => selectRoom(el.dataset.id)
    wireRoomDrop(el)
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

/* A locked character is advertised, not hidden — seeing Sable greyed out with
 * "paid to find the way it breaks" underneath is what sells the upgrade. */
function showUpgrade(c) {
  const box = $('rt-estimate')
  setView('table')
  if (!box) return
  box.className = 'rt-estimate warn'
  box.innerHTML = `<b>${esc(c.name)}</b> — ${esc(c.role)} — is part of Quorum Pro. ` +
    `The free edition seats Nib, Vex and Bolt, which is enough for a real debate. ` +
    `Pro adds the full six-character crew and lets you write your own specialists.`
}

function renderEdition() {
  const el = $('edition-badge')
  if (!el) return
  const pro = S.edition?.tier === 'pro'
  el.className = 'edition ' + (pro ? 'pro' : 'free')
  el.textContent = pro ? 'PRO' : 'FREE'
  el.title = pro
    ? `Quorum Pro${S.edition.licence?.registeredTo ? ' — ' + S.edition.licence.registeredTo : ''}`
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
      <span class="sess-time">${rel(c.mtimeMs)}</span>
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
  $('deck-stats').innerHTML = [
    deckStat('free', sys.freeMB == null ? '—' : gb(sys.freeMB)),
    deckStat('load', sys.load == null ? '—' : sys.load),
    deckStat('sessions', `${activeSessions}/${sessions.length}`),
    deckStat('processes', String(S.processes?.procs?.length || 0)),
    deckStat('rooms', String(rooms.length)),
    deckStat('memory', S.memory?.ledger?.counts ? `${S.memory.ledger.counts.pending} pending` : '—'),
    deckStat('websocket', ws?.readyState === 1 ? 'live' : 'wait'),
  ].join('')

  const roomRadiusX = Math.max(180, Math.min(w * .38, 420))
  const roomRadiusY = Math.max(100, Math.min(h * .31, 220))
  const roomNodes = rooms.map((room, i) => {
    const angle = (i / Math.max(1, rooms.length)) * Math.PI * 2 - Math.PI / 2
    const x = Math.cos(angle) * roomRadiusX
    const y = Math.sin(angle) * roomRadiusY
    const z = room.active ? 105 : 35 + (i % 3) * 12
    const selected = S.deckSelection.kind === 'project' && S.deckSelection.id === room.id
    const cards = sessions.filter(s => s.projectId === room.id)
    return `<div class="deck-node project ${room.active ? 'active' : ''} ${selected ? 'selected' : ''}" data-kind="project" data-id="${esc(room.id)}" style="--x:${x}px;--y:${y}px;--z:${z}px">
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
    return `<div class="deck-node agent ${agent.status === 'busy' ? 'busy' : ''} ${selected ? 'selected' : ''}" data-kind="agent" data-id="${esc(agent.sessionId)}" style="--x:${x}px;--y:${y}px;--z:150px">
      <div class="node-top"><span class="node-signal"></span><span class="node-title">${esc(agent.name)}</span></div>
      <div class="node-meta">${esc(agent.projectId || 'unassigned')} · ${esc(agent.status || 'idle')}</div>
    </div>`
  }).join('')

  nodes.innerHTML = roomNodes + agentNodes
  for (const node of nodes.querySelectorAll('.deck-node')) {
    node.onclick = () => {
      if (node.dataset.kind === 'project') selectDeckProject(node.dataset.id)
      else selectDeckAgent(node.dataset.id)
    }
    node.ondblclick = () => {
      if (node.dataset.kind === 'project') {
        const card = sessions.find(s => s.projectId === node.dataset.id && s.active) || sessions.find(s => s.projectId === node.dataset.id)
        if (card) { selectSession(card.file, card.agent, card.cwd); setView('radar') }
        else selectDeckProject(node.dataset.id)
      } else {
        selectChat(node.dataset.id)
        setView('office')
      }
    }
  }
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
    actions.innerHTML = '<button data-deck-action="seat" data-profile="claude">+ claude</button><button data-deck-action="seat" data-profile="codex">+ codex</button><button data-deck-action="office">open room</button>'
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
      if (button.dataset.deckAction === 'chat') { selectChat(selected.id); setView('office') }
      if (button.dataset.deckAction === 'radar') setView('radar')
    }
  }
}

function renderDeckSessions() {
  const box = $('deck-sessions')
  const count = $('deck-session-count')
  if (!box || !count) return
  const selectedProject = S.deckSelection.kind === 'project' ? S.deckSelection.id : null
  const cards = (S.sessions?.cards || []).filter(c => !selectedProject || c.projectId === selectedProject).slice(0, 20)
  count.textContent = String(cards.length)
  box.innerHTML = cards.map(c => `<div class="deck-session" data-file="${esc(c.file)}" data-agent="${esc(c.agent)}" data-cwd="${esc(c.cwd || '')}">${c.active ? '<span class="pulse"></span>' : '<span class="idle-dot"></span>'}<span>${esc(c.summary || c.id || c.file.split('/').pop())}</span><small>${esc(c.agent)}</small></div>`).join('') || '<div class="empty-sm">No matching sessions.</div>'
  for (const item of box.querySelectorAll('.deck-session')) {
    item.onclick = () => selectSession(item.dataset.file, item.dataset.agent, item.dataset.cwd)
    item.ondblclick = () => { selectSession(item.dataset.file, item.dataset.agent, item.dataset.cwd); setView('radar') }
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
        <span class="sess-time">${rel(c.mtimeMs)}</span>
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
    area(ctx, hist, x, i => y(hist[i].usedMB), 'rgba(114, 212, 255, 0.32)')
    area(ctx, hist, x, i => y(hist[i].usedMB + hist[i].compMB), 'rgba(167, 139, 250, 0.20)')
    line(ctx, hist, x, i => y(total - hist[i].freeMB), 'rgba(251, 113, 133, 0.62)')
    ctx.fillStyle = '#8e96a8'; ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(gb(total) + ' total · cyan=used violet=+comp red=pressure', 4, 10)
  }

  const [ctx2, w2, h2] = setupCanvas($('swapchart'))
  ctx2.clearRect(0, 0, w2, h2)
  if (hist.length > 1) {
    const max = Math.max(10, ...hist.map(s => s.soRate))
    const bw = w2 / hist.length
    ctx2.fillStyle = 'rgba(245, 158, 11, 0.55)'
    hist.forEach((s, i) => {
      if (!s.soRate) return
      const bh = (s.soRate / max) * (h2 - 10)
      ctx2.fillRect(i * bw, h2 - bh, Math.max(1, bw - .5), bh)
    })
    ctx2.fillStyle = '#8e96a8'; ctx2.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
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
    (a.codex?.lastRefresh ? row('codex refresh', rel(Date.parse(a.codex.lastRefresh)) + ' ago') : '') +
    row('hermes', runtimeState(a.hermes)) +
    row('recovery', !a.claude?.cli ? 'install Claude Code to convene a table' : !a.claude.configured && !a.anthropic?.apiKeyAvailable ? 'sign in to Claude Code or restart Quorum with an API key' : 'local runtime checks only')
}

function renderProcs() {
  const top = S.processes?.topRss || []
  $('top-procs').innerHTML = top.map(p =>
    `<div class="proc-row">
      ${p.group ? `<span class="grp">${p.group}</span>` : '<span class="grp">·</span>'}
      <span class="proc-name" title="pid ${p.pid}">${esc(p.name)}</span>
      <span class="proc-mem">${gb(p.rssMB)} ${p.cpu > 5 ? '· ' + p.cpu + '%' : ''}</span>
      ${p.group ? `<button class="kill" data-pid="${p.pid}" data-name="${esc(p.name)}" title="SIGTERM">✕</button>` : ''}
    </div>`).join('')
  for (const b of $('top-procs').querySelectorAll('.kill'))
    b.onclick = () => {
      if (confirm(`SIGTERM ${b.dataset.name} (pid ${b.dataset.pid})?`))
        send({ type: 'proc.kill', pid: +b.dataset.pid })
    }
}

function renderFeed() {
  $('feed-list').innerHTML = [...S.feed].reverse().slice(0, 60).map(f =>
    `<div class="feed-item feed-${f.kind}"><span class="t">${new Date(f.ts).toLocaleTimeString()}</span><span>${esc(f.text)}</span></div>`
  ).join('')
}

/* ── terminals ─────────────────────────────────────────── */
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
    theme: { background: '#08090d', foreground: '#d4dae4', cursor: '#72d4ff', selectionBackground: '#72d4ff33' },
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
  $('tb-tasks').innerHTML = `<span class="tb-item">tasks <b>${c.in_progress}</b>/${c.in_progress + c.pending}</span>`

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
  if (!pool.length) return { name: '?', role: '', palette: { body: '#556', trim: '#334', glow: '#99a' }, visor: 'dot', crest: 'spark', prop: '' }
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
    parts.push(`<div class="log-turn ${t.failed ? 'failed' : ''}" style="--c:${c?.palette.body || '#889'}">
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
    parts.push(`<a class="log-export" href="/api/roundtable/${esc(d.id)}.md" download>⤓ export decision record (.md)</a>`)
  box.innerHTML = parts.join('')
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
          : `<a class="arc-dl" href="/api/roundtable/${esc(d.id)}.md" download title="export decision record">⤓ .md</a>`}
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

function renderAll() {
  renderRuntimes()
  setView(S.view)
  renderTopbar(); renderSessions(); renderSystem(); renderServices(); renderProcs(); renderFeed()
  renderOffice(); renderRoomDetail(); renderDeck(); renderCommand(); renderAgentControl()
  renderBoard(); renderComposio(); renderMemory(); renderAgents(); renderAvatars()
  renderMascot(); renderCrew(); renderCastPicker(); renderRoundtable(); renderArchive()
  renderEdition()
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
