// The agents' canary on mainnet, on the canary bunker of scripts/canary-mainnet.ts (its 24 words and ledger in .secrets):
//   1. USDT in (swapped from SOL on Jupiter by the funding wallet), deposited
//   2. hire: the account is named "HL1 H11 Canary" and Ash One's key becomes its delegate (two signed moves)
//   3. the chain listing finds it; one mirrored trade opens and closes on it, signed by the delegate key alone
//   4. fire (one signed move): the listing no longer has it
//   5. create: the account is named "HL1 C12 Canary bot" and the custom key becomes its delegate (two signed moves)
//   6. the listing finds it as a custom agent; the live service gets a few minutes to run its own decision on it;
//      then one forced trade opens and closes on it, signed by the custom key
//   7. fire, and everything back to the funding wallet (two signed moves)
//
//   WALLET=/path/to/funding-wallet.json node scripts/hire-canary.ts
// Options: USDT=21 (collateral), WAIT=90 (seconds for a fill), SERVICE_WAIT=420 (seconds for the live service's decision).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import * as H from '../src/index.ts'
import { NET, RPC, V, conn, customAgents, customDelegate, delegateOf, listByDelegate, log, payer, send, sender, sleep, tokenBalance } from '../agents/chain.ts'
import { apply, clientBook, context, customBook, houseBook } from '../agents/engine.ts'
import { AGENTS } from '../agents/config.ts'
import type { Decision } from '../agents/brain.ts'

if (NET !== 'mainnet') throw new Error('this canary is for mainnet')
const WALLET = process.env.WALLET
if (!WALLET) throw new Error('set WALLET to the funding wallet keypair file')
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(WALLET, 'utf8'))))
const USDT = BigInt(Math.round(Number(process.env.USDT ?? '21') * 1e6))
const WAIT = Number(process.env.WAIT ?? '90')
const SERVICE_WAIT = Number(process.env.SERVICE_WAIT ?? '420')
const QUOTE = V.QUOTE_SPOT_MARKET
const MARKET = 'SOL-PERP'
const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2)

// the canary bunker: words and ledger kept by scripts/canary-mainnet.ts
const secrets = new URL('../../.secrets/', import.meta.url)
const wordsFile = new URL(`canary-words.${NET}.txt`, secrets), ledgerFile = new URL(`canary-ledger.${NET}.json`, secrets)
if (!existsSync(wordsFile)) throw new Error('no canary words: run scripts/canary-mainnet.ts first')
const master = H.wordsToMaster(readFileSync(wordsFile, 'utf8'))
const store = new Map<string, string>(existsSync(ledgerFile) ? Object.entries(JSON.parse(readFileSync(ledgerFile, 'utf8'))) : [])
const ledger = new H.SignedLedger({ get: (k) => store.get(k), set: (k, v) => { store.set(k, v); writeFileSync(ledgerFile, JSON.stringify(Object.fromEntries(store), null, 1)) } })
const keys = H.bunkerKeys(master, NET)
const bunker = keys.address

const account = () => V.getUser(conn, bunker)
const ctx = async (): Promise<H.SignContext> => ({ master, network: NET, bunkerKey: bunker, bunker: (await H.getBunker(conn, bunker))!, ledger })
/** One move of the bunker's owner: authorize (the one-time signature), then execute. */
async function act(ix: TransactionInstruction, what: string, before: TransactionInstruction[] = []): Promise<void> {
  const p = H.prepareAction(await ctx(), ix, what)
  await send([p.authorize], H.CU.AUTHORIZE, `${what} · authorize (key #${p.signed.nonce})`)
  await send([...before, p.execute], H.CU.EXECUTE, `${what} · execute`)
}
async function waitFor(what: string, test: (u: H.V.User) => boolean): Promise<boolean> {
  for (let t = 0; t < WAIT; t += 3) { const u = await account(); if (u && test(u)) return true; await sleep(3000) }
  log(`${what}: not within ${WAIT}s`); return false
}
const posIn = (u: H.V.User | null, marketIndex: number) => { const p = u ? V.perpPosition(u, marketIndex) : null; return p && p.baseAssetAmount !== 0n ? p : null }

/** SOL → USDT on Jupiter, paid and signed by the funding wallet. */
async function swapForUsdt(mint: PublicKey, amount: bigint): Promise<void> {
  const perp = (await V.getPerpMarket(conn, 0))!
  const sol = (await V.getOraclePrice(conn, perp.oracle)) ?? 100_000_000n
  const lamports = ((amount * 1_000_000_000n * 103n) / 100n) / sol + 10_000n
  const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint.toBase58()}&amount=${lamports}&slippageBps=50`)).json()
  if (!q.outAmount) throw new Error(`Jupiter quote failed: ${JSON.stringify(q).slice(0, 200)}`)
  const r = await (await fetch('https://lite-api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, userPublicKey: funder.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }) })).json()
  if (!r.swapTransaction) throw new Error(`Jupiter swap failed: ${JSON.stringify(r).slice(0, 200)}`)
  const tx = VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, 'base64'))
  tx.sign([funder])
  const sig = await sender.sendRawTransaction(tx.serialize(), { maxRetries: 5 })
  await conn.confirmTransaction(sig, 'confirmed')
  log(`swap ${Number(lamports) / 1e9} SOL → ${usd(BigInt(q.outAmount))} USDT: ${sig}`)
}

/** A trade the engine vets, sizes, sends and records exactly as it does for the agents (signed by the book's key). */
async function roundTrip(book: ReturnType<typeof clientBook>, gates: 'mirror' | 'full'): Promise<void> {
  const c = await context()
  const m = c.mkts.find((x) => x.symbol === MARKET)!
  const short = m.regime === 'trend_down'
  const open: Decision = { action: 'open', market: MARKET, side: short ? 'short' : 'long', stop_price: m.oracle * (short ? 1.015 : 0.985), take_profit_price: m.oracle * (short ? 0.96 : 1.04), invalidation: 'canary', thesis: `Canary: ${short ? 'short' : 'long'} ${MARKET} at ${m.oracle}, the venue fills it and the book's key signs it.`, confidence: 0.9, setup_score: 9 }
  const o = await apply(book, open, c, gates)
  if (o.error) throw new Error(`open refused: ${o.error}`)
  log(`${book.id}: open sent ${o.side} ${o.size} ${MARKET} (${o.notional} USDT) · ${o.txs.join(' ')}`)
  const filled = await waitFor('fill', (u) => !!posIn(u, m.marketIndex))
  if (!filled) throw new Error('the entry did not fill: cancel it from the terminal and run again')
  const pos = posIn(await account(), m.marketIndex)!
  log(`${book.id}: position ${pos.baseAssetAmount > 0n ? 'long' : 'short'} ${Number(pos.baseAssetAmount < 0n ? -pos.baseAssetAmount : pos.baseAssetAmount) / 1e9} ${MARKET}`)
  await sleep(5000)
  const cl = await apply(book, { action: 'close', market: MARKET, thesis: 'Canary: closing, the round trip is done.', confidence: 1, setup_score: 10 } as Decision, await context(), gates)
  if (cl.error) throw new Error(`close refused: ${cl.error}`)
  log(`${book.id}: close sent · ${cl.txs.join(' ')}`)
  const closed = await waitFor('close fill', (u) => !posIn(u, m.marketIndex))
  if (!closed) throw new Error('the close did not fill: close it from the terminal and run again')
  const u = (await account())!
  log(`${book.id}: flat · ${usd(V.tokenAmount(u, (await V.getSpotMarket(conn, QUOTE))!))} USDT on the exchange`)
}

async function main() {
  const state = (await V.getState(conn))!
  const quote = (await V.getSpotMarket(conn, QUOTE))!, mint = quote.mint
  const ash1 = AGENTS[0], ash1Key = delegateOf(ash1).publicKey, customKey = customDelegate().publicKey
  log(`${NET} via ${RPC} · canary bunker ${bunker.toBase58()} · funder ${funder.publicKey.toBase58()} ${(await conn.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL} SOL · fee payer ${payer.publicKey.toBase58()} ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`)
  let b = (await H.getBunker(conn, bunker))
  if (!b || !(await account())) throw new Error('the canary bunker is not on chain: run scripts/canary-mainnet.ts first')
  if (H.hasPending(b)) { const off = H.prepareCancel(await ctx()); await send([off.authorize], H.CU.AUTHORIZE, 'clear pending (authorize nothing)') }
  log(`bunker at key #${b.nonce} · delegate ${(await account())!.delegate.toBase58()}`)

  // 1. collateral
  let held = V.tokenAmount((await account())!, quote)
  if (held + 500_000n < USDT) {   // half a dollar of slack: fees already paid are not topped up
    const need = USDT - held
    if ((await tokenBalance(funder.publicKey, mint)) < need) await swapForUsdt(mint, need)
    const to = H.bunkerTokenAccount(bunker, mint)
    await send([
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, bunker, mint),
      createTransferInstruction(getAssociatedTokenAddressSync(mint, funder.publicKey), to, funder.publicKey, need),
      H.depositIx({ bunker, marketIndex: QUOTE, amount: need, mint, remaining: await V.remainingAccounts(conn, await account(), { writableSpot: [QUOTE] }) }),
    ], H.CU.SETUP, `deposit ${usd(need)} USDT`, [funder])
    held = V.tokenAmount((await account())!, quote)
  }
  log(`collateral on the exchange: ${usd(held)} USDT`)
  if (posIn(await account(), 0)) throw new Error('a position is already open on the canary: close it from the terminal first')

  // 2. hire Ash One: the name carries the configuration, the delegate is the agent's key
  if (process.env.SKIP_HIRE) log('SKIP_HIRE: the hire phase is skipped')
  const hiredCfg = { kind: 'hired' as const, base: 1 as const, aggr: 1 as const, label: 'Canary' }
  const same = (a: { kind: string; label: string } | null, b: { kind: string; label: string }) => !!a && a.kind === b.kind && a.label === b.label
  if (!process.env.SKIP_HIRE) {
  if (!same(H.decodeAgentName((await account())!.name), hiredCfg)) await act(V.updateUserNameIx({ authority: bunker, name: H.encodeAgentName(hiredCfg) }), 'name: HL1 H11 Canary')
  if (!(await account())!.delegate.equals(ash1Key)) await act(V.updateUserDelegateIx({ authority: bunker, delegate: ash1Key }), 'hire Ash One')
  // 3. the listing finds it, the mirrored trade runs on the agent's key
  const hired = await listByDelegate(ash1.id, ash1Key, 0, houseBook(ash1).authority)
  const me = hired.find((x) => x.bunker.equals(bunker))
  if (!me || me.cfg?.kind !== 'hired' || me.cfg.label !== 'Canary') throw new Error(`the listing did not find the hired canary: ${JSON.stringify(hired.map((x) => [x.bunker.toBase58().slice(0, 4), x.cfg]))}`)
  log(`listed as hired by ${ash1.id}: ${JSON.stringify(me.cfg)} (${hired.length} hired bunker${hired.length === 1 ? '' : 's'} in all)`)
  await roundTrip(clientBook(ash1, bunker, me.cfg), 'mirror')
  // 4. fire
  await act(V.updateUserDelegateIx({ authority: bunker, delegate: PublicKey.default }), 'fire Ash One')
  let gone = false
  for (let i = 0; i < 10 && !gone; i++) { await sleep(3000); gone = !(await listByDelegate(ash1.id, ash1Key, 0, houseBook(ash1).authority)).some((x) => x.bunker.equals(bunker)) }
  if (!gone) throw new Error('still listed 30s after firing')
  log('fired: no longer listed')
  }

  // 5. the bunker's own agent on the custom key
  const customCfg = { kind: 'custom' as const, base: 2 as const, aggr: 1 as const, label: 'Canary bot' }
  if (!same(H.decodeAgentName((await account())!.name), customCfg)) await act(V.updateUserNameIx({ authority: bunker, name: H.encodeAgentName(customCfg) }), 'name: HL1 C21 Canary bot')
  if (!(await account())!.delegate.equals(customKey)) await act(V.updateUserDelegateIx({ authority: bunker, delegate: customKey }), 'switch the custom agent on')
  let customs = await customAgents(0), mine = customs.find((x) => x.bunker.equals(bunker))
  for (let i = 0; i < 10 && !mine; i++) { await sleep(3000); customs = await customAgents(0); mine = customs.find((x) => x.bunker.equals(bunker)) }
  if (!mine || mine.cfg?.label !== 'Canary bot') throw new Error('the listing did not find the custom canary')
  log(`listed as a custom agent: ${JSON.stringify(mine.cfg)} (${customs.length} in all)`)
  // 6. the live service gets its turn on it (its own listing, its own decision on the smaller model)
  const logFile = new URL('../agents/data/agents.log', import.meta.url)
  const seen = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes(`custom@${bunker.toBase58()}`)) : [])
  const before = seen().length
  log(`waiting up to ${SERVICE_WAIT}s for the live service to decide on it…`)
  for (let t = 0; t < SERVICE_WAIT; t += 15) { if (seen().length > before) break; await sleep(15_000) }
  const lines = seen().slice(before)
  if (lines.length) for (const l of lines) log(`service: ${l.slice(0, 200)}`); else log('the live service did not get to it in time (its listing is cached for 5 minutes): going on')
  if (!posIn(await account(), 0)) await roundTrip(customBook(mine), 'full')
  else log('the service opened a position itself: leaving it to the guard and skipping the forced trade')
  // 7. fire and withdraw
  await act(V.updateUserDelegateIx({ authority: bunker, delegate: PublicKey.default }), 'switch the custom agent off')
  const u = (await account())!
  held = V.tokenAmount(u, quote)
  if (posIn(u, 0)) { log(`STOP: a position is still open; the guard will close it, withdraw later`); return }
  if (held > 0n && V.openOrders(u).length === 0) {
    const to = getAssociatedTokenAddressSync(mint, funder.publicKey)
    const was = await tokenBalance(funder.publicKey, mint)
    await act(V.withdrawIx({ authority: bunker, signer: state.signer, marketIndex: QUOTE, amount: held * 2n, toTokenAccount: to, remaining: await V.remainingAccounts(conn, u, { writableSpot: [QUOTE] }), reduceOnly: true }), 'withdraw everything', [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, funder.publicKey, mint)])
    log(`withdrawn ${usd((await tokenBalance(funder.publicKey, mint)) - was)} USDT to the funding wallet`)
  }
  b = (await H.getBunker(conn, bunker))!
  log(`done · bunker at key #${b.nonce} · ${usd(V.tokenAmount((await account())!, quote))} USDT left on the exchange · funder ${(await conn.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL} SOL + ${usd(await tokenBalance(funder.publicKey, mint))} USDT · fee payer ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`)
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
