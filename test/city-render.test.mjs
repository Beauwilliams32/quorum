import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* public/city.js is a browser module: it imports three.js from a served vendor
 * path and talks to a canvas. test/runtime-theme.test.mjs already lifts
 * `stateColors()` out of it the same way; this lifts the whole module and binds
 * it to a recording three.js stub, which is enough to assert what the city
 * actually asks the GPU and the DOM to do.
 *
 * What is under test is cost, not looks: the animation loop only runs while the
 * city is visible, a status-only change repaints instead of rebuilding the
 * scene graph, point lights are bounded, and label textures are reused. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const citySrc = fs.readFileSync(path.join(ROOT, 'public/city.js'), 'utf8')

class Vec {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this }
  copy(other) { this.x = other.x; this.y = other.y; this.z = other.z; return this }
}
class Colorish {
  constructor(hex = 0) { this.hex = hex }
  setHex(hex) { this.hex = hex; return this }
}
class Obj3D {
  constructor() { this.children = []; this.position = new Vec(); this.rotation = new Vec(); this.scale = new Vec(); this.userData = {} }
  add(child) { this.children.push(child); return this }
  remove(child) { this.children = this.children.filter(item => item !== child); return this }
  traverse(fn) { fn(this); for (const child of this.children) child.traverse?.(fn) }
  lookAt() {}
}

function threeStub(counters) {
  class Geometry { constructor() { counters.geometries += 1 } dispose() { counters.geometryDisposals += 1 } }
  class Material {
    constructor(options = {}) { counters.materials += 1; Object.assign(this, options); this.color = new Colorish(options.color); this.emissive = new Colorish(options.emissive); this.userData = {} }
    dispose() { counters.materialDisposals += 1; this.disposed = true }
  }
  class Mesh extends Obj3D { constructor(geometry, material) { super(); this.geometry = geometry; this.material = material } }
  const geometry = () => class extends Geometry {}
  return {
    Scene: class extends Obj3D {},
    Group: class extends Obj3D { constructor() { super(); counters.groups += 1 } },
    Mesh,
    Sprite: class extends Obj3D { constructor(material) { super(); this.material = material; counters.sprites += 1 } },
    SpriteMaterial: class extends Material {},
    MeshStandardMaterial: class extends Material {},
    MeshBasicMaterial: class extends Material {},
    CanvasTexture: class { constructor() { counters.textures += 1 } dispose() { counters.textureDisposals += 1; this.disposed = true } },
    PointLight: class extends Obj3D { constructor(color) { super(); counters.pointLights += 1; this.color = new Colorish(color) } },
    HemisphereLight: class extends Obj3D {},
    DirectionalLight: class extends Obj3D { constructor() { super(); this.castShadow = false } },
    GridHelper: class extends Obj3D {},
    FogExp2: class {},
    PerspectiveCamera: class extends Obj3D { updateProjectionMatrix() {} },
    WebGLRenderer: class {
      constructor() { counters.renderers += 1; this.shadowMap = {} }
      setClearColor() {} setPixelRatio() {} setSize() {}
      render() { counters.renders += 1 }
    },
    Raycaster: class { setFromCamera() {} intersectObjects() { return [] } },
    Vector2: Vec, Vector3: Vec,
    BoxGeometry: geometry(), PlaneGeometry: geometry(), RingGeometry: geometry(),
    CylinderGeometry: geometry(), TorusGeometry: geometry(), ConeGeometry: geometry(), CapsuleGeometry: geometry(),
    SRGBColorSpace: 'srgb', PCFSoftShadowMap: 1, DoubleSide: 2,
  }
}

function loadCity() {
  const counters = { renders: 0, renderers: 0, groups: 0, geometries: 0, materials: 0, textures: 0, sprites: 0, pointLights: 0, geometryDisposals: 0, materialDisposals: 0, textureDisposals: 0 }
  let frameQueue = []
  const canvas = {
    width: 800, height: 600,
    parentElement: { clientWidth: 800, clientHeight: 600, classList: { add() {} } },
    addEventListener() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getContext: () => ({ fillRect() {}, strokeRect() {}, fillText() {} }),
  }
  const documentStub = {
    hidden: false,
    addEventListener() {},
    getElementById: id => (id === 'city-canvas' ? canvas : null),
    createElement: () => ({ width: 0, height: 0, getContext: canvas.getContext }),
  }

  const src = citySrc
    .replace(/^import \* as THREE from .*$/m, '')
    .replace(/^import \{ token[^\n]*$/m, '')
  const factory = new Function(
    'THREE', 'token', 'tokenInt', 'tokenAlpha', 'document', 'matchMedia',
    'requestAnimationFrame', 'cancelAnimationFrame', 'devicePixelRatio', 'ResizeObserver',
    `${src.replace(/^export /gm, '')}\nreturn { updateAgentCity, focusCityEntity, setCityRunning, stateColors, counters: null }`)

  const api = factory(
    threeStub(counters),
    name => `token(${name})`,
    name => Math.abs([...name].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 0xffffff,
    () => 'rgba(0,0,0,.5)',
    documentStub,
    () => ({ matches: false, addEventListener() {} }),
    fn => { frameQueue.push(fn); return frameQueue.length },
    () => { frameQueue = [] },
    1,
    class { observe() {} })

  // Drive the animation loop by hand: one call = one frame.
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { const queued = frameQueue; frameQueue = []; for (const fn of queued) fn(i * 16) } }
  return { ...api, counters, tick, pending: () => frameQueue.length, document: documentStub }
}

const building = (id, status = 'monitoring', extra = {}) => ({ id, label: id, entityType: 'building', status, sessionCount: 1, ...extra })
const worker = (id, state = 'idle') => ({ id, label: id, entityType: 'process', state, projectId: 'p1' })
const model = (buildings, workers = []) => ({ buildings, characters: [], workers })

test('the animation loop does not run until the city is the visible view', () => {
  const city = loadCity()
  city.updateAgentCity(model([building('b1')]))
  city.tick(5)
  assert.equal(city.counters.renders, 0, 'a city nobody is looking at renders no frames')

  city.setCityRunning(true)
  city.tick(5)
  assert.equal(city.counters.renders, 5, 'it renders once the Deck is on screen')

  city.setCityRunning(false)
  const drawn = city.counters.renders
  city.tick(5)
  assert.equal(city.counters.renders, drawn, 'and stops again when the view is left')
  assert.equal(city.pending(), 0, 'no frame is left queued')
})

test('the running state survives the lazy import arriving after the view opened', () => {
  const city = loadCity()
  // The Deck asks for the loop before the module has built a scene.
  city.setCityRunning(true)
  city.updateAgentCity(model([building('b1')]))
  city.tick(3)
  assert.equal(city.counters.renders, 3)
})

test('a status-only change repaints in place instead of rebuilding the scene', () => {
  const city = loadCity()
  city.updateAgentCity(model([building('b1'), building('b2')], [worker('w1')]))
  const built = { ...city.counters }

  city.updateAgentCity(model([building('b1', 'failed'), building('b2')], [worker('w1', 'working')]))
  assert.equal(city.counters.geometries, built.geometries, 'no new geometry')
  assert.equal(city.counters.materials, built.materials, 'no new material')
  assert.equal(city.counters.geometryDisposals, 0, 'nothing was thrown away')

  // …and the colours actually moved, to the tokens the palette maps.
  const scene = city.updateAgentCity(model([building('b1', 'failed'), building('b2')], [worker('w1', 'working')]))
  const palette = city.stateColors()
  const b1 = scene.entities.get('b1').userData.parts
  assert.equal(b1.base.material.emissive.hex, palette.failed)
  assert.equal(b1.crown.material.color.hex, palette.failed)
  assert.equal(scene.entities.get('b2').userData.parts.crown.material.color.hex, palette.monitoring)
  assert.equal(scene.entities.get('w1').material.emissive.hex, palette.working)
  assert.equal(scene.entities.get('w1').userData.motion, 'working')

  // A building appearing is a structural change and does rebuild.
  city.updateAgentCity(model([building('b1', 'failed'), building('b2'), building('b3')], [worker('w1', 'working')]))
  assert.ok(city.counters.geometries > built.geometries, 'a new building is a real rebuild')
})

test('an identical model is not re-applied at all', () => {
  const city = loadCity()
  city.updateAgentCity(model([building('b1')]))
  const built = { ...city.counters }
  for (let i = 0; i < 10; i++) city.updateAgentCity(model([building('b1')]))
  assert.deepEqual({ ...city.counters }, built)
})

test('point lights are bounded however many buildings need attention', () => {
  const city = loadCity()
  const many = Array.from({ length: 40 }, (_, i) => building(`b${i}`, 'failed'))
  city.updateAgentCity(model(many))
  assert.ok(city.counters.pointLights > 0, 'a city in trouble still lights up')
  assert.ok(city.counters.pointLights <= 6, `bounded, got ${city.counters.pointLights}`)
})

test('repeated labels reuse one texture instead of painting a canvas each', () => {
  const city = loadCity()
  const twelve = Array.from({ length: 12 }, (_, i) => building(`shared-name-${i % 3}`))
  city.updateAgentCity(model(twelve))
  assert.equal(city.counters.textures, 3, 'twelve buildings, three distinct names, three textures')
  const first = city.counters.textures
  // Rebuild with the same names and one more building: the existing labels
  // come from the cache, only the new one paints a canvas.
  city.updateAgentCity(model([...twelve, building('brand-new')]))
  assert.equal(city.counters.textures, first + 1, 'only the unseen label painted a new texture')
})

test('a label still mounted in the scene is never disposed by the cache', () => {
  // `labelMaterial` evicted FIFO with no liveness check, and a cache HIT
  // returned the existing material without re-inserting it — so a Map kept its
  // ORIGINAL insertion position and the oldest entries were the long-lived,
  // still-rendered buildings rather than the churn. Past the cache limit the
  // texture under a mounted sprite was disposed and that label rendered blank.
  const city = loadCity()
  const LIMIT = 240
  const core = building('core-room')
  const labelOf = scene => {
    const group = scene.entities.get('core-room')
    assert.ok(group, 'the long-lived building is in the scene')
    const sprite = group.children.find(child => child.material?.userData?.shared)
    assert.ok(sprite, 'and it has a label sprite')
    return sprite
  }

  // `core-room` is mounted on the very first build, so it is the oldest entry
  // in the cache — exactly what blind FIFO reaches for first.
  const mounted = labelOf(city.updateAgentCity(model([core])))

  // Now churn well past the cache limit, the way a day-long cockpit session
  // does as the services collector renames the gateway buildings — with
  // `core-room` mounted and on screen the whole time.
  let scene = null
  for (let i = 0; i < LIMIT + 40; i++) scene = city.updateAgentCity(model([core, building(`churn-${i}`)]))

  assert.ok(city.counters.textureDisposals > 0, 'cold labels are still evicted, so this is a liveness check and not a leak')
  assert.equal(mounted.material.disposed, undefined, 'the mounted label material was not freed underneath it')
  assert.equal(mounted.material.map.disposed, undefined, 'nor was its texture, which is what renders blank')
  assert.equal(labelOf(scene).material, mounted.material, 'and the live scene still shares that one material')
})
