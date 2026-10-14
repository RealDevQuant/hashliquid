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

/** The chain behind the page: blocks linked in drifting chains, barely there, lit and cross-linked where the pointer is. */
export function chainField() {
  if (wired.has('chain')) return
  wired.add('chain')
  const canvas = document.createElement('canvas'); canvas.className = 'chainfield'; canvas.setAttribute('aria-hidden', 'true')
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d'); if (!ctx) return
  type N = { x: number; y: number; bx: number; by: number; ph: number; sp: number; amp: number }
  type C = { nodes: N[]; pulse: number; speed: number }
  let W = 0, H = 0, dpr = 1, chains: C[] = [], raf = 0, on = true
  let mx = -9999, my = -9999
  const R = 260
  const build = () => {
    const r = canvas.getBoundingClientRect(); dpr = Math.min(devicePixelRatio || 1, 1.5)
    W = r.width; H = r.height; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const count = Math.max(5, Math.round(H / 150)), per = Math.max(8, Math.round(W / 95))
    chains = Array.from({ length: count }, (_, i) => {
      const y0 = ((i + 0.5) / count) * H + (Math.random() - 0.5) * 60, wave = 30 + Math.random() * 70, k = 0.6 + Math.random() * 1.2, off = Math.random() * Math.PI * 2
      const nodes: N[] = Array.from({ length: per }, (__, j) => {
        const t = (j + Math.random() * 0.4) / (per - 1)
        const bx = -40 + t * (W + 80), by = y0 + Math.sin(t * Math.PI * 2 * k + off) * wave
        return { x: bx, y: by, bx, by, ph: Math.random() * Math.PI * 2, sp: 0.15 + Math.random() * 0.25, amp: 4 + Math.random() * 8 }
      })
      return { nodes, pulse: Math.random(), speed: 0.018 + Math.random() * 0.02 }
    })
  }
  const frame = (now: number) => {
    if (!on) return
    const t = now / 1000
    ctx.clearRect(0, 0, W, H)
    for (const c of chains) {
      for (const n of c.nodes) { n.x = n.bx + Math.sin(t * n.sp + n.ph) * n.amp; n.y = n.by + Math.cos(t * n.sp * 0.8 + n.ph) * n.amp * 0.6 }
      c.pulse = (c.pulse + c.speed / 60) % 1
      // links
      for (let i = 0; i < c.nodes.length - 1; i++) {
        const a = c.nodes[i], b = c.nodes[i + 1]
        const d = Math.hypot((a.x + b.x) / 2 - mx, (a.y + b.y) / 2 - my), f = Math.max(0, 1 - d / R), lit = f * f
        ctx.strokeStyle = lit > 0.01 ? `rgba(${Math.round(255 - 102 * lit)}, ${Math.round(255 - 186 * lit)}, 255, ${(0.05 + 0.75 * lit).toFixed(3)})` : 'rgba(255, 255, 255, 0.05)'
        ctx.lineWidth = 1 + lit
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      }
      // the pulse running down the chain
      const p = c.pulse * (c.nodes.length - 1), i = Math.floor(p), a = c.nodes[i], b = c.nodes[Math.min(i + 1, c.nodes.length - 1)], q = p - i
      const px = a.x + (b.x - a.x) * q, py = a.y + (b.y - a.y) * q
      const pf = Math.max(0, 1 - Math.hypot(px - mx, py - my) / R)
      ctx.fillStyle = `rgba(176, 140, 255, ${(0.25 + 0.6 * pf).toFixed(3)})`
      ctx.beginPath(); ctx.arc(px, py, 1.6 + pf * 1.5, 0, Math.PI * 2); ctx.fill()
      // blocks
      for (const n of c.nodes) {
        const d = Math.hypot(n.x - mx, n.y - my), f = Math.max(0, 1 - d / R), lit = f * f
        const s = 5 + lit * 3
        if (lit > 0.02) { ctx.shadowColor = `rgba(153, 69, 255, ${(lit * 0.9).toFixed(3)})`; ctx.shadowBlur = 14 * lit } else ctx.shadowBlur = 0
        ctx.fillStyle = lit > 0.01 ? `rgba(${Math.round(20 + 133 * lit)}, ${Math.round(16 + 53 * lit)}, ${Math.round(28 + 227 * lit)}, ${(0.5 + 0.5 * lit).toFixed(3)})` : 'rgba(255, 255, 255, 0.07)'
        ctx.beginPath(); ctx.roundRect(n.x - s / 2, n.y - s / 2, s, s, 1.5); ctx.fill()
        if (lit > 0.3) { ctx.fillStyle = `rgba(255, 255, 255, ${((lit - 0.3) * 0.9).toFixed(3)})`; ctx.fillRect(n.x - 1, n.y - 1, 2, 2) }
      }
      ctx.shadowBlur = 0
    }
    // where the pointer is, the chains find each other: cross-links between nearby blocks
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
  document.addEventListener('visibilitychange', () => { on = !document.hidden; if (on) frame(performance.now()); else cancelAnimationFrame(raf) })
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
