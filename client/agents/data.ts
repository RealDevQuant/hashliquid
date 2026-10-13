/*
  data.ts — what an agent sees before it decides. Numbers only, computed here, never by the model: candles and
  indicators (Hyperliquid's public API), the venue's order book (DLOB), funding and 24h stats (the venue's data
  API), open interest and limits (on chain). Every series is oldest first and says so. Nothing written by people
  reaches the model from here.
*/
import type { Connection } from '@solana/web3.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import * as H from '../src/index.ts'
import { MARKETS } from './config.ts'
import { dataDir } from './store.ts'

const V = H.V
type Interval = '15m' | '1h' | '4h' | '1d'
const SECONDS: Record<Interval, number> = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

export async function candles(coin: string, interval: Interval, count: number): Promise<Candle[]> {
  const end = Date.now(), start = end - count * SECONDS[interval] * 1000
  const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime: start, endTime: end } }) })
  if (!r.ok) throw new Error(`candles ${coin} ${interval}: ${r.status}`)
  const rows: { t: number; o: string; h: string; l: string; c: string; v: string }[] = await r.json()
  return rows.map((k) => ({ t: Math.floor(k.t / 1000), o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }))
}

/* ---- indicators (standard definitions) ---- */
export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null
  const k = 2 / (period + 1)
  let e = values.slice(0, period).reduce((s, x) => s + x, 0) / period
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  let gain = 0, loss = 0
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d }
  gain /= period; loss /= period
  for (let i = period + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; gain = (gain * (period - 1) + Math.max(d, 0)) / period; loss = (loss * (period - 1) + Math.max(-d, 0)) / period }
  if (loss === 0) return 100
  return 100 - 100 / (1 + gain / loss)
}
export function atr(cs: Candle[], period = 14): number | null {
  if (cs.length < period + 1) return null
  const tr = cs.slice(1).map((c, i) => Math.max(c.h - c.l, Math.abs(c.h - cs[i].c), Math.abs(c.l - cs[i].c)))
  let a = tr.slice(0, period).reduce((s, x) => s + x, 0) / period
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period
  return a
}
export function vwap(cs: Candle[]): number | null {
  const v = cs.reduce((s, c) => s + c.v, 0)
  if (!v) return null
  return cs.reduce((s, c) => s + ((c.h + c.l + c.c) / 3) * c.v, 0) / v
}

export interface Frame {
  interval: Interval; candles: number; seriesOrder: 'oldest first'
  closes: number[]                  // the last 24 closes
  changePct: number; high: number; low: number; rangePos: number
  ema20: number | null; ema50: number | null; ema200: number | null
  rsi14: number | null; atr14: number | null; atrPct: number | null
  vwap: number | null; vwapDistPct: number | null      // VWAP of the window, distance of the last close from it
  realizedVolPct: number            // standard deviation of close-to-close returns over the window, percent
  volRatio: number                  // last candle's volume / average volume in the window
  trend: 'up' | 'down' | 'flat'     // ema50 vs ema200 and price vs ema50 (ema20 vs ema50 when 200 is missing)
}

export function frame(interval: Interval, all: Candle[], window: number): Frame {
  const cs = all.slice(-window)
  const closes = all.map((c) => c.c)
  const last = cs[cs.length - 1], first = cs[0]
  const high = Math.max(...cs.map((c) => c.h)), low = Math.min(...cs.map((c) => c.l))
  const avgVol = cs.reduce((s, c) => s + c.v, 0) / cs.length
  const rets = cs.slice(1).map((c, i) => Math.log(c.c / cs[i].c))
  const mean = rets.reduce((s, r) => s + r, 0) / Math.max(1, rets.length)
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length))
  const e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200), a = atr(all, 14), vw = vwap(cs)
  const fast = e50 ?? e20, slow = e200 ?? e50
  let trend: Frame['trend'] = 'flat'
  if (fast != null && slow != null) { if (fast > slow && last.c > fast) trend = 'up'; else if (fast < slow && last.c < fast) trend = 'down' }
  return {
    interval, candles: cs.length, seriesOrder: 'oldest first', closes: closes.slice(-24).map(r4),
    changePct: r2(((last.c - first.o) / first.o) * 100), high, low, rangePos: r2(high === low ? 0.5 : (last.c - low) / (high - low)),
    ema20: rn(e20), ema50: rn(e50), ema200: rn(e200), rsi14: rn(rsi(closes, 14), 1), atr14: rn(a), atrPct: a != null ? r2((a / last.c) * 100) : null,
    vwap: rn(vw), vwapDistPct: vw != null ? r2(((last.c - vw) / vw) * 100) : null,
    realizedVolPct: r2(sd * 100), volRatio: r2(avgVol ? last.v / avgVol : 0), trend,
  }
}

export interface Book { bids: [number, number][]; asks: [number, number][]; mid: number; spreadBps: number; bidUsd: number; askUsd: number; imbalance: number }

/** The venue's live order book, top `depth` levels each side. Prices in USDT, sizes in base. */
export async function book(symbol: string, depth = 10): Promise<Book | null> {
  try {
    const r = await fetch(`https://dlob.velocity.exchange/l2?marketName=${symbol}&depth=${depth}`)
    if (!r.ok) return null
    const d: { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] } = await r.json()
    const lv = (x: { price: string; size: string }): [number, number] => [Number(x.price) / 1e6, Number(x.size) / 1e9]
    const bids = d.bids.map(lv), asks = d.asks.map(lv)
    if (!bids.length || !asks.length) return null
    const mid = (bids[0][0] + asks[0][0]) / 2
    const bidUsd = Math.round(bids.reduce((s, [p, q]) => s + p * q, 0)), askUsd = Math.round(asks.reduce((s, [p, q]) => s + p * q, 0))
    return { bids, asks, mid, spreadBps: r2(((asks[0][0] - bids[0][0]) / mid) * 1e4), bidUsd, askUsd, imbalance: r2(bidUsd + askUsd ? bidUsd / (bidUsd + askUsd) : 0.5) }
  } catch { return null }
}

export interface Stats { volume24hUsd: number | null; change24hPct: number | null; fundingHourlyPct: number | null; fundingAvg24hPct: number | null }

/** 24h volume and change from the venue's stats; the last funding payment and the 24h average, percent per hour. */
export async function stats(symbol: string): Promise<Stats> {
  const out: Stats = { volume24hUsd: null, change24hPct: null, fundingHourlyPct: null, fundingAvg24hPct: null }
  try {
    const r = await fetch('https://data.velocity.exchange/stats/markets')
    const d: { markets: { symbol: string; quoteVolume?: string; priceChange24hPercent?: string }[] } = await r.json()
    const m = d.markets.find((x) => x.symbol === symbol)
    if (m) { out.volume24hUsd = m.quoteVolume ? Math.round(Number(m.quoteVolume)) : null; out.change24hPct = m.priceChange24hPercent ? r2(Number(m.priceChange24hPercent)) : null }
  } catch { /* stays null */ }
  try {
    const r = await fetch(`https://data.velocity.exchange/market/${symbol}/fundingRates?limit=24`)
    const d: { records: { fundingRate: string; oraclePriceTwap: string }[] } = await r.json()
    const rates = (d.records ?? []).filter((f) => Number(f.oraclePriceTwap) > 0).map((f) => (Number(f.fundingRate) / Number(f.oraclePriceTwap)) * 100)
    if (rates.length) { out.fundingHourlyPct = r4(rates[0]); out.fundingAvg24hPct = r4(rates.reduce((s, x) => s + x, 0) / rates.length) }
  } catch { /* stays null */ }
  return out
}

/* ---- open interest memory: the change since the last cycles ---- */
const oiFile = new URL('oi.json', dataDir)
type OiMemory = Record<string, { t: number; oi: number }[]>
const readOi = (): OiMemory => (existsSync(oiFile) ? JSON.parse(readFileSync(oiFile, 'utf8')) : {})
function rememberOi(symbol: string, oi: number): { oiChange1hPct: number | null; oiChange24hPct: number | null } {
  const mem = readOi(), now = Math.floor(Date.now() / 1000)
  const list = (mem[symbol] ?? []).filter((x) => now - x.t < 26 * 3600)
  const at = (age: number) => { const c = list.filter((x) => now - x.t >= age - 900).sort((a, b) => b.t - a.t)[0]; return c && c.oi ? r2(((oi - c.oi) / c.oi) * 100) : null }
  const out = { oiChange1hPct: at(3600), oiChange24hPct: at(24 * 3600) }
  list.push({ t: now, oi }); mem[symbol] = list
  writeFileSync(oiFile, JSON.stringify(mem))
  return out
}

export interface MarketData {
  symbol: string; coin: string; marketIndex: number
  regime: 'trend_up' | 'trend_down' | 'range' | 'chaos'   // from the 4h/1d trends and realized vol
  chaseAtr: number | null                                 // |price − 15m EMA20| in 15m ATRs: high = chasing
  oracle: number; maxLeverage: number; stepSize: number; tickSize: number
  oiLong: number; oiShort: number; oiUsd: number; oiChange1hPct: number | null; oiChange24hPct: number | null
  stats: Stats; book: Book | null
  frames: Record<Interval, Frame>
  perp: H.V.PerpMarket
}

/** Everything about every active market, fetched together. */
export async function markets(conn: Connection): Promise<MarketData[]> {
  const state = await V.getState(conn)
  if (!state) throw new Error('no exchange state')
  const out: MarketData[] = []
  for (let i = 0; i < state.numberOfMarkets; i++) {
    const perp = await V.getPerpMarket(conn, i)
    if (!perp || perp.status !== 1) continue
    const symbol = V.nameOf(perp.name)
    if (!(MARKETS as readonly string[]).includes(symbol)) continue
    const coin = symbol.replace(/-PERP$/, '')
    const oracle = Number(await V.getOraclePrice(conn, perp.oracle)) / 1e6
    const [c15, c1h, c4h, c1d, bk, st] = await Promise.all([candles(coin, '15m', 120), candles(coin, '1h', 260), candles(coin, '4h', 260), candles(coin, '1d', 120), book(symbol), stats(symbol)])
    const oiLong = Number(perp.baseAssetAmountLong) / 1e9, oiShort = Math.abs(Number(perp.baseAssetAmountShort)) / 1e9
    const oiUsd = Math.round((oiLong + oiShort) * oracle)
    const f15 = frame('15m', c15, 32), f1h = frame('1h', c1h, 24), f4h = frame('4h', c4h, 30), f1d = frame('1d', c1d, 30)
    const regime: MarketData['regime'] = f1h.realizedVolPct > 2.5 ? 'chaos' : f4h.trend === 'up' && f1d.trend !== 'down' ? 'trend_up' : f4h.trend === 'down' && f1d.trend !== 'up' ? 'trend_down' : 'range'
    const chaseAtr = f15.ema20 != null && f15.atr14 ? r2(Math.abs(oracle - f15.ema20) / f15.atr14) : null
    out.push({
      symbol, coin, marketIndex: i, oracle, regime, chaseAtr, maxLeverage: perp.marginRatioInitial ? Math.floor(10_000 / Number(perp.marginRatioInitial)) : 1,
      stepSize: Number(perp.orderStepSize) / 1e9, tickSize: Number(perp.orderTickSize) / 1e6,
      oiLong, oiShort, oiUsd, ...rememberOi(symbol, oiUsd),
      stats: st, book: bk, frames: { '15m': f15, '1h': f1h, '4h': f4h, '1d': f1d }, perp,
    })
  }
  return out
}

/** The numbers the model reads: the same data without the raw account and with a trimmed book. */
export function forModel(m: MarketData) {
  const { perp: _perp, book: bk, ...rest } = m
  return { ...rest, book: bk ? { mid: bk.mid, spreadBps: bk.spreadBps, bidUsd: bk.bidUsd, askUsd: bk.askUsd, bidShare: bk.imbalance, bids: bk.bids.slice(0, 5), asks: bk.asks.slice(0, 5) } : null }
}

const r2 = (x: number) => Math.round(x * 100) / 100
const r4 = (x: number) => Math.round(x * 10_000) / 10_000
const rn = (x: number | null, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d)
