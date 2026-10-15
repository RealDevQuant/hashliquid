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

/** The hash behind the page. A field of hex digits, barely there, that drifts as you scroll and resolves where the
    pointer is; across it, the chain of one-time keys: each key signs, runs through SHA-256, burns to embers, and the
    next one derives. Scrolling drives the chain: every few hundred pixels another key burns. */
export function hashField() {
  if (wired.has('hash')) return
  wired.add('hash')
  const canvas = document.createElement('canvas'); canvas.className = 'chainfield'; canvas.setAttribute('aria-hidden', 'true')
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d'); if (!ctx) return
  const HEX = '0123456789abcdef'
  const rnd = (n: number) => Math.floor(Math.random() * n)
  const hex = (n: number) => Array.from({ length: n }, () => HEX[rnd(16)]).join('')
  type Cell = { c: string; t: number }
  type Key = { n: number; h: string; sig: string; burnt: number; born: number }
  type Ember = { x: number; y: number; vx: number; vy: number; t0: number; life: number; m: boolean }
  const CW = 28, CH = 32, KEYS = 9, STEP = 360
  let W = 0, H = 0, cols = 0, rows = 0, cells: Cell[] = [], keys: Key[] = [], embers: Ember[] = [], raf = 0, on = true, last = 0
  let mx = -9999, my = -9999, nextKey = 1, burned = 0, idle = 0, lastY = scrollY, vel = 0
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
    if (!keys.length) { keys = Array.from({ length: KEYS }, () => ({ n: nextKey++, h: hex(8), sig: hex(6), burnt: 0, born: 0 })) }
  }
  const chainY = (x: number, i: number) => H * 0.64 - scrollY + Math.sin(x / 520 + i * 0.3) * 36   // anchored to the page, in the hero: it scrolls away with it
  const burn = (k: Key, x: number, y: number, now: number) => {
    k.burnt = now
    for (let i = 0; i < 26; i++) embers.push({ x: x + (Math.random() - 0.5) * 60, y: y + (Math.random() - 0.5) * 14, vx: (Math.random() - 0.5) * 18, vy: -14 - Math.random() * 30, t0: now, life: 1400 + Math.random() * 1200, m: Math.random() < 0.4 })
  }
  const frame = (now: number) => {
    if (!on) return
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016; last = now
    const y = scrollY; vel = vel * 0.9 + (y - lastY) * 0.1; lastY = y
    if (now - maskAt > 120 || Math.abs(y - lastY) > 0) { refreshMask(); maskAt = now }
    idle += dt * 18                                            // the chain creeps on its own; the scroll pushes it
    const drive = y + idle
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

    // 2. the chain of keys, sliding with the scroll: each STEP of scroll burns one more key and derives the next
    const want = Math.floor(drive / STEP)
    while (burned < want) { const k = keys[0]; if (!k) break; const x = W * 0.5 - (drive % STEP) * 0.5; burn(k, x, chainY(x, 0), now); keys.shift(); keys.push({ n: nextKey++, h: hex(8), sig: '', burnt: 0, born: now }); burned++ }
    const gap = 178, x0 = W * 0.5 - ((drive % STEP) / STEP) * gap
    ctx.textAlign = 'left'
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i], x = x0 + i * gap, yy = chainY(x, i)
      if (x < -200 || x > W + 60 || yy < -60 || yy > H + 60) continue
      if (covered(x, yy) || covered(x + 76, yy) || covered(x + 38, yy - 16)) continue
      const d = Math.hypot(x + 36 - mx, yy - my), f = d < R ? 1 - d / R : 0, lit = f * f
      const signing = i === 0, next = i === 1, fresh = k.born ? Math.max(0, 1 - (now - k.born) / 900) : 0
      const base = signing ? 0.75 : next ? 0.42 : 0.22 - i * 0.015
      const al = Math.min(1, base + lit * 0.6)
      // the link to the next key: a line with the hash written on it
      if (i < keys.length - 1 && !covered(x0 + (i + 1) * gap, chainY(x0 + (i + 1) * gap, i + 1)) && !covered((x + 76 + x0 + (i + 1) * gap) / 2, (yy + chainY(x0 + (i + 1) * gap, i + 1)) / 2)) {
        const nx = x0 + (i + 1) * gap, ny = chainY(nx, i + 1)
        ctx.strokeStyle = signing ? `rgba(176, 140, 255, ${(0.55 + lit * 0.3).toFixed(3)})` : `rgba(255, 255, 255, ${(0.08 + lit * 0.4).toFixed(3)})`; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(x + 76, yy); ctx.lineTo(nx - 4, ny); ctx.stroke()
        ctx.font = '500 9px "Inter Variable", sans-serif'; ctx.textAlign = 'center'
        ctx.fillStyle = signing ? `rgba(176, 140, 255, ${(0.8).toFixed(3)})` : `rgba(255, 255, 255, ${(0.14 + lit * 0.5).toFixed(3)})`
        ctx.fillText('SHA-256', (x + 76 + nx - 4) / 2, (yy + ny) / 2 - 7)
        ctx.textAlign = 'left'
      }
      // the key itself: a small card with its number and its hex
      const w = 76, h = 26, rx = x, ry = yy - h / 2
      ctx.fillStyle = signing ? `rgba(153, 69, 255, ${(0.16 + lit * 0.2).toFixed(3)})` : `rgba(255, 255, 255, ${(0.02 + lit * 0.06).toFixed(3)})`
      ctx.strokeStyle = signing ? `rgba(176, 140, 255, ${al.toFixed(3)})` : `rgba(255, 255, 255, ${(al * 0.6).toFixed(3)})`; ctx.lineWidth = 1
      ctx.beginPath(); ctx.roundRect(rx, ry, w, h, 5); ctx.fill(); ctx.stroke()
      if (signing) { ctx.shadowColor = 'rgba(153, 69, 255, 0.9)'; ctx.shadowBlur = 18 + Math.sin(now / 160) * 6; ctx.stroke(); ctx.shadowBlur = 0 }
      ctx.font = '600 9px "Inter Variable", sans-serif'; ctx.fillStyle = signing ? 'rgba(220, 200, 255, 0.95)' : `rgba(255, 255, 255, ${al.toFixed(3)})`
      ctx.fillText(`#${k.n}`, rx + 7, yy)
      ctx.font = '500 10px "Inter Variable", sans-serif'; ctx.fillStyle = signing ? 'rgba(255, 255, 255, 0.9)' : `rgba(255, 255, 255, ${(al * 0.85).toFixed(3)})`
      ctx.fillText(fresh > 0 ? hex(8) : k.h, rx + 28, yy)
      if (signing) { ctx.font = '500 9px "Inter Variable", sans-serif'; ctx.fillStyle = 'rgba(176, 140, 255, 0.9)'; ctx.fillText('signing · one-time key', rx, ry - 9) }
      else if (next) { ctx.font = '500 9px "Inter Variable", sans-serif'; ctx.fillStyle = `rgba(255, 255, 255, ${(0.3 + lit * 0.5).toFixed(3)})`; ctx.fillText('next · derived from the words', rx, ry - 9) }
    }
    // 3. what is left of the burned keys: embers rising and fading, purple and magenta
    embers = embers.filter((e) => now - e.t0 < e.life)
    for (const e of embers) {
      const k = (now - e.t0) / e.life
      e.x += e.vx * dt; e.y += e.vy * dt; e.vy -= 6 * dt
      if (covered(e.x, e.y)) continue
      ctx.fillStyle = e.m ? `rgba(220, 31, 255, ${((1 - k) * 0.85).toFixed(3)})` : `rgba(176, 140, 255, ${((1 - k) * 0.7).toFixed(3)})`
      ctx.fillRect(e.x, e.y, 2, 2)
    }
    if (embers.length === 0 && burned === 0 && now % 4000 < 20) { /* nothing to do: the first burn comes with the scroll */ }
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
