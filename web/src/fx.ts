/*
  The site's touch: things light up under the pointer, buttons pull toward it and ripple when pressed, each section
  announces itself with a beam running along its top edge, the hero's words come into focus one by one and the
  numbers count up. All of it is decoration: nothing here changes what a page does, and it all stands down under
  prefers-reduced-motion.
*/
const still = matchMedia('(prefers-reduced-motion: reduce)').matches
const wired = new Set<string>()   // each listener goes on the document once, however often a page re-renders

/** Cards and rows that light up where the pointer is: the glow follows --mx/--my, the CSS draws it. */
export const SPOT = '.z-key, .z-agent, .z-seal, .z-steps li, .z-list li, .ag-card, .dp-opt, .dp-tab, .dp-card, .acct-card, .l-card, .gate-card, .z-badge, .hire-row, .ag-open, .chat-line, .agent-line'
export function spotlight() {
  if (still || wired.has('spot')) return
  wired.add('spot')
  document.addEventListener('pointermove', (e) => {
    const el = (e.target as Element | null)?.closest?.(SPOT) as HTMLElement | null
    if (!el) return
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${(e.clientX - r.left).toFixed(0)}px`)
    el.style.setProperty('--my', `${(e.clientY - r.top).toFixed(0)}px`)
  }, { passive: true })
}

/** Buttons lean toward the pointer a little and ripple from the point you press. */
export function buttons() {
  if (still || wired.has('btn')) return
  wired.add('btn')
  const BTN = '.btn:not(.bracket), #app button:not(.chip):not(.iv):not(.tab):not(.t-market):not(.dp-opt):not(.dp-tab)'
  document.addEventListener('pointermove', (e) => {
    const b = (e.target as Element | null)?.closest?.(BTN) as HTMLElement | null
    if (!b || b.matches(':disabled')) return
    const r = b.getBoundingClientRect()
    const dx = (e.clientX - (r.left + r.width / 2)) / r.width, dy = (e.clientY - (r.top + r.height / 2)) / r.height
    b.style.setProperty('--px', `${(dx * 6).toFixed(1)}px`); b.style.setProperty('--py', `${(dy * 4).toFixed(1)}px`)
    b.classList.add('lean')
  }, { passive: true })
  document.addEventListener('pointerout', (e) => {
    const b = (e.target as Element | null)?.closest?.(BTN) as HTMLElement | null
    if (b && !b.contains(e.relatedTarget as Node | null)) { b.classList.remove('lean'); b.style.removeProperty('--px'); b.style.removeProperty('--py') }
  })
  document.addEventListener('pointerdown', (e) => {
    const b = (e.target as Element | null)?.closest?.(BTN) as HTMLElement | null
    if (!b) return
    const r = b.getBoundingClientRect(), s = document.createElement('i')
    s.className = 'ripple'; s.style.left = `${e.clientX - r.left}px`; s.style.top = `${e.clientY - r.top}px`
    b.appendChild(s); setTimeout(() => s.remove(), 700)
  })
}

/** Each section lights its top edge as it arrives; the words of a title come into focus one after the other. */
export function sections(root: ParentNode = document) {
  const secs = Array.from(root.querySelectorAll<HTMLElement>('.z-manifesto, .z-prod, .z-steps, .z-end, .docs section, .ag-sec'))
  if (!secs.length || still) return
  const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { e.target.classList.add('lit'); io.unobserve(e.target) } }, { threshold: 0.12 })
  secs.forEach((s) => io.observe(s))
}
export function words(el: HTMLElement) {
  if (still) return
  let i = 0
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) {
        const parts = (c.textContent ?? '').split(/(\s+)/)
        const frag = document.createDocumentFragment()
        for (const p of parts) {
          if (!p) continue
          if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(p)); continue }
          const s = document.createElement('span'); s.className = 'w'; s.style.setProperty('--i', String(i++)); s.textContent = p; frag.appendChild(s)
        }
        c.replaceWith(frag)
      } else if (c.nodeType === Node.ELEMENT_NODE) walk(c)
    }
  }
  walk(el); el.classList.add('words')
}

/** Numbers count up to what they say when they come into view (the metrics). */
export function countUp(root: ParentNode = document) {
  if (still) return
  const els = Array.from(root.querySelectorAll<HTMLElement>('.metrics b'))
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue
      io.unobserve(e.target)
      const el = e.target as HTMLElement, text = el.textContent ?? ''
      const m = text.match(/^([^\d]*)([\d,]+)(\.\d+)?(.*)$/); if (!m) continue
      const [, pre, int, dec = '', post] = m, target = Number(int.replace(/,/g, '')), decimals = dec.length ? dec.length - 1 : 0
      const t0 = performance.now(), dur = 1100
      const tick = (now: number) => {
        const t = Math.min(1, (now - t0) / dur), v = target * (1 - Math.pow(1 - t, 3))
        el.textContent = `${pre}${Math.round(v).toLocaleString('en-US')}${decimals ? (t < 1 ? '.' + '0'.repeat(decimals) : dec) : ''}${post}`
        if (t < 1) requestAnimationFrame(tick); else el.textContent = text
      }
      requestAnimationFrame(tick)
    }
  }, { threshold: 0.4 })
  els.forEach((el) => io.observe(el))
}

/** The chain behind the page: cubes turning slowly in drifting chains, blocks travelling along the links, a ripple
    when a new one lands; barely there, and lit, faster and cross-linked where the pointer is. */
export function chainField() {
  if (wired.has('chain')) return
  wired.add('chain')
  const canvas = document.createElement('canvas'); canvas.className = 'chainfield'; canvas.setAttribute('aria-hidden', 'true')
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d'); if (!ctx) return
  type N = { x: number; y: number; bx: number; by: number; ph: number; sp: number; amp: number; a: number; av: number; tilt: number }
  type C = { nodes: N[]; travellers: number[]; speed: number }
  type Rip = { x: number; y: number; t0: number }
  let W = 0, H = 0, dpr = 1, chains: C[] = [], rips: Rip[] = [], raf = 0, on = true, last = 0, nextRip = 0
  let mx = -9999, my = -9999
  const R = 280
  const build = () => {
    const r = canvas.getBoundingClientRect(); dpr = Math.min(devicePixelRatio || 1, 1.5)
    W = r.width; H = r.height; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const count = Math.max(5, Math.round(H / 150)), per = Math.max(8, Math.round(W / 100))
    chains = Array.from({ length: count }, (_, i) => {
      const y0 = ((i + 0.5) / count) * H + (Math.random() - 0.5) * 60, wave = 30 + Math.random() * 70, k = 0.6 + Math.random() * 1.2, off = Math.random() * Math.PI * 2
      const nodes: N[] = Array.from({ length: per }, (__, j) => {
        const t = (j + Math.random() * 0.4) / (per - 1)
        const bx = -40 + t * (W + 80), by = y0 + Math.sin(t * Math.PI * 2 * k + off) * wave
        return { x: bx, y: by, bx, by, ph: Math.random() * Math.PI * 2, sp: 0.15 + Math.random() * 0.25, amp: 4 + Math.random() * 8, a: Math.random() * Math.PI * 2, av: (0.15 + Math.random() * 0.25) * (Math.random() < 0.5 ? -1 : 1), tilt: 0.4 + Math.random() * 0.35 }
      })
      return { nodes, travellers: [Math.random(), Math.random()], speed: 0.02 + Math.random() * 0.025 }
    })
  }
  /** A wireframe cube of half-size h at (x, y), turned by a around its axis and tilted; lit blends it toward purple. */
  const cube = (x: number, y: number, h: number, a: number, tilt: number, lit: number) => {
    const ca = Math.cos(a), sa = Math.sin(a), ct = Math.cos(tilt), st = Math.sin(tilt)
    const P: [number, number, number][] = []
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const X = sx * h, Y = sy * h, Z = sz * h
      const x1 = X * ca - Z * sa, z1 = X * sa + Z * ca          // turn around the vertical axis
      const y2 = Y * ct - z1 * st, z2 = Y * st + z1 * ct         // then tip toward the viewer
      P.push([x + x1, y + y2, z2])
    }
    const E = [[0,1],[0,2],[1,3],[2,3],[4,5],[4,6],[5,7],[6,7],[0,4],[1,5],[2,6],[3,7]]
    for (const [i, j] of E) {
      const front = (P[i][2] + P[j][2]) / 2 > 0
      const al = (front ? 0.16 : 0.07) + lit * (front ? 0.8 : 0.45)
      ctx.strokeStyle = lit > 0.01 ? `rgba(${Math.round(255 - 95 * lit)}, ${Math.round(255 - 170 * lit)}, 255, ${al.toFixed(3)})` : `rgba(255, 255, 255, ${al.toFixed(3)})`
      ctx.lineWidth = front ? 1 + lit * 0.6 : 0.8
      ctx.beginPath(); ctx.moveTo(P[i][0], P[i][1]); ctx.lineTo(P[j][0], P[j][1]); ctx.stroke()
    }
    if (lit > 0.05) { ctx.fillStyle = `rgba(153, 69, 255, ${(lit * 0.22).toFixed(3)})`; ctx.beginPath(); ctx.arc(x, y, h * 1.1, 0, Math.PI * 2); ctx.fill() }
  }
  const frame = (now: number) => {
    if (!on) return
    const t = now / 1000, dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016; last = now
    ctx.clearRect(0, 0, W, H)
    for (const c of chains) {
      for (const n of c.nodes) {
        n.x = n.bx + Math.sin(t * n.sp + n.ph) * n.amp; n.y = n.by + Math.cos(t * n.sp * 0.8 + n.ph) * n.amp * 0.6
        const f = Math.max(0, 1 - Math.hypot(n.x - mx, n.y - my) / R)
        n.a += n.av * dt * (1 + f * f * 7)                                   // the cubes turn, and spin up under the pointer
      }
      for (let i = 0; i < c.nodes.length - 1; i++) {
        const a = c.nodes[i], b = c.nodes[i + 1]
        const d = Math.hypot((a.x + b.x) / 2 - mx, (a.y + b.y) / 2 - my), f = Math.max(0, 1 - d / R), lit = f * f
        ctx.strokeStyle = lit > 0.01 ? `rgba(${Math.round(255 - 102 * lit)}, ${Math.round(255 - 186 * lit)}, 255, ${(0.05 + 0.75 * lit).toFixed(3)})` : 'rgba(255, 255, 255, 0.05)'
        ctx.lineWidth = 1 + lit
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      }
      // blocks travelling down the chain; when one reaches the end, a ripple
      c.travellers = c.travellers.map((p) => {
        const q = p + c.speed * dt * (1 + (() => { const i = Math.floor(p * (c.nodes.length - 1)); const n = c.nodes[Math.min(i, c.nodes.length - 1)]; const f = Math.max(0, 1 - Math.hypot(n.x - mx, n.y - my) / R); return f * f * 3 })())
        if (q >= 1) { const e = c.nodes[c.nodes.length - 1]; rips.push({ x: e.x, y: e.y, t0: now }); return 0 }
        return q
      })
      for (const p of c.travellers) {
        const s = p * (c.nodes.length - 1), i = Math.floor(s), a = c.nodes[i], b = c.nodes[Math.min(i + 1, c.nodes.length - 1)], q = s - i
        const px = a.x + (b.x - a.x) * q, py = a.y + (b.y - a.y) * q
        const f = Math.max(0, 1 - Math.hypot(px - mx, py - my) / R)
        cube(px, py, 2.2 + f * 1.2, t * 2.2 + p * 9, 0.6, 0.35 + f * 0.65)
      }
      for (const n of c.nodes) {
        const f = Math.max(0, 1 - Math.hypot(n.x - mx, n.y - my) / R), lit = f * f
        cube(n.x, n.y, 3.6 + lit * 2.4, n.a, n.tilt, lit)
      }
    }
    // the ripples: a ring that opens and fades
    if (now > nextRip) { const c = chains[Math.floor(Math.random() * chains.length)]; if (c) { const n = c.nodes[Math.floor(Math.random() * c.nodes.length)]; rips.push({ x: n.x, y: n.y, t0: now }) } nextRip = now + 1800 + Math.random() * 2600 }
    rips = rips.filter((r) => now - r.t0 < 1400)
    for (const r of rips) {
      const k = (now - r.t0) / 1400, f = Math.max(0, 1 - Math.hypot(r.x - mx, r.y - my) / R)
      ctx.strokeStyle = `rgba(176, 140, 255, ${((1 - k) * (0.22 + f * 0.5)).toFixed(3)})`; ctx.lineWidth = 1
      ctx.beginPath(); ctx.arc(r.x, r.y, 6 + k * 46, 0, Math.PI * 2); ctx.stroke()
    }
    // where the pointer is, the chains find each other
    if (mx > -999) {
      const near: N[] = []
      for (const c of chains) for (const n of c.nodes) if (Math.hypot(n.x - mx, n.y - my) < R) near.push(n)
      for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
        const a = near[i], b = near[j], d = Math.hypot(a.x - b.x, a.y - b.y)
        if (d > 150 || d < 20) continue
        const f = (1 - d / 150) * Math.max(0, 1 - Math.hypot((a.x + b.x) / 2 - mx, (a.y + b.y) / 2 - my) / R)
        ctx.strokeStyle = `rgba(176, 140, 255, ${(f * 0.5).toFixed(3)})`; ctx.lineWidth = 1
        ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([])
      }
    }
    raf = requestAnimationFrame(frame)
  }
  build(); frame(performance.now())
  addEventListener('resize', build)
  addEventListener('pointermove', (e) => { mx = e.clientX; my = e.clientY }, { passive: true })
  document.addEventListener('pointerleave', () => { mx = -9999; my = -9999 })
  document.addEventListener('visibilitychange', () => { on = !document.hidden; if (on) { last = 0; frame(performance.now()) } else cancelAnimationFrame(raf) })
  if (still) { cancelAnimationFrame(raf); on = false; frame(0) }
}

/** Everything, once the page is there. New content (the wizard re-renders) is covered by the CSS selectors alone. */
export function all() {
  spotlight(); buttons(); sections(); chainField()
  const h1 = document.querySelector<HTMLElement>('.z-hero h1')
  if (h1) { const go = () => { if (document.documentElement.classList.contains('intro-wait')) setTimeout(go, 150); else words(h1) }; go() }
  const metrics = document.getElementById('home-metrics')
  if (metrics) new MutationObserver(() => countUp(metrics)).observe(metrics, { childList: true })
  countUp()
}
