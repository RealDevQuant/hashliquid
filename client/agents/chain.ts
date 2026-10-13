/*
  chain.ts — the agents on chain. One fee-payer wallet pays for everything; each agent has its own 24 words,
  its own bunker and its own ledger of what every one-time key signed (on disk, so a restart never signs twice).
  Transactions are confirmed by polling, the way the app does it.
*/
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import * as H from '../src/index.ts'
import type { AgentDef } from './config.ts'
import { readClients, saveClients, type ClientEntry, type FeedOrder, type FeedPosition } from './store.ts'
import { MAX_CLIENTS } from './config.ts'

export const V = H.V
export const RPC = process.env.RPC || 'https://solana-rpc.publicnode.com'
export const NET: H.Network = /127\.0\.0\.1|localhost/.test(RPC) ? 'localnet' : 'mainnet'
const FEE = Number(process.env.FEE ?? 5_000)
export const conn = new Connection(RPC, 'confirmed')
/** Transactions go out through a second RPC when the reading one forwards them badly (publicnode drops some). */
export const sender = new Connection(process.env.SEND_RPC || (/publicnode/.test(RPC) ? 'https://api.mainnet-beta.solana.com' : RPC), 'confirmed')
export const secrets = new URL('../../.secrets/agents/', import.meta.url)
export const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('payer.json', secrets), 'utf8'))))
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a)

/** The agent's trading delegate: an ordinary key. On a bunker that hired the agent it can trade, never withdraw. */
const delegates = new Map<string, Keypair>()
export function delegateOf(def: AgentDef): Keypair {
  let k = delegates.get(def.id)
  if (!k) { k = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(`${def.id}.delegate.json`, secrets), 'utf8')))); delegates.set(def.id, k) }
  return k
}

/** The one key that trades every user-made agent's bunker. */
let customKey: Keypair | null = null
export function customDelegate(): Keypair {
  if (!customKey) customKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('custom.delegate.json', secrets), 'utf8'))))
  return customKey
}

export interface AgentChain { def: AgentDef; master: Uint8Array; keys: H.BunkerKeys; bunker: PublicKey; ledger: H.SignedLedger }

export function agentChain(def: AgentDef): AgentChain {
  const master = H.wordsToMaster(readFileSync(new URL(`${def.id}.words`, secrets), 'utf8'))
  const ledgerFile = new URL(`${def.id}.ledger.${NET}.json`, secrets)
  const store = new Map<string, string>(existsSync(ledgerFile) ? Object.entries(JSON.parse(readFileSync(ledgerFile, 'utf8'))) : [])
  const ledger = new H.SignedLedger({ get: (k) => store.get(k), set: (k, v) => { store.set(k, v); writeFileSync(ledgerFile, JSON.stringify(Object.fromEntries(store), null, 1), { mode: 0o600 }) } })
  const keys = H.bunkerKeys(master, NET)
  return { def, master, keys, bunker: keys.address, ledger }
}

/** Sends one transaction paid by the fee payer and waits for it by polling, re-broadcasting meanwhile. */
export async function send(ixs: TransactionInstruction[], cu: number, what: string, signers: Keypair[] = []): Promise<string> {
  const tx = new Transaction().add(H.cuIx(cu), ...(NET === 'localnet' ? [] : [H.priorityFeeIx(FEE)]), ...ixs)
  tx.feePayer = payer.publicKey
  const latest = await sender.getLatestBlockhash('confirmed')
  tx.recentBlockhash = latest.blockhash
  tx.sign(payer, ...signers)
  const raw = tx.serialize()
  const sig = await sender.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 })   // simulated first: a bad move is never published
  const failed = async (err: unknown) => {
    const info = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null)
    const logs = info?.meta?.logMessages ?? []
    const why = logs.map((l) => /Error Message: (.+)$/.exec(l)?.[1]).filter(Boolean).pop()
    throw new Error(`${what} failed: ${why ?? JSON.stringify(err)}`)
  }
  for (;;) {
    const st = (await sender.getSignatureStatuses([sig])).value[0]
    if (st?.err) await failed(st.err)
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) { log(`${what}: ${sig}`); return sig }
    if ((await sender.getBlockHeight('confirmed')) > latest.lastValidBlockHeight) {
      // the blockhash expired: look a few more times before saying it never landed (the status can lag the block)
      for (let i = 0; i < 6; i++) {
        await sleep(2500)
        const late = (await sender.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0]
        if (late?.err) await failed(late.err)
        if (late && (late.confirmationStatus === 'confirmed' || late.confirmationStatus === 'finalized')) { log(`${what}: ${sig}`); return sig }
      }
      throw new Error(`${what}: not included in time (nothing happened)`)
    }
    await sender.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {})
    await sleep(1500)
  }
}

const ctx = async (a: AgentChain): Promise<H.SignContext> => {
  const bunker = await H.getBunker(conn, a.bunker)
  if (!bunker) throw new Error(`${a.def.id}: no bunker on chain`)
  return { master: a.master, network: NET, bunkerKey: a.bunker, bunker, ledger: a.ledger }
}

/** One signed move: the signature (authorize), then the instruction it authorizes (execute). Returns both signatures. */
export async function act(a: AgentChain, ix: TransactionInstruction, what: string, before: TransactionInstruction[] = []): Promise<string[]> {
  const p = H.prepareAction(await ctx(a), ix, what)
  const s1 = await send([p.authorize], H.CU.AUTHORIZE, `${a.def.id} ${what} · authorize (key #${p.signed.nonce})`)
  const s2 = await send([...before, p.execute], H.CU.EXECUTE, `${a.def.id} ${what} · execute`)
  return [s1, s2]
}

/** A move authorized but never executed (a crash between the two transactions) is called off with the next key. */
export async function clearPending(a: AgentChain): Promise<string | null> {
  const b = await H.getBunker(conn, a.bunker)
  if (!b || !H.hasPending(b)) return null
  const off = H.prepareCancel(await ctx(a))
  return send([off.authorize], H.CU.AUTHORIZE, `${a.def.id} clear pending (key #${off.signed.nonce})`)
}

export const user = (a: AgentChain) => V.getUser(conn, a.bunker)

/* ---------------- the bunkers a delegate key trades for ---------------- */

const DELEGATE_OFFSET = 8 + 32   // a trading account's bytes: discriminator, authority, delegate, name
let userSize = 0
export interface Client { bunker: PublicKey; cfg: ClientEntry['cfg']; since?: number }
/**
 * The trading accounts whose delegate is `delegate`, read from the chain: sub-account 0 of a HashLiquid bunker,
 * with the agent configuration its owner wrote in the account's name. Listed at most once every `maxAgeSeconds`
 * (the listing shares an RPC with the trades themselves); the list seen last is kept on disk under `key`.
 */
export async function listByDelegate(key: string, delegate: PublicKey, maxAgeSeconds = 300, houseBunker?: PublicKey): Promise<Client[]> {
  const known = readClients()[key]
  const revive = (e: ClientEntry[]) => e.map((x) => ({ bunker: new PublicKey(x.bunker), cfg: x.cfg, since: x.since }))
  if (known && maxAgeSeconds > 0 && Date.now() / 1000 - known.t < maxAgeSeconds) return revive(known.bunkers)
  try {
    if (!userSize) userSize = (houseBunker ? await conn.getAccountInfo(V.userPda(houseBunker)) : null)?.data.length ?? 4496
    const rows = await sender.getProgramAccounts(V.VELOCITY_PROGRAM_ID, { filters: [{ dataSize: userSize }, { memcmp: { offset: DELEGATE_OFFSET, bytes: delegate.toBase58() } }], dataSlice: { offset: 8, length: 96 } })
    const found = rows.map((r) => ({ account: r.pubkey, authority: new PublicKey(r.account.data.subarray(0, 32)), name: new Uint8Array(r.account.data.subarray(64, 96)) })).filter((x) => V.userPda(x.authority, 0).equals(x.account)).slice(0, MAX_CLIENTS)
    const owners: Awaited<ReturnType<typeof conn.getMultipleAccountsInfo>> = []
    for (let i = 0; i < found.length; i += 100) owners.push(...(await conn.getMultipleAccountsInfo(found.slice(i, i + 100).map((x) => x.authority))))   // the RPC takes 100 keys a call
    const seen = new Map((known?.bunkers ?? []).map((e) => [e.bunker, e.since ?? known!.t]))
    const entries: ClientEntry[] = found.filter((_, i) => owners[i]?.owner.equals(H.PROGRAM_ID)).map((x) => ({ bunker: x.authority.toBase58(), cfg: H.decodeAgentName(x.name), since: seen.get(x.authority.toBase58()) ?? Math.floor(Date.now() / 1000) }))
    saveClients(key, entries)
    return revive(entries)
  } catch (e) {
    log(`${key}: could not list bunkers (${e instanceof Error ? e.message.slice(0, 80) : e}); using the last list`)
    return revive(known?.bunkers ?? [])
  }
}
/** The bunkers that hired this agent. */
export const clientsOf = (def: AgentDef, houseBunker?: PublicKey, maxAgeSeconds = 300) => listByDelegate(def.id, delegateOf(def).publicKey, maxAgeSeconds, houseBunker)
/** Every user-made agent (a bunker whose delegate is the custom key and whose name says so). */
export const customAgents = async (maxAgeSeconds = 300) => (await listByDelegate('custom', customDelegate().publicKey, maxAgeSeconds)).filter((c) => c.cfg?.kind === 'custom')
  .sort((a, b) => (a.since ?? 0) - (b.since ?? 0) || a.bunker.toBase58().localeCompare(b.bunker.toBase58()))   // first come, first run: the queue never reshuffles

export const solBalance = async (pk: PublicKey) => (await conn.getBalance(pk)) / LAMPORTS_PER_SOL
export const tokenBalance = async (owner: PublicKey, mint: PublicKey, allowOffCurve = false) => { try { return (await getAccount(conn, getAssociatedTokenAddressSync(mint, owner, allowOffCurve))).amount } catch { return 0n } }

export interface Account {
  user: H.V.User; collateral: number; equity: number; realized: number
  netDeposits: number; pnl: number   // what went in minus what came out, and equity minus that: the trading result since the account was opened
  positions: (FeedPosition & { marketIndex: number })[]; orders: (FeedOrder & { marketIndex: number })[]
}

/** Before the bunker exists on chain. */
export const emptyAccount = (): Account => ({ user: null as unknown as H.V.User, collateral: 0, equity: 0, realized: 0, netDeposits: 0, pnl: 0, positions: [], orders: [] })

/** The agent's trading account in plain numbers. `oracles` = market index → price. */
export function account(u: H.V.User, quote: H.V.SpotMarket, names: Map<number, string>, oracles: Map<number, number>): Account {
  const collateral = Number(V.tokenAmount(u, quote)) / 1e6
  const netDeposits = Number((u.spotPositions as H.V.SpotPosition[]).find((s) => s.marketIndex === V.QUOTE_SPOT_MARKET)?.cumulativeDeposits ?? 0n) / 1e6
  let unrealized = 0, realized = 0
  const positions: Account['positions'] = []
  for (const p of u.perpPositions as H.V.PerpPosition[]) {
    realized += Number(p.settledPnl ?? 0n) / 1e6
    if (p.baseAssetAmount === 0n) continue
    const size = Number(p.baseAssetAmount) / 1e9
    const entry = Math.abs(Number(p.quoteEntryAmount) / 1e6 / size)
    const oracle = oracles.get(p.marketIndex) ?? entry
    const upnl = (oracle - entry) * size      // size is negative for a short, so this holds both ways
    unrealized += upnl
    positions.push({ marketIndex: p.marketIndex, market: names.get(p.marketIndex) ?? `#${p.marketIndex}`, side: size > 0 ? 'long' : 'short', size: Math.abs(size), entry: r(entry, 4), unrealized: r(upnl, 2) })
  }
  const orders: Account['orders'] = V.openOrders(u).filter((o) => o.marketType === V.MARKET_TYPE.PERP).map((o) => ({
    marketIndex: o.marketIndex, market: names.get(o.marketIndex) ?? `#${o.marketIndex}`, side: o.direction === V.DIRECTION.LONG ? 'long' : 'short',
    size: Number(o.baseAssetAmount) / 1e9, price: Number(o.price) / 1e6, reduceOnly: !!o.reduceOnly, orderId: o.orderId,
  }))
  return { user: u, collateral: r(collateral, 2), equity: r(collateral + unrealized, 2), realized: r(realized, 2), netDeposits: r(netDeposits, 2), pnl: r(collateral + unrealized - netDeposits, 2), positions, orders }
}

// ---- order builders (all signed by the bunker) ----
export const toBase = (n: number) => BigInt(Math.round(n * 1e9))
export const toPrice = (p: number) => BigInt(Math.round(p * 1e6))

/** A limit order through the oracle by `slippagePct`: fills like a market order, never worse than the limit. */
export async function marketOrderIx(authority: PublicKey, u: H.V.User | null, perp: H.V.PerpMarket, side: 'long' | 'short', size: number, oracle: number, slippagePct: number, reduceOnly = false, signer?: PublicKey) {
  const long = side === 'long'
  const price = oracle * (long ? 1 + slippagePct / 100 : 1 - slippagePct / 100)
  const params = V.perpOrder({ marketIndex: perp.marketIndex, direction: long ? V.DIRECTION.LONG : V.DIRECTION.SHORT, baseAssetAmount: V.toStep(toBase(size), perp), orderType: V.ORDER_TYPE.LIMIT, price: V.toTick(toPrice(price), perp), reduceOnly })
  return V.placePerpOrderIx({ authority, signer, params, remaining: await V.remainingAccounts(conn, u, { readablePerp: [perp.marketIndex] }) })
}

/** Every open order of the account (the house: its account holds only the agent's orders). */
export async function cancelAllIx(authority: PublicKey, u: H.V.User, marketIndexes: number[], signer?: PublicKey) {
  return V.cancelOrdersIx({ authority, signer, remaining: await V.remainingAccounts(conn, u, { readablePerp: marketIndexes }) })
}
/** These orders and no others (a hired bunker: its owner may have orders of their own). */
export async function cancelIdsIx(authority: PublicKey, u: H.V.User, ids: { orderId: number; marketIndex: number }[], signer?: PublicKey) {
  const remaining = await V.remainingAccounts(conn, u, { readablePerp: [...new Set(ids.map((x) => x.marketIndex))] })
  return ids.map((x) => V.cancelOrderIx({ authority, signer, orderId: x.orderId, remaining }))
}

const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d
