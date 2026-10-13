/*
  venue.ts — live market data the chain doesn't hold: the order book (the venue's book server, which answers
  browsers directly), recent trades, 24h stats and funding (the venue's data API, through our same-origin relay
  at /api/venue because it sends no CORS headers). Every function returns null on any failure: panels show "–".
*/

export interface Level { price: number; size: number }
export interface Book { bids: Level[]; asks: Level[]; mid: number; spreadBps: number }

export async function fetchBook(symbol: string, depth = 14): Promise<Book | null> {
  try {
    const r = await fetch(`https://dlob.velocity.exchange/l2?marketName=${encodeURIComponent(symbol)}&depth=${depth}`)
    if (!r.ok) return null
    const d: { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] } = await r.json()
    const lv = (x: { price: string; size: string }): Level => ({ price: Number(x.price) / 1e6, size: Number(x.size) / 1e9 })
    const bids = d.bids.map(lv), asks = d.asks.map(lv)
    if (!bids.length || !asks.length) return null
    const mid = (bids[0].price + asks[0].price) / 2
    return { bids, asks, mid, spreadBps: ((asks[0].price - bids[0].price) / mid) * 1e4 }
  } catch { return null }
}

export interface Trade { t: number; price: number; size: number; side: 'buy' | 'sell'; sig: string }

export async function fetchTrades(symbol: string, limit = 40): Promise<Trade[] | null> {
  try {
    const r = await fetch(`/api/venue/market/${encodeURIComponent(symbol)}/trades?limit=${limit}`)
    if (!r.ok) return null
    const d: { records: { ts: number; txSig: string; baseAssetAmountFilled: string; quoteAssetAmountFilled: string; takerOrderDirection?: string; takerSide?: string }[] } = await r.json()
    return d.records.map((x) => {
      const size = Number(x.baseAssetAmountFilled), quote = Number(x.quoteAssetAmountFilled)
      const dir = (x.takerOrderDirection ?? x.takerSide ?? '').toLowerCase()
      const side: 'buy' | 'sell' = dir.startsWith('short') || dir === 'sell' ? 'sell' : 'buy'
      return { t: x.ts, price: size ? quote / size : 0, size, side, sig: x.txSig }
    }).filter((t) => t.size > 0)
  } catch { return null }
}

export interface Stats { volume24h: number | null; change24h: number | null; high24h: number | null; low24h: number | null }

/** 24h numbers of every perp market, keyed by symbol. */
export async function fetchStats(): Promise<Map<string, Stats> | null> {
  try {
    const r = await fetch('/api/venue/stats/markets')
    if (!r.ok) return null
    const d: { markets: { symbol: string; marketType: string; quoteVolume?: string; priceChange24hPercent?: string; priceHigh?: { oracle?: string }; priceLow?: { oracle?: string } }[] } = await r.json()
    const out = new Map<string, Stats>()
    for (const m of d.markets) {
      if (m.marketType !== 'perp') continue
      const n = (s?: string) => (s && s !== '' && Number.isFinite(Number(s)) ? Number(s) : null)
      out.set(m.symbol, { volume24h: n(m.quoteVolume), change24h: n(m.priceChange24hPercent), high24h: n(m.priceHigh?.oracle), low24h: n(m.priceLow?.oracle) })
    }
    return out
  } catch { return null }
}

export interface Funding { hourlyPct: number; at: number }

/** The last funding payment of a market as a percent per hour (positive = longs pay). */
export async function fetchFunding(symbol: string): Promise<Funding | null> {
  try {
    const r = await fetch(`/api/venue/market/${encodeURIComponent(symbol)}/fundingRates?limit=1`)
    if (!r.ok) return null
    const d: { records: { ts: number; fundingRate: string; oraclePriceTwap: string }[] } = await r.json()
    const f = d.records?.[0]
    if (!f || !(Number(f.oraclePriceTwap) > 0)) return null
    return { hourlyPct: (Number(f.fundingRate) / Number(f.oraclePriceTwap)) * 100, at: f.ts }
  } catch { return null }
}
