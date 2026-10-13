// The canary: one bunker, a few dollars, a full round trip on the real exchange, every step signed by a one-time key.
//   open + trading account → fund with USDT → deposit → buy a little SOL-PERP → wait for the keepers to fill →
//   close (reduce-only) → wait → withdraw everything back to the paying wallet.
//
//   WALLET=/path/to/payer.json RPC=https://... npm --prefix client run canary
//
// Options (env): USDT=10 (collateral to deposit), SIZE=0.05 (SOL-PERP), WAIT=90 (seconds to wait for a fill),
// FEE=5000 (priority fee, µL/CU), SWAP=1 (if the wallet has no USDT, swap SOL for it on Jupiter first).
//
// The bunker's 24 words are generated the first time and kept in .secrets/canary-words.txt (never printed), with the
// ledger of what each key signed next to them, so the script can be run again on the same bunker. On a local
// validator (RPC on 127.0.0.1) nobody fills orders: the script then cancels and still withdraws, which proves
// everything except the fill.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import * as H from '../src/index.ts'

const V = H.V
const RPC = process.env.RPC || 'https://api.mainnet-beta.solana.com'
const LOCAL = /127\.0\.0\.1|localhost/.test(RPC)
const NET: H.Network = LOCAL ? 'localnet' : 'mainnet'
const WALLET = process.env.WALLET
if (!WALLET) throw new Error('set WALLET to the payer keypair file')
const USDT_TO_DEPOSIT = BigInt(Math.round(Number(process.env.USDT ?? '10') * 1e6))
const SIZE = BigInt(Math.round(Number(process.env.SIZE ?? '0.05') * 1e9))
const WAIT = Number(process.env.WAIT ?? (LOCAL ? '10' : '90'))
const FEE = Number(process.env.FEE ?? '5000')
const SWAP = (process.env.SWAP ?? '1') !== '0'
const MARKET = 0, QUOTE = V.QUOTE_SPOT_MARKET

const conn = new Connection(RPC, 'confirmed')
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(WALLET, 'utf8'))))
const secrets = new URL('../../.secrets/', import.meta.url)
mkdirSync(secrets, { recursive: true, mode: 0o700 })
const wordsFile = new URL(`canary-words.${NET}.txt`, secrets), ledgerFile = new URL(`canary-ledger.${NET}.json`, secrets)
if (!existsSync(wordsFile)) { writeFileSync(wordsFile, H.newWords() + '\n', { mode: 0o600 }); chmodSync(wordsFile, 0o600) }
const master = H.wordsToMaster(readFileSync(wordsFile, 'utf8'))
const store = new Map<string, string>(existsSync(ledgerFile) ? Object.entries(JSON.parse(readFileSync(ledgerFile, 'utf8'))) : [])
const ledger = new H.SignedLedger({ get: (k) => store.get(k), set: (k, v) => { store.set(k, v); writeFileSync(ledgerFile, JSON.stringify(Object.fromEntries(store), null, 1), { mode: 0o600 }) } })
const keys = H.bunkerKeys(master, NET)
const bunker = keys.address

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)
const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function send(ixs: TransactionInstruction[], cu: number, what: string): Promise<string> {
  const tx = new Transaction().add(H.cuIx(cu), ...(LOCAL ? [] : [H.priorityFeeIx(FEE)]), ...ixs)
  tx.feePayer = payer.publicKey
  const latest = await conn.getLatestBlockhash()
  tx.recentBlockhash = latest.blockhash
  tx.sign(payer)
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 })
  const res = await conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed')
  const info = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  if (res.value.err) {
    const logs = info?.meta?.logMessages ?? []
    throw new Error(`${what} failed: ${logs.map((l) => /Error Message: (.+)$/.exec(l)?.[1]).filter(Boolean).pop() ?? JSON.stringify(res.value.err)}\n${logs.slice(-8).join('\n')}`)
  }
  log(`${what}: ${sig} (${info?.meta?.computeUnitsConsumed} CU)`)
  return sig
}
const tokens = async (owner: PublicKey, mint: PublicKey) => { try { return (await getAccount(conn, getAssociatedTokenAddressSync(mint, owner, true))).amount } catch { return 0n } }
const account = () => V.getUser(conn, bunker)
const ctx = async (): Promise<H.SignContext> => ({ master, network: NET, bunkerKey: bunker, bunker: (await H.getBunker(conn, bunker))!, ledger })
/** authorize, then execute: one signed action, two transactions */
async function act(ix: TransactionInstruction, what: string, before: TransactionInstruction[] = []) {
  const p = H.prepareAction(await ctx(), ix, what)
  await send([p.authorize], H.CU.AUTHORIZE, `${what} · authorize (key #${p.signed.nonce})`)
  await send([...before, p.execute], H.CU.EXECUTE, `${what} · execute`)
}
async function waitFor(what: string, test: (u: H.V.User) => boolean): Promise<boolean> {
  for (let t = 0; t < WAIT; t += 3) {
    const u = await account()
    if (u && test(u)) return true
    await sleep(3000)
  }
  log(`${what}: not within ${WAIT}s`)
  return false
}

/** SOL → USDT on Jupiter, so the canary has collateral. Mainnet only. */
async function swapForUsdt(mint: PublicKey, amount: bigint) {
  const sol = await V.getOraclePrice(conn, (await V.getPerpMarket(conn, MARKET))!.oracle)
  const lamports = ((amount * 1_000_000_000n * 103n) / 100n) / (sol ?? 100_000_000n) + 10_000n   // 3% headroom
  const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint.toBase58()}&amount=${lamports}&slippageBps=50`)).json()
  if (!q.outAmount) throw new Error(`Jupiter quote failed: ${JSON.stringify(q).slice(0, 200)}`)
  const r = await (await fetch('https://lite-api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, userPublicKey: payer.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }) })).json()
  if (!r.swapTransaction) throw new Error(`Jupiter swap failed: ${JSON.stringify(r).slice(0, 200)}`)
  const tx = VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, 'base64'))
  tx.sign([payer])
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 })
  await conn.confirmTransaction(sig, 'confirmed')
  log(`swap ${Number(lamports) / 1e9} SOL → ${usd(BigInt(q.outAmount))} USDT: ${sig}`)
}

async function main() {
  const state = await V.getState(conn)
  if (!state) throw new Error(`no exchange at ${RPC}`)
  const perp = (await V.getPerpMarket(conn, MARKET))!, quote = (await V.getSpotMarket(conn, QUOTE))!
  const usdtMint = quote.mint
  const oracle = (await V.getOraclePrice(conn, perp.oracle))!
  log(`${NET} · payer ${payer.publicKey.toBase58()} · ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL · ${usd(await tokens(payer.publicKey, usdtMint))} USDT`)
  log(`bunker ${bunker.toBase58()} · ${V.nameOf(perp.name)} oracle ${usd(oracle)} · size ${Number(SIZE) / 1e9}`)
  if (!(await conn.getAccountInfo(H.PROGRAM_ID))) throw new Error(`the wallet program ${H.PROGRAM_ID.toBase58()} is not deployed on ${RPC}`)

  // 1. the bunker and its trading account (idempotent)
  let b = await H.getBunker(conn, bunker)
  if (!b || !(await account())) {
    await send([...(b ? [] : [H.openIx({ payer: payer.publicKey, keys })]), ...((await account()) ? [] : [H.initTradingIx({ bunker, payer: payer.publicKey, name: 'HashLiquid canary' })])], H.CU.SETUP, 'open + init_trading')
  }
  b = (await H.getBunker(conn, bunker))!
  log(`bunker open · key #${b.nonce}${H.hasPending(b) ? ' · an action is PENDING' : ''}`)
  if (H.hasPending(b)) { const off = H.prepareCancel(await ctx()); await send([off.authorize], H.CU.AUTHORIZE, 'clear pending (authorize nothing)') }

  // 2. collateral: USDT from the payer into the bunker's token account, then into its trading account
  let held = V.tokenAmount((await account())!, quote)
  if (held < USDT_TO_DEPOSIT / 2n) {
    if ((await tokens(payer.publicKey, usdtMint)) < USDT_TO_DEPOSIT) {
      if (!SWAP || LOCAL) throw new Error(`the payer holds no USDT: set SWAP=1 (mainnet) or fund it`)
      await swapForUsdt(usdtMint, USDT_TO_DEPOSIT)
    }
    const to = H.bunkerTokenAccount(bunker, usdtMint)
    await send([
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, bunker, usdtMint),
      createTransferInstruction(getAssociatedTokenAddressSync(usdtMint, payer.publicKey), to, payer.publicKey, USDT_TO_DEPOSIT),
      H.depositIx({ bunker, marketIndex: QUOTE, amount: USDT_TO_DEPOSIT, mint: usdtMint, remaining: await V.remainingAccounts(conn, await account(), { writableSpot: [QUOTE] }) }),
    ], H.CU.SETUP, `deposit ${usd(USDT_TO_DEPOSIT)} USDT`)
    held = V.tokenAmount((await account())!, quote)
  }
  log(`collateral on the exchange: ${usd(held)} USDT`)

  // 3. a small buy through the oracle price (a limit order that fills like a market order, never worse than +1%)
  const perpAccounts = async () => V.remainingAccounts(conn, await account(), { readablePerp: [MARKET] })
  let pos = V.perpPosition((await account())!, MARKET)
  if (!pos || pos.baseAssetAmount === 0n) {
    const buy = V.perpOrder({ marketIndex: MARKET, direction: V.DIRECTION.LONG, baseAssetAmount: V.toStep(SIZE, perp), orderType: V.ORDER_TYPE.LIMIT, price: V.toTick((oracle * 101n) / 100n, perp) })
    await act(V.placePerpOrderIx({ authority: bunker, params: buy, remaining: await perpAccounts() }), 'buy')
    const filled = await waitFor('fill', (u) => (V.perpPosition(u, MARKET)?.baseAssetAmount ?? 0n) > 0n)
    if (!filled) {
      const open = V.openOrders((await account())!)
      if (open.length) await act(V.cancelOrdersIx({ authority: bunker, remaining: await perpAccounts() }), 'cancel (not filled)')
    }
  }
  pos = V.perpPosition((await account())!, MARKET)
  if (pos && pos.baseAssetAmount > 0n) {
    log(`position: long ${Number(pos.baseAssetAmount) / 1e9} SOL-PERP, entry ${usd((-pos.quoteEntryAmount * 1_000_000_000n) / pos.baseAssetAmount)}`)
    // 4. close it: reduce-only sell, never worse than −1%
    const price = (await V.getOraclePrice(conn, perp.oracle))!
    const sell = V.perpOrder({ marketIndex: MARKET, direction: V.DIRECTION.SHORT, baseAssetAmount: pos.baseAssetAmount, orderType: V.ORDER_TYPE.LIMIT, price: V.toTick((price * 99n) / 100n, perp), reduceOnly: true })
    await act(V.placePerpOrderIx({ authority: bunker, params: sell, remaining: await perpAccounts() }), 'close')
    const closed = await waitFor('close fill', (u) => (V.perpPosition(u, MARKET)?.baseAssetAmount ?? 0n) === 0n)
    if (!closed) { log('STOP: the position is still open; run again later to close and withdraw'); return }
    const after = V.perpPosition((await account())!, MARKET)
    log(`closed · realized PnL ${usd(after?.settledPnl ?? 0n)} USDT`)
  }

  // 5. everything back to the payer
  const u = (await account())!
  held = V.tokenAmount(u, quote)
  if (held > 0n && V.openOrders(u).length === 0) {
    const to = getAssociatedTokenAddressSync(usdtMint, payer.publicKey)
    const before = await tokens(payer.publicKey, usdtMint)
    await act(V.withdrawIx({ authority: bunker, signer: state.signer, marketIndex: QUOTE, amount: held * 2n, toTokenAccount: to, remaining: await V.remainingAccounts(conn, u, { writableSpot: [QUOTE] }), reduceOnly: true }), 'withdraw all',
      [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, payer.publicKey, usdtMint)])
    log(`withdrawn: ${usd((await tokens(payer.publicKey, usdtMint)) - before)} USDT back to the payer`)
  }
  const fin = (await H.getBunker(conn, bunker))!
  log(`done · bunker at key #${fin.nonce} · ${usd(V.tokenAmount((await account())!, quote))} USDT left on the exchange · payer ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`)
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
