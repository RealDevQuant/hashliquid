/*
  engine.ts — what the agents do. An agent decides once per cadence, on its own bunker; the code checks the
  decision against the limits, sizes it and sends it. The same decision is then applied to every bunker that
  hired that agent, sized for that bunker with the careful profile. Between decisions a guard watches every open
  position against its exit plan (stop, target, breakeven, trailing, time) and closes what must be closed.

  A "book" is one trading account the agent works on:
    the house book    the agent's own bunker; every move is signed with its one-time hash keys (two transactions)
    a hired book      somebody's bunker whose trading delegate is the agent's key; the agent can place and cancel
                      orders there with that key (one transaction) and nothing else: it cannot withdraw, and only
                      the owner's 24 words can hire or fire it. On a hired book the agent touches only the
                      positions and orders it opened itself.
*/
import { PublicKey, type Keypair, type TransactionInstruction } from '@solana/web3.js'
import * as H from '../src/index.ts'
import { burnDue, dailyBurn, feedBurns } from './burn.ts'
import { AGENTS, AGGR, CLIENT, CUSTOM_MODEL, PROMPT_BASE, ownerPrompt, LAUNCH_GAP_MINUTES, LAUNCH_ROUNDS, LIMITS, MAX_CUSTOM_AGENTS, MIN_CLIENT_EQUITY, OFFSETS, customDef, type AgentDef, type Limits } from './config.ts'
import { V, conn, payer, agentChain, act, clearPending, account, emptyAccount, marketOrderIx, cancelIdsIx, clientsOf, customAgents, customDelegate, delegateOf, send, log, solBalance, sleep, type AgentChain, type Account, type Client } from './chain.ts'
import { markets as readMarkets, forModel, type MarketData } from './data.ts'
import { decide, type Decision } from './brain.ts'
import { counters, logClientMove, logMove, publishFeed, readClientMoves, readClients, readMoves, readPlans, saveCounters, savePlan, type ClientEntry, type Counters, type Feed, type FeedAgent, type FeedCustom, type FeedHired, type FeedMetrics, type FeedTrade, type Move, type Plan, readPrompt } from './store.ts'

/** `dry`: decide and log, sign nothing. Set by the command line. */
export const flags = { dry: false }
const now = () => Math.floor(Date.now() / 1000)
const r2 = (x: number) => Math.round(x * 100) / 100
const GUARD_SLIPPAGE = 3          // a guard close is about getting out, not price
const RESTING_PATIENCE = 600      // seconds an entry or exit order may rest before the guard cancels and retries

export interface Ctx { quote: H.V.SpotMarket; mkts: MarketData[]; names: Map<number, string>; oracles: Map<number, number> }
export async function context(): Promise<Ctx> {
  const quote = (await V.getSpotMarket(conn, V.QUOTE_SPOT_MARKET))!
  const mkts = await readMarkets(conn)
  return { quote, mkts, names: new Map(mkts.map((m) => [m.marketIndex, m.symbol])), oracles: new Map(mkts.map((m) => [m.marketIndex, m.oracle])) }
}

/* ---------------- books ---------------- */

export interface Book { id: string; def: AgentDef; authority: PublicKey; house: AgentChain | null; delegate: Keypair | null; limits: Limits; cfg: ClientEntry['cfg'] }
export const houseBook = (def: AgentDef): Book => { const a = agentChain(def); return { id: def.id, def, authority: a.bunker, house: a, delegate: null, limits: LIMITS, cfg: null } }
/** Somebody's bunker that hired `def`: the aggressiveness its owner chose sets the limits (careful when unsaid). */
export const clientBook = (def: AgentDef, bunker: PublicKey, cfg: ClientEntry['cfg'] = null): Book => ({ id: `${def.id}@${bunker.toBase58()}`, def, authority: bunker, house: null, delegate: delegateOf(def), limits: cfg ? AGGR[cfg.aggr].limits : CLIENT, cfg })
/** A user's own agent on their bunker. */
export const customBook = (c: Client, prompt?: string | null): Book => { const cfg = c.cfg ?? { kind: 'custom' as const, base: 1 as const, aggr: 1 as const, label: 'Agent' }; return { id: `custom@${c.bunker.toBase58()}`, def: customDef(cfg, c.bunker.toBase58(), prompt), authority: c.bunker, house: null, delegate: customDelegate(), limits: AGGR[cfg.aggr].limits, cfg } }
/** The book with the owner's prompt loaded when the agent runs on one (base 4). */
const customBookWithPrompt = async (c: Client): Promise<Book> => customBook(c, c.cfg?.base === PROMPT_BASE ? await readPrompt(c.bunker.toBase58()) : null)
const tag = (b: Book) => (b.house ? b.def.id : `${b.def.id}→${b.authority.toBase58().slice(0, 4)}…`)
const snapshot = async (b: Book, c: Ctx): Promise<Account> => { const u = await V.getUser(conn, b.authority); return u ? account(u, c.quote, c.names, c.oracles) : emptyAccount() }
const record = (b: Book, m: Move) => { if (flags.dry) return; if (b.house) logMove(m); else logClientMove(b.id, m) }

/** Sends a move on a book: hash-signed on the house, signed by the delegate key on a hired bunker. */
async function run(b: Book, ixs: TransactionInstruction[], what: string): Promise<string[]> {
  if (b.house) {
    await clearPending(b.house)
    if (ixs.length !== 1) throw new Error('the house signs one instruction per key')
    return act(b.house, ixs[0], what)
  }
  return [await send(ixs, H.CU.EXECUTE, `${tag(b)} ${what}`, [b.delegate!])]
}
/** A limit order through the oracle (fills like a market order). Returns the venue's id of the order placed. */
async function place(b: Book, m: MarketData, side: 'long' | 'short', size: number, slippagePct: number, reduceOnly: boolean, what: string, user?: Awaited<ReturnType<typeof V.getUser>>): Promise<{ txs: string[]; orderId?: number }> {
  const u = user ?? await V.getUser(conn, b.authority)
  const orderId = u ? Number(u.nextOrderId) : undefined
  const ix = await marketOrderIx(b.authority, u, m.perp, side, size, m.oracle, slippagePct, reduceOnly, b.delegate?.publicKey)
  return { txs: await run(b, [ix], what), orderId }
}
/** Cancels exactly these orders of the agent, on the house and on a hired bunker alike. */
async function cancel(b: Book, acct: Account, orders: Account['orders'], what: string): Promise<string[]> {
  if (!orders.length) return []
  const ids = orders.map((o) => ({ orderId: o.orderId, marketIndex: o.marketIndex }))
  if (b.house) {   // the house signs one instruction per key: one key per cancelled order, and the other markets' orders stay
    const txs: string[] = []
    for (const ix of await cancelIdsIx(b.authority, acct.user, ids)) txs.push(...(await run(b, [ix], what)))
    return txs
  }
  return run(b, await cancelIdsIx(b.authority, acct.user, ids, b.delegate!.publicKey), what)
}
/** Polls the account for a position in the market, up to `seconds`. */
async function waitForPosition(b: Book, marketIndex: number, seconds: number): Promise<{ entry: number; size: number } | null> {
  for (let t = 0; t < seconds; t += 3) {
    await sleep(3000)
    const u = await V.getUser(conn, b.authority)
    const p = u ? V.perpPosition(u, marketIndex) : null
    if (p && p.baseAssetAmount !== 0n) { const size = Number(p.baseAssetAmount) / 1e9; return { entry: Math.abs(Number(p.quoteEntryAmount) / 1e6 / size), size: Math.abs(size) } }
  }
  return null
}

/* ---------------- the veto and the sizing ---------------- */

/** full = the agent's own decision; launch = a forced launch entry; mirror = a decision the house already took, applied to a hired bunker. */
export type Gates = 'full' | 'launch' | 'mirror'
interface Vetted { error: string | null; m?: MarketData; size?: number; notional?: number; stop?: number; target?: number | null; riskPct?: number; pos?: Account['positions'][number] }

/** The code's veto. Returns the error, or the sized move. `L` = the limits of the book. */
function vet(d: Decision, acct: Account, c: Ctx, cnt: Counters, plans: Record<string, Plan>, L: Limits, gates: Gates): Vetted {
  if (d.action === 'hold') return { error: null }
  const m = c.mkts.find((x) => x.symbol === d.market)
  if (!m) return { error: `unknown market ${d.market}` }
  const pos = acct.positions.find((p) => p.marketIndex === m.marketIndex)
  if (d.action === 'close') return pos ? { error: null, m, pos, size: pos.size, notional: r2(pos.size * m.oracle) } : { error: `no position in ${m.symbol}` }
  if (d.action === 'adjust_stop') {
    if (!pos) return { error: `no position in ${m.symbol}` }
    const plan = plans[m.symbol], stop = Number(d.stop_price)
    if (!(stop > 0)) return { error: 'stop missing' }
    if (pos.side === 'long' ? stop >= m.oracle : stop <= m.oracle) return { error: `stop ${stop} on the wrong side of the oracle ${m.oracle}` }
    if (plan && (pos.side === 'long' ? stop < plan.stop : stop > plan.stop)) return { error: `stop ${stop} would widen the current stop ${plan.stop}` }
    return { error: null, m, pos, stop }
  }
  // open
  const forced = gates === 'launch'
  if (pos) return { error: `already in ${m.symbol}: one position per market` }
  if (acct.orders.some((o) => o.marketIndex === m.marketIndex && !o.reduceOnly)) return { error: `an entry order already rests in ${m.symbol}` }
  if (acct.equity < L.minEquityUsd) return { error: `equity ${acct.equity} USDT < ${L.minEquityUsd}: only close or hold` }
  const dayPnlPct = cnt.dayStartEquity ? ((acct.equity - cnt.dayStartEquity) / cnt.dayStartEquity) * 100 : 0
  if (dayPnlPct < -L.dailyLossStopPct) return { error: `day PnL ${dayPnlPct.toFixed(1)}%: no new positions today` }
  if (cnt.peakEquity && acct.equity < cnt.peakEquity * (1 - L.drawdownKillPct / 100)) return { error: `equity ${acct.equity} is ${L.drawdownKillPct}% below the peak ${cnt.peakEquity}: only closes` }
  if (!forced && cnt.opens >= L.maxOpensPerDay) return { error: `${cnt.opens} positions opened today already` }
  const lastClose = cnt.lastCloseAt[m.symbol] ?? 0
  if (!forced && now() - lastClose < L.cooldownMinutes * 60) return { error: `closed ${m.symbol} ${Math.round((now() - lastClose) / 60)} min ago: cooling down` }
  if (!d.side) return { error: 'side missing' }
  const stop = Number(d.stop_price)
  if (!(stop > 0)) return { error: 'a stop is required' }
  const long = d.side === 'long'
  if (long ? stop >= m.oracle : stop <= m.oracle) return { error: `stop ${stop} on the wrong side of the oracle ${m.oracle}` }
  const stopPct = (Math.abs(m.oracle - stop) / m.oracle) * 100
  if (stopPct < L.minStopPct || stopPct > L.maxStopPct) return { error: `stop ${stopPct.toFixed(2)}% away: must be between ${L.minStopPct}% and ${L.maxStopPct}%` }
  // the evidence-backed gates: confidence, setup score, the trend, chasing (only the agent's own, unforced decision goes through them)
  const against = m.regime === (long ? 'trend_down' : 'trend_up')
  if (gates === 'full') {
    if ((d.confidence ?? 0) < L.minConfidence) return { error: `confidence ${d.confidence} < ${L.minConfidence}: hold` }
    const score = Number(d.setup_score ?? 0)
    if (score < (against ? L.minSetupScoreCounterTrend : L.minSetupScore)) return { error: `setup score ${score} below the bar (${against ? L.minSetupScoreCounterTrend + ', against the 4h trend' : L.minSetupScore})` }
    if (m.regime === 'chaos') return { error: `${m.symbol} is in chaos (1h realized vol ${m.frames['1h'].realizedVolPct}%): no entries` }
    if (m.chaseAtr != null && m.chaseAtr > L.chaseAtr) return { error: `chasing: price is ${m.chaseAtr} ATR from the 15m EMA20` }
  }
  const target = d.take_profit_price ? Number(d.take_profit_price) : null
  if (target == null) return { error: 'a target is required' }
  if (long ? target <= m.oracle : target >= m.oracle) return { error: `target ${target} on the wrong side` }
  const rr = Math.abs(target - m.oracle) / Math.abs(m.oracle - stop)
  const minRr = gates === 'full' ? L.minRewardRisk : 1.2
  if (rr < minRr) return { error: `reward ${rr.toFixed(2)}R < ${minRr}R` }
  if (Math.abs(target - m.oracle) / m.oracle * 100 < 3 * 2 * L.takerFeePct) return { error: 'target too close to cover fees' }
  // size: a fixed share of equity per position, never below the venue's minimum order; the stop sets the risk
  const costPct = stopPct + 2 * L.takerFeePct + L.slippagePct / 2
  let notional = Math.max(L.minOrderUsd, acct.equity * L.positionShareOfEquity * L.targetLeverage * (against ? 0.5 : 1))
  const riskPct = Math.round(((notional * costPct) / acct.equity) * 100) / 100
  if (riskPct > L.maxRiskPct) return { error: `this stop would risk ${riskPct.toFixed(1)}% of equity on the smallest allowed size: tighten it or hold` }
  notional = Math.min(notional, L.maxOrderShareOfEquity * acct.equity)
  const exposure = acct.positions.reduce((s, p) => s + p.size * (c.oracles.get(p.marketIndex) ?? p.entry), 0) + acct.orders.filter((o) => !o.reduceOnly).reduce((s, o) => s + o.size * o.price, 0)
  const room = L.maxLeverage * acct.equity * 1.02 - exposure
  if (forced && notional > room && room >= L.minOrderUsd) notional = room
  if (exposure + notional > L.maxLeverage * acct.equity * 1.02) return { error: `leverage after the move ${((exposure + notional) / acct.equity).toFixed(1)}× > ${L.maxLeverage}×` }
  const inMarkets = new Set([...acct.positions.map((p) => p.marketIndex), ...acct.orders.filter((o) => !o.reduceOnly).map((o) => o.marketIndex)])
  if (inMarkets.size >= L.maxMarketsOpen) return { error: `already in ${inMarkets.size} markets` }
  let size = Math.floor(notional / m.oracle / m.stepSize) * m.stepSize
  if (size * m.oracle < L.minOrderUsd) {   // the smallest order rounds up to the step, not down to nothing (a 21 USDT bunker at 1x still trades)
    size = Math.ceil(L.minOrderUsd / m.oracle / m.stepSize) * m.stepSize
    if (exposure + size * m.oracle > L.maxLeverage * acct.equity * 1.02) return { error: `the smallest order (${size} ${m.coin}) would take leverage past ${L.maxLeverage}×` }
  }
  return { error: null, m, size, notional: r2(size * m.oracle), stop, target, riskPct }
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { for (;;) { const k = next++; if (k >= items.length) return; out[k] = await fn(items[k], k) } }))
  return out
}
const MIRROR_AT_ONCE = 3, READ_AT_ONCE = 4

/* ---------------- one decision on one book ---------------- */

/** Vets a decision for this book, sends what passes, keeps the exit plan, records the move. */
export async function apply(b: Book, d: Decision, c: Ctx, gates: Gates): Promise<Move> {
  const L = b.limits
  const move: Move = { t: now(), agent: b.def.id, market: d.market ?? '', kind: d.action, side: d.side, thesis: d.thesis, confidence: d.confidence, txs: [], by: 'model' }
  let acct: Account
  try { acct = await snapshot(b, c) } catch (e) { move.error = `could not read the account: ${e instanceof Error ? e.message.split('\n')[0] : e}`; log(`${tag(b)}: ${move.error}`); record(b, move); return move }
  const cnt = counters(b.id, acct.equity, acct.pnl)
  const plans = readPlans()[b.id] ?? {}
  if (d.action === 'hold' && d.no_trade_reason && !move.thesis.includes(d.no_trade_reason)) move.thesis = `${move.thesis} ${d.no_trade_reason}`.trim()
  // the list of hired bunkers can be a few minutes old: the account itself says whether the agent still works here
  if (!b.house && !(acct.user && acct.user.delegate.equals(b.delegate!.publicKey))) { move.error = 'no longer hired'; return move }
  // a hired bunker too small to trade is left alone, without a line in its log every cycle
  if (!b.house && d.action === 'open' && acct.equity < MIN_CLIENT_EQUITY) { move.error = `equity ${acct.equity} USDT is below ${MIN_CLIENT_EQUITY}: left alone`; return move }
  try {
    const v = vet(d, acct, c, cnt, plans, L, gates)
    // on a hired bunker the agent closes and trails only what it opened itself
    const notMine = !b.house && (d.action === 'close' || d.action === 'adjust_stop') && v.m && !plans[v.m.symbol]
    if (v.error || notMine) { move.error = v.error ?? `not the agent's position in ${v.m!.symbol}`; log(`${tag(b)}: ${d.action} ${d.market ?? ''} not sent: ${move.error}`) }
    else if (d.action === 'open' && v.m) {
      const m = v.m
      move.size = v.size; move.price = m.oracle; move.notional = v.notional; move.stop = v.stop; move.target = v.target ?? undefined; move.invalidation = d.invalidation; move.riskPct = v.riskPct
      if (flags.dry) log(`${tag(b)} (dry): open ${d.side} ${m.symbol} ${v.size} (${v.notional} USDT) stop ${v.stop} target ${v.target ?? '-'}`)
      else {
        // the plan goes to disk before the order goes out: whatever fails after the send, the position has its stop
        const u = await V.getUser(conn, b.authority)
        const plan: Plan = { side: d.side!, entry: m.oracle, stop: v.stop!, target: v.target ?? null, invalidation: d.invalidation ?? '', thesis: d.thesis, openedAt: now(), initialRisk: r2((v.notional! * Math.abs(m.oracle - v.stop!)) / m.oracle), atr: m.frames['1h'].atr14, filled: false, entryOrderId: u ? Number(u.nextOrderId) : undefined }
        savePlan(b.id, m.symbol, plan)
        const placed = await place(b, m, d.side!, v.size!, L.slippagePct, false, `open ${d.side} ${m.symbol}`, u)   // if this throws the guard drops the plan (no order, no position) or adopts the position
        move.txs = placed.txs
        let filled: Awaited<ReturnType<typeof waitForPosition>> = null
        try { filled = await waitForPosition(b, m.marketIndex, 15) } catch (e) { log(`${tag(b)}: could not confirm the fill (${e instanceof Error ? e.message.split('\n')[0] : e}); the guard will`) }
        const entry = filled?.entry ?? m.oracle
        savePlan(b.id, m.symbol, { ...plan, entry, initialRisk: r2((v.notional! * Math.abs(entry - v.stop!)) / entry), filled: !!filled })
        if (filled) move.price = filled.entry; else log(`${tag(b)}: ${m.symbol} entry is resting on the book`)
        cnt.opens += 1; saveCounters(b.id, cnt)
      }
    } else if (d.action === 'close' && v.m && v.pos) {
      const m = v.m, pos = v.pos
      move.side = pos.side === 'long' ? 'short' : 'long'; move.size = pos.size; move.price = m.oracle; move.notional = v.notional
      if (flags.dry) log(`${tag(b)} (dry): close ${m.symbol}`)
      else {
        const placed = await place(b, m, move.side, pos.size, L.slippagePct, true, `close ${m.symbol}`)
        move.txs = placed.txs
        const plan = plans[m.symbol] ?? { side: pos.side, entry: pos.entry, stop: pos.entry, target: null, invalidation: '', thesis: d.thesis, openedAt: now(), initialRisk: 0, atr: null }
        savePlan(b.id, m.symbol, { ...plan, closingAt: now(), exitOrderId: placed.orderId }); cnt.lastCloseAt[m.symbol] = now(); saveCounters(b.id, cnt)
      }
    } else if (d.action === 'adjust_stop' && v.m && v.pos) {
      const plan = plans[v.m.symbol]
      move.stop = v.stop; move.price = v.m.oracle
      if (!flags.dry) savePlan(b.id, v.m.symbol, { ...(plan ?? { side: v.pos.side, entry: v.pos.entry, target: null, invalidation: '', thesis: d.thesis, openedAt: now(), initialRisk: 0, atr: null }), stop: v.stop! })
      log(`${tag(b)}: stop on ${v.m.symbol} → ${v.stop}`)
    } else log(`${tag(b)}: hold · ${d.thesis.slice(0, 100)}`)
  } catch (e) {
    move.error = e instanceof Error ? e.message.split('\n')[0] : String(e)
    log(`${tag(b)}: ERROR ${move.error}`)
  }
  if (flags.dry && b.house) log(`${tag(b)} (dry, not logged): ${move.kind} ${move.market} ${move.side ?? ''} · ${move.thesis.slice(0, 140)}`)
  record(b, move)
  return move
}

/** Applies a decision the agent just took on its own bunker to every bunker that hired it. */
export async function mirror(def: AgentDef, d: Decision, c: Ctx): Promise<number> {
  const clients = await clientsOf(def, houseBook(def).authority)
  let done = 0
  await mapLimit(clients, MIRROR_AT_ONCE, async (cl) => {
    try { const m = await apply(clientBook(def, cl.bunker, cl.cfg), d, c, 'mirror'); if (!m.error) done++ } catch (e) { log(`${def.id}→${cl.bunker.toBase58().slice(0, 4)}…: ${e instanceof Error ? e.message : e}`) }
  })
  if (clients.length) log(`${def.id}: ${d.action} ${d.market ?? ''} applied to ${done} of ${clients.length} hired bunkers`)
  return done
}

/* ---------------- the agent's own decision ---------------- */

/** What the other agents hold and said, for the banter. */
async function desk(me: string, c: Ctx) {
  const out: { name: string; style: string; positions: unknown[]; lastNote: string | null; lastNoteAgo: string | null }[] = []
  for (const d of AGENTS) {
    if (d.id === me) continue
    const acct = await snapshot(houseBook(d), c)
    const last = [...readMoves(d.id, 50)].reverse().find((m) => m.thesis && m.by !== 'guard')
    out.push({ name: d.name, style: d.strategy, positions: acct.positions.map(({ marketIndex: _i, ...p }) => p), lastNote: last ? last.thesis.slice(0, 400) : null, lastNoteAgo: last ? `${Math.round((now() - last.t) / 60)} min ago` : null })
  }
  return out
}

export async function oneAgent(def: AgentDef, c: Ctx, forced?: { market: string }): Promise<void> {
  const b = houseBook(def)
  let d: Decision
  try {
    if (!flags.dry) await clearPending(b.house!)
    const acct = await snapshot(b, c)
    const cnt = counters(b.id, acct.equity, acct.pnl)
    const plans = readPlans()[b.id] ?? {}
    const positions = acct.positions.map(({ marketIndex: _i, ...p }) => ({ ...p, plan: plans[p.market] ? { stop: plans[p.market].stop, target: plans[p.market].target, invalidation: plans[p.market].invalidation, thesis: plans[p.market].thesis, hoursHeld: r2((now() - plans[p.market].openedAt) / 3600), initialRiskUsd: plans[p.market].initialRisk } : null }))
    const snap = {
      markets: c.mkts.map(forModel),
      account: { equity: acct.equity, collateral: acct.collateral, realizedTotal: acct.realized, dayPnlPct: acct.equity > 0 ? r2(((acct.pnl - (cnt.dayStartPnl ?? acct.pnl)) / acct.equity) * 100) : 0, peakEquity: cnt.peakEquity, opensToday: cnt.opens, hoursFlat: acct.positions.length ? 0 : hoursFlat(def.id), positions },
    }
    d = await decide(def, { ...snap, lessons: lessons(def.id), desk: await desk(def.id, c) }, readMoves(def.id, 6), forced)
    if (forced) {
      // a launch entry: the market is given; if the model still would not open, the code opens with the trend
      const fm = c.mkts.find((x) => x.symbol === forced.market)!
      if (d.action === 'open' && d.market === forced.market && d.side && d.stop_price && !d.take_profit_price) {
        const dist = Math.abs(fm.oracle - Number(d.stop_price))
        d.take_profit_price = d.side === 'short' ? fm.oracle - 1.6 * dist : fm.oracle + 1.6 * dist
      }
      if (d.action === 'open' && !d.thesis) d.thesis = `Launch day on ${fm.coin}: ${d.side} at ${fm.oracle}, stop ${d.stop_price}, target ${Number(d.take_profit_price).toFixed(2)}.`
      if (d.action !== 'open' || d.market !== forced.market || !d.side || !d.stop_price) {
        const atr = fm.frames['1h'].atr14 ?? fm.oracle * 0.01
        const short = fm.regime === 'trend_down' || (fm.regime !== 'trend_up' && fm.frames['1h'].ema20 != null && fm.oracle < fm.frames['1h'].ema20)
        d = { action: 'open', market: fm.symbol, side: short ? 'short' : 'long', stop_price: short ? fm.oracle + 1.5 * atr : fm.oracle - 1.5 * atr, take_profit_price: short ? fm.oracle - 2.5 * atr : fm.oracle + 2.5 * atr, invalidation: `${short ? 'A close above' : 'A close below'} ${(short ? fm.oracle + 1.5 * atr : fm.oracle - 1.5 * atr).toFixed(2)}`, thesis: `${d.thesis ? d.thesis + ' ' : ''}Launch day on ${fm.coin}: ${short ? 'short' : 'long'} with the ${fm.regime.replace('_', ' ')} at ${fm.oracle}, stop 1.5 ATR away, target 2.5 ATR.`, confidence: Math.max(d.confidence ?? 0.5, 0.5), setup_score: 5, regime: fm.regime }
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e.message.split('\n')[0] : String(e)
    log(`${def.id}: ERROR ${error}`)
    record(b, { t: now(), agent: def.id, market: '', kind: 'hold', thesis: '', txs: [], by: 'model', error })
    return
  }
  const move = await apply(b, d, c, forced ? 'launch' : 'full')
  // the bunkers that hired this agent get what it actually did
  if (d.action !== 'hold' && !move.error) await mirror(def, d, c)
}

/* ---------------- user-made agents: each decides for its own bunker ---------------- */

const customDecided = new Map<string, number>()
const CUSTOM_PER_PASS = 6
/** The custom agents whose turn it is (by the cadence of their aggressiveness), each on the cheaper model. */
export async function customCycle(c: Ctx): Promise<number> {
  const all = (await customAgents()).slice(0, MAX_CUSTOM_AGENTS)   // the rest is queued: shown on the site, not run
  const due = (await Promise.all(all.map(customBookWithPrompt)))
    .filter((b) => Date.now() - (customDecided.get(b.id) ?? 0) >= AGGR[b.cfg!.aggr].cadenceMinutes * 60_000)
    .sort((x, y) => (customDecided.get(x.id) ?? 0) - (customDecided.get(y.id) ?? 0))
    .slice(0, CUSTOM_PER_PASS)   // a pass stays short, so the guard keeps its cadence; the others go next pass
  let ran = 0
  for (const b of due) {
    customDecided.set(b.id, Date.now())
    try {
      const acct = await snapshot(b, c)
      if (!acct.user || !acct.user.delegate.equals(b.delegate!.publicKey)) continue
      if (acct.equity < MIN_CLIENT_EQUITY && !acct.positions.length) continue
      const cnt = counters(b.id, acct.equity, acct.pnl)
      const plans = readPlans()[b.id] ?? {}
      const positions = acct.positions.filter((p) => plans[p.market]).map(({ marketIndex: _i, ...p }) => ({ ...p, plan: { stop: plans[p.market].stop, target: plans[p.market].target, invalidation: plans[p.market].invalidation, thesis: plans[p.market].thesis, hoursHeld: r2((now() - plans[p.market].openedAt) / 3600), initialRiskUsd: plans[p.market].initialRisk } }))
      const snap = { markets: c.mkts.map(forModel), account: { equity: acct.equity, collateral: acct.collateral, realizedTotal: acct.realized, dayPnlPct: acct.equity > 0 ? r2(((acct.pnl - (cnt.dayStartPnl ?? acct.pnl)) / acct.equity) * 100) : 0, peakEquity: cnt.peakEquity, opensToday: cnt.opens, hoursFlat: positions.length ? 0 : hoursFlatOf(readClientMoves(b.id, 500)), positions } }
      const d = await decide(b.def, { ...snap, lessons: lessonsOf(readClientMoves(b.id, 500)), desk: await desk('', c) }, readClientMoves(b.id, 6), undefined, CUSTOM_MODEL)
      await apply(b, d, c, 'full')
      ran++
    } catch (e) { log(`${tag(b)}: ${e instanceof Error ? e.message.split('\n')[0] : e}`) }
  }
  return ran
}

/** One line per pattern in the agent's own closed trades, computed here, never written by the model. */
function lessons(agent: string): string[] { return lessonsOf(readMoves(agent, 500)) }
function lessonsOf(moves: Move[]): string[] {
  const closes = moves.filter((m) => m.kind === 'close' && m.txs.length && !m.error)
  const out: string[] = []
  const stopped = closes.filter((m) => /^Stop hit/.test(m.thesis))
  const targets = closes.filter((m) => /^Target hit/.test(m.thesis))
  if (closes.length) out.push(`${closes.length} closed trades: ${stopped.length} stopped out, ${targets.length} hit the target, ${closes.length - stopped.length - targets.length} closed otherwise.`)
  const lastTwo = closes.slice(-2)
  if (lastTwo.length === 2 && lastTwo.every((m) => /^Stop hit/.test(m.thesis))) out.push('The last two trades were both stopped out: the next entry needs a cleaner setup, not a faster one.')
  const opens = moves.filter((m) => m.kind === 'open' && m.txs.length && !m.error)
  const longs = opens.filter((m) => m.side === 'long').length
  if (opens.length >= 4 && (longs / opens.length > 0.8 || longs / opens.length < 0.2)) out.push(`${longs} of your last ${opens.length} entries were longs: check for a directional bias that the 4h trend does not justify.`)
  const vetoed = moves.filter((m) => m.kind === 'open' && m.error).slice(-5)
  if (vetoed.length >= 3) out.push(`${vetoed.length} of your recent entries were rejected by the code (${vetoed[vetoed.length - 1].error}): fix the setup, not the wording.`)
  return out
}

/** Round trips paired from the log: each open with the close that followed it in that market. */
function tradesOf(agent: string, openPositions: { market: string; entry: number }[]): FeedTrade[] { return tradesFrom(readMoves(agent, 1000), openPositions) }
function tradesFrom(moves: Move[], openPositions: { market: string; entry: number }[]): FeedTrade[] {
  const out: FeedTrade[] = []
  const pending = new Map<string, FeedTrade>()
  for (const m of moves) {
    if (m.error || !m.txs.length) continue
    if (m.kind === 'open' && m.side && m.size && m.price) {
      const t: FeedTrade = { market: m.market, side: m.side, size: m.size, entry: m.price, exit: null, openedAt: m.t, closedAt: null, pnl: null, pnlPct: null, reason: '', txs: [...m.txs] }
      pending.set(m.market, t); out.push(t)
    } else if (m.kind === 'close' && !m.price) {
      // the guard cancelled a resting entry: that open never became a trade
      const t = pending.get(m.market)
      if (t) { out.splice(out.indexOf(t), 1); pending.delete(m.market) }
    } else if (m.kind === 'close' && m.price) {
      const t = pending.get(m.market)
      if (!t) continue
      t.exit = m.price; t.closedAt = m.t; t.txs.push(...m.txs)
      const dir = t.side === 'long' ? 1 : -1
      t.pnl = r2((t.exit - t.entry) * t.size * dir - t.size * (t.entry + t.exit) * (LIMITS.takerFeePct / 100))
      t.pnlPct = r2(((t.exit - t.entry) / t.entry) * 100 * dir)
      t.reason = /^Stop hit/.test(m.thesis) ? 'stop' : /^Target hit/.test(m.thesis) ? 'target' : /^Time exit/.test(m.thesis) ? 'time' : m.by === 'guard' ? 'guard' : 'closed'
      pending.delete(m.market)
    }
  }
  // the entry of a still-open trade is the real fill, from the plan
  for (const t of out) if (t.exit == null) { const p = openPositions.find((x) => x.market === t.market); if (p) t.entry = p.entry }
  return out.reverse()   // newest first
}

/** Hours since the agent last opened or closed something (or since its first decision). */
function hoursFlat(agent: string): number { return hoursFlatOf(readMoves(agent, 500)) }
function hoursFlatOf(moves: Move[]): number {
  const last = [...moves].reverse().find((m) => (m.kind === 'open' || m.kind === 'close') && !m.error) ?? moves[0]
  return last ? r2((now() - last.t) / 3600) : 0
}

/* ---------------- the guard: stops, targets, breakeven, trailing, time, and orders left on the book ---------------- */

export async function guard(b: Book, c: Ctx): Promise<boolean> {
  const L = b.limits
  const acct = await snapshot(b, c)
  const plans = readPlans()[b.id] ?? {}
  if (!b.house) {
    // a hired bunker stays in the agent's care only while its delegate is the agent's key
    const still = acct.user && acct.user.delegate.equals(b.delegate!.publicKey)
    if (!still) { for (const symbol of Object.keys(plans)) savePlan(b.id, symbol, null); if (Object.keys(plans).length) log(`${tag(b)}: no longer hired, plans dropped`); return false }
  }
  if (!acct.positions.length && !Object.keys(plans).length) return false
  const cnt = counters(b.id, acct.equity, acct.pnl)
  let changed = false
  const note = (m: Partial<Move> & { market: string; thesis: string }) => { record(b, { t: now(), agent: b.def.id, kind: 'hold', txs: [], by: 'guard', ...m }); changed = true }
  const mine = (plan: Plan, o: Account['orders'][number]) => !!b.house || o.orderId === plan.entryOrderId || o.orderId === plan.exitOrderId

  // 1. plans whose position is gone: an entry that never filled, or an exit that did
  for (const [symbol, plan] of Object.entries(plans)) {
    const m = c.mkts.find((x) => x.symbol === symbol)
    if (!m || acct.positions.some((p) => p.marketIndex === m.marketIndex)) continue
    const resting = acct.orders.filter((o) => o.marketIndex === m.marketIndex && mine(plan, o))
    if (plan.filled === false) {
      if (!resting.length) { savePlan(b.id, symbol, null); note({ market: symbol, thesis: `The entry order on ${symbol} is no longer on the book and no position exists: plan dropped.` }); continue }
      if (now() - plan.openedAt < RESTING_PATIENCE) continue
      try { if (!flags.dry) { const txs = await cancel(b, acct, resting, `guard cancel resting entry ${symbol}`); savePlan(b.id, symbol, null); note({ market: symbol, kind: 'close', side: plan.side, txs, thesis: `The entry order on ${symbol} rested ${Math.round((now() - plan.openedAt) / 60)} minutes without filling: cancelled.` }) } }
      catch (e) { log(`${tag(b)}: cancel failed: ${e instanceof Error ? e.message : e}`) }
      continue
    }
    // it was filled and now it is gone: closed by an exit order (or by its owner, or liquidated)
    savePlan(b.id, symbol, null); cnt.lastCloseAt[symbol] = now(); saveCounters(b.id, cnt)
    note({ market: symbol, thesis: `${symbol} position closed at ${c.oracles.get(m.marketIndex) ?? '?'}${plan.closingAt ? '' : ' (not by this guard)'}.` })
    if (resting.length) { try { if (!flags.dry) await cancel(b, acct, resting, `guard cancel leftovers ${symbol}`) } catch { /* next pass */ } }
  }

  // 2. open positions: finish closes in progress, then stops, targets, breakeven, trailing
  for (const pos of acct.positions) {
    const m = c.mkts.find((x) => x.marketIndex === pos.marketIndex)
    if (!m) continue
    let plan = plans[m.symbol]
    if (!plan) {
      if (!b.house) continue   // a hired bunker: a position the agent didn't open is its owner's business
      plan = { side: pos.side, entry: pos.entry, stop: pos.side === 'long' ? pos.entry * (1 - L.defaultStopPct / 100) : pos.entry * (1 + L.defaultStopPct / 100), target: null, invalidation: '', thesis: '', openedAt: now(), initialRisk: r2((pos.size * pos.entry * L.defaultStopPct) / 100), atr: m.frames['1h'].atr14, filled: true }
      savePlan(b.id, m.symbol, plan)
    }
    if (plan.filled === false) { plan = { ...plan, filled: true, entry: pos.entry, initialRisk: r2(pos.size * Math.abs(pos.entry - plan.stop)) }; savePlan(b.id, m.symbol, plan) }
    const held = plan
    const long = pos.side === 'long', px = m.oracle
    const exits = acct.orders.filter((o) => o.marketIndex === m.marketIndex && o.reduceOnly && mine(held, o))
    const sendClose = async (why: string, label: string) => {
      const move: Move = { t: now(), agent: b.def.id, market: m.symbol, kind: 'close', side: long ? 'short' : 'long', size: pos.size, price: px, notional: r2(pos.size * px), thesis: why, txs: [], by: 'guard' }
      try {
        if (!flags.dry) {
          if (exits.length) await cancel(b, acct, exits, `guard cancel stale exit ${m.symbol}`)   // one fresh order instead of a pile
          const placed = await place(b, m, move.side!, pos.size, GUARD_SLIPPAGE, true, `guard close ${m.symbol} (${label})`)
          move.txs = placed.txs
          savePlan(b.id, m.symbol, { ...held, closingAt: now(), exitOrderId: placed.orderId })
        }
        log(`${tag(b)}: guard closing ${m.symbol} (${label})`)
      } catch (e) { move.error = e instanceof Error ? e.message.split('\n')[0] : String(e); log(`${tag(b)}: guard close failed: ${move.error}`) }
      record(b, move); changed = true
    }
    if (held.closingAt) {
      if (exits.length && now() - held.closingAt < RESTING_PATIENCE) continue   // the exit is on the book: give it time
      await sendClose(`Still closing ${m.symbol}: the exit order did not fill within ${Math.round(RESTING_PATIENCE / 60)} minutes, sent again at ${px}.`, 'retry')
      continue
    }
    const hitStop = long ? px <= held.stop : px >= held.stop
    const hitTarget = held.target != null && (long ? px >= held.target : px <= held.target)
    if (hitStop || hitTarget) {
      const why = hitStop ? `Stop hit: ${m.symbol} at ${px}, stop was ${held.stop}.` : `Target hit: ${m.symbol} at ${px}, target was ${held.target}.`
      await sendClose(`${why} ${held.thesis ? 'The idea was: ' + held.thesis : ''}`.trim(), hitStop ? 'stop' : 'target')
      continue
    }
    const rDist = held.initialRisk && pos.size ? held.initialRisk / pos.size : Math.abs(held.entry - held.stop)
    const profitR = rDist ? (long ? px - held.entry : held.entry - px) / rDist : 0
    // a position that never got going is a position that is wrong: time exit
    const hoursHeld = (now() - held.openedAt) / 3600
    if (hoursHeld > L.maxHoursNoProgress && profitR < 0.5 && (long ? held.stop < held.entry : held.stop > held.entry)) {
      await sendClose(`Time exit: ${m.symbol} held ${hoursHeld.toFixed(1)} hours without reaching +0.5R (now ${profitR.toFixed(2)}R at ${px}).`, 'time')
      continue
    }
    // breakeven at +1R, then a trailing stop at trailAtr × ATR behind the price, never backwards
    let newStop = held.stop
    if (profitR >= L.breakevenAtR && (long ? held.stop < held.entry : held.stop > held.entry)) newStop = held.entry
    const atr = m.frames['1h'].atr14 ?? held.atr
    if (atr && profitR >= L.breakevenAtR) { const trail = long ? px - L.trailAtr * atr : px + L.trailAtr * atr; if (long ? trail > newStop : trail < newStop) newStop = trail }
    newStop = Math.round(newStop / m.tickSize) * m.tickSize
    if (newStop !== held.stop) {
      savePlan(b.id, m.symbol, { ...held, stop: newStop })
      note({ market: m.symbol, kind: 'adjust_stop', side: pos.side, price: px, stop: newStop, thesis: `Stop moved to ${r2(newStop)} on ${m.symbol} (${profitR.toFixed(1)}R in profit).` })
    }
  }
  return changed
}

/** Every book with something to watch: the three houses, and each hired bunker or custom agent that has a plan. */
function booksToGuard(): Book[] {
  const out: Book[] = AGENTS.map(houseBook)
  const known = readClients()
  const cfgOf = (key: string, bunker: string) => known[key]?.bunkers.find((e) => e.bunker === bunker)?.cfg ?? null
  for (const id of Object.keys(readPlans())) {
    const [agent, bunker] = id.split('@')
    if (!bunker || !Object.keys(readPlans()[id] ?? {}).length) continue
    try {
      const pk = new PublicKey(bunker)
      if (agent === 'custom') out.push(customBook({ bunker: pk, cfg: cfgOf('custom', bunker) }))
      else { const def = AGENTS.find((a) => a.id === agent); if (def) out.push(clientBook(def, pk, cfgOf(agent, bunker))) }
    } catch { /* not an address */ }
  }
  return out
}

/* ---------------- the feed ---------------- */

async function feedAgent(def: AgentDef, c: Ctx): Promise<FeedAgent> {
  const b = houseBook(def)
  const acct = await snapshot(b, c)
  const cnt = counters(def.id, acct.equity, acct.pnl)
  const plans = readPlans()[def.id] ?? {}
  const moves = readMoves(def.id, 100)
  const last = [...moves].reverse().find((x) => x.thesis)
  const trades = tradesOf(def.id, acct.positions)
  const closed = trades.filter((t) => t.pnl != null)
  const start = acct.netDeposits > 0 ? acct.netDeposits : (cnt.startEquity || cnt.dayStartEquity)
  // the bunkers that hired it, and the equity it manages there
  const clients = await clientsOf(def, b.authority)
  let aum = 0
  for (const eq of await mapLimit(clients, READ_AT_ONCE, (cl) => snapshot(clientBook(def, cl.bunker, cl.cfg), c).then((a) => a.equity).catch(() => 0))) aum += eq
  const bunkers = clients
  return {
    id: def.id, name: def.name, color: def.color, initials: def.initials, avatar: def.avatar, persona: def.persona, strategy: def.strategy, bunker: b.authority.toBase58(),
    equity: acct.equity, collateral: acct.collateral, realized: acct.realized,
    dayPnlPct: acct.equity > 0 ? r2(((acct.pnl - (cnt.dayStartPnl ?? acct.pnl)) / acct.equity) * 100) : null, opensToday: cnt.opens, peakEquity: cnt.peakEquity,
    startEquity: start, allTimePnl: r2(acct.equity - start), allTimePct: start ? r2(((acct.equity - start) / start) * 100) : 0,
    delegate: delegateOf(def).publicKey.toBase58(), clients: bunkers.length, aum: r2(aum),
    trades, wins: closed.filter((t) => t.pnl! > 0).length, losses: closed.filter((t) => t.pnl! <= 0).length,
    positions: acct.positions.map(({ marketIndex: _i, ...p }) => ({ ...p, stop: plans[p.market]?.stop, target: plans[p.market]?.target ?? null, invalidation: plans[p.market]?.invalidation })),
    orders: acct.orders.map(({ marketIndex: _i, ...o }) => o),
    lastThesis: last?.thesis ?? null, lastAt: last?.t ?? null, moves,
  }
}
/** What a hired bunker looks like in public: Ash for Bob. */
async function feedHired(def: AgentDef, cl: Client, c: Ctx): Promise<FeedHired> {
  const b = clientBook(def, cl.bunker, cl.cfg)
  const acct = await snapshot(b, c)
  if (!acct.user || !acct.user.delegate.equals(b.delegate!.publicKey)) throw new Error('no longer hired')   // the listing can be minutes old: the chain decides
  const plans = readPlans()[b.id] ?? {}
  const mine = acct.positions.filter((p) => plans[p.market])
  return { agent: def.id, bunker: cl.bunker.toBase58(), label: cl.cfg?.label ?? '', aggr: cl.cfg?.aggr ?? 1, equity: acct.equity, positions: mine.map(({ marketIndex: _i, ...p }) => ({ ...p, stop: plans[p.market]?.stop, target: plans[p.market]?.target ?? null })), trades: tradesFrom(readClientMoves(b.id, 500), mine).slice(0, 20) }
}
async function feedCustom(cl: Client, queued: boolean, c: Ctx): Promise<FeedCustom> {
  const b = await customBookWithPrompt(cl)
  const acct = await snapshot(b, c)
  if (!acct.user || !acct.user.delegate.equals(b.delegate!.publicKey)) throw new Error('switched off')   // the listing can be minutes old: the chain decides
  const cnt = counters(b.id, acct.equity, acct.pnl)
  const plans = readPlans()[b.id] ?? {}
  const moves = readClientMoves(b.id, 100)
  const mine = acct.positions.filter((p) => plans[p.market])
  const trades = tradesFrom(moves, mine)
  const closed = trades.filter((t) => t.pnl != null)
  const last = [...moves].reverse().find((x) => x.thesis)
  const start = acct.netDeposits > 0 ? acct.netDeposits : (cnt.startEquity || cnt.dayStartEquity)
  return {
    bunker: cl.bunker.toBase58(), label: b.def.name, base: b.cfg!.base, aggr: b.cfg!.aggr, color: b.def.color, initials: b.def.initials, strategy: b.def.strategy,
    equity: acct.equity, startEquity: start, allTimePnl: r2(acct.equity - start), positions: mine.map(({ marketIndex: _i, ...p }) => ({ ...p, stop: plans[p.market]?.stop, target: plans[p.market]?.target ?? null })),
    trades: trades.slice(0, 20), wins: closed.filter((t) => t.pnl! > 0).length, losses: closed.filter((t) => t.pnl! <= 0).length,
    lastThesis: last?.thesis ?? null, lastAt: last?.t ?? null, moves: moves.slice(-20), queued,
    prompt: cl.cfg?.base === PROMPT_BASE ? ownerPrompt((await readPrompt(cl.bunker.toBase58())) ?? '') || null : null,
  }
}
export async function publish(c: Ctx): Promise<void> {
  const feed: Feed = { updatedAt: now(), cadenceMinutes: LIMITS.cadenceMinutes, agents: [], hired: [], custom: [], metrics: { agentsDeployed: 0, hiredBunkers: 0, customAgents: 0, positionsOpen: 0, tradesTotal: 0, volumeUsd: 0, aum: 0, burnedUsd: 0 }, burns: feedBurns() }
  for (const def of AGENTS) {
    feed.agents.push(await feedAgent(def, c))
    for (const h of await mapLimit(await clientsOf(def, houseBook(def).authority), READ_AT_ONCE, (cl) => feedHired(def, cl, c).catch(() => null))) if (h) feed.hired.push(h)
  }
  for (const x of await mapLimit(await customAgents(), READ_AT_ONCE, (cl, i) => feedCustom(cl, i >= MAX_CUSTOM_AGENTS, c).catch(() => null))) if (x) feed.custom.push(x)
  const m: FeedMetrics = feed.metrics
  const allTrades = [...feed.agents.flatMap((a) => a.trades), ...feed.hired.flatMap((h) => h.trades), ...feed.custom.flatMap((x) => x.trades)]
  const running = feed.custom.filter((x) => !x.queued).length
  m.agentsDeployed = feed.agents.length + feed.hired.length + running
  m.hiredBunkers = feed.hired.length; m.customAgents = running
  m.positionsOpen = feed.agents.reduce((s, a) => s + a.positions.length, 0) + feed.hired.reduce((s, h) => s + h.positions.length, 0) + feed.custom.reduce((s, x) => s + x.positions.length, 0)
  m.tradesTotal = allTrades.length
  m.volumeUsd = r2(allTrades.reduce((s, t) => s + t.size * t.entry + (t.exit != null ? t.size * t.exit : 0), 0))
  m.aum = r2(feed.agents.reduce((s, a) => s + a.equity, 0) + feed.hired.reduce((s, h) => s + h.equity, 0) + feed.custom.reduce((s, x) => s + x.equity, 0))
  m.burnedUsd = feed.burns.totalUsd
  log(`feed published: ${await publishFeed(feed)}`)
}

/* ---------------- the loops ---------------- */

export async function decisionCycle(agents: AgentDef[] = AGENTS, done?: (id: string) => void): Promise<void> {
  const started = Date.now()
  const c = await context()
  const sol = await solBalance(payer.publicKey)
  log(`cycle (${agents.map((a) => a.id).join(', ')}) · ${c.mkts.map((m) => `${m.coin} ${m.oracle}`).join(' · ')} · payer ${sol} SOL${sol < 0.05 ? ' · LOW: top the fee payer up' : ''}`)
  for (const def of agents) { await oneAgent(def, c); done?.(def.id) }
  await sleep(10_000)   // the public RPC can lag a few seconds behind the moves just made
  await publish(await context())
  log(`cycle took ${Math.round((Date.now() - started) / 1000)}s`)
}
export async function guardPass(): Promise<void> {
  const c = await context()
  let changed = false
  for (const b of booksToGuard()) { try { if (await guard(b, c)) changed = true } catch (e) { log(`${tag(b)}: guard error ${e instanceof Error ? e.message : e}`) } }
  if (changed) { await sleep(4000); await publish(await context()) }
}

/** Launch day: round 1 now, round 2 five minutes later, each agent on its assigned market. */
export async function launch(): Promise<void> {
  // start clean: every open position of the houses is closed first, so the six launch trades are the whole book
  {
    const c = await context()
    for (const def of AGENTS) {
      const b = houseBook(def)
      const acct = await snapshot(b, c)
      for (const pos of acct.positions) {
        const m = c.mkts.find((x) => x.marketIndex === pos.marketIndex); if (!m) continue
        const move: Move = { t: now(), agent: def.id, market: m.symbol, kind: 'close', side: pos.side === 'long' ? 'short' : 'long', size: pos.size, price: m.oracle, notional: r2(pos.size * m.oracle), thesis: `Flat before launch: closing ${m.symbol} at ${m.oracle}.`, txs: [], by: 'guard' }
        try { if (!flags.dry) { move.txs = (await place(b, m, move.side!, pos.size, GUARD_SLIPPAGE, true, `flatten ${m.symbol}`)).txs; savePlan(def.id, m.symbol, null) } log(`${def.id}: flattened ${m.symbol}`) }
        catch (e) { move.error = e instanceof Error ? e.message.split('\n')[0] : String(e); log(`${def.id}: flatten failed: ${move.error}`) }
        record(b, move)
      }
    }
    if (!flags.dry) await sleep(20_000)
  }
  for (const [i, round] of LAUNCH_ROUNDS.entries()) {
    const c = await context()
    log(`launch round ${i + 1} · ${Object.entries(round).map(([k, v]) => `${k}→${v.replace('-PERP', '')}`).join(' ')}`)
    for (const def of AGENTS) { const market = round[def.id]; if (market) await oneAgent(def, c, { market }) }
    await sleep(10_000)
    await publish(await context())
    const gap = Number(process.env.LAUNCH_GAP ?? LAUNCH_GAP_MINUTES)
    if (i < LAUNCH_ROUNDS.length - 1) { log(`next round in ${gap} min`); await sleep(gap * 60_000) }
  }
  log('launch done')
}

/** Forever: every GUARD minutes the guard for every book, then the decision of the agents whose slot has come, then a few custom agents. */
export async function loop(): Promise<never> {
  const GUARD_MS = LIMITS.guardMinutes * 60_000
  const decided = new Map<string, number>(AGENTS.map((a) => [a.id, Date.now()]))   // after a restart each agent waits for its next slot
  const slotStart = (off: number) => { const m = Math.floor(Date.now() / 60_000); const k = (((m - off) % LIMITS.cadenceMinutes) + LIMITS.cadenceMinutes) % LIMITS.cadenceMinutes; return (m - k) * 60_000 }
  const safely = async (what: string, f: () => Promise<unknown>) => { try { await f() } catch (e) { log(`${what} error:`, e instanceof Error ? e.message : e) } }
  for (;;) {
    const started = Date.now()
    await safely('guard', guardPass)
    await safely('decision', async () => {
      const due = AGENTS.filter((a) => (decided.get(a.id) ?? 0) < slotStart(OFFSETS[a.id] ?? 0))   // its slot started after its last decision
      if (due.length) await decisionCycle(due, (id) => decided.set(id, Date.now()))
    })
    if (burnDue()) await safely('burn', async () => dailyBurn(await context(), false))   // once a day: the house share, then everything in the burn wallet
    await safely('custom', async () => { const ran = await customCycle(await context()); if (ran) { await sleep(10_000); await publish(await context()) } })
    // a long pass (many hired bunkers, many custom agents) must not leave the stops unwatched
    if (Date.now() - started > GUARD_MS) await safely('guard', guardPass)
    await sleep(Math.max(15_000, GUARD_MS - (Date.now() - started)))
  }
}
