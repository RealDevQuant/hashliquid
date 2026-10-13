/*
  The home, fourth cut. The vault door is the protagonist: it lives in the hero, turns with the pointer, opens when
  you press Launch, and as you scroll it shrinks and keeps to the side while the rooms of the bunker pass by. A
  spine of keys runs down the rooms, each key lighting as its room arrives and burning as you move on. The agents
  ride a rail you can drag. Everything stands down under prefers-reduced-motion.
*/
import type { Api } from './intro.ts'

const still = matchMedia('(prefers-reduced-motion: reduce)').matches

/** The door in the hero. Returns a function that opens it and resolves when the site should move on. */
export async function door(canvas: HTMLCanvasElement, stage: HTMLElement): Promise<(() => Promise<void>) | null> {
  let api: Api
  try { const { mountDoor } = await import('./intro.ts'); api = await mountDoor(canvas, { centre: true }) } catch { canvas.closest('.v-door')?.classList.add('flat'); return null }
  let raf = 0, on = true, opening: number | null = null
  const loop = (now: number) => {
    if (!on) return
    const t = opening == null ? null : (now - opening) / 1000
    api.frame(now, t)
    raf = requestAnimationFrame(loop)
  }
  const fit = () => api.fit()
  addEventListener('resize', fit)
  if (!still) addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); api.state.mx = ((e.clientX - r.left) / r.width) * 2 - 1; api.state.my = -(((e.clientY - r.top) / r.height) * 2 - 1) }, { passive: true })
  document.addEventListener('visibilitychange', () => { on = !document.hidden; if (on) loop(performance.now()); else cancelAnimationFrame(raf) })
  loop(performance.now())
  // the door shrinks and docks to the side as the rooms scroll past
  const dock = () => {
    const r = stage.getBoundingClientRect(), vh = innerHeight
    const p = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - vh)))   // 0 at the top of the stage, 1 at its end
    stage.style.setProperty('--p', p.toFixed(3))
  }
  if (!still) { addEventListener('scroll', dock, { passive: true }); addEventListener('resize', dock) }
  dock()
  return () => new Promise<void>((done) => {
    if (opening != null || still) { done(); return }
    opening = performance.now(); canvas.closest('.v-door')?.classList.add('opening')
    setTimeout(done, 3000)
  })
}

/** Each room lights its key as it arrives; the keys above burn. */
export function spine(rooms: HTMLElement[]) {
  if (!rooms.length) return
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      const el = e.target as HTMLElement
      if (!e.isIntersecting) continue
      const i = rooms.indexOf(el)
      rooms.forEach((r, j) => { r.classList.toggle('burned', j < i); r.classList.toggle('now', j === i) })
    }
  }, { rootMargin: '-35% 0px -45% 0px' })
  rooms.forEach((r) => io.observe(r))
}

/** The rail of agents: drag with the pointer, arrows at the ends. */
export function rail(root: HTMLElement) {
  const track = root.querySelector<HTMLElement>('.v-track'); if (!track) return
  let down = false, x0 = 0, s0 = 0, moved = false
  track.addEventListener('pointerdown', (e) => { down = true; moved = false; x0 = e.clientX; s0 = track.scrollLeft; track.classList.add('drag') })
  addEventListener('pointermove', (e) => { if (!down) return; const dx = e.clientX - x0; if (Math.abs(dx) > 4) moved = true; track.scrollLeft = s0 - dx })
  addEventListener('pointerup', () => { down = false; track.classList.remove('drag') })
  track.addEventListener('click', (e) => { if (moved) { e.preventDefault(); e.stopPropagation() } }, true)
  for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-rail]'))) b.addEventListener('click', () => track.scrollBy({ left: (b.dataset.rail === 'next' ? 1 : -1) * (track.clientWidth * 0.8), behavior: 'smooth' }))
}

/** Everything on the page. */
export async function all() {
  const canvas = document.querySelector<HTMLCanvasElement>('.v-door canvas'), stage = document.querySelector<HTMLElement>('.v-stage')
  spine(Array.from(document.querySelectorAll<HTMLElement>('.v-room')))
  const r = document.querySelector<HTMLElement>('.v-rail'); if (r) rail(r)
  if (canvas && stage) {
    const open = await door(canvas, stage)
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-open]'))) {
      a.addEventListener('click', (e) => { if (!open || e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); void open().then(() => { location.href = a.href }) })
    }
  }
}
