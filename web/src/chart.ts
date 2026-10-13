/*
  chart.ts — the market chart: candles with volume, EMA 20/50/200 and VWAP, drawn with lightweight-charts
  (TradingView's open-source engine). Candles come from Hyperliquid's public market-data API (every coin the venue
  lists trades there too, and the API answers browsers); the last candle keeps moving with live prices. Scrolling
  left loads older candles until the API has no more. Lines mark the user's entry and resting orders. The agents'
  bubbles are HTML placed over the canvas with the coordinates this class gives out.
*/
import {
  CandlestickSeries, ColorType, HistogramSeries, LineSeries, LineStyle, createChart,
  type CandlestickData, type HistogramData, type IChartApi, type IPriceLine, type ISeriesApi, type LineData, type Time, type UTCTimestamp,
} from 'lightweight-charts'

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
export type Interval = (typeof INTERVALS)[number]
export const SECONDS: Record<Interval, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }
const CANDLES = 5000      // the most the API returns per request
const VISIBLE = 140       // candles on screen after a load
const LOAD_MORE_AT = 60   // candles of slack before the left edge triggers an older page

export interface Candle extends CandlestickData<Time> { volume: number }
interface Row { t: number; o: string; h: string; l: string; c: string; v: string }

/** Up to `count` candles of `coin` ("SOL", "BTC", …) at `interval` ending at `endTime` (ms), oldest first. */
export async function fetchCandles(coin: string, interval: Interval, endTime = Date.now(), count = CANDLES): Promise<Candle[]> {
  const start = endTime - count * SECONDS[interval] * 1000
  const r = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime: start, endTime } }),
  })
  if (!r.ok) throw new Error(`candles: ${r.status}`)
  const rows: Row[] = await r.json()
  return rows.map((k) => ({ time: Math.floor(k.t / 1000) as UTCTimestamp, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }))
}

function emaSeries(cs: Candle[], period: number): LineData<Time>[] {
  if (cs.length < period) return []
  const k = 2 / (period + 1)
  let e = cs.slice(0, period).reduce((s, c) => s + c.close, 0) / period
  const out: LineData<Time>[] = [{ time: cs[period - 1].time, value: e }]
  for (let i = period; i < cs.length; i++) { e = cs[i].close * k + e * (1 - k); out.push({ time: cs[i].time, value: e }) }
  return out
}
/** VWAP that resets at every UTC day, the convention of most terminals. */
function vwapSeries(cs: Candle[]): LineData<Time>[] {
  const out: LineData<Time>[] = []
  let day = -1, pv = 0, v = 0
  for (const c of cs) {
    const d = Math.floor((c.time as number) / 86400)
    if (d !== day) { day = d; pv = 0; v = 0 }
    pv += ((c.high + c.low + c.close) / 3) * c.volume; v += c.volume
    if (v > 0) out.push({ time: c.time, value: pv / v })
  }
  return out
}

export interface Indicators { ema: boolean; vwap: boolean; volume: boolean }
export type HoverHandler = (time: number | null, point: { x: number; y: number } | null, candle: Candle | null) => void

export class MarketChart {
  private chart: IChartApi
  private series: ISeriesApi<'Candlestick'>
  private volume: ISeriesApi<'Histogram'>
  private emas: { period: number; series: ISeriesApi<'Line'> }[]
  private vwap: ISeriesApi<'Line'>
  private data: Candle[] = []
  private last: Candle | null = null
  private lines: IPriceLine[] = []
  private loadingMore = false
  private exhausted = false
  private layoutCbs: (() => void)[] = []
  private up: string
  private down: string
  indicators: Indicators = { ema: true, vwap: true, volume: true }
  interval: Interval = '1h'
  coin = ''

  constructor(el: HTMLElement) {
    const css = getComputedStyle(document.documentElement)
    const v = (name: string) => css.getPropertyValue(name).trim()
    this.up = v('--long'); this.down = v('--short')
    this.chart = createChart(el, {
      autoSize: true,
      localization: { locale: 'en-US' },
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: v('--muted'), fontFamily: v('--font'), fontSize: 12, attributionLogo: false },
      grid: { vertLines: { color: v('--line') }, horzLines: { color: v('--line') } },
      rightPriceScale: { borderColor: v('--line-strong'), scaleMargins: { top: 0.06, bottom: 0.2 } },
      timeScale: { borderColor: v('--line-strong'), timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 8 },
      crosshair: { mode: 0, horzLine: { labelBackgroundColor: v('--surface-2') }, vertLine: { labelBackgroundColor: v('--surface-2') } },
    })
    this.series = this.chart.addSeries(CandlestickSeries, {
      upColor: this.up, downColor: this.down, borderVisible: false, wickUpColor: this.up, wickDownColor: this.down,
      priceFormat: { type: 'price', precision: 3, minMove: 0.001 }, priceLineColor: v('--accent'), priceLineStyle: LineStyle.Dotted,
    })
    this.volume = this.chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false })
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } })
    const line = (color: string, style = LineStyle.Solid) => this.chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: style, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false })
    this.emas = [{ period: 20, series: line('#f5c542') }, { period: 50, series: line('#5cc8ff') }, { period: 200, series: line('#c792ea') }]
    this.vwap = line('#ffffff', LineStyle.Dashed)
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range && range.from < LOAD_MORE_AT) void this.loadMore()
      for (const cb of this.layoutCbs) cb()
    })
    new ResizeObserver(() => { for (const cb of this.layoutCbs) cb() }).observe(el)
  }

  private bar(c: Candle): HistogramData<Time> { return { time: c.time, value: c.volume, color: (c.close >= c.open ? this.up : this.down) + '55' } }
  private setAll(data: Candle[]) {
    this.data = data
    this.series.setData(data)
    this.volume.setData(this.indicators.volume ? data.map((c) => this.bar(c)) : [])
    this.redrawIndicators()
    for (const cb of this.layoutCbs) cb()
  }
  private redrawIndicators() {
    for (const e of this.emas) e.series.setData(this.indicators.ema ? emaSeries(this.data, e.period) : [])
    this.vwap.setData(this.indicators.vwap ? vwapSeries(this.data) : [])
  }
  setIndicators(ind: Partial<Indicators>) { this.indicators = { ...this.indicators, ...ind }; this.volume.setData(this.indicators.volume ? this.data.map((c) => this.bar(c)) : []); this.redrawIndicators() }

  /** Loads a market's recent history and shows the last VISIBLE candles. */
  async load(coin: string, interval: Interval = this.interval): Promise<void> {
    this.coin = coin; this.interval = interval; this.exhausted = false
    const data = await fetchCandles(coin, interval)
    if (coin !== this.coin || interval !== this.interval) return   // superseded while loading
    this.setAll(data)
    this.last = data[data.length - 1] ?? null
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.length - VISIBLE), to: data.length + 6 })
  }

  /** Prepends the page of candles before the oldest one shown. Called as the user scrolls left. */
  private async loadMore(): Promise<void> {
    if (this.loadingMore || this.exhausted || !this.data.length) return
    this.loadingMore = true
    const coin = this.coin, interval = this.interval
    try {
      const first = this.data[0].time as number
      const older = (await fetchCandles(coin, interval, first * 1000 - 1)).filter((c) => (c.time as number) < first)
      if (coin !== this.coin || interval !== this.interval) return
      if (!older.length) { this.exhausted = true; return }
      const range = this.chart.timeScale().getVisibleLogicalRange()
      this.setAll([...older, ...this.data])
      if (range) this.chart.timeScale().setVisibleLogicalRange({ from: range.from + older.length, to: range.to + older.length })
    } catch { /* the next scroll tries again */ } finally { this.loadingMore = false }
  }

  /** Re-reads the last candles from the API (open, high, low, close, volume), so the chart stays live. */
  async refreshLast(): Promise<void> {
    if (!this.data.length || this.loadingMore) return
    const coin = this.coin, interval = this.interval
    try {
      const fresh = await fetchCandles(coin, interval, Date.now(), 3)
      if (coin !== this.coin || interval !== this.interval || !fresh.length) return
      let changed = false
      for (const c of fresh) {
        const i = this.data.findIndex((x) => x.time === c.time)
        if (i >= 0) this.data[i] = c
        else if ((c.time as number) > (this.data[this.data.length - 1].time as number)) this.data.push(c)
        else continue
        this.series.update(c); if (this.indicators.volume) this.volume.update(this.bar(c)); changed = true
      }
      this.last = this.data[this.data.length - 1]
      if (changed) { this.redrawIndicators(); for (const cb of this.layoutCbs) cb() }
    } catch { /* next time */ }
  }

  /** Moves the current candle with a live price (opens a new candle when the interval has rolled over). */
  tick(price: number): void {
    if (!this.last) return
    const step = SECONDS[this.interval]
    const now = Math.floor(Date.now() / 1000)
    const bucket = (Math.floor(now / step) * step) as UTCTimestamp
    if (bucket > (this.last.time as number)) { this.last = { time: bucket, open: price, high: price, low: price, close: price, volume: 0 }; this.data.push(this.last) }
    else { this.last = { ...this.last, high: Math.max(this.last.high, price), low: Math.min(this.last.low, price), close: price }; this.data[this.data.length - 1] = this.last }
    this.series.update(this.last)
    if (this.indicators.volume) this.volume.update(this.bar(this.last))
  }

  /** Horizontal lines: entry, liquidation, resting orders. Replaces the previous set. */
  setLines(lines: { price: number; color: string; title: string; dashed?: boolean }[]): void {
    for (const l of this.lines) this.series.removePriceLine(l)
    this.lines = lines.map((l) => this.series.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.dashed ? 2 : 0, axisLabelVisible: true, title: l.title }))
  }

  /* ---- for things drawn over the canvas (the agents' bubbles) ---- */
  /** Pixel position of (time, price) inside the chart element, or null when off the loaded range. */
  coordinates(time: number, price: number): { x: number; y: number } | null {
    if (!this.data.length) return null
    const bucket = this.bucketOf(time)
    const first = this.data[0].time as number, lastT = this.data[this.data.length - 1].time as number
    if (bucket < first || bucket > lastT) return null
    const x = this.chart.timeScale().timeToCoordinate(bucket as UTCTimestamp)
    const y = this.series.priceToCoordinate(price)
    if (x == null || y == null) return null
    return { x, y }
  }
  /** Called whenever the visible range, the size or the data change: reposition the overlay. */
  onLayout(cb: () => void): void { this.layoutCbs.push(cb) }
  /** The bar under the cursor (null when it leaves the chart), the cursor position, and that bar's candle. */
  onHover(cb: HoverHandler): void {
    this.chart.subscribeCrosshairMove((p) => {
      const t = p.time != null ? Number(p.time) : null
      const candle = t != null ? this.data.find((c) => (c.time as number) === t) ?? null : null
      cb(t, p.point ? { x: p.point.x, y: p.point.y } : null, candle)
    })
  }
  /** The bar time of a timestamp at the current interval. */
  bucketOf(time: number): number { const s = SECONDS[this.interval]; return Math.floor(time / s) * s }
  lastCandle(): Candle | null { return this.last }
  /** The candle before `c`, for the legend's change. */
  previous(c: Candle): Candle | null { const i = this.data.indexOf(c); return i > 0 ? this.data[i - 1] : null }

  /** The price scale needs more digits for cheap coins. */
  setPrecision(price: number): void {
    const precision = price >= 1000 ? 1 : price >= 100 ? 2 : price >= 1 ? 3 : 5
    this.series.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } })
  }

  destroy(): void { this.chart.remove() }
}
