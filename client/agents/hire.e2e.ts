// Hiring an agent, end to end, on the local validator (scripts/localnet.sh) with the real exchange program:
// a bunker hires Ash One with one hash-signed move; the agent's decision reaches that bunker signed by the
// agent's delegate key alone; the agent touches only its own orders there; the delegate key can neither
// withdraw nor change the delegate; the owner's words fire it, and from then on the key is refused.
//
//   AGENTS_DATA=/some/scratch/dir RPC=http://127.0.0.1:18899 node --test agents/hire.e2e.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import * as H from '../src/index.ts'
import { AGENTS } from './config.ts'
import { V, NET, conn, payer, send, clientsOf, delegateOf } from './chain.ts'
import { clientBook, context, guard, mirror } from './engine.ts'
import type { Decision } from './brain.ts'
import { readPlans, savePlan } from './store.ts'

if (NET !== 'localnet') throw new Error('localnet only: set RPC to the local validator')
if (!process.env.AGENTS_DATA) throw new Error('set AGENTS_DATA to a scratch folder: this test must not touch the live service\'s files')

const ash = AGENTS[0]
const delegate = delegateOf(ash)
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('../../.localnet/admin.json', import.meta.url), 'utf8'))))
const master = H.wordsToMaster(H.newWords())
const keys = H.bunkerKeys(master, 'localnet')
const bunker = keys.address
const ledger = new H.SignedLedger()
const USDT = 1_000_000n
const airdrop = async (to: PublicKey, sol: number) => { await conn.confirmTransaction(await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL), 'confirmed') }
const account = async () => (await V.getUser(conn, bunker))!
const nonce = async () => (await H.getBunker(conn, bunker))!.nonce
/** One move of the owner: signed with the bunker's next one-time key. */
async function act(ix: TransactionInstruction, what: string) {
  const p = H.prepareAction({ master, network: 'localnet', bunkerKey: bunker, bunker: (await H.getBunker(conn, bunker))!, ledger }, ix, what)
  await send([p.authorize], H.CU.AUTHORIZE, `owner ${what} · authorize`)
  await send([p.execute], H.CU.EXECUTE, `owner ${what} · execute`)
}
/** The same instruction with the delegate key standing where the owner should sign. */
const asDelegate = (ix: TransactionInstruction): TransactionInstruction => {
  for (const k of ix.keys) if (k.pubkey.equals(bunker)) { k.pubkey = delegate.publicKey; k.isSigner = true }
  return ix
}
let mint: PublicKey

test('setup: a bunker with collateral, and an order of its owner on the book', async () => {
  await airdrop(payer.publicKey, 20); await airdrop(admin.publicKey, 5)
  const quote = (await V.getSpotMarket(conn, V.QUOTE_SPOT_MARKET))!
  mint = quote.mint
  await send([H.openIx({ payer: payer.publicKey, keys }), H.initTradingIx({ bunker, payer: payer.publicKey })], H.CU.SETUP, 'open bunker')
  const from = await getOrCreateAssociatedTokenAccount(conn, admin, mint, payer.publicKey)
  await mintTo(conn, admin, mint, from.address, admin, 500n * USDT)
  const to = H.bunkerTokenAccount(bunker, mint)
  await send([
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, bunker, mint),
    createTransferInstruction(from.address, to, payer.publicKey, 500n * USDT),
    H.depositIx({ bunker, marketIndex: V.QUOTE_SPOT_MARKET, amount: 500n * USDT, mint, remaining: await V.remainingAccounts(conn, await account(), { writableSpot: [V.QUOTE_SPOT_MARKET] }) }),
  ], H.CU.SETUP, 'deposit')
  // the owner's own resting bid on BTC, far below the market: nothing the agent does may touch it
  const c = await context()
  const btc = c.mkts.find((m) => m.symbol === 'BTC-PERP')!
  const params = V.perpOrder({ marketIndex: btc.marketIndex, direction: V.DIRECTION.LONG, baseAssetAmount: V.toStep(1_000_000n, btc.perp), orderType: V.ORDER_TYPE.LIMIT, price: V.toTick(BigInt(Math.round(btc.oracle * 0.8 * 1e6)), btc.perp) })
  await act(V.placePerpOrderIx({ authority: bunker, params, remaining: await V.remainingAccounts(conn, await account(), { readablePerp: [btc.marketIndex] }) }), 'own bid')
  assert.equal(V.openOrders(await account()).length, 1)
})

test('hire: one hash-signed move, and the chain lists the bunker as hired (a plain wallet is not)', async () => {
  const listed = async () => (await clientsOf(ash, undefined, 0)).map((x) => x.bunker.toBase58())
  const before = await listed()   // an earlier run on the same validator may have left bunkers hired
  assert.ok(!before.includes(bunker.toBase58()), 'this bunker has not hired the agent yet')
  await act(V.updateUserDelegateIx({ authority: bunker, delegate: delegate.publicKey }), 'hire')
  assert.equal((await account()).delegate.toBase58(), delegate.publicKey.toBase58())
  // an ordinary account that names the same key is not a HashLiquid bunker: the agent does not work for it
  const plain = Keypair.generate(); await airdrop(plain.publicKey, 2)
  await send([V.initializeUserStatsIx({ authority: plain.publicKey, payer: plain.publicKey }), V.initializeUserIx({ authority: plain.publicKey, payer: plain.publicKey }), V.updateUserDelegateIx({ authority: plain.publicKey, delegate: delegate.publicKey })], H.CU.SETUP, 'plain account', [plain])
  assert.deepEqual((await listed()).sort(), [...before, bunker.toBase58()].sort(), 'the bunker is listed, the plain account is not')
})

test('the agent\'s decision reaches the hired bunker, signed by the delegate key alone', async () => {
  const c = await context()
  const sol = c.mkts.find((m) => m.symbol === 'SOL-PERP')!
  const before = await nonce()
  const d: Decision = { action: 'open', market: 'SOL-PERP', side: 'long', stop_price: sol.oracle * 0.985, take_profit_price: sol.oracle * 1.03, invalidation: 'test', thesis: 'test entry', confidence: 0.9, setup_score: 9 }
  await clientsOf(ash, undefined, 0)   // the service lists the chain every few minutes; here, now
  assert.equal(await mirror(ash, d, c), 1, 'applied to the one hired bunker')
  assert.equal(await nonce(), before, 'no hash key of the owner was used')
  const u = await account()
  const mine = V.openOrders(u).find((o) => o.marketIndex === sol.marketIndex)
  const pos = V.perpPosition(u, sol.marketIndex)
  assert.ok(mine || (pos && pos.baseAssetAmount > 0n), 'the entry is on the account')
  const plan = readPlans()[clientBook(ash, bunker).id]?.['SOL-PERP']
  assert.ok(plan && plan.side === 'long' && plan.stop === d.stop_price, 'the exit plan is kept')
  if (mine) assert.equal(plan!.entryOrderId, mine.orderId, 'with the id of the order it placed')
  // careful sizing: a tenth of the equity, not the house's leverage
  const notional = (mine ? Number(mine.baseAssetAmount) : Number(pos!.baseAssetAmount)) / 1e9 * sol.oracle
  assert.ok(notional > 40 && notional < 60, `about 10% of 500 USDT, got ${notional.toFixed(2)}`)
})

test('the guard cancels the agent\'s stale entry and leaves the owner\'s order alone', async () => {
  const book = clientBook(ash, bunker)
  const plan = readPlans()[book.id]['SOL-PERP']
  const u0 = await account()
  if (!V.openOrders(u0).some((o) => o.orderId === plan.entryOrderId)) return   // it filled: nothing rests
  savePlan(book.id, 'SOL-PERP', { ...plan, openedAt: plan.openedAt - 3600 })
  await guard(book, await context())
  const left = V.openOrders(await account())
  assert.equal(left.length, 1, 'one order left')
  assert.notEqual(left[0].orderId, plan.entryOrderId, 'and it is the owner\'s')
  assert.equal(readPlans()[book.id]?.['SOL-PERP'], undefined, 'the plan is gone')
})

test('the delegate key cannot withdraw and cannot change the delegate', async () => {
  const state = (await V.getState(conn))!
  const u = await account()
  const to = (await getOrCreateAssociatedTokenAccount(conn, admin, mint, delegate.publicKey)).address
  const withdraw = asDelegate(V.withdrawIx({ authority: bunker, signer: state.signer, marketIndex: V.QUOTE_SPOT_MARKET, amount: 50n * USDT, toTokenAccount: to, remaining: await V.remainingAccounts(conn, u, { writableSpot: [V.QUOTE_SPOT_MARKET] }) }))
  // refused by the exchange's own rule (the account's authority must be the signer), not for a malformed request
  // (withdraw: the account's authority must be the signer; set-delegate: the account is derived from the signer's own key)
  const hasOne = /ConstraintHasOne|0x7d1|2001|ConstraintSeeds|0x7d6|2006/i
  await assert.rejects(send([withdraw], H.CU.EXECUTE, 'delegate withdraw', [delegate]), (e: Error) => { assert.match(e.message + JSON.stringify((e as any).logs ?? ''), hasOne); return true })
  assert.equal((await getAccount(conn, to)).amount, 0n, 'nothing left the exchange')
  const thief = Keypair.generate().publicKey
  await assert.rejects(send([asDelegate(V.updateUserDelegateIx({ authority: bunker, delegate: thief }))], H.CU.EXECUTE, 'delegate re-delegates', [delegate]), (e: Error) => { assert.match(e.message + JSON.stringify((e as any).logs ?? ''), hasOne); return true })
  assert.equal((await account()).delegate.toBase58(), delegate.publicKey.toBase58(), 'the delegate is who the owner chose')
  assert.equal(V.tokenAmount(await account(), (await V.getSpotMarket(conn, V.QUOTE_SPOT_MARKET))!) >= 499n * USDT, true, 'the collateral is where it was')
})

test('fire: the owner\'s words take the agent away, and its key is refused from then on', async () => {
  await act(V.updateUserDelegateIx({ authority: bunker, delegate: PublicKey.default }), 'fire')
  assert.ok((await account()).delegate.equals(PublicKey.default))
  assert.ok(!(await clientsOf(ash, undefined, 0)).map((x) => x.bunker.toBase58()).includes(bunker.toBase58()), 'no longer listed')
  const c = await context()
  const sol = c.mkts.find((m) => m.symbol === 'SOL-PERP')!
  const params = V.perpOrder({ marketIndex: sol.marketIndex, direction: V.DIRECTION.LONG, baseAssetAmount: V.toStep(100_000_000n, sol.perp), orderType: V.ORDER_TYPE.LIMIT, price: V.toTick(BigInt(Math.round(sol.oracle * 0.9 * 1e6)), sol.perp) })
  await assert.rejects(send([V.placePerpOrderIx({ authority: bunker, signer: delegate.publicKey, params, remaining: await V.remainingAccounts(conn, await account(), { readablePerp: [sol.marketIndex] }) })], H.CU.EXECUTE, 'fired delegate places', [delegate]))
  // and the guard lets go of anything it still had in mind for this bunker
  const book = clientBook(ash, bunker)
  savePlan(book.id, 'SOL-PERP', { side: 'long', entry: sol.oracle, stop: sol.oracle * 0.98, target: null, invalidation: '', thesis: '', openedAt: 0, initialRisk: 1, atr: null, filled: true })
  await guard(book, c)
  assert.deepEqual(Object.keys(readPlans()[book.id] ?? {}), [])
})

/* ---------------- a user's own agent ---------------- */

test('create your agent: the config is in the account name, the custom key trades it, the owner fires it', async () => {
  const { customAgents, customDelegate } = await import('./chain.ts')
  const { customBook, apply, guard } = await import('./engine.ts')
  const custom = customDelegate()
  mint ??= (await V.getSpotMarket(conn, V.QUOTE_SPOT_MARKET))!.mint   // when this scenario runs on its own
  if ((await conn.getBalance(payer.publicKey)) < 2 * LAMPORTS_PER_SOL) await airdrop(payer.publicKey, 20)
  if ((await conn.getBalance(admin.publicKey)) < LAMPORTS_PER_SOL) await airdrop(admin.publicKey, 5)
  const m2 = H.wordsToMaster(H.newWords()); const k2 = H.bunkerKeys(m2, 'localnet'); const bob = k2.address; const l2 = new H.SignedLedger()
  const actBob = async (ix: TransactionInstruction, what: string) => {
    const p = H.prepareAction({ master: m2, network: 'localnet', bunkerKey: bob, bunker: (await H.getBunker(conn, bob))!, ledger: l2 }, ix, what)
    await send([p.authorize], H.CU.AUTHORIZE, `bob ${what} · authorize`); await send([p.execute], H.CU.EXECUTE, `bob ${what} · execute`)
  }
  // the bunker is created with its agent's configuration already in the account name: base 2, aggressiveness 2
  const cfg = { kind: 'custom' as const, base: 2 as const, aggr: 2 as const, label: "Bob's bot" }
  await send([H.openIx({ payer: payer.publicKey, keys: k2 }), H.initTradingIx({ bunker: bob, payer: payer.publicKey, nameBytes: H.encodeAgentName(cfg) })], H.CU.SETUP, 'open bob')
  assert.deepEqual(H.decodeAgentName((await V.getUser(conn, bob))!.name), cfg, 'the name on chain decodes to the config')
  const from = await getOrCreateAssociatedTokenAccount(conn, admin, mint, payer.publicKey)
  await mintTo(conn, admin, mint, from.address, admin, 400n * USDT)
  const to = H.bunkerTokenAccount(bob, mint)
  await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, bob, mint), createTransferInstruction(from.address, to, payer.publicKey, 400n * USDT), H.depositIx({ bunker: bob, marketIndex: V.QUOTE_SPOT_MARKET, amount: 400n * USDT, mint, remaining: await V.remainingAccounts(conn, (await V.getUser(conn, bob))!, { writableSpot: [V.QUOTE_SPOT_MARKET] }) })], H.CU.SETUP, 'bob deposit')
  // switching it on = naming the custom key as the delegate, one signed move
  await actBob(V.updateUserDelegateIx({ authority: bob, delegate: custom.publicKey }), 'create agent')
  const listed = (await customAgents(0)).find((x) => x.bunker.equals(bob))
  assert.ok(listed, 'the chain lists it as a custom agent'); assert.deepEqual(listed!.cfg, cfg)
  const book = customBook(listed!)
  assert.equal(book.def.name, "Bob's bot"); assert.equal(book.limits.targetLeverage, 2, 'aggressiveness 2 = 2x')
  // its own decision (what the model would return), sized for its bunker and limits, signed by the custom key
  const c = await context()
  const eth = c.mkts.find((m) => m.symbol === 'BTC-PERP')!   // the local validator clones SOL and BTC only
  const nonceBefore = (await H.getBunker(conn, bob))!.nonce
  // with the trend (a trade against it is sized at half), so the size check below is about the limits alone
  const short = eth.regime === 'trend_down'
  const d: Decision = { action: 'open', market: 'BTC-PERP', side: short ? 'short' : 'long', stop_price: eth.oracle * (short ? 1.015 : 0.985), take_profit_price: eth.oracle * (short ? 0.96 : 1.04), invalidation: 'test', thesis: 'test', confidence: 0.9, setup_score: 9 }
  const move = await apply(book, d, c, 'full')
  assert.equal(move.error, undefined, move.error)
  assert.equal((await H.getBunker(conn, bob))!.nonce, nonceBefore, 'none of Bob\'s keys were used')
  const u = (await V.getUser(conn, bob))!
  const order = V.openOrders(u).find((o) => o.marketIndex === eth.marketIndex), pos = V.perpPosition(u, eth.marketIndex)
  const notional = ((order ? Number(order.baseAssetAmount) : Number(pos?.baseAssetAmount ?? 0n)) / 1e9) * eth.oracle
  const want = Math.floor((0.2 * 400 * 2) / eth.oracle / eth.stepSize) * eth.stepSize * eth.oracle   // 160 USDT, rounded down to BTC's step
  assert.ok(Math.abs(notional - want) < want * 0.01, `20% of 400 at 2x = 160 USDT rounded to the step (${want.toFixed(2)}), got ${notional.toFixed(2)}`)
  assert.ok(readPlans()[book.id]?.['BTC-PERP'], 'its exit plan is kept under custom@<bunker>')
  // the owner switches it off: the custom key is refused and the guard lets go
  await actBob(V.updateUserDelegateIx({ authority: bob, delegate: PublicKey.default }), 'fire agent')
  assert.ok(!(await customAgents(0)).some((x) => x.bunker.equals(bob)), 'no longer listed')
  await guard(book, c)
  assert.deepEqual(Object.keys(readPlans()[book.id] ?? {}), [], 'plans dropped')
})
