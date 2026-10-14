/*
  Isometric line art, drawn by code into SVG: cubes, slabs and prisms on a 30° grid, in the site's purple.
  Scenes: the chain of keys, the hash, the wallet feeding the bunker, the program as a stack, a trade.
  Every path knows its length, so a scene can draw itself stroke by stroke when it comes into view.
*/
const C = Math.cos(Math.PI / 6), S = Math.sin(Math.PI / 6)
const P = (x: number, y: number, z: number): [number, number] => [(x - y) * C, (x + y) * S - z]
const pt = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`
const poly = (ps: [number, number][], cls = '') => `<path class="${cls}" d="M${ps.map(pt).join('L')}Z"/>`
const line = (a: [number, number], b: [number, number], cls = '') => `<path class="${cls}" d="M${pt(a)}L${pt(b)}"/>`

/** A cube with its corner at (x, y, z) and side s: the three faces you can see. */
export function cube(x: number, y: number, z: number, s: number, cls = '') {
  const t = [P(x, y, z + s), P(x + s, y, z + s), P(x + s, y + s, z + s), P(x, y + s, z + s)] as [number, number][]
  const l = [P(x, y + s, z), P(x, y + s, z + s), P(x + s, y + s, z + s), P(x + s, y + s, z)] as [number, number][]
  const r = [P(x + s, y, z), P(x + s, y, z + s), P(x + s, y + s, z + s), P(x + s, y + s, z)] as [number, number][]
  return `<g class="cube ${cls}">${poly(t, 'f top')}${poly(l, 'f left')}${poly(r, 'f right')}</g>`
}
/** A slab: a box w by d, h tall. */
export const slab = (x: number, y: number, z: number, w: number, d: number, h: number, cls = '') => {
  const t = [P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)] as [number, number][]
  const l = [P(x, y + d, z), P(x, y + d, z + h), P(x + w, y + d, z + h), P(x + w, y + d, z)] as [number, number][]
  const r = [P(x + w, y, z), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x + w, y + d, z)] as [number, number][]
  return `<g class="slab ${cls}">${poly(t, 'f top')}${poly(l, 'f left')}${poly(r, 'f right')}</g>`
}
/** A hexagonal prism standing on (x, y), radius r, height h. */
export function prism(x: number, y: number, z: number, r: number, h: number, cls = '') {
  const ring = (zz: number) => Array.from({ length: 6 }, (_, i) => { const a = (i / 6) * Math.PI * 2 + Math.PI / 6; return P(x + Math.cos(a) * r, y + Math.sin(a) * r, zz) }) as [number, number][]
  const top = ring(z + h), bot = ring(z)
  let faces = ''
  for (let i = 0; i < 6; i++) { const j = (i + 1) % 6; faces += poly([bot[i], top[i], top[j], bot[j]], 'f side') }
  return `<g class="prism ${cls}">${faces}${poly(top, 'f top')}</g>`
}

const wrap = (inner: string, box: string) => `<svg class="iso" viewBox="${box}" fill="none" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${inner}</svg>`

/** The chain of keys: six cubes on a slab; which one is lit is set by the caller (data-k). */
export function keysScene() {
  let s = slab(0, 0, 0, 9.6, 3.2, 0.5, 'base')
  for (let i = 0; i < 6; i++) s += cube(0.6 + i * 1.5, 1.1, 0.5, 1.0, `k k${i}`)
  for (let i = 0; i < 5; i++) s += line(P(1.6 + i * 1.5, 1.6, 1.6), P(2.1 + i * 1.5, 1.6, 1.6), 'chain')
  return wrap(s, '-4 -5 18 11')
}
/** The hash: many lines fall into one prism, one line leaves. */
export function hashScene() {
  let s = slab(0, 0, 0, 7, 7, 0.4, 'base')
  s += prism(3.5, 3.5, 0.4, 1.8, 2.6, 'hash')
  for (let i = 0; i < 7; i++) { const a = P(-2.5 + i * 0.8, -2.0 + i * 0.25, 2.6 + (i % 3) * 0.5); s += line(a, P(3.5, 3.5, 3.0), `in i${i}`) }
  s += line(P(3.5, 3.5, 3.0), P(9.5, 3.5, 3.0), 'out')
  s += cube(9.5, 3.0, 2.5, 1.0, 'k now')
  return wrap(s, '-6 -5.5 20 11.5')
}
/** The wallet: a card feeds the bunker through a slot; the bunker is a locked cube. */
export function walletScene() {
  let s = slab(0, 0, 0, 10, 5, 0.4, 'base')
  s += slab(0.6, 1.4, 0.4, 3.2, 2.0, 0.3, 'card')
  s += line(P(1.0, 1.7, 0.75), P(3.4, 1.7, 0.75), 'thin') + line(P(1.0, 2.1, 0.75), P(2.6, 2.1, 0.75), 'thin')
  s += line(P(3.8, 2.4, 0.9), P(5.8, 2.4, 0.9), 'flow')
  s += cube(6.0, 1.2, 0.4, 2.6, 'bunker')
  s += poly([P(6.85, 3.8, 1.25), P(7.75, 3.8, 1.25), P(7.75, 3.8, 1.85), P(6.85, 3.8, 1.85)], 'lock') + line(P(7.05, 3.8, 1.85), P(7.05, 3.8, 2.25), 'lock') + line(P(7.55, 3.8, 1.85), P(7.55, 3.8, 2.25), 'lock') + line(P(7.05, 3.8, 2.25), P(7.55, 3.8, 2.25), 'lock')
  return wrap(s, '-6 -4 20 11')
}
/** The program: three layers, the middle one sealed. */
export function programScene() {
  let s = slab(0, 0, 0, 8, 8, 0.35, 'base')
  s += slab(0.8, 0.8, 1.0, 6.4, 6.4, 0.35, 'layer l1')
  s += slab(0.8, 0.8, 2.3, 6.4, 6.4, 0.35, 'layer l2 seal')
  s += slab(0.8, 0.8, 3.6, 6.4, 6.4, 0.35, 'layer l3')
  s += prism(4, 4, 2.65, 0.9, 0.5, 'mark')
  return wrap(s, '-7 -6 20 12')
}
/** A trade: bars rising on a slab, a line through their tops. */
export function tradeScene() {
  let s = slab(0, 0, 0, 10, 4, 0.4, 'base')
  const hs = [0.8, 1.4, 1.1, 2.0, 2.6, 2.2, 3.1]
  hs.forEach((h, i) => { s += slab(0.6 + i * 1.3, 1.5, 0.4, 0.8, 0.8, h, `bar b${i}`) })
  for (let i = 0; i < hs.length - 1; i++) s += line(P(1.0 + i * 1.3, 1.9, 0.4 + hs[i] + 0.2), P(2.3 + i * 1.3, 1.9, 0.4 + hs[i + 1] + 0.2), 'chain')
  return wrap(s, '-5 -5 19 11')
}

export const SCENES: Record<string, () => string> = { keys: keysScene, hash: hashScene, wallet: walletScene, program: programScene, trade: tradeScene }
export const CAPTIONS: Record<string, string> = { keys: 'keys · one per move', hash: 'SHA-256 · nothing else', wallet: 'wallet → bunker · fees only', program: 'chain · program · venue', trade: 'margin × leverage' }

/** Puts a scene in `host` and makes it draw itself when `host` (or an ancestor) carries `.in`. */
export function mount(host: HTMLElement, name: string) {
  host.innerHTML = SCENES[name]?.() ?? ''
  const svg = host.querySelector<SVGSVGElement>('svg.iso'); if (!svg) return
  const paths = Array.from(svg.querySelectorAll<SVGPathElement>('path'))
  paths.forEach((p, i) => { const L = p.getTotalLength(); p.style.strokeDasharray = `${L}`; p.style.strokeDashoffset = `${L}`; p.style.transitionDelay = `${(i * 18) % 900}ms` })
  svg.dataset.scene = name
  host.dataset.cap = CAPTIONS[name] ?? ''
}
