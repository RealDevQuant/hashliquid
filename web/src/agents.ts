/*
  agents.ts — the agents' public feed: who they are, what they hold, every trade with its result, every note.
  Written by the agents' service, read here by the terminal (faces on the chart, the Agents tab), by the Agents
  page and by the home.
*/
export const FEED_URL: string = import.meta.env.VITE_AGENTS_FEED || 'https://f5hdtinpoqngxkbv.public.blob.vercel-storage.com/agents.json'

export interface Move {
  t: number; agent: string; market: string; kind: 'open' | 'close' | 'adjust_stop' | 'hold' | 'limit' | 'cancel'
  side?: 'long' | 'short'; size?: number; price?: number; notional?: number; stop?: number; target?: number; invalidation?: string; riskPct?: number
  thesis: string; confidence?: number; txs: string[]; error?: string; by?: 'model' | 'guard'
}
export interface Trade { market: string; side: 'long' | 'short'; size: number; entry: number; exit: number | null; openedAt: number; closedAt: number | null; pnl: number | null; pnlPct: number | null; reason: string; txs: string[] }
export interface Position { market: string; side: 'long' | 'short'; size: number; entry: number; unrealized: number; stop?: number; target?: number | null; invalidation?: string }
export interface Order { market: string; side: 'long' | 'short'; size: number; price: number; reduceOnly: boolean; orderId: number }
export interface Agent {
  id: string; name: string; color: string; initials: string; avatar?: string; persona: string; strategy?: string; bunker: string
  equity: number; collateral: number; realized: number; dayPnlPct?: number | null; opensToday?: number; peakEquity?: number
  startEquity?: number; allTimePnl?: number; allTimePct?: number; trades?: Trade[]; wins?: number; losses?: number
  delegate?: string; clients?: number; aum?: number
  positions: Position[]; orders: Order[]
  lastThesis: string | null; lastAt: number | null; moves: Move[]
}
export interface Hired { agent: string; bunker: string; label: string; aggr: number; equity: number; positions: Position[]; trades: Trade[] }
export interface Custom {
  bunker: string; label: string; base: number; aggr: number; color: string; initials: string; strategy: string
  equity: number; startEquity: number; allTimePnl: number; positions: Position[]; trades: Trade[]; wins: number; losses: number
  lastThesis: string | null; lastAt: number | null; moves: Move[]; queued: boolean
  prompt?: string | null
}
export interface Metrics { agentsDeployed: number; hiredBunkers: number; customAgents: number; positionsOpen: number; tradesTotal: number; volumeUsd: number; aum: number }
export interface Feed { updatedAt: number; cadenceMinutes: number; agents: Agent[]; hired?: Hired[]; custom?: Custom[]; metrics?: Metrics }
/** Where the feed and the users' logos live. */
export const BLOB_BASE = FEED_URL.replace(/\/agents\.json$/, '')
/** A user-made agent's logo, uploaded through /api/logo. */
export const logoUrl = (bunker: string) => `${BLOB_BASE}/logos/${bunker}`

export async function fetchFeed(): Promise<Feed | null> {
  try {
    const r = await fetch(FEED_URL, { cache: 'no-cache' })
    if (!r.ok) return null
    return (await r.json()) as Feed
  } catch { return null }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The agent's face when its picture exists, its initials otherwise (the image swaps itself out on error). */
export const avatarHtml = (a: { color: string; initials: string; avatar?: string }, cls = 'avatar'): string => {
  const src = a.avatar?.startsWith('logo:') ? logoUrl(a.avatar.slice(5)) : a.avatar
  const img = src ? `<img src="${esc(src)}" alt="" onerror="this.remove()" />` : ''
  return `<span class="${cls}" style="--c:${esc(a.color)}">${img}<i>${esc(a.initials)}</i></span>`
}
/** What a flat agent shows. */
export const FLAT_TEXT = 'No trade open yet.'

/** Who is drawn on the chart: a face (or logo) and a colour, plus "for Bob" when the trade is on somebody's bunker. */
export interface ChartWho { id: string; name: string; color: string; initials: string; avatar?: string; forLabel?: string }
/** The trades of a market, for the chart: the entry (a face) and, when closed, the exit (a dot) with the result. */
export function chartTrades(feed: Feed, market: string): { agent: ChartWho; trade: Trade; note: string }[] {
  const out: { agent: ChartWho; trade: Trade; note: string }[] = []
  for (const a of feed.agents) for (const t of (a.trades ?? []).filter((t) => t.market === market)) out.push({ agent: a, trade: t, note: [...(a.moves ?? [])].reverse().find((m) => m.kind === 'open' && m.market === market && Math.abs(m.t - t.openedAt) < 5)?.thesis ?? '' })
  for (const h of feed.hired ?? []) { const a = feed.agents.find((x) => x.id === h.agent); if (!a) continue; for (const t of (h.trades ?? []).filter((t) => t.market === market)) out.push({ agent: { ...a, forLabel: h.label || h.bunker.slice(0, 4) + '…' }, trade: t, note: '' }) }
  for (const c of feed.custom ?? []) for (const t of (c.trades ?? []).filter((t) => t.market === market)) out.push({ agent: { id: `custom@${c.bunker}`, name: c.label, color: c.color, initials: c.initials, avatar: `logo:${c.bunker}` }, trade: t, note: [...(c.moves ?? [])].reverse().find((m) => m.kind === 'open' && m.market === market && Math.abs(m.t - t.openedAt) < 5)?.thesis ?? '' })
  return out
}
export const AGGR_LABEL: Record<number, string> = { 1: 'careful', 2: 'standard', 3: 'all in' }
export const BASE_LABEL: Record<number, string> = { 1: 'trend', 2: 'mean reversion', 3: 'momentum', 4: 'own prompt' }
/** The metrics strip the pages share. */
export function metricsHtml(m: Metrics | undefined): string {
  if (!m) return ''
  const n = (x: number) => x.toLocaleString('en-US')
  const usd = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e4 ? `$${(x / 1e3).toFixed(1)}k` : `$${x.toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
  return `<div class="metrics">
    <div><b>${n(m.agentsDeployed)}</b><span>agents deployed</span></div>
    <div><b>${n(m.hiredBunkers + m.customAgents)}</b><span>bunkers on autopilot</span></div>
    <div><b>${n(m.positionsOpen)}</b><span>positions open</span></div>
    <div><b>${n(m.tradesTotal)}</b><span>trades</span></div>
    <div><b>${usd(m.volumeUsd)}</b><span>traded</span></div>
    <div><b>${usd(m.aum)}</b><span>under management</span></div>
  </div>`
}

export const ago = (t: number): string => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t)
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}
export const duration = (from: number, to: number): string => {
  const s = Math.max(0, to - from)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`
  return `${(s / 86400).toFixed(1)} d`
}
