/*
  The top bar: a pill of glass from the first pixel, an indicator that glides under the link you are on, live
  prices for the three markets, and a button whose arrow leans forward. Shared by the landing, the agents page
  and the docs. The terminal keeps its own bar.
*/
const still = matchMedia('(prefers-reduced-motion: reduce)').matches
const MARKETS = ['BTC', 'ETH', 'SOL']

/** The glass pill, from the start; a little tighter once the page has moved. */
export function floatNav(nav: HTMLElement) {
  nav.classList.add('is-pill')
  const set = () => nav.classList.toggle('is-float', scrollY > 24)
  addEventListener('scroll', set, { passive: true }); set()
}

/** A light that glides under the link under the pointer, and rests under the section in view. */
export function indicator(nav: HTMLElement) {
  const links = nav.querySelector<HTMLElement>('.nav-links'); if (!links) return
  const ind = document.createElement('span'); ind.className = 'nav-ind'; links.appendChild(ind)
  let resting: HTMLElement | null = links.querySelector('a[aria-current]')
  const moveTo = (a: HTMLElement | null) => {
    if (!a) { ind.style.opacity = '0'; return }
    const r = a.getBoundingClientRect(), p = links.getBoundingClientRect()
    ind.style.opacity = '1'; ind.style.transform = `translateX(${(r.left - p.left).toFixed(1)}px)`; ind.style.width = `${r.width.toFixed(1)}px`
  }
  for (const a of Array.from(links.querySelectorAll<HTMLElement>('a:not([hidden])'))) {
    a.addEventListener('pointerenter', () => moveTo(a))
  }
  links.addEventListener('pointerleave', () => moveTo(resting))
  // on the home the resting place follows the section on screen
  const targets = Array.from(links.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')).map((a) => ({ a, el: document.querySelector<HTMLElement>(a.getAttribute('href')!) })).filter((t) => t.el)
  if (targets.length) {
    const io = new IntersectionObserver((es) => {
      for (const e of es) { const t = targets.find((x) => x.el === e.target); if (!t) continue; if (e.isIntersecting) { resting = t.a; moveTo(resting) } else if (resting === t.a) { resting = null; moveTo(null) } }
    }, { rootMargin: '-40% 0px -50% 0px' })
    targets.forEach((t) => io.observe(t.el!))
  }
  moveTo(resting)
  addEventListener('resize', () => moveTo(resting))
}

/** BTC, ETH and SOL, live, refreshed every ten seconds; the colour says which way the last move went. */
export function ticker(nav: HTMLElement) {
  const box = document.createElement('div'); box.className = 'nav-tick'; box.setAttribute('aria-label', 'Live prices')
  box.innerHTML = MARKETS.map((m) => `<a href="/app.html" data-m="${m}"><b>${m}</b><span>…</span></a>`).join('')
  const btn = nav.querySelector('.nav-in > .btn'); if (btn) btn.before(box); else nav.querySelector('.nav-in')?.appendChild(box)
  const last: Record<string, number> = {}
  const fmt = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: v >= 1000 ? 1 : 2, maximumFractionDigits: v >= 1000 ? 1 : 2 })
  const pull = async () => {
    try {
      const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }) })
      const mids = (await r.json()) as Record<string, string>
      for (const m of MARKETS) {
        const v = Number(mids[m]); if (!Number.isFinite(v)) continue
        const el = box.querySelector<HTMLElement>(`[data-m="${m}"]`); if (!el) continue
        const s = el.querySelector('span')!; s.textContent = fmt(v)
        const prev = last[m]; last[m] = v
        if (prev != null && v !== prev) { el.classList.remove('up', 'down'); void el.offsetWidth; el.classList.add(v > prev ? 'up' : 'down') }
      }
    } catch { /* the bar can live without prices */ }
  }
  void pull()
  if (!still) setInterval(() => { if (!document.hidden) void pull() }, 10_000)
}

export function all() {
  const nav = document.querySelector<HTMLElement>('.nav'); if (!nav || nav.classList.contains('nav-app')) return
  floatNav(nav); indicator(nav); ticker(nav)
}
