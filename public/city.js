import * as THREE from '/vendor/three.module.js'

const STATE_COLOR = { monitoring: 0x56d6b3, active: 0x56d6b3, working: 0xf2c15c, thinking: 0x8cb8ff, reading: 0x8cb8ff, coding: 0x9b8cff, testing: 0x55c8e8, attention: 0xffbd59, blocked: 0xff7a6e, failed: 0xff5d67, recovering: 0xf29d5c, sleeping: 0x596270, completed: 0x75d59a }
let city

function disposeObject(object) {
  object.traverse(child => { child.geometry?.dispose?.(); if (Array.isArray(child.material)) child.material.forEach(item => item.dispose?.()); else child.material?.dispose?.() })
}

function labelSprite(text, color = '#d9e4ea') {
  const canvas = document.createElement('canvas')
  canvas.width = 512; canvas.height = 96
  const context = canvas.getContext('2d')
  context.fillStyle = 'rgba(5, 8, 13, .86)'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.strokeStyle = 'rgba(86, 214, 179, .42)'; context.lineWidth = 3; context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4)
  context.fillStyle = color; context.font = '600 28px ui-monospace, SFMono-Regular, Menlo, monospace'; context.textAlign = 'center'; context.textBaseline = 'middle'
  const value = String(text || 'UNTITLED').toUpperCase(); context.fillText(value.length > 27 ? `${value.slice(0, 26)}...` : value, 256, 49)
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }))
  sprite.scale.set(5.2, .98, 1); return sprite
}

class AgentCity {
  constructor(canvas, onSelect) {
    this.canvas = canvas; this.onSelect = onSelect; this.entities = new Map(); this.animated = []; this.pointer = new THREE.Vector2(); this.raycaster = new THREE.Raycaster(); this.drag = null; this.hovered = null; this.selected = null; this.yaw = -.62; this.pitch = .72; this.distance = 52; this.target = new THREE.Vector3(0, 0, 0)
    canvas.parentElement.classList.add('city-ready')
    this.scene = new THREE.Scene(); this.scene.fog = new THREE.FogExp2(0x080a0f, .021)
    this.camera = new THREE.PerspectiveCamera(48, 1, .1, 240); this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' }); this.renderer.setClearColor(0x080a0f, .82); this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.scene.add(new THREE.HemisphereLight(0xa8d8ff, 0x19131e, 1.45)); const sun = new THREE.DirectionalLight(0xffe2b4, 2.5); sun.position.set(18, 32, 12); sun.castShadow = true; this.scene.add(sun)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: 0x10151b, roughness: .96, metalness: .04 })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; this.scene.add(ground)
    const grid = new THREE.GridHelper(120, 60, 0x284252, 0x17232d); grid.position.y = .015; this.scene.add(grid)
    const ring = new THREE.Mesh(new THREE.RingGeometry(31, 31.14, 128), new THREE.MeshBasicMaterial({ color: 0xe3b64f, transparent: true, opacity: .42, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.y = .035; this.scene.add(ring)
    this.world = new THREE.Group(); this.scene.add(this.world)
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(canvas.parentElement); this.wire(); this.resize(); this.frame()
  }
  wire() {
    this.canvas.addEventListener('pointerdown', event => { this.drag = { x: event.clientX, y: event.clientY, yaw: this.yaw, pitch: this.pitch, moved: false }; this.canvas.setPointerCapture(event.pointerId) })
    this.canvas.addEventListener('pointermove', event => { if (!this.drag) return; const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y; this.drag.moved ||= Math.abs(dx) + Math.abs(dy) > 5; this.yaw = this.drag.yaw - dx * .006; this.pitch = Math.max(.28, Math.min(1.25, this.drag.pitch + dy * .004)) })
    this.canvas.addEventListener('pointerup', event => { const moved = this.drag?.moved; this.drag = null; if (!moved) this.pick(event) })
    this.canvas.addEventListener('wheel', event => { event.preventDefault(); this.distance = Math.max(18, Math.min(90, this.distance + event.deltaY * .035)) }, { passive: false })
    this.canvas.addEventListener('keydown', event => { const step = event.shiftKey ? .2 : .08; if (event.key === 'ArrowLeft') this.yaw += step; if (event.key === 'ArrowRight') this.yaw -= step; if (event.key === 'ArrowUp') this.pitch = Math.max(.28, this.pitch - step); if (event.key === 'ArrowDown') this.pitch = Math.min(1.25, this.pitch + step); if (event.key === '+' || event.key === '=') this.distance = Math.max(18, this.distance - 3); if (event.key === '-') this.distance = Math.min(90, this.distance + 3) })
  }
  resize() { const host = this.canvas.parentElement, width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight); this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.renderer.setSize(width, height, false) }
  setData(model = {}) {
    const signature = JSON.stringify([(model.buildings || []).map(x => [x.id, x.status, x.sessionCount]), (model.characters || []).map(x => [x.id, x.state, x.projectId]), (model.workers || []).map(x => [x.id, x.state])])
    if (signature === this.signature) return; this.signature = signature
    disposeObject(this.world); this.scene.remove(this.world); this.world = new THREE.Group(); this.scene.add(this.world); this.entities.clear(); this.animated = []
    const buildings = model.buildings || [], columns = Math.max(4, Math.ceil(Math.sqrt(buildings.length))), spacing = 7.2
    buildings.forEach((item, index) => { const x = (index % columns - (columns - 1) / 2) * spacing, z = (Math.floor(index / columns) - Math.ceil(buildings.length / columns) / 2) * spacing; const height = 2.6 + Math.min(5.5, Number(item.sessionCount || 0) * .55 + index % 4 * .55); const group = new THREE.Group(); group.position.set(x, 0, z); group.userData.entity = item
      const base = new THREE.Mesh(new THREE.BoxGeometry(5.1, height, 5.1), new THREE.MeshStandardMaterial({ color: item.entityType === 'infrastructure' ? 0x34294a : 0x20303a, emissive: STATE_COLOR[item.status] || 0x14202a, emissiveIntensity: .16, roughness: .7, metalness: .25 })); base.position.y = height / 2; base.castShadow = true; base.receiveShadow = true; group.add(base)
      const crown = new THREE.Mesh(new THREE.BoxGeometry(4.35, .16, 4.35), new THREE.MeshBasicMaterial({ color: STATE_COLOR[item.status] || 0x6f8392 })); crown.position.y = height + .1; group.add(crown)
      if (item.id === 'building:memory') {
        const archive = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 2.05, 1.4, 12), new THREE.MeshStandardMaterial({ color: 0x263e43, emissive: 0x56d6b3, emissiveIntensity: .28, metalness: .55, roughness: .35 })); archive.position.y = height + .78; group.add(archive)
      } else if (item.district === 'gateways') {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(.12, .22, 2.6, 8), new THREE.MeshStandardMaterial({ color: 0xd0a847, emissive: 0xe0b24d, emissiveIntensity: .45 })); mast.position.y = height + 1.35; group.add(mast)
        const signal = new THREE.Mesh(new THREE.TorusGeometry(.7, .055, 8, 28), new THREE.MeshBasicMaterial({ color: 0xe0b24d })); signal.position.y = height + 2.35; signal.rotation.x = Math.PI / 2; group.add(signal)
      } else if (index % 3 === 0) {
        const roof = new THREE.Mesh(new THREE.ConeGeometry(1.55, 1.25, 4), new THREE.MeshStandardMaterial({ color: 0x29464b, roughness: .62 })); roof.position.y = height + .76; roof.rotation.y = Math.PI / 4; group.add(roof)
      } else if (index % 3 === 1) {
        const tower = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.3, 1.7), new THREE.MeshStandardMaterial({ color: 0x29464b, roughness: .62 })); tower.position.y = height + .72; group.add(tower)
      }
      const label = labelSprite(item.name || item.label || item.id, item.entityType === 'infrastructure' ? '#e7c46a' : '#d8f5ec'); label.position.set(0, height + .82, 0); group.add(label)
      const beacon = new THREE.PointLight(STATE_COLOR[item.status] || 0x56d6b3, item.status === 'attention' || item.status === 'failed' ? 2.8 : .8, 8); beacon.position.set(0, height + .4, 0); group.add(beacon)
      this.world.add(group); this.entities.set(item.id, group)
    })
    const projectPosition = projectId => this.entities.get(`building:${projectId}`)?.position || new THREE.Vector3()
    ;[...(model.characters || []), ...(model.workers || []).slice(0, 90)].forEach((item, index) => { const anchor = projectPosition(item.projectId); const angle = (index * 2.399) % (Math.PI * 2), radius = 3.4 + index % 4 * .55; const body = new THREE.Mesh(new THREE.CapsuleGeometry(item.entityType === 'agent' ? .34 : .2, item.entityType === 'agent' ? .72 : .38, 4, 8), new THREE.MeshStandardMaterial({ color: item.entityType === 'agent' ? 0x9b8cff : 0x607786, emissive: STATE_COLOR[item.state] || STATE_COLOR.monitoring, emissiveIntensity: item.state === 'working' ? .65 : .24, roughness: .48 })); body.position.set(anchor.x + Math.cos(angle) * radius, item.entityType === 'agent' ? .75 : .43, anchor.z + Math.sin(angle) * radius); body.userData.baseY = body.position.y; body.userData.baseX = body.position.x; body.userData.motion = item.state || 'monitoring'; body.castShadow = true; body.userData.entity = item; this.world.add(body); this.entities.set(item.id, body); this.animated.push(body) })
  }
  focus(id) { const object = this.entities.get(id); if (!object) return false; this.selected = object; this.target.copy(object.position); this.target.y = 1.4; this.distance = Math.min(this.distance, 22); return true }
  pick(event) { const rect = this.canvas.getBoundingClientRect(); this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1); this.raycaster.setFromCamera(this.pointer, this.camera); const hit = this.raycaster.intersectObjects(this.world.children, true).find(item => item.object.userData.entity || item.object.parent?.userData.entity); const entity = hit?.object.userData.entity || hit?.object.parent?.userData.entity; if (entity) this.onSelect?.(entity) }
  frame(time = 0) { requestAnimationFrame(value => this.frame(value)); const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; if (!reduced) this.animated.forEach((item, index) => { const motion = item.userData.motion; const speed = ['working', 'coding', 'testing', 'recovering'].includes(motion) ? .004 : ['blocked', 'failed', 'sleeping'].includes(motion) ? 0 : .0017; item.position.y = item.userData.baseY + (speed ? Math.sin(time * speed + index) * (motion === 'recovering' ? .14 : .06) : 0); item.position.x = item.userData.baseX + (motion === 'recovering' ? Math.sin(time * .006 + index) * .07 : 0); item.rotation.y += speed * .55 }); const horizontal = Math.cos(this.pitch) * this.distance; this.camera.position.set(this.target.x + Math.sin(this.yaw) * horizontal, this.target.y + Math.sin(this.pitch) * this.distance, this.target.z + Math.cos(this.yaw) * horizontal); this.camera.lookAt(this.target); this.renderer.render(this.scene, this.camera) }
}

export function updateAgentCity(model, { onSelect } = {}) {
  const canvas = document.getElementById('city-canvas'); if (!canvas) return null
  if (!city) city = new AgentCity(canvas, onSelect); else city.onSelect = onSelect
  city.setData(model); return city
}

export function focusCityEntity(id) { return city?.focus(id) || false }
