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

/** The hash behind the page: a field of hex digits, barely there, that drifts as you scroll, flips now and then,
    resolves in purple where the pointer is, and stays dark under anything there is to read or look at. */
export function hashField() {
  if (wired.has('hash')) return
  wired.add('hash')
  const canvas = document.createElement('canvas'); canvas.className = 'chainfield'; canvas.setAttribute('aria-hidden', 'true')
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d'); if (!ctx) return
  const HEX = '0123456789abcdef'
  const rnd = (n: number) => Math.floor(Math.random() * n)
  type Cell = { c: string; t: number }
  const CW = 28, CH = 32
  let W = 0, H = 0, cols = 0, rows = 0, cells: Cell[] = [], raf = 0, on = true, last = 0
  let mx = -9999, my = -9999, lastY = scrollY, vel = 0
  const R = 240
  // where the page has something to read or look at, the field stays dark: the rects of the content on screen
  type Rect = { l: number; t: number; r: number; b: number }
  let mask: Rect[] = [], maskAt = 0
  const SEL = 'h1, h2, h3, h4, p, li, img, figure, canvas.iso, svg.iso, .btn, button, .metrics, .n6-agent, .n6-links a, .n6-steps li, .n6-proof li, .n6-fig, .nav-in, .brand, code, dl, table, .n6-art, .l-foot nav'
  const refreshMask = () => {
    const out: Rect[] = []
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SEL))) {
      if (el.closest('.chainfield')) continue
      const r = el.getBoundingClientRect()
      if (r.bottom < -20 || r.top > H + 20 || r.width === 0 || r.height === 0) continue
      out.push({ l: r.left - 14, t: r.top - 10, r: r.right + 14, b: r.bottom + 10 })
    }
    mask = out
  }
  const covered = (x: number, y: number) => { for (const m of mask) if (x > m.l && x < m.r && y > m.t && y < m.b) return true; return false }
  const build = () => {
    const r = canvas.getBoundingClientRect(); const dpr = Math.min(devicePixelRatio || 1, 1.25)
    W = r.width; H = r.height; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    cols = Math.ceil(W / CW) + 2; rows = Math.ceil(H / CH) + 2
    cells = Array.from({ length: cols * rows }, () => ({ c: HEX[rnd(16)], t: Math.random() * 10 }))
  }
  const frame = (now: number) => {
    if (!on) return
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016; last = now
    const y = scrollY; vel = vel * 0.9 + (y - lastY) * 0.1; lastY = y
    if (now - maskAt > 120 || Math.abs(y - lastY) > 0) { refreshMask(); maskAt = now }
    ctx.clearRect(0, 0, W, H)

    // 1. the field of digits: drifts up with the scroll, flips now and then, resolves near the pointer and in a band where you just scrolled
    const oy = (y * 0.35) % CH, ox = (y * 0.08) % CW
    ctx.font = '500 12px "Inter Variable", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    const band = Math.min(1, Math.abs(vel) / 40)
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c]
      cell.t -= dt * (1 + band * 6)
      if (cell.t <= 0) { cell.c = HEX[rnd(16)]; cell.t = 2 + Math.random() * 12 }
      const px = c * CW - ox + CW / 2, py = r * CH - oy + CH / 2
      if (covered(px, py)) continue
      const d = Math.hypot(px - mx, py - my), f = d < R ? 1 - d / R : 0, lit = f * f
      const scan = band * Math.max(0, 1 - Math.abs(py - H * 0.5) / (H * 0.5)) * 0.25
      const al = 0.038 + lit * 0.6 + scan
      if (al < 0.02) continue
      ctx.fillStyle = lit > 0.02 ? `rgba(${Math.round(220 - 60 * lit)}, ${Math.round(220 - 130 * lit)}, 255, ${al.toFixed(3)})` : `rgba(255, 255, 255, ${al.toFixed(3)})`
      ctx.fillText(cell.c, px, py)
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
  spotlight(); buttons(); sections(); hashField()
  const h1 = document.querySelector<HTMLElement>('.z-hero h1')
  if (h1) { const go = () => { if (document.documentElement.classList.contains('intro-wait')) setTimeout(go, 150); else words(h1) }; go() }
  const metrics = document.getElementById('home-metrics')
  if (metrics) new MutationObserver(() => countUp(metrics)).observe(metrics, { childList: true })
  countUp()
}
