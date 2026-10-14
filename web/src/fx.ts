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

/** A trail of purple light that follows the pointer across the dark, three blobs with growing lag; it stays off the terminal. */
export function trail() {
  if (still || wired.has('trail') || matchMedia('(pointer: coarse)').matches) return
  wired.add('trail')
  const host = document.createElement('div'); host.className = 'trail'; host.setAttribute('aria-hidden', 'true')
  const blobs = [520, 340, 200].map((s, i) => { const b = document.createElement('i'); b.style.width = b.style.height = `${s}px`; b.style.opacity = String(0.28 + i * 0.12); host.appendChild(b); return { el: b, x: innerWidth / 2, y: innerHeight / 2, k: 0.08 + i * 0.07 } })
  document.body.appendChild(host)
  let tx = innerWidth / 2, ty = innerHeight / 2, on = false, raf = 0
  const tick = () => {
    for (const b of blobs) { b.x += (tx - b.x) * b.k; b.y += (ty - b.y) * b.k; b.el.style.transform = `translate(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px) translate(-50%, -50%)` }
    raf = requestAnimationFrame(tick)
  }
  addEventListener('pointermove', (e) => {
    tx = e.clientX; ty = e.clientY
    const overApp = !!(e.target as Element | null)?.closest?.('.term, .drawer, .gate, .nav')
    host.classList.toggle('on', !overApp)
    if (!on) { on = true; tick() }
  }, { passive: true })
  document.addEventListener('pointerleave', () => host.classList.remove('on'))
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); on = false } })
}

/** Everything, once the page is there. New content (the wizard re-renders) is covered by the CSS selectors alone. */
export function all() {
  spotlight(); buttons(); sections(); trail()
  const h1 = document.querySelector<HTMLElement>('.z-hero h1')
  if (h1) { const go = () => { if (document.documentElement.classList.contains('intro-wait')) setTimeout(go, 150); else words(h1) }; go() }
  const metrics = document.getElementById('home-metrics')
  if (metrics) new MutationObserver(() => countUp(metrics)).observe(metrics, { childList: true })
  countUp()
}
