// The landing and the docs are plain HTML. This brings in the two typefaces, the shared stylesheet and the outside links,
// and on the home it fills the agents' cards with their live numbers from the public feed.
import '@fontsource-variable/instrument-sans'
import '@fontsource/instrument-serif/400-italic.css'
import './style.css'
import './home.css'
import { wireLinks } from './links.ts'
import { all as fx } from './fx.ts'
import { FLAT_TEXT, ago, avatarHtml, fetchFeed, metricsHtml } from './agents.ts'

wireLinks()
fx()

// the vault on the home: once per browser session (?intro=1 forces it, ?intro=0 skips it)
{
  const q = new URLSearchParams(location.search).get('intro')
  const home = location.pathname === '/' || location.pathname.endsWith('/index.html')
  let seen = false
  try { seen = sessionStorage.getItem('hashliquid:entered') === '1' } catch { /* private mode */ }
  if (home && q !== '0' && (q === '1' || !seen)) {
    void import('./intro.ts').then(({ showIntro }) => showIntro()).then(() => { try { sessionStorage.setItem('hashliquid:entered', '1') } catch { /* ignore */ } })
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const n = (x: number, d = 2) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

async function liveCards() {
  const slots = document.querySelectorAll<HTMLElement>('[data-live]')
  if (!slots.length) return
  const feed = await fetchFeed()
  const hm = document.getElementById('home-metrics'); if (hm && feed) hm.innerHTML = metricsHtml(feed.metrics)
  for (const el of slots) {
    const a = feed?.agents.find((x) => x.id === el.dataset.live)
    if (!a) { el.textContent = 'Live numbers are not available right now.'; continue }
    const pos = (a.positions ?? []).length ? (a.positions ?? []).map((p) => `<b class="${p.side === 'long' ? 'pos' : 'neg'}">${p.side === 'long' ? 'Long' : 'Short'} ${n(p.size, 3)} ${esc(p.market)}</b>`).join(', ') : `<span class="dim">${FLAT_TEXT}</span>`
    const face = el.closest('.agent')?.querySelector('.avatar'); if (face && a.avatar) face.outerHTML = avatarHtml(a)
    const last = [...(a.moves ?? [])].reverse().find((m) => m.thesis)
    const quote = last ? `<br>“${esc(last.thesis.length > 150 ? last.thesis.slice(0, 150).replace(/\s+\S*$/, '') + '…' : last.thesis)}” <span class="dim">· ${ago(last.t)}</span>` : ''
    el.innerHTML = `<b>${n(a.equity)} USDT</b> · ${pos}${quote}`
  }
}
void liveCards()

// the page reveals as it comes into view, once the vault intro is out of the way
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal], .l-hero h1, .l-hero .l-lede, .l-hero .l-cta, .l-hero .l-proof, .l-sec .wrap > *, .l-specs > div'))
  els.forEach((el, i) => { el.classList.add('reveal'); el.style.setProperty('--i', String(i % 5)) })
  const io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) } }, { threshold: 0.1 })
  const start = () => { if (document.querySelector('.intro')) { setTimeout(start, 200); return } els.forEach((el) => io.observe(el)) }
  start()
}

// the home's motion and the floating nav
{
  const nav = document.querySelector<HTMLElement>('.nav'); if (nav) void import('./home.ts').then((m) => m.floatNav(nav))
  const dust = document.querySelector<HTMLCanvasElement>('.z-dust'), dev = document.querySelector<HTMLElement>('.z-device'), keys = document.querySelector<HTMLElement>('.z-keys')
  if (dust || dev || keys) void import('./home.ts').then((m) => { if (dust) m.dust(dust); if (dev) m.device(dev); if (keys) m.keys(keys) })
}
