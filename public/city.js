import * as THREE from '/vendor/three.module.js'
import { token, tokenInt, tokenAlpha } from './theme.js'

/* The city used to carry thirteen hardcoded state colours and a dozen more
 * hardcoded scene ints, so retheming the UI left the 3D view in the old
 * palette. Every colour below now resolves from public/tokens.css through
 * theme.js at scene construction, which is also why this is a getter and not a
 * frozen constant: the scene is rebuilt on data change, and a future theme
 * switch repaints it on the next rebuild rather than needing a reload.
 *
 * The mapping is the same semantics the rest of the cockpit uses:
 *   accent  = live / in-flight      warn  = needs attention
 *   ok      = healthy / done        error = blocked / failed
 *   purple  = reasoning             muted = idle
 *
 * `active`, `working`, `completed`, `blocked` and `failed` are also mission
 * statuses painted by `.mission-status.*` in public/style.css. The two surfaces
 * sit side by side, so they must resolve the SAME token for a shared status —
 * test/runtime-theme.test.mjs asserts that, which is why `working` is accent
 * (in-flight) here rather than warn (which this legend reserves for "needs
 * attention": `attention` and `recovering`).
 */
export function stateColors() {
  const accent = tokenInt('--accent'), ok = tokenInt('--ok'), warn = tokenInt('--warn')
  const error = tokenInt('--error'), info = tokenInt('--info'), purple = tokenInt('--purple')
  const idle = tokenInt('--muted')
  return {
    monitoring: ok, completed: ok,
    active: accent, working: accent, testing: accent,
    attention: warn, recovering: warn,
    thinking: info, reading: info,
    coding: purple,
    blocked: error, failed: error,
    sleeping: idle,
  }
}
let STATE_COLOR = stateColors()
const MOTION_PROFILE = {
  working: { bob: .1, sway: .015, turn: .0022, phase: .004 }, coding: { bob: .07, sway: .03, turn: .0032, phase: .005 },
  testing: { bob: .045, sway: .02, turn: .0015, phase: .008 }, reading: { bob: .025, sway: .01, turn: .0008, phase: .002 },
  thinking: { bob: .09, sway: .06, turn: .0005, phase: .0013 }, recovering: { bob: .14, sway: .12, turn: .002, phase: .006 },
  monitoring: { bob: .035, sway: .01, turn: .0008, phase: .0017 }, active: { bob: .06, sway: .02, turn: .001, phase: .002 },
  completed: { bob: .02, sway: .01, turn: .0004, phase: .001 }, sleeping: { bob: .012, sway: .004, turn: 0, phase: .0005 },
  blocked: { bob: 0, sway: 0, turn: 0, phase: 0 }, failed: { bob: 0, sway: 0, turn: 0, phase: 0 },
}
let city

// Queried once. `frame()` used to call matchMedia() on every animation frame,
// which is a CSSOM lookup 60 times a second for a value that changes when the
// user changes an OS setting.
const REDUCED_MOTION = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false, addEventListener() {} }

// How many buildings may carry their own point light. Every building used to
// get one, so a 60-building city meant 60 dynamic lights and a shader
// recompile whenever the count changed. The ones that need attention get the
// budget; every other building still shows its status through its emissive
// body and its coloured crown, which is where the colour was legible anyway.
const BEACON_BUDGET = 6

/* Label sprites are a 512x96 canvas each, and the labels repeat: the same
 * project names come back on every rebuild. Materials are cached by text and
 * colour and shared between sprites — `disposeObject` is told to leave shared
 * materials alone, or the next scene would render a blank label. */
const labelMaterials = new Map()
const LABEL_CACHE_LIMIT = 240

function labelMaterial(text, color) {
  const value = String(text || 'UNTITLED').toUpperCase()
  const key = `${value}|${color}`
  const cached = labelMaterials.get(key)
  // A hit is a use. Re-inserting moves it to the back, so the Map's order is a
  // real LRU: without this a hit left the entry where it was first inserted,
  // and the OLDEST entries were the long-lived, still-rendered buildings
  // rather than the churn.
  if (cached) { labelMaterials.delete(key); labelMaterials.set(key, cached); return cached }
  const canvas = document.createElement('canvas')
  canvas.width = 512; canvas.height = 96
  const context = canvas.getContext('2d')
  context.fillStyle = tokenAlpha('--bg0', .86); context.fillRect(0, 0, canvas.width, canvas.height)
  context.strokeStyle = tokenAlpha('--accent', .42); context.lineWidth = 3; context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4)
  context.fillStyle = color; context.font = '600 28px ui-monospace, SFMono-Regular, Menlo, monospace'; context.textAlign = 'center'; context.textBaseline = 'middle'
  context.fillText(value.length > 27 ? `${value.slice(0, 26)}...` : value, 256, 49)
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
  material.userData.shared = true
  material.userData.mounted = 0
  if (labelMaterials.size >= LABEL_CACHE_LIMIT) evictColdestLabel()
  labelMaterials.set(key, material)
  return material
}

/* Evict the least recently used label material that no sprite still has
 * mounted. Eviction used to be blind FIFO with no liveness check, so it freed
 * the texture under a building that was still on screen and that label rendered
 * blank. When every cached label is mounted nothing is evicted and the cache is
 * allowed to grow past its limit: this is a cockpit left open all day, and a
 * bounded overshoot you can measure beats a label that quietly goes empty. */
function evictColdestLabel() {
  for (const [key, material] of labelMaterials) {
    if (material.userData?.mounted > 0) continue
    material.map?.dispose?.(); material.dispose?.()
    labelMaterials.delete(key)
    return true
  }
  return false
}

function disposeObject(object) {
  object.traverse(child => {
    child.geometry?.dispose?.()
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if (!material) continue
      // A shared label material is cached and reused, so disposing it here
      // would blank the next scene's label. Drop this sprite's claim on it
      // instead, which is what tells the cache it may be evicted again.
      if (material.userData?.shared) material.userData.mounted = Math.max(0, (material.userData.mounted || 0) - 1)
      else material.dispose?.()
    }
  })
}

function labelSprite(text, color) {
  const material = labelMaterial(text, color || token('--fg1'))
  material.userData.mounted = (material.userData.mounted || 0) + 1
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(5.2, .98, 1); return sprite
}

class AgentCity {
  constructor(canvas, onSelect) {
    this.canvas = canvas; this.onSelect = onSelect; this.entities = new Map(); this.animated = []; this.pointer = new THREE.Vector2(); this.raycaster = new THREE.Raycaster(); this.drag = null; this.hovered = null; this.selected = null; this.yaw = -.62; this.pitch = .72; this.distance = 52; this.target = new THREE.Vector3(0, 0, 0)
    canvas.parentElement.classList.add('city-ready')
    this.scene = new THREE.Scene(); STATE_COLOR = stateColors(); this.scene.fog = new THREE.FogExp2(tokenInt('--bg0'), .021)
    this.camera = new THREE.PerspectiveCamera(48, 1, .1, 240); this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' }); this.renderer.setClearColor(tokenInt('--bg0'), .82); this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.scene.add(new THREE.HemisphereLight(tokenInt('--info'), tokenInt('--bg0'), 1.45)); const sun = new THREE.DirectionalLight(tokenInt('--fg0'), 2.5); sun.position.set(18, 32, 12); sun.castShadow = true; this.scene.add(sun)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: tokenInt('--bg1'), roughness: .96, metalness: .04 })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; this.scene.add(ground)
    const grid = new THREE.GridHelper(120, 60, tokenInt('--stage-edge'), tokenInt('--bg2')); grid.position.y = .015; this.scene.add(grid)
    const ring = new THREE.Mesh(new THREE.RingGeometry(31, 31.14, 128), new THREE.MeshBasicMaterial({ color: tokenInt('--warn'), transparent: true, opacity: .42, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.y = .035; this.scene.add(ring)
    this.world = new THREE.Group(); this.scene.add(this.world)
    this.running = false; this.raf = null; this.dirty = true
    this.resizeObserver = new ResizeObserver(() => { this.resize(); this.dirty = true }); this.resizeObserver.observe(canvas.parentElement); this.wire(); this.resize()
    // The loop is driven by visibility, not by construction: a city nobody is
    // looking at renders nothing.
    this.onVisibility = () => { if (document.hidden) this.stop(); else if (this.wanted) this.start() }
    document.addEventListener('visibilitychange', this.onVisibility)
    REDUCED_MOTION.addEventListener?.('change', () => { this.dirty = true })
  }
  /** Run the loop while the city is on screen; `wanted` remembers the caller's intent across tab hides. */
  setRunning(on) { this.wanted = on; if (on && !document.hidden) this.start(); else this.stop() }
  start() { if (this.running) return; this.running = true; this.dirty = true; this.raf = requestAnimationFrame(time => this.frame(time)) }
  stop() { this.running = false; if (this.raf != null) cancelAnimationFrame(this.raf); this.raf = null }
  wire() {
    this.canvas.addEventListener('pointerdown', event => { this.drag = { x: event.clientX, y: event.clientY, yaw: this.yaw, pitch: this.pitch, moved: false }; this.canvas.setPointerCapture(event.pointerId) })
    this.canvas.addEventListener('pointermove', event => { if (!this.drag) return; const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y; this.drag.moved ||= Math.abs(dx) + Math.abs(dy) > 5; this.yaw = this.drag.yaw - dx * .006; this.pitch = Math.max(.28, Math.min(1.25, this.drag.pitch + dy * .004)); this.dirty = true })
    this.canvas.addEventListener('pointerup', event => { const moved = this.drag?.moved; this.drag = null; if (!moved) this.pick(event) })
    this.canvas.addEventListener('wheel', event => { event.preventDefault(); this.distance = Math.max(18, Math.min(90, this.distance + event.deltaY * .035)); this.dirty = true }, { passive: false })
    this.canvas.addEventListener('keydown', event => { const step = event.shiftKey ? .2 : .08; if (event.key === 'ArrowLeft') this.yaw += step; if (event.key === 'ArrowRight') this.yaw -= step; if (event.key === 'ArrowUp') this.pitch = Math.max(.28, this.pitch - step); if (event.key === 'ArrowDown') this.pitch = Math.min(1.25, this.pitch + step); if (event.key === '+' || event.key === '=') this.distance = Math.max(18, this.distance - 3); if (event.key === '-') this.distance = Math.min(90, this.distance + 3); this.dirty = true })
  }
  resize() { const host = this.canvas.parentElement, width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight); this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.renderer.setSize(width, height, false) }
  /* Two signatures, not one.
   *
   * `structure` is what decides where things stand and how tall they are;
   * `status` is what decides what colour they are. A collector tick almost
   * always changes only the second, and the whole scene graph used to be
   * disposed and rebuilt from scratch for that — every geometry, material and
   * label texture, several times a minute. Now a status-only change repaints
   * the materials that are already there. */
  setData(model = {}) {
    const buildings = model.buildings || [], characters = model.characters || [], workers = (model.workers || []).slice(0, 90)
    const structure = JSON.stringify([buildings.map(x => [x.id, x.entityType, x.district, x.sessionCount, x.name || x.label || x.id]), characters.map(x => [x.id, x.entityType, x.projectId]), workers.map(x => [x.id, x.entityType, x.projectId])])
    const status = JSON.stringify([buildings.map(x => x.status), characters.map(x => x.state), workers.map(x => x.state)])
    if (structure === this.structure && status === this.status) return
    this.status = status
    if (structure === this.structure) { this.repaint(buildings, characters, workers); this.dirty = true; return }
    this.structure = structure

    disposeObject(this.world); this.scene.remove(this.world); this.world = new THREE.Group(); this.scene.add(this.world); this.entities.clear(); this.animated = []
    this.dirty = true
    // Point lights are per-fragment work, and changing how many there are
    // recompiles every material's shader. Only buildings that need attention
    // get one, and only up to a fixed budget; the rest still show their status
    // through the emissive body and the coloured crown, which is where it was
    // legible anyway.
    let beaconsUsed = 0
    const columns = Math.max(4, Math.ceil(Math.sqrt(buildings.length))), spacing = 7.2
    buildings.forEach((item, index) => { const x = (index % columns - (columns - 1) / 2) * spacing, z = (Math.floor(index / columns) - Math.ceil(buildings.length / columns) / 2) * spacing; const height = 2.6 + Math.min(5.5, Number(item.sessionCount || 0) * .55 + index % 4 * .55); const group = new THREE.Group(); group.position.set(x, 0, z); group.userData.entity = item
      const base = new THREE.Mesh(new THREE.BoxGeometry(5.1, height, 5.1), new THREE.MeshStandardMaterial({ color: item.entityType === 'infrastructure' ? tokenInt('--bg2') : tokenInt('--stage-edge'), emissive: STATE_COLOR[item.status] || tokenInt('--bg1'), emissiveIntensity: .16, roughness: .7, metalness: .25 })); base.position.y = height / 2; base.castShadow = true; base.receiveShadow = true; group.add(base)
      const crown = new THREE.Mesh(new THREE.BoxGeometry(4.35, .16, 4.35), new THREE.MeshBasicMaterial({ color: STATE_COLOR[item.status] || tokenInt('--muted') })); crown.position.y = height + .1; group.add(crown)
      if (item.id === 'building:memory') {
        const archive = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 2.05, 1.4, 12), new THREE.MeshStandardMaterial({ color: tokenInt('--stage-edge'), emissive: tokenInt('--purple'), emissiveIntensity: .28, metalness: .55, roughness: .35 })); archive.position.y = height + .78; group.add(archive)
      } else if (item.district === 'gateways') {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(.12, .22, 2.6, 8), new THREE.MeshStandardMaterial({ color: tokenInt('--warn'), emissive: tokenInt('--warn'), emissiveIntensity: .45 })); mast.position.y = height + 1.35; group.add(mast)
        const signal = new THREE.Mesh(new THREE.TorusGeometry(.7, .055, 8, 28), new THREE.MeshBasicMaterial({ color: tokenInt('--warn') })); signal.position.y = height + 2.35; signal.rotation.x = Math.PI / 2; group.add(signal)
      } else if (index % 3 === 0) {
        const roof = new THREE.Mesh(new THREE.ConeGeometry(1.55, 1.25, 4), new THREE.MeshStandardMaterial({ color: tokenInt('--stage-edge'), roughness: .62 })); roof.position.y = height + .76; roof.rotation.y = Math.PI / 4; group.add(roof)
      } else if (index % 3 === 1) {
        const tower = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.3, 1.7), new THREE.MeshStandardMaterial({ color: tokenInt('--stage-edge'), roughness: .62 })); tower.position.y = height + .72; group.add(tower)
      }
      const label = labelSprite(item.name || item.label || item.id, item.entityType === 'infrastructure' ? token('--warn') : token('--fg0')); label.position.set(0, height + .82, 0); group.add(label)
      group.userData.parts = { base, crown, height }
      if ((item.status === 'attention' || item.status === 'failed') && beaconsUsed < BEACON_BUDGET) {
        beaconsUsed += 1
        const beacon = new THREE.PointLight(STATE_COLOR[item.status] || tokenInt('--ok'), 2.8, 8); beacon.position.set(0, height + .4, 0); group.add(beacon)
        group.userData.parts.beacon = beacon
      }
      this.world.add(group); this.entities.set(item.id, group)
    })
    const projectPosition = projectId => this.entities.get(`building:${projectId}`)?.position || new THREE.Vector3()
    ;[...characters, ...workers].forEach((item, index) => { const anchor = projectPosition(item.projectId); const angle = (index * 2.399) % (Math.PI * 2), radius = 3.4 + index % 4 * .55; const body = new THREE.Mesh(new THREE.CapsuleGeometry(item.entityType === 'agent' ? .34 : .2, item.entityType === 'agent' ? .72 : .38, 4, 8), new THREE.MeshStandardMaterial({ color: item.entityType === 'agent' ? tokenInt('--purple') : tokenInt('--muted'), emissive: STATE_COLOR[item.state] || STATE_COLOR.monitoring, emissiveIntensity: item.state === 'working' ? .65 : .24, roughness: .48 })); body.position.set(anchor.x + Math.cos(angle) * radius, item.entityType === 'agent' ? .75 : .43, anchor.z + Math.sin(angle) * radius); body.userData.baseY = body.position.y; body.userData.baseX = body.position.x; body.userData.motion = item.state || 'monitoring'; body.castShadow = true; body.userData.entity = item; this.world.add(body); this.entities.set(item.id, body); this.animated.push(body) })
  }
  /** Same buildings, new statuses: recolour what is already in the scene. */
  repaint(buildings, characters, workers) {
    for (const item of buildings) {
      const parts = this.entities.get(item.id)?.userData.parts
      if (!parts) continue
      const colour = STATE_COLOR[item.status] ?? tokenInt('--bg1')
      parts.base.material.emissive.setHex(colour)
      parts.crown.material.color.setHex(STATE_COLOR[item.status] ?? tokenInt('--muted'))
      if (parts.beacon) parts.beacon.color.setHex(colour)
    }
    for (const item of [...characters, ...workers]) {
      const body = this.entities.get(item.id)
      if (!body?.material) continue
      body.material.emissive.setHex(STATE_COLOR[item.state] ?? STATE_COLOR.monitoring)
      body.material.emissiveIntensity = item.state === 'working' ? .65 : .24
      body.userData.motion = item.state || 'monitoring'
      body.userData.entity = item
    }
  }
  focus(id) { const object = this.entities.get(id); if (!object) return false; this.selected = object; this.target.copy(object.position); this.target.y = 1.4; this.distance = Math.min(this.distance, 22); this.dirty = true; return true }
  pick(event) { const rect = this.canvas.getBoundingClientRect(); this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1); this.raycaster.setFromCamera(this.pointer, this.camera); const hit = this.raycaster.intersectObjects(this.world.children, true).find(item => item.object.userData.entity || item.object.parent?.userData.entity); const entity = hit?.object.userData.entity || hit?.object.parent?.userData.entity; if (entity) this.onSelect?.(entity) }
  frame(time = 0) {
    if (!this.running) return
    this.raf = requestAnimationFrame(value => this.frame(value))
    const reduced = REDUCED_MOTION.matches
    // Reduced motion and nothing moved: there is no new pixel to draw.
    if (reduced && !this.dirty) return
    this.dirty = false
    if (!reduced) this.animated.forEach((item, index) => { const motion = item.userData.motion; const profile = MOTION_PROFILE[motion] || MOTION_PROFILE.monitoring; item.position.y = item.userData.baseY + Math.sin(time * profile.phase + index) * profile.bob; item.position.x = item.userData.baseX + Math.sin(time * profile.phase * 1.3 + index) * profile.sway; item.rotation.y += profile.turn; item.rotation.z = Math.sin(time * profile.phase * .7 + index) * Math.min(.025, profile.sway * .35) }); const horizontal = Math.cos(this.pitch) * this.distance; this.camera.position.set(this.target.x + Math.sin(this.yaw) * horizontal, this.target.y + Math.sin(this.pitch) * this.distance, this.target.z + Math.cos(this.yaw) * horizontal); this.camera.lookAt(this.target); this.renderer.render(this.scene, this.camera) }
}

// Remembered across the lazy import: the Deck can ask for the loop before the
// scene exists, because the module itself only arrives when the view is opened.
let wantRunning = false

/** Run the animation loop only while the city is the visible view. */
export function setCityRunning(on) { wantRunning = on; city?.setRunning(on) }

export function updateAgentCity(model, { onSelect } = {}) {
  const canvas = document.getElementById('city-canvas'); if (!canvas) return null
  if (!city) { city = new AgentCity(canvas, onSelect); city.setRunning(wantRunning) } else city.onSelect = onSelect
  city.setData(model); return city
}

export function focusCityEntity(id) { return city?.focus(id) || false }
