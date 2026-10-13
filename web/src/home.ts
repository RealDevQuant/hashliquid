/*
  The home's motion: dust in the light, the terminal straightening as it scrolls into view, a ledger of keys
  burning one by one, and the floating nav. Everything stops under prefers-reduced-motion and when the tab hides.
*/
const still = matchMedia('(prefers-reduced-motion: reduce)').matches

/** Dust drifting through the beam. */
export function dust(canvas: HTMLCanvasElement) {
  if (still) return
  const ctx = canvas.getContext('2d'); if (!ctx) return
  type P = { x: number; y: number; r: number; vx: number; vy: number; a: number; t: number }
  let w = 0, h = 0, ps: P[] = [], raf = 0, on = true
  const seed = (): P => ({ x: Math.random() * w, y: Math.random() * h, r: 0.6 + Math.random() * 1.4, vx: (Math.random() - 0.5) * 0.12, vy: -0.04 - Math.random() * 0.12, a: 0.15 + Math.random() * 0.5, t: Math.random() * Math.PI * 2 })
  const fit = () => { const r = canvas.getBoundingClientRect(); w = canvas.width = Math.round(r.width); h = canvas.height = Math.round(r.height); ps = Array.from({ length: Math.round((w * h) / 16000) }, seed) }
  const frame = () => {
    if (!on) return
    ctx.clearRect(0, 0, w, h)
    for (const p of ps) {
      p.x += p.vx; p.y += p.vy; p.t += 0.01
      if (p.y < -4 || p.x < -4 || p.x > w + 4) Object.assign(p, seed(), { y: h + 4 })
      const light = Math.max(0, 1 - Math.hypot(p.x - w * 0.5, p.y - h * 0.2) / (h * 0.9))
      ctx.globalAlpha = p.a * (0.35 + 0.65 * light) * (0.6 + 0.4 * Math.sin(p.t))
      ctx.fillStyle = '#cfbcff'
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill()
    }
    raf = requestAnimationFrame(frame)
  }
  fit(); frame()
  addEventListener('resize', fit)
  document.addEventListener('visibilitychange', () => { on = !document.hidden; if (on) frame(); else cancelAnimationFrame(raf) })
}

/** The device lies flat at the top and straightens as it comes up; the mouse tilts it a little. */
export function device(el: HTMLElement) {
  if (still) { el.style.setProperty('--rx', '8deg'); el.style.setProperty('--sc', '1'); return }
  let mx = 0, my = 0
  const place = () => {
    const r = el.getBoundingClientRect(), vh = innerHeight
    const t = Math.min(1, Math.max(0, 1 - (r.top - vh * 0.12) / (vh * 0.55)))   // 0 at the bottom of the screen, 1 once it is high enough
    const flat = innerWidth < 600 ? 14 : 34                                     // a phone has no room for a deep angle
    const rx = flat - (flat - 6) * t + my * 2.5, sc = 0.94 + 0.06 * t
    el.style.setProperty('--rx', `${rx.toFixed(2)}deg`); el.style.setProperty('--ry', `${(mx * 3).toFixed(2)}deg`); el.style.setProperty('--sc', sc.toFixed(3))
  }
  let raf = 0
  const ask = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place) }
  addEventListener('scroll', ask, { passive: true }); addEventListener('resize', ask)
  addEventListener('pointermove', (e) => { mx = (e.clientX / innerWidth) * 2 - 1; my = (e.clientY / innerHeight) * 2 - 1; ask() }, { passive: true })
  place()
}

/** The bunker's drawing: the chain of keys by default, one cube lit after another; the list's rows switch the scene. */
export function scenes(stage: HTMLElement, list: HTMLElement | null) {
  const names = ['keys', 'hash', 'wallet', 'program']
  let current = 'keys', timer = 0, lit = 2
  const show = (name: string) => {
    if (name === current && stage.dataset.scene) return
    current = name; stage.dataset.scene = name
    void import('./iso.ts').then((m) => { m.mount(stage, name); requestAnimationFrame(() => stage.classList.add('drawn')) })
  }
  show('keys')
  if (list) list.querySelectorAll<HTMLElement>('li').forEach((li, i) => { li.addEventListener('pointerenter', () => show(names[i] ?? 'keys')); li.addEventListener('focusin', () => show(names[i] ?? 'keys')) })
  if (still) return
  timer = window.setInterval(() => {
    if (document.hidden || current !== 'keys') return
    const cubes = stage.querySelectorAll<SVGGElement>('.cube.k')
    if (!cubes.length) return
    lit = (lit + 1) % 6
    cubes.forEach((c, i) => { c.classList.toggle('burned', i < lit); c.classList.toggle('now', i === lit); c.classList.toggle('ready', i > lit) })
  }, 1800)
  void timer
}

/** The tape under the hero: the agents' real moves from the public feed, one key burned per move. */
export async function tape(el: HTMLElement) {
  const { fetchFeed } = await import('./agents.ts')
  const feed = await fetchFeed().catch(() => null)
  if (!feed) { el.remove(); return }
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const n = (x: number, d = 2) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
  const items: string[] = []
  const moves = feed.agents.flatMap((a) => (a.moves ?? []).filter((m) => m.kind !== 'hold' && !m.error).map((m) => ({ ...m, who: a.name }))).sort((a, b) => b.t - a.t).slice(0, 24)
  for (const m of moves) {
    const what = m.kind === 'open' ? `${m.side} ${m.size ? n(m.size, 3) + ' ' : ''}${m.market}${m.price ? ' · ' + n(m.price, m.price > 1000 ? 1 : 2) : ''}` : m.kind === 'close' ? `closed ${m.market}` : m.kind === 'cancel' ? `cancelled ${m.market}` : m.kind === 'limit' ? `bid ${m.market}${m.price ? ' · ' + n(m.price, m.price > 1000 ? 1 : 2) : ''}` : `${m.kind} ${m.market}`
    items.push(`<span class="z-move"><b>${esc(m.who)}</b>${esc(what)}<i>key burned</i></span>`)
  }
  if (!items.length) { el.remove(); return }
  const row = items.join('')
  el.innerHTML = `<div class="z-tape-in"><span class="z-tape-tag">Live moves</span><div class="z-tape-track"><div>${row}</div><div aria-hidden="true">${row}</div></div></div>`
}

/** The steps: one open at a time, a bar that fills and moves on; the drawing on the right follows. */
export function accordion(root: HTMLElement) {
  const items = Array.from(root.querySelectorAll<HTMLElement>('.z-step')), stage = root.querySelector<HTMLElement>('.z-step-stage')
  const scenesFor = ['wallet', 'keys', 'program', 'trade']
  let i = 0, timer = 0, paused = false
  const open = (k: number) => {
    i = k
    items.forEach((it, j) => { it.classList.toggle('open', j === k); it.querySelector<HTMLElement>('.bar')?.style.setProperty('animation', 'none'); void it.offsetWidth; it.querySelector<HTMLElement>('.bar')?.style.removeProperty('animation') })
    if (stage) void import('./iso.ts').then((m) => { m.mount(stage, scenesFor[k] ?? 'keys'); requestAnimationFrame(() => stage.classList.add('drawn')) })
  }
  items.forEach((it, k) => { it.addEventListener('click', () => { open(k); restart() }) })
  const tick = () => { if (!paused && !document.hidden) open((i + 1) % items.length) }
  const restart = () => { clearInterval(timer); if (!still) timer = window.setInterval(tick, 5200) }
  root.addEventListener('pointerenter', () => { paused = true }); root.addEventListener('pointerleave', () => { paused = false })
  open(0); restart()
}
