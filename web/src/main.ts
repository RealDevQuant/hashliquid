/*
  HashLiquid — the trading terminal: markets on the left, chart in the middle, order form on the right, positions
  and orders below. The bunker (a hash-locked wallet) signs every move with a one-time key from 24 words.

  Two secrets, kept apart:
    the wallet     pays network fees and sends collateral in (Phantom, or a wallet created in this browser).
                   It has no power over the bunker.
    the 24 words   derive the bunker's one-time keys. They stay in this tab (sessionStorage) and never go into
                   a transaction; only the signatures made with them do.
  What each one-time key signed is remembered in localStorage (SignedLedger): a key signs one message, ever.

  Every move is two transactions: `authorize` (the signature) and `execute` (the instruction to the exchange).
  Orders are filled by the exchange's keepers.
*/
import './polyfill.ts'
import { spotlight, buttons } from './fx.ts'
import '@fontsource-variable/inter'
import '@fontsource-variable/geist-mono'
import './style.css'
import { Connection, LAMPORTS_PER_SOL, PublicKey, Transaction, type TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import * as H from '@hashliquid/client'
import { INTERVALS, MarketChart, fetchCandles, type Candle, type Indicators, type Interval } from './chart.ts'
import { fetchBook, fetchFunding, fetchStats, fetchTrades, type Book, type Funding, type Stats, type Trade } from './venue.ts'
import { FLAT_TEXT, ago, avatarHtml, chartTrades, fetchFeed, type Feed } from './agents.ts'
import { wireLinks } from './links.ts'
import { AGENT_META, CUSTOM_DELEGATE, DELEGATES, MIN_HIRE_USDT, agentOfDelegate } from './hire.ts'
import { AGGR_LABEL, BASE_LABEL } from './agents.ts'
import { BURN_FEE_PCT, BURN_WALLET } from './burn.ts'
import { browserWalletSecret, connectBrowserWallet, connectPhantom, hasBrowserWallet, hasPhantom, importBrowserWallet, type Wallet } from './wallet.ts'

const V = H.V
const RPC: string = import.meta.env.VITE_RPC_URL || 'http://127.0.0.1:8899'
/** Opening a bunker and its trading account costs rent plus fees: the wallet needs this much SOL. */
const OPEN_SOL = 0.05
const NET = (import.meta.env.VITE_CLUSTER || 'localnet') as H.Network
const QUOTE = V.QUOTE_SPOT_MARKET
const conn = new Connection(RPC, 'confirmed')
const ledger = new H.SignedLedger({ get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) })
const WORDS_KEY = `hashliquid:words:${NET}`
const WALLET_KEY = 'hashliquid:wallet'
const MARKET_KEY = 'hashliquid:market'
/** deploy.html: the same app in one column, as a wizard that ends with an agent on your bunker. */
const DEPLOY = location.pathname.endsWith('/deploy.html')
/** The markets the terminal shows (the venue lists more; the rest come back once we are fully live). */
const MARKETS_SHOWN: string[] = String(import.meta.env.VITE_MARKETS || 'BTC-PERP,ETH-PERP,SOL-PERP').split(',').map((x) => x.trim())   // in this order
const IND_KEY = 'hashliquid:indicators'

interface MarketInfo { index: number; name: string; coin: string; perp: H.V.PerpMarket; price: bigint | null; change24h: number | null }
interface Chain { state: H.V.VelocityState | null; quote: H.V.SpotMarket | null; markets: MarketInfo[]; bunker: H.Bunker | null; user: H.V.User | null; sol: number; tokens: bigint }
const QUERY = new URLSearchParams(location.search)
/** An agent id from a link is used only when it is one of ours. */
const knownAgent = (id: string | null): id is string => !!id && Object.prototype.hasOwnProperty.call(DELEGATES, id)
const ui = {
  wallet: null as Wallet | null,
  master: null as Uint8Array | null,
  /** Freshly generated words, shown until the user confirms they are written down. */
  fresh: null as string | null,
  chain: { state: null, quote: null, markets: [], bunker: null, user: null, sol: 0, tokens: 0n } as Chain,
  market: Number(localStorage.getItem(MARKET_KEY) ?? -1),   // -1: the first market shown, until one is picked
  interval: (localStorage.getItem('hashliquid:interval') as Interval) || ('1h' as Interval),
  indicators: { ema: true, vwap: true, volume: true, ...JSON.parse(localStorage.getItem(IND_KEY) || '{}') } as Indicators,
  tab: 'positions' as 'positions' | 'orders' | 'activity' | 'agents',
  /** Live data beside the chain: the venue's book and tape, 24h stats, funding, the agents' feed. */
  live: { book: null as Book | null, trades: null as Trade[] | null, stats: null as Map<string, Stats> | null, funding: null as Funding | null, feed: null as Feed | null, bookFor: '' },
  drawer: false,
  /** The agent a link asked to hire (?hire=ash2): its row is marked. */
  hirePick: new URLSearchParams(location.search).get('hire') ?? '',
  /** The deploy wizard's choices. */
  deploy: { choice: (knownAgent(QUERY.get('hire')) ? 'hire' : QUERY.get('create') ? 'custom' : '') as '' | 'hire' | 'custom', agent: knownAgent(QUERY.get('hire')) ? QUERY.get('hire')! : 'ash1', base: 1 as 1 | 2 | 3 | 4, aggr: 1 as 1 | 2 | 3, logo: null as File | null, done: '' },
  showSecret: false,
  showWords: false,
  busy: '',
  log: [] as { kind: 'ok' | 'err'; text: string; at: number }[],
  form: { side: 'long', type: 'market', size: '1', slippage: '1', limit: '', reduceOnly: false as boolean, deposit: '100', withdraw: '', to: '', words: '', secret: '', agentName: '', ownerName: '', fund: '50' } as Record<string, string | boolean>,
}
const f = (name: string): string => String(ui.form[name] ?? '')

/* ---------------- formatting ---------------- */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
function units(v: bigint, decimals: number, show: number): string {
  const neg = v < 0n
  const a = neg ? -v : v
  const scale = 10n ** BigInt(decimals)
  const frac = (a % scale).toString().padStart(decimals, '0').slice(0, show)
  return `${neg ? '-' : ''}${(a / scale).toLocaleString('en-US')}${show ? '.' + frac : ''}`
}
/** Dollars to the nearest cent. */
const usd = (v: bigint) => units(v + (v < 0n ? -5_000n : 5_000n), 6, 2)
const base = (v: bigint) => units(v, 9, 3)
const price = (v: bigint) => (v >= 1000n * V.PRICE_PRECISION ? units(v, 6, 1) : v >= V.PRICE_PRECISION ? units(v, 6, 3) : units(v, 6, 5))
const pct = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`
/** "1.5" → 1500000n at 6 decimals. Throws on anything that isn't a positive decimal number. */
function parseUnits(s: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s.trim().replace(/,/g, ''))
  if (!m) throw new Error(`"${s}" is not a number`)
  const v = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0').slice(0, decimals) || '0')
  if (v <= 0n) throw new Error('the amount must be more than zero')
  return v
}
const short = (k: PublicKey | string) => { const s = k.toString(); return `${s.slice(0, 4)}…${s.slice(-4)}` }
const quoteName = () => (ui.chain.quote ? V.nameOf(ui.chain.quote.name) : 'USDT')
const current = (): MarketInfo | null => ui.chain.markets.find((m) => m.index === ui.market) ?? ui.chain.markets[0] ?? null
const marketOf = (index: number | bigint) => ui.chain.markets.find((m) => m.index === Number(index))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ---------------- chain ---------------- */

const keys = () => H.bunkerKeys(ui.master!, NET)
const collateral = () => (ui.chain.user && ui.chain.quote ? V.tokenAmount(ui.chain.user, ui.chain.quote) : 0n)

/** The markets, once: their accounts and names. Prices refresh with everything else. */
async function loadMarkets() {
  const c = ui.chain
  if (!c.state) return
  const n = Number(c.state.numberOfMarkets)
  const markets: MarketInfo[] = []
  for (let i = 0; i < n; i++) {
    const perp = await V.getPerpMarket(conn, i)
    if (!perp || perp.status !== 1) continue   // Active only
    const name = V.nameOf(perp.name)
    if (!MARKETS_SHOWN.includes(name)) continue
    markets.push({ index: i, name, coin: name.replace(/-PERP$/, ''), perp, price: null, change24h: null })
  }
  markets.sort((a, b) => MARKETS_SHOWN.indexOf(a.name) - MARKETS_SHOWN.indexOf(b.name))   // BTC, ETH, SOL
  c.markets = markets
  if (!markets.some((m) => m.index === ui.market) && markets[0]) ui.market = markets[0].index
}

/** 24-hour change of every market, from the chart's candles. Every few minutes. */
async function loadChanges() {
  if (DEPLOY) return
  for (const m of ui.chain.markets) {
    try {
      const k = await fetchCandles(m.coin, '1h')
      const a = k[Math.max(0, k.length - 25)]?.open, b = k[k.length - 1]?.close
      if (a && b) m.change24h = ((b - a) / a) * 100
    } catch { /* keep the old value */ }
  }
}

async function refresh() {
  const c = ui.chain
  ;[c.state, c.quote] = await Promise.all([V.getState(conn), V.getSpotMarket(conn, QUOTE)])
  if (!c.markets.length) await loadMarkets()
  await Promise.all(c.markets.map(async (m) => { m.price = await V.getOraclePrice(conn, m.perp.oracle) }))
  if (ui.wallet) {
    c.sol = (await conn.getBalance(ui.wallet.publicKey)) / LAMPORTS_PER_SOL
    c.tokens = 0n
    if (c.quote) {
      try { c.tokens = (await getAccount(conn, getAssociatedTokenAddressSync(c.quote.mint, ui.wallet.publicKey))).amount } catch { /* no token account yet */ }
    }
  }
  if (ui.master) {
    c.bunker = await H.getBunker(conn, keys().address)
    c.user = c.bunker ? await V.getUser(conn, keys().address) : null
  } else { c.bunker = null; c.user = null }
}

/**
 * Sends a transaction and waits for it by polling (the public RPC has no working websocket), re-broadcasting
 * while it waits. A transaction that didn't land before its blockhash expired is checked one last time on
 * chain before being reported as not landed.
 */
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const SOL_RESERVE = 0.03   // SOL the wallet keeps for fees and rent when it swaps
/** The oracle price of SOL in USDT, from the SOL market, or 0. */
const solPrice = (): number => { const m = ui.chain.markets.find((x) => x.coin === 'SOL'); return m?.price ? Number(m.price) / 1e6 : 0 }
/** SOL → USDT on the open market, signed by the connected wallet. Returns the USDT that arrived (quote units). */
async function swapSolToUsdt(lamports: bigint): Promise<bigint> {
  const wallet = ui.wallet!, mint = ui.chain.quote!.mint
  ui.busy = 'Pricing the swap…'; render()
  const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${mint.toBase58()}&amount=${lamports}&slippageBps=50`)).json()
  if (!q.outAmount) throw new Error('No swap route right now: try again in a moment, or deposit USDT.')
  const r = await (await fetch('https://lite-api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }) })).json()
  if (!r.swapTransaction) throw new Error('The swap could not be built: try again in a moment, or deposit USDT.')
  const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(r.swapTransaction), (ch) => ch.charCodeAt(0)))
  ui.busy = `Swapping ${(Number(lamports) / 1e9).toFixed(4)} SOL for about ${usd(BigInt(q.outAmount))} ${quoteName()}…`; render()
  const before = ui.chain.tokens
  const signed = await wallet.signVersioned(tx)
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 2 })
  for (let i = 0; i < 40; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0]
    if (st?.err) throw new Error(`The swap failed on chain (${JSON.stringify(st.err)}). Nothing was deposited.`)
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break
    if (i === 39) throw new Error('The swap was not confirmed in time. Check the wallet before trying again.')
    await sleep(1500)
  }
  await refresh()
  const got = ui.chain.tokens - before
  if (got <= 0n) throw new Error(`The swap confirmed (${sig.slice(0, 8)}…) but the ${quoteName()} is not visible yet: deposit it from the wallet in a moment.`)
  return got
}
/** Two chips: deposit USDT as it is, or SOL that the wallet swaps first. */
const assetChips = (name: string): string => { const v = f(name) || 'usdt'; return `<div class="t-asset">${[['usdt', quoteName()], ['sol', 'SOL · swapped to ' + quoteName()]].map(([k, l]) => `<button type="button" class="chip ${v === k ? 'on' : ''}" data-action="${name}" data-arg="${k}">${esc(l)}</button>`).join('')}</div>` }

async function send(ixs: TransactionInstruction[], cu?: number, onSent?: () => void): Promise<string> {
  const wallet = ui.wallet!
  // Phantom sets its own priority fee: ours would sit next to it. The compute limit stays: a signature needs it.
  const fee = NET === 'localnet' || wallet.signAndSend ? [] : [H.priorityFeeIx(Number(import.meta.env.VITE_PRIORITY_FEE ?? 5_000))]
  const tx = new Transaction().add(...(cu ? [H.cuIx(cu)] : []), ...fee, ...ixs)
  tx.feePayer = wallet.publicKey
  // a finalized blockhash: every node, the wallet's included, already knows it (a fresh one from this RPC can be
  // ahead of the wallet's node, and its simulation then fails with "blockhash not found")
  const latest = await conn.getLatestBlockhash('finalized')
  tx.recentBlockhash = latest.blockhash
  // a dry run first: a transaction that would fail is explained here, before the wallet is asked to sign it
  // simulated with the node's own latest blockhash: the public RPC's nodes don't all know ours yet
  const dry = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { replaceRecentBlockhash: true, sigVerify: false }).catch(() => null)
  if (dry?.value.err && !/BlockhashNotFound/.test(JSON.stringify(dry.value.err))) {
    const logs = dry.value.logs ?? []
    const why = logs.map((l) => /Error Message: (.+)$/.exec(l)?.[1]).filter(Boolean).pop()
    const err = JSON.stringify(dry.value.err)
    if (/AccountNotFound/.test(err) || ui.chain.sol === 0) throw new Error(`The wallet ${short(wallet.publicKey)} has no SOL. It pays rent and fees: send it about ${OPEN_SOL} SOL first.`)
    if (/insufficient (lamports|funds)/i.test(logs.join(' ')) || /InsufficientFunds/.test(err)) throw new Error(`The wallet ${short(wallet.publicKey)} holds ${ui.chain.sol.toFixed(4)} SOL: not enough for the rent and fees of this move (about ${OPEN_SOL} SOL).`)
    throw new Error(why ? why.replace(/\.$/, '') + '.' : `This move would fail: ${err}`)
  }
  const signed = await wallet.signTransaction(tx)
  const raw: Uint8Array | null = signed.serialize()
  // the RPC simulates first: a move that would fail never gets published
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 })
  onSent?.()   // from here on the network has it: the signature can no longer be taken back
  const failed = async (err: unknown) => {
    const info = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null)
    const logs = info?.meta?.logMessages ?? []
    const why = logs.map((l) => /Error Message: (.+)$/.exec(l)?.[1]).filter(Boolean).pop()
    throw new Error(why ? why.replace(/\.$/, '') + '.' : `Transaction failed: ${JSON.stringify(err)}`)
  }
  // the public RPC's block height and statuses can disagree for a while: a transaction is given up only after the
  // blockhash is past its window AND a good minute has gone by AND the history says nothing landed
  const started = Date.now()
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0]
    if (st?.err) await failed(st.err)
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig
    const height = await conn.getBlockHeight('confirmed').catch(() => 0)
    if (height > latest.lastValidBlockHeight && Date.now() - started > 60_000) {
      for (let i = 0; i < 5; i++) {
        const info = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null)
        if (info) { if (info.meta?.err) await failed(info.meta.err); return sig }
        await sleep(2000)
      }
      throw new Error('The network did not include the transaction in time. Nothing happened: try again.')
    }
    if (raw) await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {})
    await sleep(1500)
  }
}

const signContext = (): H.SignContext => {
  if (!ui.master) throw new Error('Enter your 24 words first.')
  if (!ui.chain.bunker) throw new Error('Create the bunker first.')
  return { master: ui.master, network: NET, bunkerKey: keys().address, bunker: ui.chain.bunker, ledger }
}

/** One signed move of the bunker: the signature first, then the instruction it authorizes. */
async function act(ix: TransactionInstruction, note: string, before: TransactionInstruction[] = [], after: TransactionInstruction[] = []): Promise<bigint> {
  const p = H.prepareAction(signContext(), ix, note)
  localStorage.setItem(`${ledger.key(keys().address, p.signed.nonce)}:at`, String(Date.now()))
  ui.busy = `Key #${p.signed.nonce}: sending the signature…`; render()
  await send([p.authorize], H.CU.AUTHORIZE, () => localStorage.setItem(`${ledger.key(keys().address, p.signed.nonce)}:sent`, '1'))
  ui.busy = `Key #${p.signed.nonce}: sending the ${note}…`; render()
  await send([...before, p.execute, ...after], H.CU.EXECUTE)
  return p.signed.nonce
}

const perpAccounts = (marketIndex: number) => V.remainingAccounts(conn, ui.chain.user, { readablePerp: [marketIndex] })
const quoteAccounts = () => V.remainingAccounts(conn, ui.chain.user, { writableSpot: [QUOTE] })
const slippageBps = (): bigint => {
  const v = Number(f('slippage'))
  if (!(v >= 0 && v <= 50)) throw new Error('Slippage must be between 0 and 50%.')
  return BigInt(Math.round(v * 100))
}
/** The order the form describes, for the current market. A market order is a limit through the oracle by the slippage. */
function orderFromForm(): H.V.OrderParams {
  const m = current()
  if (!m || !m.price) throw new Error('No oracle price right now.')
  const direction = f('side') === 'long' ? V.DIRECTION.LONG : V.DIRECTION.SHORT
  if (!f('size').trim()) throw new Error(collateral() > 0n ? (sizeMode() === 'margin' ? 'Enter the margin and pick a leverage.' : 'Enter a size.') : 'Deposit collateral first.')
  const size = sizeFromForm(m)
  if (size <= 0n) throw new Error(`The smallest order on this market is ${fmtSize(m.perp.orderStepSize, m.perp)} ${m.coin}${m.price ? ` (about ${usd((m.perp.orderStepSize * m.price) / V.BASE_PRECISION)} ${quoteName()})` : ''}.`)
  let limit: bigint
  if (f('type') === 'limit') limit = parseUnits(f('limit'), 6)
  else {
    const bps = slippageBps()
    limit = direction === V.DIRECTION.LONG ? (m.price * (10_000n + bps)) / 10_000n : (m.price * (10_000n - bps)) / 10_000n
  }
  return V.perpOrder({ marketIndex: m.index, direction, baseAssetAmount: size, orderType: V.ORDER_TYPE.LIMIT, price: V.toTick(limit, m.perp), reduceOnly: !!ui.form.reduceOnly, postOnly: f('type') === 'limit' ? V.POST_ONLY.TRY_POST_ONLY : V.POST_ONLY.NONE })
}
/** The market's maximum leverage, from its initial margin ratio. */
const maxLeverage = (m: MarketInfo | null): number => (m?.perp.marginRatioInitial ? Number(10_000n / BigInt(m.perp.marginRatioInitial)) : 20)
/** A size with exactly the decimals the market's step needs (0.0001 BTC is "0.0001", not "0.000"). */
function fmtSize(size: bigint, perp: H.V.PerpMarket): string {
  let step = perp.orderStepSize, zeros = 0
  while (zeros < 9 && step % 10n === 0n) { step /= 10n; zeros++ }
  const decimals = 9 - zeros
  const whole = size / V.BASE_PRECISION, frac = (size % V.BASE_PRECISION).toString().padStart(9, '0').slice(0, decimals)
  return decimals ? `${whole}.${frac}` : whole.toString()
}
/** 'margin' (the default): the field is the collateral put behind the trade, and leverage × margin is the position. 'base': the field is a size in the coin. */
const sizeMode = (): 'margin' | 'base' => (ui.form.sizeMode === 'base' ? 'base' : 'margin')
/** The leverage picked, 1 to the market's maximum (5x until the person picks one). */
function levOfForm(): number { const max = maxLeverage(current()); const v = Number(f('lev') || 5); return Math.min(Math.max(Number.isFinite(v) ? v : 5, 1), max) }
/** The coin amount the form means, rounded to the market's step. */
function sizeFromForm(m: MarketInfo): bigint {
  if (sizeMode() === 'base') return V.toStep(parseUnits(f('size'), 9), m.perp)
  if (!m.price) throw new Error('No oracle price right now.')
  const margin = parseUnits(f('size'), 6)
  if (margin > collateral()) throw new Error(`The margin can be at most your collateral, ${usd(collateral())} ${quoteName()}.`)
  const notional = (margin * BigInt(Math.round(levOfForm() * 10))) / 10n
  return V.toStep((notional * V.BASE_PRECISION) / m.price, m.perp)
}
/** The position in dollars that the form means. */
function notionalOfForm(m: MarketInfo): bigint { return (sizeFromForm(m) * (m.price ?? 0n)) / V.BASE_PRECISION }
/** In the coin mode: the size that puts `lev` times the collateral into this market, as the size field shows it. */
function sizeForLeverage(lev: number): string {
  const m = current()
  if (!m || !m.price || collateral() <= 0n) return ''
  const raw = (collateral() * BigInt(Math.round(lev * 100)) * V.BASE_PRECISION) / (m.price * 100n)
  return fmtSize(V.toStep(raw, m.perp), m.perp)
}
/** The leverage the form means on this bunker's collateral (the pick in margin mode; size ÷ collateral in coin mode). */
function leverageOfForm(): number {
  if (sizeMode() === 'margin') return levOfForm()
  const m = current()
  if (!m || !m.price || collateral() <= 0n) return 0
  let size = 0n
  try { size = sizeFromForm(m) } catch { return 0 }
  return Math.round((Number((size * m.price) / V.BASE_PRECISION) / Number(collateral())) * 10) / 10
}
function leverageHtml(): string {
  const m = current(), max = maxLeverage(m), lev = leverageOfForm(), none = collateral() <= 0n
  const steps = [1, 2, 5, 10, 15, 20, max].filter((v, i, a) => v <= max && a.indexOf(v) === i)
  return `<div class="t-lev"><div class="t-lev-head"><span>Leverage · up to ${max}x on this market</span><b class="t-lev-val">${lev > 0 ? lev.toFixed(1) + 'x' : '–'}</b></div>
    <input type="range" data-lev min="1" max="${max}" step="0.5" value="${Math.min(Math.max(lev || 1, 1), max)}" aria-label="Leverage" ${none && sizeMode() === 'base' ? 'disabled' : ''} />
    <div class="t-lev-chips">${steps.map((v) => `<button type="button" class="chip ${Math.abs(lev - v) < 0.05 ? 'on' : ''}" data-action="lev" data-arg="${v}" ${none && sizeMode() === 'base' ? 'disabled' : ''}>${v}x</button>`).join('')}</div>
    ${none ? `<p class="dim small">Deposit collateral first (Deposit / Withdraw above): the margin comes from it.</p>` : ''}</div>`
}
const previewHtml = (): string => {
  try {
    const params = orderFromForm()
    const notional = (params.baseAssetAmount * (current()?.price ?? 0n)) / V.BASE_PRECISION
    const lev = sizeMode() === 'margin' ? levOfForm() : collateral() > 0n ? Number(notional) / Number(collateral()) : 0
    const max = maxLeverage(current())
    return `<dl class="t-preview"><div><dt>Position</dt><dd>${usd(notional)} ${quoteName()}</dd></div><div><dt>${f('side') === 'long' ? 'Buys' : 'Sells'}</dt><dd>${fmtSize(params.baseAssetAmount, current()!.perp)} ${esc(current()!.coin)}</dd></div><div><dt>No worse than</dt><dd>${price(params.price)}</dd></div><div><dt>Leverage</dt><dd class="${lev > max ? 'neg' : ''}">${lev.toFixed(1)}x${lev > max ? ` · above ${max}x` : ''}</dd></div></dl>`
  } catch (e) { return `<p class="dim small t-preview">${esc(e instanceof Error ? e.message : String(e))}</p>` }
}

/* ---------------- actions ---------------- */

const actions: Record<string, (arg?: string) => Promise<string | void>> = {
  async phantom() { ui.wallet = await connectPhantom(); localStorage.setItem(WALLET_KEY, 'phantom') },
  async browserWallet() { ui.wallet = connectBrowserWallet(); localStorage.setItem(WALLET_KEY, 'browser') },
  async importWallet() { ui.wallet = importBrowserWallet(f('secret').trim()); ui.form.secret = ''; localStorage.setItem(WALLET_KEY, 'browser') },
  async showSecret() { ui.showSecret = !ui.showSecret },
  async showWords() { ui.showWords = !ui.showWords },
  async disconnect() { ui.wallet = null; ui.showSecret = false; ui.drawer = false; localStorage.removeItem(WALLET_KEY) },
  async account() { ui.drawer = !ui.drawer },
  async closeDrawer() { ui.drawer = false },
  async market(index) { ui.market = Number(index); localStorage.setItem(MARKET_KEY, String(ui.market)); ui.live.book = null; ui.live.trades = null; ui.live.funding = null; void pollBook(); void pollTrades(); void pollSlow() },
  async interval(i) { ui.interval = i as Interval; localStorage.setItem('hashliquid:interval', ui.interval); void loadChart() },
  async indicator(name) { const k = name as keyof Indicators; ui.indicators[k] = !ui.indicators[k]; localStorage.setItem(IND_KEY, JSON.stringify(ui.indicators)); chart?.setIndicators(ui.indicators) },
  async tab(t) { ui.tab = t as typeof ui.tab },
  async side(s) { ui.form.side = s! },
  async type(t) { ui.form.type = t!; if (t === 'limit' && !f('limit') && current()?.price) ui.form.limit = units(current()!.price!, 6, 3).replace(/,/g, '') },
  async reduceOnly() { ui.form.reduceOnly = !ui.form.reduceOnly },

  /** Local validator only: SOL for fees and test USDT, from the dev server's faucet. */
  async fund() {
    const r = await fetch(`/__fund?to=${ui.wallet!.publicKey.toBase58()}`)
    if (!r.ok) throw new Error(`Could not get test funds: ${await r.text()}`)
    return 'Test funds received: 5 SOL and 10,000 USDT.'
  },

  async newWords() { ui.fresh = H.newWords(); if (ui.form.remember === undefined) ui.form.remember = 'yes' },
  async rememberWords() { ui.form.remember = ui.form.remember === 'no' ? 'yes' : 'no' },
  async copyWords() { const w = ui.fresh ?? sessionStorage.getItem(WORDS_KEY) ?? ''; await navigator.clipboard.writeText(w); ui.log.unshift({ kind: 'ok', text: 'The 24 words are in the clipboard.', at: Date.now() }) },
  async downloadWords() { const w = ui.fresh ?? sessionStorage.getItem(WORDS_KEY) ?? ''; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`HashLiquid bunker, 24 words. Whoever has these words has the bunker.\n\n${w}\n`], { type: 'text/plain' })); a.download = 'hashliquid-bunker-words.txt'; a.click(); URL.revokeObjectURL(a.href) },
  async confirmWords() { ui.master = H.wordsToMaster(ui.fresh!); sessionStorage.setItem(WORDS_KEY, ui.fresh!); if (ui.form.remember !== 'no') localStorage.setItem(WORDS_KEY, ui.fresh!); ui.fresh = null },
  async importWords() { ui.master = H.wordsToMaster(f('words')); sessionStorage.setItem(WORDS_KEY, H.normalize(f('words'))); if (ui.form.remember !== 'no') localStorage.setItem(WORDS_KEY, H.normalize(f('words'))); ui.form.words = '' },
  async forgetWords() { ui.master = null; sessionStorage.removeItem(WORDS_KEY); localStorage.removeItem(WORDS_KEY) },

  /** The bunker and its trading account on the exchange, in one transaction. */
  async createBunker() {
    const k = keys()
    await send([H.openIx({ payer: ui.wallet!.publicKey, keys: k }), H.initTradingIx({ bunker: k.address, payer: ui.wallet!.publicKey })], H.CU.SETUP)
    return `Bunker ${short(k.address)} is open. Key #0 is committed on chain.`
  },

  /** From the wallet to the bunker's token account, then into its trading account: one ordinary transaction. */
  async deposit() {
    const mint = ui.chain.quote!.mint, bunker = keys().address, wallet = ui.wallet!.publicKey
    let amount: bigint, swapped = ''
    if ((f('depositAsset') || 'usdt') === 'sol') {
      const lamports = parseUnits(f('deposit'), 9)
      const spendable = BigInt(Math.max(0, Math.round((ui.chain.sol - SOL_RESERVE) * 1e9)))
      if (lamports <= 0n) throw new Error('How much SOL?')
      if (lamports > spendable) throw new Error(`The wallet holds ${ui.chain.sol.toFixed(4)} SOL and keeps ${SOL_RESERVE} for fees: up to ${(Number(spendable) / 1e9).toFixed(4)} SOL can go in.`)
      amount = await swapSolToUsdt(lamports)
      swapped = `Swapped ${(Number(lamports) / 1e9).toFixed(4)} SOL for ${usd(amount)} ${quoteName()} and d`
    } else {
      amount = f('deposit').trim() ? parseUnits(f('deposit'), ui.chain.quote!.decimals) : ui.chain.tokens   // empty = everything the wallet holds
      if (amount > ui.chain.tokens && amount - ui.chain.tokens <= 10_000n) amount = ui.chain.tokens   // a rounding hair over the balance: all of it
      if (amount > ui.chain.tokens) throw new Error(`The wallet holds ${(Number(ui.chain.tokens) / 1e6).toFixed(4)} ${quoteName()}.`)
      if (amount <= 0n) throw new Error('How much?')
    }
    ui.busy = `Depositing ${usd(amount)} ${quoteName()}…`; render()
    const to = H.bunkerTokenAccount(bunker, mint)
    await send([
      createAssociatedTokenAccountIdempotentInstruction(wallet, to, bunker, mint),
      createTransferInstruction(getAssociatedTokenAddressSync(mint, wallet), to, wallet, amount),
      H.depositIx({ bunker, marketIndex: QUOTE, amount, mint, remaining: await quoteAccounts() }),
    ], H.CU.SETUP)
    ui.form.deposit = ''
    return swapped ? `${swapped}eposited it.` : `Deposited ${usd(amount)} ${quoteName()}.`
  },
  async depositAsset(a) { ui.form.depositAsset = a ?? 'usdt' },
  async depositUsdt() { ui.form.depositAsset = 'usdt'; return actions.deposit() },
  async depositSol() { ui.form.depositAsset = 'sol'; ui.form.deposit = f('depositSol').trim() || Math.max(0, ui.chain.sol - SOL_RESERVE).toFixed(4); const r = await actions.deposit(); ui.form.depositSol = ''; return r },
  /** Switching how the size is written converts what is typed, so the order stays the same. */
  async sizeMode(a) {
    const m = current(), was = sizeMode(), to = a === 'base' ? 'base' : 'margin'
    if (was === to) return
    let size = 0n
    try { if (m) size = sizeFromForm(m) } catch { size = 0n }
    ui.form.sizeMode = to
    if (!m || !m.price || size <= 0n) return
    if (to === 'base') ui.form.size = fmtSize(size, m.perp)   // the same order, written as a size
    else { const notional = (size * m.price) / V.BASE_PRECISION; ui.form.size = (Number(notional) / 1e6 / levOfForm()).toFixed(2) }   // the same order, as margin at the leverage picked
  },
  async fundAsset(a) { ui.form.fundAsset = a ?? 'usdt' },

  /** Signed: out of the exchange, to the wallet's token account or to the owner typed in. */
  async withdraw() {
    const mint = ui.chain.quote!.mint, bunker = keys().address
    const all = !f('withdraw').trim()
    const amount = all ? collateral() : parseUnits(f('withdraw'), ui.chain.quote!.decimals)
    if (amount <= 0n) throw new Error('Nothing to withdraw.')
    let owner = ui.wallet!.publicKey
    if (f('to').trim()) { try { owner = new PublicKey(f('to').trim()) } catch { throw new Error('The destination is not a valid Solana address.') } }
    const to = getAssociatedTokenAddressSync(mint, owner, true)
    // "everything": ask for more than there is and let the exchange cap it at the balance (reduce-only)
    // buyback and burn: 2% of the gain inside a withdrawal from a bunker that runs or ran an agent, in the same transaction
    const fee = burnFeeDue(all ? collateral() : amount)
    if (fee > 0n && !owner.equals(ui.wallet!.publicKey)) throw new Error(`${usd(fee)} ${quoteName()} of this withdrawal is the buyback-and-burn share (${BURN_FEE_PCT}% of the gain): withdraw to the connected wallet, which sends it on.`)
    const burnAta = getAssociatedTokenAddressSync(mint, new PublicKey(BURN_WALLET))
    const after = fee > 0n ? [createAssociatedTokenAccountIdempotentInstruction(ui.wallet!.publicKey, burnAta, new PublicKey(BURN_WALLET), mint), createTransferInstruction(to, burnAta, ui.wallet!.publicKey, fee)] : []
    const ix = V.withdrawIx({ authority: bunker, signer: ui.chain.state!.signer, marketIndex: QUOTE, amount: all ? amount * 2n : amount, toTokenAccount: to, remaining: await quoteAccounts(), reduceOnly: true })
    const nonce = await act(ix, 'withdrawal', [createAssociatedTokenAccountIdempotentInstruction(ui.wallet!.publicKey, to, owner, mint)], after)
    ui.form.withdraw = ''; ui.form.to = ''
    return `Withdrew ${all ? 'everything' : usd(amount) + ' ' + quoteName()} to ${short(owner)} with key #${nonce}.${fee > 0n ? ` ${usd(fee)} ${quoteName()} (${BURN_FEE_PCT}% of the gain) went to the buyback and burn.` : ''}`
  },

  async order() {
    const m = current()!
    const params = orderFromForm()
    if (collateral() <= 0n) throw new Error('Deposit collateral first.')
    if (sizeMode() === 'margin' && parseUnits(f('size'), 6) > collateral()) throw new Error(`The margin can be at most your collateral, ${usd(collateral())} ${quoteName()}.`)
    // the venue refuses an order past the market's leverage; said here, before a key is spent on it
    if (!params.reduceOnly && m.price) {
      const notional = (params.baseAssetAmount * m.price) / V.BASE_PRECISION
      const max = BigInt(maxLeverage(m))
      if (notional > collateral() * max) throw new Error(`${usd(notional)} ${quoteName()} of ${m.coin} is more than ${max}x of your ${usd(collateral())} ${quoteName()}: the most this collateral allows is about ${usd(collateral() * max)} ${quoteName()}.`)
    }
    const nonce = await act(V.placePerpOrderIx({ authority: keys().address, params, remaining: await perpAccounts(m.index) }), 'order')
    return `${f('side') === 'long' ? 'Buy' : 'Sell'} ${base(params.baseAssetAmount)} ${m.name} at ${f('type') === 'limit' ? price(params.price) : 'market (no worse than ' + price(params.price) + ')'}, signed with key #${nonce}.`
  },
  /** Closes the position of a market: a reduce-only order for the whole size, 1% through the oracle. */
  async close(marketIndex) {
    const m = marketOf(Number(marketIndex))
    const pos = m && ui.chain.user ? V.perpPosition(ui.chain.user, m.index) : null
    if (!m || !m.price || !pos || pos.baseAssetAmount === 0n) throw new Error('No position to close.')
    const long = pos.baseAssetAmount > 0n
    const limit = long ? (m.price * 99n) / 100n : (m.price * 101n) / 100n
    const params = V.perpOrder({ marketIndex: m.index, direction: long ? V.DIRECTION.SHORT : V.DIRECTION.LONG, baseAssetAmount: long ? pos.baseAssetAmount : -pos.baseAssetAmount, orderType: V.ORDER_TYPE.LIMIT, price: V.toTick(limit, m.perp), reduceOnly: true })
    const nonce = await act(V.placePerpOrderIx({ authority: keys().address, params, remaining: await perpAccounts(m.index) }), 'closing order')
    return `Closing ${m.name}, no worse than ${price(params.price)}, signed with key #${nonce}.`
  },
  async cancel(arg) {
    const [orderId, marketIndex] = arg!.split(',').map(Number)
    const nonce = await act(V.cancelOrderIx({ authority: keys().address, orderId, remaining: await perpAccounts(marketIndex) }), 'cancellation')
    return `Order ${orderId} cancelled with key #${nonce}.`
  },

  /** Hires an agent: names its key as the trading delegate of the bunker's account. One signed move. */
  async hire(id) {
    const key = DELEGATES[id ?? '']
    if (!key) throw new Error('Unknown agent.')
    if (collateral() < BigInt(MIN_HIRE_USDT) * 10n ** BigInt(ui.chain.quote!.decimals)) throw new Error(`Deposit at least ${MIN_HIRE_USDT} ${quoteName()} first.`)
    const nonce = await act(V.updateUserDelegateIx({ authority: keys().address, delegate: new PublicKey(key) }), 'hire')
    return `${AGENT_META[id!].name} hired with key #${nonce}. It joins its next trade.`
  },
  // ---- the deploy wizard ----
  /** The native file control speaks the browser's language: this button speaks ours. */
  /** A leverage sets the size: that much of the collateral, as notional, in this market. */
  async lev(n) {
    const m = current(), lev = Number(n)
    if (sizeMode() === 'margin') { ui.form.lev = String(lev); return }
    const size = sizeForLeverage(lev)
    if (m && m.price && collateral() > 0n && !(Number(size) > 0)) {
      const minUsd = Number((m.perp.orderStepSize * m.price) / V.BASE_PRECISION) / 1e6
      throw new Error(`${lev}x of your ${usd(collateral())} ${quoteName()} is ${usd(BigInt(Math.round(Number(collateral()) * lev)))}: below this market's smallest order, ${fmtSize(m.perp.orderStepSize, m.perp)} ${m.coin} (about ${minUsd.toFixed(0)} ${quoteName()}). Deposit more, or trade a market with a smaller minimum.`)
    }
    ui.form.size = size
  },
  async pickLogo() { document.querySelector<HTMLInputElement>('input[data-logo]')?.click() },
  async pick(arg) { const [choice, agent] = (arg ?? '').split(':'); ui.deploy.choice = choice as '' | 'hire' | 'custom'; if (agent) ui.deploy.agent = agent },
  async aggr(n) { ui.deploy.aggr = Number(n) as 1 | 2 | 3 },
  async base(n) { ui.deploy.base = Number(n) as 1 | 2 | 3 | 4 },
  /** Everything in one go: the bunker and its account (named after the agent), the deposit, the agent switched on. */
  async deployGo() {
    const d = ui.deploy
    if (!d.choice) d.choice = 'hire'   // the first tab is the default
    if (d.choice === 'custom' && d.logo && (d.logo.size > 300 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(d.logo.type))) throw new Error('The logo must be a png, jpg or webp of at most 300 KB.')
    const label = H.sanitizeLabel(f(d.choice === 'hire' ? 'ownerName' : 'agentName'))
    if (d.choice === 'custom' && !label) throw new Error('Give your agent a name.')
    const base = (d.choice === 'hire' ? Number(d.agent.replace('ash', '')) : d.base) as 1 | 2 | 3 | 4
    const prompt = f('prompt').trim()
    if (d.choice === 'custom' && base === 4 && !prompt) throw new Error('Write the prompt your agent will trade by.')
    const cfg = { kind: d.choice === 'hire' ? 'hired' as const : 'custom' as const, base, aggr: d.aggr, label }
    const nameBytes = H.encodeAgentName(cfg)
    const delegate = new PublicKey(d.choice === 'hire' ? DELEGATES[d.agent] : CUSTOM_DELEGATE)
    const k = keys(), wallet = ui.wallet!.publicKey
    const fundSol = (f('fundAsset') || 'usdt') === 'sol'
    const solIn = fundSol && f('fund').trim() ? parseUnits(f('fund'), 9) : 0n
    let amount = !fundSol && f('fund').trim() ? parseUnits(f('fund'), ui.chain.quote!.decimals) : 0n
    const estimate = fundSol ? BigInt(Math.round((Number(solIn) / 1e9) * solPrice() * 1e6)) : amount
    const have = BigInt(Math.round(Number(collateral()) + Number(estimate)))
    if (have < BigInt(MIN_HIRE_USDT) * 10n ** BigInt(ui.chain.quote!.decimals)) throw new Error(`An agent needs at least ${MIN_HIRE_USDT} ${quoteName()} in the bunker: deposit more.`)
    if (!fundSol && amount > ui.chain.tokens) throw new Error(`The wallet holds ${usd(ui.chain.tokens)} ${quoteName()}.`)
    if (fundSol) {
      const needed = SOL_RESERVE + (ui.chain.bunker && ui.chain.user ? 0 : OPEN_SOL)
      if (Number(solIn) / 1e9 > ui.chain.sol - needed) throw new Error(`The wallet holds ${ui.chain.sol.toFixed(4)} SOL and needs ${needed} for the bunker's rent and fees: up to ${Math.max(0, ui.chain.sol - needed).toFixed(4)} SOL can go in.`)
    }
    // 1. the bunker and its trading account, named after the agent (free when new, one signed move when it exists)
    if (!ui.chain.bunker || !ui.chain.user) {
      ui.busy = 'Opening the bunker…'; render()
      await send([...(ui.chain.bunker ? [] : [H.openIx({ payer: wallet, keys: k })]), H.initTradingIx({ bunker: k.address, payer: wallet, nameBytes })], H.CU.SETUP)
      await refresh()
    } else {
      ui.busy = 'Naming the agent…'; render()
      await act(V.updateUserNameIx({ authority: k.address, name: nameBytes }), 'agent name')
      await refresh()
    }
    // the owner's prompt (base 4): not on chain; saved once under the bunker's address, now that the account's name says the agent runs on it
    if (d.choice === 'custom' && base === 4) {
      ui.busy = 'Saving the prompt…'; render()
      const r = await fetch(`/api/prompt?bunker=${k.address.toBase58()}`, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: prompt }).catch(() => null)
      if (!r || (!r.ok && r.status !== 409)) throw new Error(`The prompt was not saved${r ? `: ${(await r.json().catch(() => ({}))).error ?? r.status}` : ''}. Nothing else was signed: press again.`)
    }
    // the logo, if any: not on chain; saved under the bunker's address as soon as the account carries the agent's name
    let logoNote = ''
    if (d.choice === 'custom' && d.logo) {
      ui.busy = 'Saving the logo…'; render()
      const r = await fetch(`/api/logo?bunker=${k.address.toBase58()}`, { method: 'POST', body: d.logo }).catch(() => null)
      if (!r?.ok) logoNote = ` The logo was not saved${r ? `: ${(await r.json().catch(() => ({}))).error ?? r.status}` : ''}.`
    }
    // 2. collateral: SOL is swapped for USDT by the wallet first
    if (fundSol && solIn > 0n) amount = await swapSolToUsdt(solIn)
    if (amount > 0n) {
      ui.busy = `Depositing ${usd(amount)} ${quoteName()}…`; render()
      const mint = ui.chain.quote!.mint, to = H.bunkerTokenAccount(k.address, mint)
      await send([createAssociatedTokenAccountIdempotentInstruction(wallet, to, k.address, mint), createTransferInstruction(getAssociatedTokenAddressSync(mint, wallet), to, wallet, amount), H.depositIx({ bunker: k.address, marketIndex: QUOTE, amount, mint, remaining: await quoteAccounts() })], H.CU.SETUP)
      ui.form.fund = ''   // paid: a retry after a later failure must not deposit again
      await refresh()
    }
    // 3. the agent's key becomes the account's trading delegate: one signed move
    ui.busy = 'Switching the agent on…'; render()
    const nonce = await act(V.updateUserDelegateIx({ authority: k.address, delegate }), d.choice === 'hire' ? 'hire' : 'agent')
    d.done = d.choice === 'hire' ? `${AGENT_META[d.agent].name} is trading your bunker` : `${label} is live`
    return `${d.done} (key #${nonce}).${logoNote}`
  },
  async deployAgain() { ui.deploy.done = ''; ui.deploy.choice = '' },

  /** Fires the agent: the default key removes the delegate. Positions stay as they are. */
  async fire() {
    const nonce = await act(V.updateUserDelegateIx({ authority: keys().address, delegate: PublicKey.default }), 'firing')
    ui.deploy.done = ''; ui.deploy.choice = ''
    return `Agent fired with key #${nonce}. Open positions stay yours to manage.`
  },

  /** An authorized move that hasn't run yet: send it (from the ledger), or call it off with the next key. */
  async runPending() {
    const b = ui.chain.bunker!
    const record = ledger.get(keys().address, b.pendingNonce)
    if (!record) throw new Error('This device did not sign the pending move, so it cannot rebuild it. Call it off instead.')
    const { execute } = H.fromRecord({ bunker: keys().address, record })
    if (execute) await send([execute], H.CU.EXECUTE)
    return 'Sent.'
  },
  /** A signature that never reached the network, or whose window has long passed: the key is free to sign something else. */
  async discardSigned() {
    const b = ui.chain.bunker!, k = ledger.key(keys().address, b.nonce)
    const sent = !!localStorage.getItem(`${k}:sent`), at = Number(localStorage.getItem(`${k}:at`) || 0)
    if (sent && Date.now() - at <= 180_000) throw new Error('That signature was sent less than three minutes ago: wait, it may still land.')
    localStorage.removeItem(k); localStorage.removeItem(`${k}:sent`); localStorage.removeItem(`${k}:at`)
    return `Discarded. Key #${b.nonce} is free again; nothing was sent.`
  },
  async dropPending() {
    const off = H.prepareCancel(signContext())
    await send([off.authorize], H.CU.AUTHORIZE)
    return `Called off with key #${off.signed.nonce}.`
  },
  /** The current key signed on this device but its signature never landed: send the same bytes again. */
  async resend() {
    const record = ledger.get(keys().address, ui.chain.bunker!.nonce)
    if (!record) return
    const { authorize, execute } = H.fromRecord({ bunker: keys().address, record })
    await send([authorize], H.CU.AUTHORIZE, () => localStorage.setItem(`${ledger.key(keys().address, ui.chain.bunker!.nonce)}:sent`, '1'))
    if (execute) await send([execute], H.CU.EXECUTE)
    return 'Sent.'
  },
}

/** Actions that only change what is shown: no chain, no busy state. */
const QUIET = new Set(['market', 'interval', 'indicator', 'tab', 'side', 'type', 'reduceOnly', 'account', 'closeDrawer', 'showSecret', 'showWords', 'rememberWords', 'copyWords', 'downloadWords', 'newWords', 'confirmWords', 'importWords', 'forgetWords', 'pick', 'pickLogo', 'lev', 'sizeMode', 'depositAsset', 'fundAsset', 'aggr', 'base', 'deployAgain'])
async function run(name: string, arg?: string) {
  if (ui.busy) return
  if (QUIET.has(name)) {
    try { await actions[name](arg) } catch (e) { ui.log.unshift({ kind: 'err', text: e instanceof Error ? e.message : String(e), at: Date.now() }) }
    if (name === 'importWords' || name === 'confirmWords' || name === 'forgetWords') { try { await refresh() } catch { /* shown on the next tick */ } }
    render(); return
  }
  ui.busy = 'Working…'
  render()
  try {
    const text = await actions[name](arg)
    if (text) ui.log.unshift({ kind: 'ok', text, at: Date.now() })
  } catch (e) {
    ui.log.unshift({ kind: 'err', text: e instanceof Error ? e.message : String(e), at: Date.now() })
  }
  try { await refresh() } catch (e) { ui.log.unshift({ kind: 'err', text: `Could not read the chain at ${RPC}: ${e instanceof Error ? e.message : e}`, at: Date.now() }) }
  ui.busy = ''
  render()
}

/* ---------------- the chart ---------------- */

const chartHost = document.createElement('div')
chartHost.className = 'chart-host'
let chart: MarketChart | null = null
let chartLoading = ''
async function loadChart() {
  const m = current()
  if (!m) return
  if (!chart) { chart = new MarketChart(chartHost); chart.setIndicators(ui.indicators); chart.onHover(onCrosshair); chart.onLayout(positionBubbles) }
  const key = `${m.coin}:${ui.interval}`
  if (chartLoading === key) return
  chartLoading = key
  if (m.price) chart.setPrecision(Number(m.price) / 1e6)
  try { await chart.load(m.coin, ui.interval) } catch (e) { ui.log.unshift({ kind: 'err', text: `Chart: ${e instanceof Error ? e.message : e}`, at: Date.now() }) }
  chartLoading = ''
  drawLines()
  drawBubbles()
  legend(null)
}
function drawLines() {
  const m = current()
  if (!chart || !m || !ui.chain.user) return
  const css = getComputedStyle(document.documentElement)
  const lines: { price: number; color: string; title: string; dashed?: boolean }[] = []
  const pos = V.perpPosition(ui.chain.user, m.index)
  if (pos && pos.baseAssetAmount !== 0n) {
    const abs = pos.baseAssetAmount < 0n ? -pos.baseAssetAmount : pos.baseAssetAmount
    const entry = ((pos.quoteEntryAmount < 0n ? -pos.quoteEntryAmount : pos.quoteEntryAmount) * V.BASE_PRECISION) / abs
    lines.push({ price: Number(entry) / 1e6, color: css.getPropertyValue('--accent').trim(), title: `entry ${pos.baseAssetAmount > 0n ? 'long' : 'short'}` })
  }
  for (const o of V.openOrders(ui.chain.user).filter((o) => o.marketIndex === m.index && o.marketType === V.MARKET_TYPE.PERP)) {
    lines.push({ price: Number(o.price) / 1e6, color: css.getPropertyValue(o.direction === V.DIRECTION.LONG ? '--long' : '--short').trim(), title: `${o.direction === V.DIRECTION.LONG ? 'buy' : 'sell'} ${base(o.baseAssetAmount - o.baseAssetAmountFilled)}`, dashed: true })
  }
  chart.setLines(lines)
}

/* ---- the agents on the chart: a face at the entry, a dot at the exit, a line between them ---- */
interface Bubble { el: HTMLElement; time: number; price: number; exit?: { el: HTMLElement; time: number; price: number; line: SVGLineElement } }
let bubbles: Bubble[] = []
function drawBubbles() {
  const host = document.getElementById('chart-bubbles'); const m = current(); const feed = ui.live.feed
  if (!host) return
  host.innerHTML = ''; bubbles = []
  if (!m || !feed || !chart) return
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'trade-lines'); host.appendChild(svg)
  for (const { agent, trade, note } of chartTrades(feed, m.name)) {
    const long = trade.side === 'long'
    const el = document.createElement('button')
    el.className = `bubble ${long ? 'long' : 'short'}`
    el.style.setProperty('--c', agent.color)
    el.innerHTML = avatarHtml(agent, 'face') + (agent.forLabel ? `<i class="for">for ${esc(agent.forLabel)}</i>` : '')
    const result = trade.exit == null ? `<b class="dim">open</b>` : `<b class="${trade.pnl! > 0 ? 'pos' : 'neg'}">${trade.pnl! >= 0 ? '+' : ''}${trade.pnl!.toFixed(2)} USDT</b> <span class="dim">· ${trade.reason === 'target' ? 'target hit' : trade.reason === 'stop' ? 'stop hit' : trade.reason === 'time' ? 'time exit' : 'closed'} @ ${pricef(trade.exit)}</span>`
    const html = `<div class="tip-row">${avatarHtml(agent, 'avatar sm')}<div><b>${esc(agent.name)}</b>${agent.forLabel ? ` <span class="dim">for ${esc(agent.forLabel)}</span>` : ''} <span class="${long ? 'pos' : 'neg'}">${long ? 'long' : 'short'}</span> ${fmtNum(trade.size, 3)} ${esc(m.coin)} @ ${pricef(trade.entry)} <span class="dim">· ${ago(trade.openedAt)}</span><div class="tip-result">${result}</div>${note ? `<p>${esc(note)}</p>` : ''}</div></div>`
    el.setAttribute('aria-label', `${agent.name}${agent.forLabel ? ` for ${agent.forLabel}` : ''}: ${trade.side} ${m.name}`)
    el.addEventListener('mouseenter', () => showTip(html, el.offsetLeft, el.offsetTop))
    el.addEventListener('mouseleave', hideTip)
    host.appendChild(el)
    const b: Bubble = { el, time: trade.openedAt, price: trade.entry }
    if (trade.exit != null && trade.closedAt) {
      const dot = document.createElement('button')
      dot.className = `exit ${trade.pnl! > 0 ? 'win' : 'loss'}`
      dot.style.setProperty('--c', agent.color)
      dot.addEventListener('mouseenter', () => showTip(html, dot.offsetLeft, dot.offsetTop))
      dot.addEventListener('mouseleave', hideTip)
      host.appendChild(dot)
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('class', trade.pnl! > 0 ? 'win' : 'loss')
      svg.appendChild(line)
      b.exit = { el: dot, time: trade.closedAt, price: trade.exit, line }
    }
    bubbles.push(b)
  }
  positionBubbles()
}
function positionBubbles() {
  if (!chart) return
  const placed: { x: number; y: number }[] = []
  for (const b of bubbles) {
    const c = chart.coordinates(b.time, b.price)
    if (!c) { b.el.hidden = true; if (b.exit) { b.exit.el.hidden = true; b.exit.line.setAttribute('visibility', 'hidden') } continue }
    // faces that would overlap are stacked upwards, 30px apart
    let y = c.y
    for (let guard = 0; guard < 8 && placed.some((p) => Math.abs(p.x - c.x) < 30 && Math.abs(p.y - y) < 30); guard++) y -= 32
    placed.push({ x: c.x, y })
    b.el.hidden = false; b.el.style.left = `${c.x}px`; b.el.style.top = `${y}px`
    if (b.exit) {
      const e = chart.coordinates(b.exit.time, b.exit.price)
      if (!e) { b.exit.el.hidden = true; b.exit.line.setAttribute('visibility', 'hidden'); continue }
      b.exit.el.hidden = false; b.exit.el.style.left = `${e.x}px`; b.exit.el.style.top = `${e.y}px`
      b.exit.line.setAttribute('visibility', 'visible')
      b.exit.line.setAttribute('x1', String(c.x)); b.exit.line.setAttribute('y1', String(y)); b.exit.line.setAttribute('x2', String(e.x)); b.exit.line.setAttribute('y2', String(e.y))
    }
  }
}
function showTip(html: string, x: number, y: number) {
  const tip = document.getElementById('chart-tip'); if (!tip) return
  tip.innerHTML = html; tip.hidden = false
  const host = tip.parentElement!
  const left = Math.min(x + 22, host.clientWidth - tip.offsetWidth - 8), top = Math.min(Math.max(8, y - 24), host.clientHeight - tip.offsetHeight - 8)
  tip.style.left = `${Math.max(8, left)}px`; tip.style.top = `${top}px`
}
function hideTip() { const tip = document.getElementById('chart-tip'); if (tip) tip.hidden = true }

/** The legend over the chart: the hovered candle, or the last one. */
function legend(c: Candle | null) {
  const el = document.getElementById('chart-legend'); const m = current()
  if (!el || !m || !chart) return
  const k = c ?? chart.lastCandle()
  if (!k) { el.innerHTML = `<b>${esc(m.name)}</b> <span>${ui.interval}</span>`; return }
  const prev = chart.previous(k)
  const chg = prev ? ((k.close - prev.close) / prev.close) * 100 : (k.close - k.open) / k.open * 100
  const cls = k.close >= k.open ? 'pos' : 'neg'
  el.innerHTML = `<b>${esc(m.name)}</b><span>${ui.interval}</span><span><i>O</i><span class="${cls}">${pricef(k.open)}</span></span><span><i>H</i><span class="${cls}">${pricef(k.high)}</span></span><span><i>L</i><span class="${cls}">${pricef(k.low)}</span></span><span><i>C</i><span class="${cls}">${pricef(k.close)}</span></span><span><i>Vol</i>${fmtNum(k.volume, k.volume >= 100 ? 0 : 2)} ${esc(m.coin)}</span><span class="${chg >= 0 ? 'pos' : 'neg'}">${pct(chg)}</span>`
}
function onCrosshair(_time: number | null, _point: { x: number; y: number } | null, candle: Candle | null) { legend(candle) }

/* ---------------- views ---------------- */

/** The buyback-and-burn share of a withdrawal of `amount`: 2% of the trading gain in it, only on a bunker that runs or ran an agent. */
function burnFeeDue(amount: bigint): bigint {
  const u = ui.chain.user
  if (!u || !H.decodeAgentName(u.name)) return 0n
  const net = u.spotPositions.find((s) => s.marketIndex === QUOTE)?.cumulativeDeposits ?? 0n
  const base = amount < collateral() ? amount : collateral()
  return H.burnFee(base, net)
}
/** The line under the withdraw fields. */
function burnLine(): string {
  const all = !f('withdraw').trim()
  let amount = 0n
  try { amount = all ? collateral() : parseUnits(f('withdraw') || '0', ui.chain.quote?.decimals ?? 6) } catch { amount = 0n }
  const fee = amount > 0n ? burnFeeDue(amount) : 0n
  return fee > 0n ? `Buyback and burn: ${BURN_FEE_PCT}% of the gain in this withdrawal, ${usd(fee)} ${quoteName()}, goes to the burn wallet in the same transaction.` : ''
}
/** The latest error, when it is fresh: shown under the button that caused it, not only in the Activity tab. */
const errLine = (): string => (ui.log.length && ui.log[0].kind === 'err' && Date.now() - ui.log[0].at < 120_000 ? `<p class="gate-err">${esc(ui.log[0].text)}</p>` : '')
const field = (name: string, label: string, attrs = '') =>
  `<label>${label}<input data-field="${name}" value="${esc(f(name))}" ${attrs} /></label>`

/** The way in: pick a wallet. Nothing else is shown until there is one. */
function gate(): string {
  const phantomBtn = hasPhantom()
    ? '<button data-action="phantom">Connect Phantom</button>'
    : '<a class="btn ghost" href="https://phantom.com/download" target="_blank" rel="noopener">Get Phantom</a>'
  const browserBtn = `<button class="ghost" data-action="browserWallet">${hasBrowserWallet() ? 'Use the wallet in this browser' : 'Create a wallet in this browser'}</button>`
  return `<main class="gate">
    <section class="gate-card">
      <span class="eyebrow">Step 1</span>
      <h1>Choose a wallet</h1>
      <p>It pays network fees and sends your collateral in. It has no power over the bunker: that belongs to your 24 words.</p>
      <div class="gate-actions">${phantomBtn}${browserBtn}</div>
      <details class="gate-more">
        <summary>Import a wallet you already have</summary>
        <div class="row">${field('secret', 'Secret key (JSON array, as Phantom exports it)', 'autocomplete="off" spellcheck="false"')}<button class="ghost" data-action="importWallet">Import</button></div>
      </details>
      ${ui.log.length && ui.log[0].kind === 'err' ? `<p class="gate-err">${esc(ui.log[0].text)}</p>` : ''}
    </section>
  </main>`
}

function marketsPanel(): string {
  return `<aside class="t-markets"><h2>Markets</h2>${ui.chain.markets.map((m) => `
    <button class="t-market ${m.index === ui.market ? 'on' : ''}" data-action="market" data-arg="${m.index}">
      <img class="coin" src="/coins/${esc(m.coin.toLowerCase())}.png" alt="" width="22" height="22" /><span class="name">${esc(m.name)}</span>
      <span class="px">${m.price ? price(m.price) : '–'}</span>
      <span class="chg ${m.change24h == null ? '' : m.change24h >= 0 ? 'pos' : 'neg'}">${m.change24h == null ? '' : pct(m.change24h)}</span>
    </button>`).join('')}</aside>`
}

const fmtUsd = (x: number) => x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${x.toFixed(0)}`
const fmtNum = (x: number, d = 2) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const pricef = (x: number) => (x >= 1000 ? fmtNum(x, 1) : x >= 1 ? fmtNum(x, 3) : fmtNum(x, 5))
const untilNextHour = () => { const s = 3600 - (Math.floor(Date.now() / 1000) % 3600); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }

function marketStrip(): string {
  const m = current()
  if (!m) return '<div class="t-strip"><span class="dim">No markets.</span></div>'
  const p = m.perp
  const shortOi = p.baseAssetAmountShort < 0n ? -p.baseAssetAmountShort : p.baseAssetAmountShort
  const px = m.price ? Number(m.price) / 1e6 : 0
  const st = ui.live.stats?.get(m.name) ?? null
  const chg = st?.change24h ?? m.change24h
  const oiUsd = px ? (Number(p.baseAssetAmountLong) / 1e9 + Number(shortOi) / 1e9) * px : 0
  const fund = ui.live.funding
  const mark = ui.live.book && ui.live.bookFor === m.name ? ui.live.book.mid : null
  return `<div class="t-strip">
    <div class="t-stat big"><span class="sym"><img class="coin lg" src="/coins/${esc(m.coin.toLowerCase())}.png" alt="" width="28" height="28" />${esc(m.name)}</span><b id="oracle">${m.price ? price(m.price) : '–'}</b></div>
    <div class="t-stat"><span>Mark</span><b id="s-mark">${mark ? pricef(mark) : '–'}</b></div>
    <div class="t-stat"><span>24h change</span><b class="${chg == null ? '' : chg >= 0 ? 'pos' : 'neg'}">${chg == null ? '–' : pct(chg)}</b></div>
    <div class="t-stat"><span>24h volume</span><b id="s-vol">${st?.volume24h != null ? fmtUsd(st.volume24h) : '–'}</b></div>
    <div class="t-stat"><span>24h high / low</span><b>${st?.high24h && st.low24h ? `${pricef(st.high24h)} / ${pricef(st.low24h)}` : '–'}</b></div>
    <div class="t-stat"><span>Open interest</span><b>${oiUsd ? fmtUsd(oiUsd) : '–'} <small class="dim">${base(p.baseAssetAmountLong)} L · ${base(shortOi)} S</small></b></div>
    <div class="t-stat"><span>Funding / 1h</span><b id="s-fund" class="${fund ? (fund.hourlyPct >= 0 ? 'pos' : 'neg') : ''}">${fund ? `${fund.hourlyPct >= 0 ? '+' : ''}${fund.hourlyPct.toFixed(4)}%` : '–'} <small class="dim">${fund ? `${(fund.hourlyPct * 24 * 365).toFixed(1)}% APR` : ''}</small></b></div>
    <div class="t-stat"><span>Next funding</span><b id="s-next">${untilNextHour()}</b></div>
    <div class="t-stat"><span>Max leverage</span><b>${p.marginRatioInitial ? (10_000n / BigInt(p.marginRatioInitial)).toString() + 'x' : '–'}</b></div>
  </div>`
}

/* ---------------- the book, the depth, the tape ---------------- */

function bookHtml(): string {
  const m = current()
  const b = ui.live.book && ui.live.bookFor === m?.name ? ui.live.book : null
  if (!b) return '<p class="dim small pad">Waiting for the book…</p>'
  const max = Math.max(...b.bids.map((l) => l.size), ...b.asks.map((l) => l.size), 1e-9)
  let cum = 0
  const row = (l: { price: number; size: number }, side: 'bid' | 'ask') => { cum += l.size; return `<div class="lvl ${side}" style="--w:${((l.size / max) * 100).toFixed(1)}%"><span>${pricef(l.price)}</span><span>${fmtNum(l.size, 3)}</span><span>${fmtNum(cum, 2)}</span></div>` }
  const LEVELS = 9
  cum = 0; const askRows = b.asks.slice(0, LEVELS).map((l) => row(l, 'ask')).reverse().join('')   // cumulative from the touch outwards, drawn top-down
  cum = 0; const bidRows = b.bids.slice(0, LEVELS).map((l) => row(l, 'bid')).join('')
  return `<div class="book-head"><span>Price</span><span>Size ${esc(m?.coin ?? '')}</span><span>Total</span></div>
    <div class="asks">${askRows}</div>
    <div class="mid"><b>${pricef(b.mid)}</b><span class="dim">spread ${b.spreadBps.toFixed(1)} bps</span></div>
    <div class="bids">${bidRows}</div>`
}

function tapeHtml(): string {
  const t = ui.live.trades
  if (!t) return '<p class="dim small pad">Waiting for trades…</p>'
  if (!t.length) return '<p class="dim small pad">No trades yet today.</p>'
  return `<div class="book-head"><span>Price</span><span>Size</span><span>Time</span></div>` + t.slice(0, 30).map((x) => `<div class="lvl ${x.side === 'buy' ? 'bid' : 'ask'} flat"><span>${pricef(x.price)}</span><span>${fmtNum(x.size, x.size < 0.01 ? 4 : 3)}</span><span>${new Date(x.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>`).join('')
}

function drawDepth() {
  const c = document.getElementById('depth') as HTMLCanvasElement | null
  const m = current()
  const b = ui.live.book && ui.live.bookFor === m?.name ? ui.live.book : null
  if (!c || !b) return
  const css = getComputedStyle(document.documentElement)
  const dpr = window.devicePixelRatio || 1
  const W = c.clientWidth, Hh = c.clientHeight
  c.width = W * dpr; c.height = Hh * dpr
  const g = c.getContext('2d')!
  g.scale(dpr, dpr); g.clearRect(0, 0, W, Hh)
  const bids = b.bids.slice(0, 14), asks = b.asks.slice(0, 14)
  let acc = 0; const bc = bids.map((l) => (acc += l.size)); acc = 0; const ac = asks.map((l) => (acc += l.size))
  const maxCum = Math.max(bc[bc.length - 1] ?? 0, ac[ac.length - 1] ?? 0, 1e-9)
  const lo = bids[bids.length - 1]?.price ?? b.mid, hi = asks[asks.length - 1]?.price ?? b.mid
  const x = (p: number) => ((p - lo) / (hi - lo || 1)) * W
  const y = (v: number) => Hh - (v / maxCum) * (Hh - 6)
  const area = (pts: [number, number][], color: string) => {
    if (!pts.length) return
    g.beginPath(); g.moveTo(pts[0][0], Hh)
    for (const [px, py] of pts) g.lineTo(px, py)
    g.lineTo(pts[pts.length - 1][0], Hh); g.closePath()
    g.fillStyle = color + '33'; g.fill(); g.strokeStyle = color; g.lineWidth = 1.2
    g.beginPath(); for (const [i, [px, py]] of pts.entries()) (i ? g.lineTo(px, py) : g.moveTo(px, py)); g.stroke()
  }
  // bids: step down from the mid to the left; asks: step up to the right
  const bp: [number, number][] = []; bids.forEach((l, i) => { bp.push([x(l.price), y(bc[i])]); if (bids[i + 1]) bp.push([x(bids[i + 1].price), y(bc[i])]) })
  const ap: [number, number][] = []; asks.forEach((l, i) => { ap.push([x(l.price), y(ac[i])]); if (asks[i + 1]) ap.push([x(asks[i + 1].price), y(ac[i])]) })
  area(bp.reverse(), css.getPropertyValue('--long').trim())
  area(ap, css.getPropertyValue('--short').trim())
  g.fillStyle = css.getPropertyValue('--muted').trim(); g.font = `11px ${css.getPropertyValue('--font').trim()}`
  g.fillText(pricef(lo), 4, 12); g.textAlign = 'right'; g.fillText(pricef(hi), W - 4, 12); g.textAlign = 'center'; g.fillText(pricef(b.mid), x(b.mid), 12)
}

function sidePanel(): string {
  return `<aside class="t-side">
    <div class="t-side-head"><h2>Order book</h2></div>
    <div class="book" id="book">${bookHtml()}</div>
    <canvas class="depth" id="depth" height="90"></canvas>
    <div class="t-side-head"><h2>Trades</h2></div>
    <div class="tape" id="tape">${tapeHtml()}</div>
  </aside>`
}

/** Replaces only the live panels, so the page isn't rebuilt every second. */
function patchLive() {
  const book = document.getElementById('book'); if (book) book.innerHTML = bookHtml()
  const tape = document.getElementById('tape'); if (tape) tape.innerHTML = tapeHtml()
  const mark = document.getElementById('s-mark'); const m = current(); const b = ui.live.book
  if (mark && b && ui.live.bookFor === m?.name) mark.textContent = pricef(b.mid)
  const next = document.getElementById('s-next'); if (next) next.textContent = untilNextHour()
  if (!document.querySelector('#chart-slot:hover')) legend(null)
  drawDepth()
}

async function pollBook() {
  if (DEPLOY) return
  const m = current(); if (!m || document.hidden) return
  const b = await fetchBook(m.name)
  if (current()?.name !== m.name) return
  ui.live.book = b; ui.live.bookFor = m.name
  patchLive()
}
async function pollTrades() {
  if (DEPLOY) return
  const m = current(); if (!m || document.hidden) return
  const t = await fetchTrades(m.name)
  if (current()?.name !== m.name) return
  ui.live.trades = t
  if (chart && chart.coin === m.coin) void chart.refreshLast()
  patchLive()
}
async function pollSlow() {
  const m = current(); if (!m || document.hidden) return
  const [st, fu, feed] = await Promise.all([fetchStats(), fetchFunding(m.name), fetchFeed()])
  if (st) ui.live.stats = st
  if (current()?.name === m.name) ui.live.funding = fu
  if (feed) { ui.live.feed = feed; drawBubbles() }
}

function chartPanel(): string {
  const ind = ui.indicators
  const toggle = (name: keyof Indicators, label: string, color: string) => `<button class="iv ind ${ind[name] ? '' : 'off'}" data-action="indicator" data-arg="${name}" style="--c:${color}"><i></i>${label}</button>`
  return `<section class="t-chart">
    <div class="t-chart-bar">
      <div class="group">${INTERVALS.map((i) => `<button class="iv ${i === ui.interval ? 'on' : ''}" data-action="interval" data-arg="${i}">${i}</button>`).join('')}</div>
      <div class="group">${toggle('ema', 'EMA 20 · 50 · 200', '#f5c542')}${toggle('vwap', 'VWAP', '#ffffff')}${toggle('volume', 'Volume', 'var(--long)')}</div>
    </div>
    <div id="chart-slot"><div id="chart-legend" class="chart-legend"></div><div id="chart-bubbles" class="chart-bubbles"></div><div id="chart-tip" class="chart-tip" hidden></div></div>
  </section>`
}

/** True while the current key can't sign something new: a move is pending, or this key already signed. */
function blocked(): boolean {
  const b = ui.chain.bunker
  return !b || H.hasPending(b) || !!ledger.get(keys().address, b.nonce)
}

function pendingBanner(): string {
  const b = ui.chain.bunker
  if (!b || !ui.master) return ''
  if (H.hasPending(b)) {
    const record = ledger.get(keys().address, b.pendingNonce)
    return `<div class="note">Key #${b.pendingNonce} authorized ${record?.note ? 'a ' + esc(record.note) : 'a move'} that hasn't run yet.
      <div class="row">${record ? '<button data-action="runPending">Send it</button>' : ''}<button class="ghost" data-action="dropPending">Call it off (key #${b.nonce})</button></div></div>`
  }
  const unsent = ledger.get(keys().address, b.nonce)
  if (unsent) {
    const k = ledger.key(keys().address, b.nonce)
    const sent = !!localStorage.getItem(`${k}:sent`), at = Number(localStorage.getItem(`${k}:at`) || 0)
    const canDiscard = !sent || Date.now() - at > 180_000   // never handed to the network, or its blockhash window is long gone: it can never land
    return `<div class="note">Key #${b.nonce} already signed ${unsent.note ? 'a ' + esc(unsent.note) : 'a move'} on this device and it hasn't landed. A key signs one message: send that one again${canDiscard ? ', or discard it' : ''}.
      <div class="row"><button data-action="resend">Send it again</button>${canDiscard ? '<button class="ghost" data-action="discardSigned">Discard it</button>' : ''}</div>
      ${canDiscard ? `<p class="dim small">Discarding is safe here: ${sent ? 'the signature was sent minutes ago and its window has passed, so it can never land' : 'the signature never left this device'}. Key #${b.nonce} signs something else next.</p>` : ''}</div>`
  }
  return ''
}

/** The right column: words → bunker → the order form. */
function orderPanel(): string {
  const m = current()
  if (!ui.master) {
    if (ui.fresh) {
      return `<section class="t-order"><h2>Your 24 words</h2>
        <ol class="words">${ui.fresh.split(' ').map((w) => `<li>${w}</li>`).join('')}</ol>
        <p class="note">Write them down now. They are the bunker: every order and every withdrawal is signed with a key derived from them, and nothing else can move what is inside.</p>
        <div class="row"><button class="ghost sm" data-action="copyWords">Copy</button><button class="ghost sm" data-action="downloadWords">Download as a file</button></div><label class="t-check"><input type="checkbox" data-action="rememberWords" ${ui.form.remember !== 'no' ? 'checked' : ''} /> Keep them in this browser, so closing the tab does not lose them (anyone with this browser can then use the bunker)</label>
        <div class="row"><button data-action="confirmWords">I saved them</button></div></section>`
    }
    return `<section class="t-order"><h2>Step 2 · 24 words</h2>
      <p class="dim">A bunker has no private key. Its 24 words derive one-time keys: each signs once and names the next.</p>
      <div class="row"><button data-action="newWords">Generate 24 words</button></div>
      <div class="row">${field('words', 'Or enter the words of a bunker you already have', 'placeholder="word1 word2 …" autocomplete="off" spellcheck="false"')}</div>
      <div class="row"><button class="ghost" data-action="importWords">Use these words</button></div>${errLine()}</section>`
  }
  if (!ui.chain.bunker || !ui.chain.user) {
    const lowSol = NET !== 'localnet' && ui.chain.sol < OPEN_SOL
    return `<section class="t-order"><h2>Step 3 · Bunker</h2>
      <dl><div><dt>Address</dt><dd class="small" id="bunker-address">${keys().address.toBase58()}</dd></div></dl>
      <p class="dim">Opens the bunker and its trading account. The account belongs to the bunker, not to your wallet.</p>
      <p class="dim small">The wallet pays the rent of the two accounts and the fees: about ${OPEN_SOL} SOL. It holds ${ui.chain.sol.toFixed(4)} SOL.${lowSol ? ` <b class="neg">Send at least ${OPEN_SOL} SOL to ${esc(ui.wallet!.publicKey.toBase58())} first.</b>` : ''}</p>
      <div class="row"><button data-action="createBunker" ${lowSol || ui.busy ? 'disabled' : ''}>Create bunker</button></div>${errLine()}</section>`
  }
  const b = ui.chain.bunker
  const held = collateral()
  const cant = blocked()
  const long = f('side') === 'long'
  const limitMode = f('type') === 'limit'
  return `<section class="t-order">
    <div class="t-acct">
      <div><dt>Collateral</dt><dd id="collateral">${usd(held)} ${quoteName()}</dd></div>
      <div><dt>Bunker</dt><dd><span class="badge locked">key #${b.nonce}</span></dd></div>
      <button class="ghost sm" data-action="account">Deposit / Withdraw</button>
    </div>
    ${pendingBanner()}
    <div class="side"><button data-action="side" data-arg="long" class="long ${long ? 'on' : ''}">Long</button><button data-action="side" data-arg="short" class="short ${long ? '' : 'on'}">Short</button></div>
    <div class="t-type"><button data-action="type" data-arg="market" class="${limitMode ? '' : 'on'}">Market</button><button data-action="type" data-arg="limit" class="${limitMode ? 'on' : ''}">Limit</button></div>
    <div class="t-sizemode"><button type="button" class="chip ${sizeMode() === 'margin' ? 'on' : ''}" data-action="sizeMode" data-arg="margin">Margin × leverage</button><button type="button" class="chip ${sizeMode() === 'base' ? 'on' : ''}" data-action="sizeMode" data-arg="base">Size in ${esc(m?.coin ?? '')}</button></div>
    <div class="row">${field('size', sizeMode() === 'margin' ? `Margin (${quoteName()})` : `Size (${esc(m?.coin ?? '')})`, 'inputmode="decimal" placeholder="' + (sizeMode() === 'margin' ? '100' : '') + '"')}${limitMode ? field('limit', `Limit price (${quoteName()})`, 'inputmode="decimal"') : field('slippage', 'Slippage %', 'inputmode="decimal"')}</div>
    ${leverageHtml()}${errLine()}
    <label class="t-check"><input type="checkbox" data-action="reduceOnly" ${ui.form.reduceOnly ? 'checked' : ''} /> Reduce only</label>
    ${previewHtml()}
    <button data-action="order" class="${long ? 'long' : 'short'} wide" ${cant || held <= 0n ? 'disabled' : ''}>Sign with key #${b.nonce} &amp; ${long ? 'buy' : 'sell'} ${esc(m?.coin ?? '')}</button>
    ${held > 0n ? '' : '<p class="dim small">Deposit collateral first.</p>'}
    ${hirePanel()}
  </section>`
}

/** Hire one of the agents for this bunker, or see who is trading it and fire them. */
function hirePanel(): string {
  const u = ui.chain.user, b = ui.chain.bunker
  if (!u || !b) return ''
  const cant = blocked()
  const feedOf = (id: string) => ui.live.feed?.agents.find((a) => a.id === id)
  const face = (id: string) => avatarHtml({ color: AGENT_META[id].color, initials: AGENT_META[id].initials, avatar: AGENT_META[id].avatar })
  if (u.delegate.toBase58() === CUSTOM_DELEGATE) {
    const cfg = H.decodeAgentName(u.name), name = cfg?.label || 'Your agent'
    return `<div class="t-hire hired" id="hire" style="--c:var(--accent)">
      <h2>Your agent</h2>
      <div class="hire-row">${avatarHtml({ color: '#9945ff', initials: name.slice(0, 2).toUpperCase(), avatar: `logo:${keys().address.toBase58()}` })}<div class="who"><b id="hired-name">${esc(name)}</b><span class="dim small">Your own agent trades this bunker. It can trade, it cannot withdraw.</span></div></div>
      <button class="ghost wide" data-action="fire" ${cant ? 'disabled' : ''}>Sign with key #${b.nonce} &amp; switch it off</button>
    </div>`
  }
  const hired = agentOfDelegate(u.delegate.toBase58())
  if (hired) {
    const a = AGENT_META[hired]
    return `<div class="t-hire hired" id="hire" style="--c:${a.color}">
      <h2>Your agent</h2>
      <div class="hire-row">${face(hired)}<div class="who"><b id="hired-name">${esc(a.name)}</b><span class="dim small">Trading this bunker. It can trade, it cannot withdraw.</span></div></div>
      <button class="ghost wide" data-action="fire" ${cant ? 'disabled' : ''}>Sign with key #${b.nonce} &amp; fire ${esc(a.name)}</button>
    </div>`
  }
  const enough = collateral() >= BigInt(MIN_HIRE_USDT) * 10n ** BigInt(ui.chain.quote?.decimals ?? 6)
  const rows = Object.keys(DELEGATES).map((id) => {
    const a = AGENT_META[id], f = feedOf(id)
    const all = f?.allTimePct
    return `<div class="hire-row ${ui.hirePick === id ? 'pick' : ''}" style="--c:${a.color}">${face(id)}
      <div class="who"><b>${esc(a.name)}</b><span class="dim small">${esc(a.strategy.split(':')[0])}${all != null ? ` · <span class="${all >= 0 ? 'pos' : 'neg'}">${all >= 0 ? '+' : ''}${all.toFixed(1)}%</span>` : ''}</span></div>
      <button class="sm" data-action="hire" data-arg="${id}" ${cant || !enough ? 'disabled' : ''}>Hire</button></div>`
  }).join('')
  return `<div class="t-hire" id="hire">
    <h2>Hire an agent</h2>
    <p class="dim small">It trades this bunker for you: the trades it takes on its own, about a tenth of your equity each. It can never withdraw. Your words fire it.</p>
    ${rows}
    <p class="dim small">${enough ? `Hiring is signed with key #${b.nonce}.` : `Deposit at least ${MIN_HIRE_USDT} ${quoteName()} to hire.`} <a href="/deploy.html?create=1">Or create your own agent →</a></p>
  </div>`
}

function bottomPanel(): string {
  const u = ui.chain.user
  const feed = ui.live.feed
  const here = current()?.name ?? ''
  const agentsHere = feed ? feed.agents.filter((a) => (a.positions ?? []).some((p) => p.market === here) || (a.orders ?? []).some((o) => o.market === here)).length : 0
  const tabs = (['positions', 'orders', 'agents', 'activity'] as const).map((t) => `<button class="tab ${ui.tab === t ? 'on' : ''}" data-action="tab" data-arg="${t}">${t[0].toUpperCase() + t.slice(1)}${t === 'orders' && u ? ` (${V.openOrders(u).length})` : ''}${t === 'agents' && agentsHere ? ` (${agentsHere})` : ''}</button>`).join('')
  let body = ''
  if (ui.tab === 'positions') {
    const rows = u ? u.perpPositions.filter((p) => p.baseAssetAmount !== 0n).map((p) => {
      const m = marketOf(p.marketIndex)
      const long = p.baseAssetAmount > 0n
      const abs = long ? p.baseAssetAmount : -p.baseAssetAmount
      const entry = ((p.quoteEntryAmount < 0n ? -p.quoteEntryAmount : p.quoteEntryAmount) * V.BASE_PRECISION) / abs
      const pnl = m?.price ? (p.baseAssetAmount * m.price) / V.BASE_PRECISION + p.quoteAssetAmount : 0n
      return `<tr><td>${esc(m?.name ?? String(p.marketIndex))}</td><td class="${long ? 'pos' : 'neg'}" id="pos-size">${long ? 'Long' : 'Short'} ${base(abs)}</td><td>${price(entry)}</td><td>${m?.price ? price(m.price) : '–'}</td><td class="${pnl >= 0n ? 'pos' : 'neg'}">${usd(pnl)}</td>
        <td><button class="ghost sm" data-action="close" data-arg="${p.marketIndex}" ${blocked() ? 'disabled' : ''}>Close</button></td></tr>`
    }) : []
    body = rows.length ? `<table><tr><th>Market</th><th>Size</th><th>Entry</th><th>Oracle</th><th>PnL</th><th></th></tr>${rows.join('')}</table>` : '<p class="dim" id="pos-size">No open positions.</p>'
  } else if (ui.tab === 'orders') {
    const rows = u ? V.openOrders(u).filter((o) => o.marketType === V.MARKET_TYPE.PERP).map((o) => `<tr class="order"><td>${esc(marketOf(o.marketIndex)?.name ?? String(o.marketIndex))}</td><td>${o.orderId}</td><td class="${o.direction === V.DIRECTION.LONG ? 'pos' : 'neg'}">${o.direction === V.DIRECTION.LONG ? 'Buy' : 'Sell'}${o.reduceOnly ? ' · reduce' : ''}</td><td>${base(o.baseAssetAmount - o.baseAssetAmountFilled)}</td><td>${price(o.price)}</td>
        <td><button class="ghost sm" data-action="cancel" data-arg="${o.orderId},${o.marketIndex}" ${blocked() ? 'disabled' : ''}>Cancel</button></td></tr>`) : []
    body = rows.length ? `<table><tr><th>Market</th><th>Order</th><th>Side</th><th>Size</th><th>Limit</th><th></th></tr>${rows.join('')}</table>` : '<p class="dim">No open orders.</p>'
  } else if (ui.tab === 'agents') {
    body = agentsHtml()
  } else {
    body = `<div id="log">${ui.log.length ? ui.log.slice(0, 40).map((l) => `<div class="${l.kind}"><span class="at">${new Date(l.at).toLocaleTimeString()}</span>${esc(l.text)}</div>`).join('') : '<div class="dim">Nothing yet.</div>'}</div>`
  }
  return `<section class="t-bottom"><div class="tabs">${tabs}</div>${body}</section>`
}

/** The agents on this market: one line each. Open trade or not, and the running result. */
function agentsHtml(): string {
  const feed = ui.live.feed
  const m = current()
  if (!feed || !m) return '<p class="dim">The agents\' feed is not available right now.</p>'
  const rows = feed.agents.map((a) => {
    const pos = a.positions.filter((p) => p.market === m.name)
    const all = a.allTimePnl ?? 0
    const line = pos.length
      ? pos.map((p) => `<b class="${p.side === 'long' ? 'pos' : 'neg'}">${p.side === 'long' ? 'Long' : 'Short'} ${fmtNum(p.size, 3)} ${esc(m.coin)}</b> @ ${pricef(p.entry)} · <b class="${p.unrealized > 0 ? 'pos' : p.unrealized < 0 ? 'neg' : ''}">${p.unrealized >= 0 ? '+' : ''}${p.unrealized.toFixed(2)}</b>${p.stop ? ` <span class="dim">· stop ${pricef(p.stop)}${p.target ? ' · target ' + pricef(p.target) : ''}</span>` : ''}`).join('<br>')
      : a.positions.length
        ? `<span class="dim">No trade open on ${esc(m.coin)} ·</span> ${a.positions.map((p) => `<b class="${p.side === 'long' ? 'pos' : 'neg'}">${p.side === 'long' ? 'Long' : 'Short'} ${fmtNum(p.size, 3)} ${esc(p.market.replace('-PERP', ''))}</b> <b class="${p.unrealized > 0 ? 'pos' : p.unrealized < 0 ? 'neg' : ''}">${p.unrealized >= 0 ? '+' : ''}${p.unrealized.toFixed(2)}</b>`).join(', ')}`
        : `<span class="dim">${FLAT_TEXT}</span>`
    const yours = ui.chain.user && agentOfDelegate(ui.chain.user.delegate.toBase58()) === a.id
    return `<div class="agent-line">${avatarHtml(a)}<div class="who"><b>${esc(a.name)}${yours ? ' <span class="badge locked">trading your bunker</span>' : ''}</b><span class="dim small">${esc(a.strategy ?? '')}</span></div><div class="now">${line}</div><div class="all ${all > 0 ? 'pos' : all < 0 ? 'neg' : 'dim'}">${all >= 0 ? '+' : ''}${all.toFixed(2)} <span class="dim small">all time</span></div></div>`
  }).join('')
  return `<div class="agents">${rows}<p class="dim small pad"><a href="/agents.html">All trades and profiles →</a></p></div>`
}

/* ---------------- the deploy wizard ---------------- */

function deployView(): string {
  const d = ui.deploy
  const choice = d.choice || 'hire'
  const face = (id: string, cls = 'avatar') => avatarHtml({ color: AGENT_META[id].color, initials: AGENT_META[id].initials, avatar: AGENT_META[id].avatar }, cls)
  const step = (n: number, title: string, body: string, state: 'done' | 'now' | 'later') => `<section class="dp-step ${state}"><span class="dp-n">${state === 'done' ? '✓' : n}</span><div><h2>${title}</h2>${state === 'later' ? '' : body}</div></section>`
  // already on autopilot?
  const hired = ui.chain.user ? agentOfDelegate(ui.chain.user.delegate.toBase58()) : null
  const custom = !!ui.chain.user && ui.chain.user.delegate.toBase58() === CUSTOM_DELEGATE
  const current = ui.chain.user ? H.decodeAgentName(ui.chain.user.name) : null
  if (d.done || hired || custom) {
    const who = d.done || (hired ? `${AGENT_META[hired].name} is trading your bunker` : `${current?.label || 'Your agent'} is live`)
    return `<main class="deploy"><section class="dp-done" style="--c:${hired ? AGENT_META[hired].color : 'var(--accent)'}">
      ${hired ? face(hired) : ''}<h1>${esc(who)}.</h1>
      <p class="dim">${current ? `${current.kind === 'hired' ? AGENT_META['ash' + current.base]?.name ?? '' : esc(current.label)} · ${esc(BASE_LABEL[current.base])} · ${esc(AGGR_LABEL[current.aggr])}` : ''} It decides on its own schedule; its first move shows on the chart when it takes it.</p>
      <div class="l-cta"><a class="btn lg" href="/app.html">See it on the chart</a><a class="btn lg ghost" href="/agents.html">All agents</a></div>
      <div class="row"><button class="ghost sm" data-action="fire" ${blocked() ? 'disabled' : ''}>Switch it off (key #${ui.chain.bunker?.nonce ?? '?'})</button>${d.done ? '' : '<button class="ghost sm" data-action="deployAgain">Change</button>'}</div>
      ${ui.log.length ? `<p class="dim small">${esc(ui.log[0].text)}</p>` : ''}
    </section></main>`
  }
  const has1 = !!ui.wallet, has2 = !!ui.master
  const stage = !has1 ? 1 : !has2 ? 2 : 3
  const bar = `<ol class="dp-bar">${['Wallet', '24 words', 'Choose', 'Fund and go'].map((t, i) => { const n = i + 1, st = n < stage ? 'done' : n === stage || (stage === 3 && n === 4) ? 'now' : 'later'; return `<li class="${st}"><span class="dp-n">${st === 'done' ? '✓' : n}</span><span>${t}</span></li>` }).join('')}</ol>`
  // 1 wallet
  const s1 = ui.wallet
    ? `<p class="dp-line dim">${esc(ui.wallet.name)} · ${short(ui.wallet.publicKey)} · ${ui.chain.sol.toFixed(3)} SOL · ${usd(ui.chain.tokens)} ${quoteName()}${ui.wallet.local && NET === 'localnet' ? ' <button class="ghost sm" data-action="fund">Get test funds</button>' : ''}</p>`
    : `<p class="dim">It pays network fees and sends your collateral in. It has no power over the bunker.</p><div class="row">${hasPhantom() ? '<button data-action="phantom">Connect Phantom</button>' : ''}<button class="${hasPhantom() ? 'ghost' : ''}" data-action="browserWallet">${hasBrowserWallet() ? 'Use the wallet in this browser' : 'Create a wallet in this browser'}</button></div>`
  // 2 words
  const s2 = ui.master
    ? `<p class="dp-line dim">Loaded in this tab · bunker ${short(keys().address)}${ui.chain.user ? ' · account open' : ''}</p>`
    : ui.fresh
      ? `<ol class="words">${ui.fresh.split(' ').map((w) => `<li>${w}</li>`).join('')}</ol><p class="note">Write them down now. They are the bunker.</p><div class="row"><button class="ghost sm" data-action="copyWords">Copy</button><button class="ghost sm" data-action="downloadWords">Download as a file</button></div><label class="t-check"><input type="checkbox" data-action="rememberWords" ${ui.form.remember !== 'no' ? 'checked' : ''} /> Keep them in this browser, so closing the tab does not lose them (anyone with this browser can then use the bunker)</label><div class="row"><button data-action="confirmWords">I saved them</button></div>`
      : `<p class="dim">A bunker has no private key. Its 24 words derive one-time keys: each signs once.</p><div class="row"><button data-action="newWords">Generate 24 words</button></div><div class="row">${field('words', 'Or the words of a bunker you already have', 'placeholder="word1 word2 …" autocomplete="off" spellcheck="false"')}<button class="ghost" data-action="importWords">Use these words</button></div>`
  // 3 choose: who, or what, trades the bunker
  const STRATEGIES: [1 | 2 | 3 | 4, string, string][] = [
    [1, 'Trend following', 'Rides the 4h direction: buys pullbacks in an uptrend, sells bounces in a downtrend, and lets winners run behind a trailing stop.'],
    [2, 'Mean reversion', 'Fades stretched moves: enters when price runs too far from its average or the crowd piles onto one side, and takes profit as it comes back.'],
    [3, 'Momentum', 'Breakouts with volume behind them: enters as a level gives way, keeps a tight stop and trails the winner.'],
    [4, 'Write your own', 'Your instructions, in your words: what it trades, how it enters and exits, how it talks. The risk limits you pick still apply.'],
  ]
  const LEVELS: [1 | 2 | 3, string, string, string, string][] = [
    [1, 'Careful', '10% of equity a trade', 'No leverage', 'Decides every hour'],
    [2, 'Standard', '20% of equity a trade', 'Up to 2x', 'Decides every 30 minutes'],
    [3, 'All in', 'The house setting', 'Up to 5x, two markets at once', 'Decides every 10 minutes'],
  ]
  const tabs = `<div class="dp-tabs">
      <button class="dp-tab ${choice === 'hire' ? 'on' : ''}" data-action="pick" data-arg="hire"><b>Hire an agent</b><small>One of the three house traders works your bunker too, with the trades it takes on its own. Its face on the chart, with your name.</small></button>
      <button class="dp-tab ${choice === 'custom' ? 'on' : ''}" data-action="pick" data-arg="custom"><b>Create your own</b><small>Your name and logo, a strategy you pick, as hard as you want it to trade. It shows on the chart and in the desk chat with the others.</small></button>
    </div>`
  const agentCards = Object.keys(DELEGATES).map((id) => {
    const a = AGENT_META[id], live = ui.live.feed?.agents.find((x) => x.id === id), [what, how] = a.strategy.split(/:\s*/)
    return `<button class="dp-opt ${choice === 'hire' && d.agent === id ? 'on' : ''}" data-action="pick" data-arg="hire:${id}" style="--c:${a.color}">${face(id, 'avatar lg')}<b>${esc(a.name)}</b><span class="dp-strat">${esc(what)}</span><p>${esc(how ?? '')}</p>${live?.allTimePct != null ? `<small class="${live.allTimePct >= 0 ? 'pos' : 'neg'}">${live.allTimePct >= 0 ? '+' : ''}${live.allTimePct.toFixed(1)}% all time</small>` : ''}</button>`
  }).join('')
  const strategyCards = STRATEGIES.map(([v, t, why]) => `<button class="dp-opt ${d.base === v ? 'on' : ''}" data-action="base" data-arg="${v}" style="--c:${v === 4 ? '#b366ff' : AGENT_META['ash' + v].color}"><b>${t}</b><p>${why}</p><small>${v === 4 ? 'Your own prompt' : `${face('ash' + v, 'avatar xs')} ${AGENT_META['ash' + v].name}'s method`}</small></button>`).join('')
  const promptBox = `<label class="dp-prompt">Your trading prompt<textarea data-field="prompt" rows="8" maxlength="1500" placeholder="Example: Trade SOL only. Go long on a 1h close above the 4h EMA20 with rising volume, short the mirror image. Keep the stop under the last swing, take profit at 2R, never add to a loser. Talk like a calm desk trader.">${esc(f('prompt'))}</textarea><span class="dim small"><span class="count">${f('prompt').length}/1500</span> · Saved once, under your bunker's address. The aggressiveness you pick below still applies: the code enforces it whatever the prompt says.</span></label>`
  const levelCards = LEVELS.map(([v, t, ...specs]) => `<button class="dp-opt ${d.aggr === v ? 'on' : ''}" data-action="aggr" data-arg="${v}"><b>${t}</b><ul class="dp-spec">${specs.map((x) => `<li>${x}</li>`).join('')}</ul></button>`).join('')
  const s3 = `${tabs}
    ${choice === 'hire'
      ? `<h3 class="dp-h">Who trades for you</h3><div class="dp-grid3">${agentCards}</div><div class="row">${field('ownerName', 'Your name on the chart (optional)', 'maxlength="24" placeholder="Bob"')}</div>`
      : `<div class="dp-identity">${field('agentName', 'Name, as it appears on the chart', 'maxlength="24" placeholder="Bob\'s bot"')}<div class="dp-file"><span>Logo (png, jpg or webp, up to 300 KB)</span><div class="row"><button type="button" class="ghost sm" data-action="pickLogo">Choose a file</button><span class="dim small">${d.logo ? esc(d.logo.name) : 'No file chosen'}</span></div><input type="file" data-logo hidden accept="image/png,image/jpeg,image/webp" /></div></div>
         <h3 class="dp-h">Pick a trading strategy</h3><div class="dp-grid4">${strategyCards}</div>${d.base === 4 ? promptBox : ''}`}
    <h3 class="dp-h">How hard it trades</h3><div class="dp-grid3">${levelCards}</div>`
  // 4 fund + go
  const fundSol = (f('fundAsset') || 'usdt') === 'sol'
  const enough = Number(f('fund') || 0) * (fundSol ? solPrice() : 1) + Number(collateral()) / 1e6 >= MIN_HIRE_USDT
  const lvl = LEVELS[d.aggr - 1]
  const summary = choice === 'hire' ? `${AGENT_META[d.agent].name}${f('ownerName').trim() ? ` for ${f('ownerName').trim()}` : ''}` : `${f('agentName').trim() || 'Your agent'} · ${STRATEGIES[d.base - 1][1]}`
  const s4 = `<div class="dp-fund"><div>${assetChips('fundAsset')}<div class="row">${field('fund', fundSol ? `Deposit SOL from the wallet (swapped to ${quoteName()} first; the bunker holds ${usd(collateral())})` : `Deposit ${quoteName()} from the wallet (the bunker holds ${usd(collateral())})`, 'inputmode="decimal"')}</div></div>
      <aside class="dp-summary"><b>${esc(summary)}</b><span>${lvl[1]} · ${lvl[2]} · ${lvl[3]} · ${lvl[4].toLowerCase()}</span><span class="dim small">At least ${MIN_HIRE_USDT} ${quoteName()} in the bunker. The agent can trade it and never withdraw it; your words take it out whenever you want.</span></aside></div>
    <button class="wide lg" data-action="deployGo" ${!enough || ui.busy ? 'disabled' : ''}>${choice === 'custom' ? 'Create the agent' : `Hire ${esc(AGENT_META[d.agent].name)}`}</button>
    ${ui.log.length ? `<p class="${ui.log[0].kind === 'err' ? 'gate-err' : 'dim'} small">${esc(ui.log[0].text)}</p>` : ''}`
  return `<main class="deploy">
    <header class="dp-head"><p class="eyebrow">Deploy</p><h1>Put an agent on <em>your bunker.</em></h1><p class="l-lede">Four steps. The agent trades, you keep the keys.</p>${bar}</header>
    ${step(1, 'Wallet', s1, has1 ? 'done' : 'now')}
    ${step(2, '24 words', s2, !has1 ? 'later' : has2 ? 'done' : 'now')}
    ${step(3, 'Choose', s3, has1 && has2 ? 'now' : 'later')}
    ${step(4, 'Fund and go', s4, has1 && has2 ? 'now' : 'later')}
  </main>`
}

/** The account drawer: wallet, words, bunker funding. */
function drawer(): string {
  const w = ui.wallet!
  const b = ui.chain.bunker
  const held = collateral()
  const spendable = Math.max(0, ui.chain.sol - SOL_RESERVE)
  return `<div class="drawer-back" data-action="closeDrawer"></div><aside class="drawer">
    <div class="drawer-head"><h2>Account</h2><button class="ghost sm" data-action="closeDrawer">Close</button></div>
    <section><h2>Wallet</h2>
      <dl>
        <div><dt>${esc(w.name)}</dt><dd id="wallet-address" class="small">${w.publicKey.toBase58()}</dd></div>
        <div><dt>SOL</dt><dd>${ui.chain.sol.toFixed(3)}</dd></div>
        <div><dt>${quoteName()}</dt><dd id="wallet-tokens">${usd(ui.chain.tokens)}</dd></div>
      </dl>
      <div class="row">
        ${w.local && NET === 'localnet' ? '<button class="ghost sm" data-action="fund">Get test funds</button>' : ''}
        ${w.local ? `<button class="ghost sm" data-action="showSecret">${ui.showSecret ? 'Hide' : 'Back up'} secret key</button>` : ''}
        <button class="ghost sm" data-action="disconnect">Disconnect</button>
      </div>
      ${w.local && ui.showSecret ? `<p>Keep this somewhere safe: it is the only copy. It imports into Phantom and the Solana CLI.</p><p class="mono small break" style="user-select:all">${esc(browserWalletSecret() ?? '')}</p>` : ''}
    </section>
    ${b && ui.chain.user ? `<section><h2>Deposit</h2>
      <div class="acct-cards">
        <article class="acct-card">
          <h3>Deposit ${quoteName()} here</h3>
          <p class="dim small">Send ${quoteName()} on Solana to the wallet's address, then press the button.</p>
          <p class="mono small break acct-addr" style="user-select:all">${w.publicKey.toBase58()}</p>
          ${ui.chain.tokens > 0n ? `<div class="row">${field('deposit', `Amount (empty = all ${usd(ui.chain.tokens)})`, 'inputmode="decimal"')}<button data-action="depositUsdt">Deposit</button></div>` : `<p class="dim small">No ${quoteName()} in the wallet yet.</p>`}
        </article>
        <article class="acct-card">
          <h3>Swap SOL for ${quoteName()}</h3>
          <p class="dim small">The wallet holds ${ui.chain.sol.toFixed(3)} SOL. It swaps on the open market and deposits in one go: two signatures.</p>
          ${spendable > 0.001 ? `<div class="row">${field('depositSol', `SOL to swap (empty = all ${spendable.toFixed(3)})`, 'inputmode="decimal"')}<button data-action="depositSol">Swap and deposit</button></div>` : `<p class="dim small">Send SOL to the address above first (${SOL_RESERVE} stays for fees).</p>`}
        </article>
      </div>
    </section>
    <section><h2>Withdraw <span class="badge locked">key #${b.nonce}</span></h2>
      <dl><div><dt>Bunker</dt><dd class="small" id="bunker-address">${keys().address.toBase58()}</dd></div><div><dt>Collateral</dt><dd>${usd(held)} ${quoteName()}</dd></div></dl>
      <p class="dim small">Withdrawing is signed with the next one-time key.</p>
      <div class="row">${field('withdraw', `${quoteName()} (empty = all)`, 'inputmode="decimal"')}${field('to', 'To (empty = this wallet)', 'placeholder="owner address" autocomplete="off" spellcheck="false"')}</div>
      <p class="dim small burn-line">${burnLine()}</p>
      <div class="row"><button class="ghost" data-action="withdraw" ${held > 0n && !blocked() ? '' : 'disabled'}>Withdraw</button></div>
    </section>` : `<section><h2>Bunker</h2><p class="dim">Open the bunker first: Step 3 in the terminal. Deposits and withdrawals appear here after that.</p></section>`}
    ${ui.master ? `<section><h2>24 words</h2><p class="dim small">Loaded in this tab. They sign here in the browser and are never sent anywhere. Closing the tab forgets them: keep a copy.</p>
      <div class="row"><button class="ghost sm" data-action="showWords">${ui.showWords ? 'Hide' : 'Show'} the 24 words</button><button class="ghost sm" data-action="forgetWords">Forget them in this tab</button></div>
      ${ui.showWords ? `<ol class="words">${(sessionStorage.getItem(WORDS_KEY) ?? '').split(' ').map((w) => `<li>${esc(w)}</li>`).join('')}</ol>` : ''}</section>` : ''}
  </aside>`
}

function render() {
  const app = document.getElementById('app')!
  const active = document.activeElement as HTMLInputElement | null
  const focused = active?.dataset?.field
  const caret = focused ? active!.selectionStart : null
  chartHost.remove()
  const m = current()
  app.innerHTML = `
    <header class="nav"><div class="nav-in">
      <a class="brand" href="/" aria-label="HashLiquid home"><img src="/logo.png" width="34" height="34" alt="" /><b>HashLiquid</b></a>
      ${DEPLOY ? '<span class="nav-note">Deploy an agent</span>' : ui.wallet && m ? `<span class="nav-note">${esc(m.name)} <b>${m.price ? price(m.price) : ''}</b></span>` : '<span class="nav-note">Trade perps in bunker mode.</span>'}
      <nav class="nav-links" aria-label="Pages"><a href="/agents.html">Agents</a><a href="/docs.html">Docs</a><a data-link="x" hidden rel="noopener" target="_blank">X</a><a data-link="chart" hidden rel="noopener" target="_blank">Chart</a></nav>
      ${ui.wallet ? `<button class="ghost sm" data-action="account">${short(ui.wallet.publicKey)}</button>` : ''}
    </div></header>
    ${DEPLOY ? deployView() : ui.wallet ? `<main class="term">
      ${marketsPanel()}
      <div class="t-center">${marketStrip()}${chartPanel()}${bottomPanel()}</div>
      ${sidePanel()}
      ${orderPanel()}
    </main>${ui.drawer ? drawer() : ''}` : gate()}
    <div id="busy" role="status">${esc(ui.busy)}</div>`
  wireLinks(); spotlight(); buttons()
  const slot = DEPLOY ? null : document.getElementById('chart-slot')
  if (slot) {
    slot.insertBefore(chartHost, slot.firstChild)
    if (!chart || chart.coin !== m?.coin) void loadChart()
    else { drawLines(); drawBubbles(); legend(null) }
    drawDepth()
  }
  if (focused) {
    const el = app.querySelector<HTMLInputElement>(`input[data-field="${focused}"], textarea[data-field="${focused}"]`)
    if (el) { el.focus(); if (caret !== null) el.setSelectionRange(caret, caret) }
  }
}

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')
  if (!el || (el as HTMLButtonElement).disabled) return
  if (el instanceof HTMLInputElement && el.type === 'checkbox' && el.dataset.action !== 'rememberWords') { ui.form[el.dataset.action!] = el.checked; render(); return }
  void run(el.dataset.action!, el.dataset.arg)
})
document.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement
  if (el.dataset?.lev !== undefined) {   // the slider; the page is not rebuilt under the thumb
    if (sizeMode() === 'margin') ui.form.lev = el.value
    else { ui.form.size = sizeForLeverage(Number(el.value)); const sz = document.querySelector<HTMLInputElement>('input[data-field="size"]'); if (sz) sz.value = ui.form.size }
    const v = document.querySelector('.t-lev-val'); if (v) v.textContent = `${Number(el.value).toFixed(1)}x`
    const pv = document.querySelector('.t-preview'); if (pv) pv.outerHTML = previewHtml()
    for (const c of Array.from(document.querySelectorAll<HTMLElement>('.t-lev-chips .chip'))) c.classList.toggle('on', Math.abs(Number(c.dataset.arg) - Number(el.value)) < 0.05)
    return
  }
  if (!el.dataset?.field) return
  ui.form[el.dataset.field] = el.value
  if (el.dataset.field === 'prompt') { const n = document.querySelector('.dp-prompt .count'); if (n) n.textContent = `${el.value.length}/1500` }
  if (el.dataset.field === 'withdraw') { const n = document.querySelector('.burn-line'); if (n) n.textContent = burnLine() }
  // the order preview follows the form without rebuilding the page under the cursor
  const pv = document.querySelector('.t-preview')
  if (pv) pv.outerHTML = previewHtml()
  if (el.dataset.field === 'size' && sizeMode() === 'base') { const lev = leverageOfForm(); const r = document.querySelector<HTMLInputElement>('input[data-lev]'); if (r) r.value = String(Math.min(Math.max(lev || 1, 1), Number(r.max))); const v = document.querySelector('.t-lev-val'); if (v) v.textContent = lev > 0 ? `${lev.toFixed(1)}x` : '–' }
})
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.drawer) { ui.drawer = false; render() } })
document.addEventListener('change', (e) => { const el = e.target as HTMLInputElement; if (el?.dataset?.logo !== undefined) { ui.deploy.logo = el.files?.[0] ?? null; render() } })

async function start() {
  const saved = sessionStorage.getItem(WORDS_KEY) ?? localStorage.getItem(WORDS_KEY)   // the tab's, or the device's when the person chose to keep them
  if (saved && H.validWords(saved)) ui.master = H.wordsToMaster(saved)
  // the wallet used last time comes back on reload (Phantom only if it already trusts this site)
  const last = localStorage.getItem(WALLET_KEY)
  if (last === 'browser' && hasBrowserWallet()) ui.wallet = connectBrowserWallet()
  if (last === 'phantom' && hasPhantom()) ui.wallet = await connectPhantom(true).catch(() => null)
  render()
  try { await refresh() } catch (e) { ui.log.unshift({ kind: 'err', text: `Could not read the chain at ${RPC}: ${e instanceof Error ? e.message : e}`, at: Date.now() }) }
  render()
  void loadChanges().then(render)
  setInterval(async () => {
    if (ui.busy || document.hidden) return
    try {
      await refresh()
      const m = current()
      // numbers refresh in the background; the page isn't rebuilt under someone who is typing
      if (!ui.busy && !(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) && !document.querySelector('#chart-slot:hover')) render()
    } catch { /* next tick */ }
  }, 6000)
  setInterval(() => { if (!document.hidden) void loadChanges() }, 180_000)
  // the venue's book and tape, the slow numbers, the agents' feed
  void pollBook(); void pollTrades(); void pollSlow().then(render)
  setInterval(() => { if (ui.wallet) void pollBook() }, 2000)
  setInterval(() => { if (ui.wallet) void pollTrades() }, 5000)
  setInterval(() => { if (ui.wallet) void pollSlow() }, 60_000)
  window.addEventListener('resize', drawDepth)
}
void start()
