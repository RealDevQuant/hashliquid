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

/** The ledger: a key signs, burns, the next one steps up. */
export function keys(list: HTMLElement) {
  const moves = [['order', 'BTC-PERP long · 10x'], ['cancel', 'resting bid 108,500'], ['order', 'ETH-PERP short · 5x'], ['withdraw', '250 USDT to the wallet'], ['order', 'SOL-PERP long · 3x'], ['close', 'BTC-PERP long · +4.2%'], ['hire', 'Ash One on this bunker'], ['order', 'SOL-PERP short · 2x']]
  let n = 1, i = 0
  const row = (k: number, state: 'used' | 'now' | 'next', m?: string[]) => {
    const li = document.createElement('div'); li.className = `z-key ${state}`
    li.innerHTML = `<span class="n">#${k}</span><span class="what">${m ? `${m[0]}<small>${m[1]}</small>` : 'next<small>derived from the words</small>'}</span><span class="st">${state === 'used' ? 'burned' : state === 'now' ? 'signing' : 'ready'}</span>`
    return li
  }
  const seed = () => { list.innerHTML = ''; for (let k = 0; k < 5; k++) { const m = moves[(i + k) % moves.length]; list.appendChild(row(n + k, k < 2 ? 'used' : k === 2 ? 'now' : 'next', k <= 2 ? m : undefined)) } }
  seed()
  if (still) return
  const step = () => {
    if (document.hidden) return
    const rows = Array.from(list.children) as HTMLElement[]
    rows[2]?.classList.replace('now', 'used'); rows[2]?.querySelector('.st')?.replaceChildren('burned')
    const nxt = rows[3]; if (nxt) { nxt.classList.replace('next', 'now'); const m = moves[(i + 3) % moves.length]; nxt.querySelector('.what')!.innerHTML = `${m[0]}<small>${m[1]}</small>`; nxt.querySelector('.st')!.textContent = 'signing' }
    const gone = rows[0]; if (gone) { gone.classList.add('leave'); setTimeout(() => gone.remove(), 600) }
    const fresh = row(n + 5, 'next'); fresh.classList.add('enter'); list.appendChild(fresh)
    n++; i++
  }
  setInterval(step, 2600)
}
