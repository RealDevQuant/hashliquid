/*
  intro.ts — the vault. A round blast door in a concrete wall, the HashLiquid mark on its face, one line under it.
  Click (or Enter) spins the wheel, pulls the bolts, swings the door and flies the camera through into the site.
  Procedural three.js geometry with canvas textures; the only image is the logo. Ported from BUNKERPAD's door.
  Shown once per browser on "/" (force with ?intro=1, skip with ?intro=0, Esc skips).
*/
import * as THREE from 'three'

const TAU = Math.PI * 2
const deg = (d: number) => (d * Math.PI) / 180
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a))
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
const easeIn = (x: number) => x * x * x
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3)
export const INTRO_SECONDS = 4.7

let seed = 7
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, repeat?: [number, number]) {
  const c = document.createElement('canvas'); c.width = c.height = size
  draw(c.getContext('2d')!, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]) }
  return t
}
const concrete = () => canvasTex(1024, (g, s) => {
  g.fillStyle = '#34323c'; g.fillRect(0, 0, s, s)
  for (let i = 0; i < 26000; i++) { const v = 36 + rnd() * 50; g.fillStyle = `rgba(${v},${v - 2},${v + 8},${0.05 + rnd() * 0.12})`; g.fillRect(rnd() * s, rnd() * s, 1 + rnd() * 3, 1 + rnd() * 3) }
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 3
  for (let y = 0; y <= s; y += s / 4) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke() }
  for (let x = 0; x <= s; x += s / 2) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s); g.stroke() }
  g.fillStyle = 'rgba(0,0,0,0.45)'
  for (let y = s / 8; y < s; y += s / 4) for (let x = s / 8; x < s; x += s / 4) { g.beginPath(); g.arc(x, y, 7, 0, TAU); g.fill() }
  for (let i = 0; i < 26; i++) { const x = rnd() * s, w = 8 + rnd() * 34, h = 120 + rnd() * 420, y = rnd() * s; const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, 'rgba(0,0,0,0.2)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x, y, w, h) }
}, [3, 2])
const brushedSteel = () => canvasTex(1024, (g, s) => {
  g.fillStyle = '#8b8d92'; g.fillRect(0, 0, s, s); g.translate(s / 2, s / 2)
  for (let r = 2; r < s * 0.72; r += 1.1) { const v = 120 + rnd() * 70; g.strokeStyle = `rgba(${v},${v},${v + 4},${0.25 + rnd() * 0.35})`; g.lineWidth = 0.7 + rnd(); const a = rnd() * TAU; g.beginPath(); g.arc(0, 0, r, a, a + 1 + rnd() * 4.5); g.stroke() }
  for (let i = 0; i < 60; i++) { g.strokeStyle = `rgba(20,20,22,${0.05 + rnd() * 0.12})`; g.lineWidth = 1 + rnd() * 2; const a = rnd() * TAU, r = rnd() * s * 0.45; g.beginPath(); g.moveTo(Math.cos(a) * r, Math.sin(a) * r); g.lineTo(Math.cos(a) * r + (rnd() - 0.5) * 90, Math.sin(a) * r + (rnd() - 0.5) * 90); g.stroke() }
})
const hazard = () => canvasTex(256, (g, s) => {
  g.fillStyle = '#0c0c0d'; g.fillRect(0, 0, s, s); g.fillStyle = '#9945ff'
  for (const x of [-s, 0, s]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + s / 2, 0); g.lineTo(x + s, s); g.lineTo(x + s / 2, s); g.fill() }
  for (let i = 0; i < 1800; i++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.3})`; g.fillRect(rnd() * s, rnd() * s, 2, 2) }
}, [34, 1])

export interface Api { frame(now: number, t: number | null): number; fit(): void; dispose(): void; state: { t0: number | null; mx: number; my: number; camZ: number; lift: number } }

/** The door. `centre` frames it in the middle of the canvas (the hero); the intro keeps it high, with the line under it. */
export function buildScene(canvas: HTMLCanvasElement, logo: THREE.Texture, opts: { centre?: boolean } = {}): Api {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#000000')
  scene.fog = new THREE.FogExp2('#000000', 0.035)
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120)
  const R = 2.6
  const texConcrete = concrete(), texSteel = brushedSteel(), texHazard = hazard()
  const bump = texConcrete.clone(); bump.colorSpace = THREE.NoColorSpace
  const mConcrete = new THREE.MeshStandardMaterial({ map: texConcrete, bumpMap: bump, bumpScale: 0.6, roughness: 0.96, metalness: 0.02, color: '#b4b0bf' })
  const mSteel = new THREE.MeshStandardMaterial({ map: texSteel, roughness: 0.42, metalness: 0.85, color: '#9a9ca2' })
  const mDark = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.8, color: '#2a2630' })

  const wallShape = new THREE.Shape()
  wallShape.moveTo(-30, -20); wallShape.lineTo(30, -20); wallShape.lineTo(30, 20); wallShape.lineTo(-30, 20); wallShape.closePath()
  const hole = new THREE.Path(); hole.absarc(0, 0, R + 0.02, 0, TAU, true); wallShape.holes.push(hole)
  const wallGeo = new THREE.ExtrudeGeometry(wallShape, { depth: 1.6, bevelEnabled: false, curveSegments: 72 })
  { const uv = wallGeo.attributes.uv, pos = wallGeo.attributes.position; for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / 10, pos.getY(i) / 10 + pos.getZ(i) / 10) }
  const wall = new THREE.Mesh(wallGeo, mConcrete); wall.position.z = -1.6; wall.receiveShadow = true; scene.add(wall)
  const collar = new THREE.Mesh(new THREE.TorusGeometry(R + 0.22, 0.26, 20, 96), mDark); collar.position.z = 0.02; collar.castShadow = true; scene.add(collar)
  const band = new THREE.Mesh(new THREE.RingGeometry(R + 0.52, R + 0.86, 128, 1), new THREE.MeshStandardMaterial({ color: '#5a2fa6', emissive: '#9945ff', emissiveIntensity: 0.35, roughness: 0.7, metalness: 0.2 }))
  band.position.z = 0.012; scene.add(band)
  void texHazard
  const frameBolt = new THREE.CylinderGeometry(0.075, 0.075, 0.12, 6)
  for (let i = 0; i < 24; i++) { const a = (i / 24) * TAU, b = new THREE.Mesh(frameBolt, mSteel); b.position.set(Math.cos(a) * (R + 1.02), Math.sin(a) * (R + 1.02), 0.05); b.rotation.x = Math.PI / 2; scene.add(b) }

  const tunnel = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 26, 64, 1, true), new THREE.MeshStandardMaterial({ map: texConcrete, roughness: 0.85, color: '#4e4a5a', side: THREE.BackSide }))
  tunnel.rotation.x = Math.PI / 2; tunnel.position.z = -14.5; scene.add(tunnel)
  const rings: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>[] = []
  for (let i = 0; i < 7; i++) { const ring = new THREE.Mesh(new THREE.TorusGeometry(R - 0.06, 0.035, 8, 96), new THREE.MeshBasicMaterial({ color: '#c9a6ff', transparent: true, opacity: 0 })); ring.position.z = -3.2 - i * 3.4; scene.add(ring); rings.push(ring) }
  const endWall = new THREE.Mesh(new THREE.CircleGeometry(R, 64), new THREE.MeshBasicMaterial({ color: '#070608', fog: false })); endWall.position.z = -27.2; scene.add(endWall)
  const haloTex = canvasTex(256, (g, s) => { const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); gr.addColorStop(0, 'rgba(220,31,255,0.95)'); gr.addColorStop(0.35, 'rgba(153,69,255,0.4)'); gr.addColorStop(1, 'rgba(153,69,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, s, s) })
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(R * 2.6, R * 2.6), new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, opacity: 0, fog: false, depthWrite: false, blending: THREE.AdditiveBlending })); halo.position.z = -27.1; scene.add(halo)
  const endMark = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), new THREE.MeshBasicMaterial({ map: logo, transparent: true, opacity: 0, fog: false, toneMapped: false })); endMark.position.z = -26.9; scene.add(endMark)
  const inner = new THREE.PointLight('#c9a6ff', 0, 40, 1.4); inner.position.set(0, 0, -5); scene.add(inner)

  const hinge = new THREE.Group(); hinge.position.set(-(R + 0.25), 0, 0.12); scene.add(hinge)
  const door = new THREE.Group(); door.position.set(R + 0.25, 0, 0); hinge.add(door)
  const slab = (r: number, h: number, z: number, mat: THREE.Material = mSteel) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 96), mat); m.rotation.x = Math.PI / 2; m.position.z = z; m.castShadow = true; m.receiveShadow = true; door.add(m); return m }
  slab(R - 0.02, 0.5, -0.1); slab(R - 0.42, 0.14, 0.2, mDark); slab(R - 0.62, 0.2, 0.26); slab(1.42, 0.16, 0.4, mDark)
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU + TAU / 24
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.11, 0.07), mDark); rib.position.set(Math.cos(a) * 1.72, Math.sin(a) * 1.72, 0.38); rib.rotation.z = a; door.add(rib)
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 6), mSteel); nut.position.set(Math.cos(a) * (R - 0.24), Math.sin(a) * (R - 0.24), 0.17); nut.rotation.x = Math.PI / 2; door.add(nut)
  }
  const bolts: THREE.Mesh[] = []
  for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + TAU / 16; const b = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.7, 16), mSteel); b.rotation.z = a - Math.PI / 2; b.userData.a = a; b.castShadow = true; door.add(b); bolts.push(b) }
  const placeBolts = (k: number) => bolts.forEach((b) => { const r = R - 0.02 - k * 0.46; b.position.set(Math.cos(b.userData.a) * r, Math.sin(b.userData.a) * r, -0.1) })
  placeBolts(0)
  for (const y of [1.25, -1.25]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.9, 20), mDark); barrel.position.set(-(R + 0.25), y, 0.12); barrel.castShadow = true; scene.add(barrel)
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.3, 0.14), mDark); arm.position.set(0.55, y, 0.02); hinge.add(arm)
  }
  // the hand wheel: a steel ring with four spokes, and the HashLiquid mark on the door face behind it, glowing
  const wheel = new THREE.Group(); wheel.position.z = 0.66; door.add(wheel)
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.1, 20, 96), mSteel); rim.castShadow = true; wheel.add(rim)
  for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; const knob = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), mSteel); knob.position.set(Math.cos(a) * 1.25, Math.sin(a) * 1.25, 0); wheel.add(knob) }
  // the mark: a dark disc inside the rim with the logo on it, drawn flat and crisp (no spokes, no additive glow over it)
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.12, 64), mDark); disc.rotation.x = Math.PI / 2; disc.position.z = 0.42; door.add(disc)
  const mMark = new THREE.MeshBasicMaterial({ map: logo, transparent: true, alphaTest: 0.05, depthWrite: false, toneMapped: false })
  const mark = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.7), mMark); mark.position.z = 0.49; door.add(mark)
  const markGlow = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 3.0), new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending })); markGlow.position.z = 0.36; door.add(markGlow)

  scene.add(new THREE.HemisphereLight('#d8d2e6', '#000000', 0.05))
  const key = new THREE.SpotLight('#ffffff', 210, 40, deg(21), 0.95, 1.5); key.position.set(3.4, 7.2, 8.5); key.target.position.set(0, 0, 0); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0004; scene.add(key, key.target)
  const rimL = new THREE.SpotLight('#b89cff', 70, 40, deg(24), 1, 1.6); rimL.position.set(-8, 2.5, 4.5); rimL.target.position.set(0, 0, 0); scene.add(rimL, rimL.target)
  const N = 420, dust = new Float32Array(N * 3)
  for (let i = 0; i < N; i++) { dust[i * 3] = (rnd() - 0.5) * 24; dust[i * 3 + 1] = (rnd() - 0.4) * 11; dust[i * 3 + 2] = rnd() * 7 - 0.5 }
  const sprite = canvasTex(64, (g, s) => { const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, s, s) })
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dust, 3))
  const motes = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: '#e6d8ff', map: sprite, size: 0.07, transparent: true, opacity: 0.42, depthWrite: false })); scene.add(motes)

  const state = { t0: null as number | null, mx: 0, my: 0, camZ: 15.2, lift: 0 }
  const fit = () => {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight
    renderer.setSize(w, h, false); camera.aspect = w / h
    state.camZ = (opts.centre ? 13.6 : 17.4) * Math.max(1, 0.68 / camera.aspect)
    state.lift = opts.centre ? 0 : camera.aspect < 0.8 ? -2.2 : -1.2
    ;(scene.fog as THREE.FogExp2).density = 0.035 * 17.4 / state.camZ
    camera.updateProjectionMatrix()
  }
  fit()
  function frame(now: number, t: number | null): number {
    const idle = now / 1000
    motes.rotation.y = idle * 0.012; motes.position.y = Math.sin(idle * 0.2) * 0.12
    let spin = Math.sin(idle * 0.6) * 0.035, bolt = 0, swing = 0, pull = 0, fly = 0, light = 0
    if (t != null) { spin += easeInOut(seg(t, 0, 1.5)) * TAU * 2.25; bolt = easeInOut(seg(t, 1.0, 1.7)); pull = easeOut(seg(t, 1.6, 2.1)); swing = easeInOut(seg(t, 2.0, 3.5)); light = easeOut(seg(t, 2.1, 3.6)); fly = easeIn(seg(t, 2.9, 4.7)) }
    wheel.rotation.z = -spin
    placeBolts(bolt); door.position.z = pull * 0.3; hinge.rotation.y = -swing * 1.92
    inner.intensity = light * 120
    rings.forEach((r, i) => { r.material.opacity = light * (0.9 - i * 0.07) })
    ;(endMark.material as THREE.MeshBasicMaterial).opacity = light; endMark.scale.setScalar(1 + fly * 0.25)
    ;(halo.material as THREE.MeshBasicMaterial).opacity = light * (0.55 + fly * 0.45)
    ;(markGlow.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(idle * 1.4) * 0.05 + (t != null ? seg(t, 0, 0.4) * 0.2 : 0)
    const centre = t != null ? easeInOut(seg(t, 1.9, 3.3)) : 0
    const sy = state.lift * (1 - centre)
    const px = state.mx * 0.55 * (1 - fly), py = sy + (0.25 + state.my * 0.3) * (1 - fly)
    camera.position.set(px, py, state.camZ + (-22 - state.camZ) * fly)
    camera.fov = 38 + fly * 26; camera.updateProjectionMatrix()
    camera.lookAt(0, sy + 0.05 * (1 - fly), -30)
    renderer.toneMappingExposure = 1.05 + light * 0.25
    renderer.render(scene, camera)
    return t != null ? easeIn(seg(t, 3.9, 4.7)) : 0
  }
  function dispose() {
    scene.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : []; mats.forEach((mt) => { const x = mt as THREE.MeshStandardMaterial; x.map?.dispose?.(); x.bumpMap?.dispose?.(); mt.dispose() }) })
    renderer.dispose()
  }
  return { frame, fit, dispose, state }
}

/** Mounts the vault over the page; resolves when it has gone. */
/** Loads the mark and builds the door on `canvas`; the caller runs the frames. */
export function mountDoor(canvas: HTMLCanvasElement, opts: { centre?: boolean } = {}): Promise<Api> {
  return new Promise((ok, no) => new THREE.TextureLoader().load('/logo-1024.png', (logo) => {
    logo.colorSpace = THREE.SRGBColorSpace; logo.anisotropy = 16; logo.minFilter = THREE.LinearMipmapLinearFilter; logo.generateMipmaps = true
    try { ok(buildScene(canvas, logo, opts)) } catch (e) { no(e) }
  }, undefined, no))
}

export function showIntro(): Promise<void> {
  return new Promise((done) => {
    const root = document.createElement('div'); root.className = 'intro'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'HashLiquid')
    root.innerHTML = `<canvas class="intro-canvas"></canvas><div class="intro-flash"></div><div class="intro-ui"><p class="intro-line">Trade perps in <em>bunker mode.</em></p></div>`
    document.body.appendChild(root)
    const canvas = root.querySelector('canvas')!, flash = root.querySelector<HTMLElement>('.intro-flash')!
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden'
    let api: Api | null = null, raf = 0, finished = false, leaving = false
    const leave = () => { if (leaving) return; leaving = true; root.classList.add('is-leaving'); setTimeout(() => { cancelAnimationFrame(raf); api?.dispose(); root.remove(); document.body.style.overflow = prev; window.removeEventListener('resize', onResize); window.removeEventListener('pointermove', onMove); window.removeEventListener('keydown', onKey); done() }, 750) }
    const enter = () => { if (!api || api.state.t0 != null) { if (!api) leave(); return } root.classList.add('is-entering'); if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { leave(); return } api.state.t0 = performance.now() }
    const onResize = () => api?.fit()
    const onMove = (e: PointerEvent) => { if (api) { api.state.mx = (e.clientX / window.innerWidth) * 2 - 1; api.state.my = -((e.clientY / window.innerHeight) * 2 - 1) } }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter() } if (e.key === 'Escape') leave() }
    window.addEventListener('resize', onResize); window.addEventListener('pointermove', onMove); window.addEventListener('keydown', onKey)
    canvas.addEventListener('click', enter)
    new THREE.TextureLoader().load('/logo-1024.png', (logo) => {
      logo.colorSpace = THREE.SRGBColorSpace; logo.anisotropy = 16; logo.minFilter = THREE.LinearMipmapLinearFilter; logo.generateMipmaps = true
      try { api = buildScene(canvas, logo) } catch { leave(); return }
      const loop = (now: number) => {
        const t = api!.state.t0 == null ? null : (now - api!.state.t0) / 1000
        flash.style.opacity = String(api!.frame(now, t))
        if (t != null && t >= INTRO_SECONDS && !finished) { finished = true; leave(); return }
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
    }, undefined, () => leave())
  })
}
