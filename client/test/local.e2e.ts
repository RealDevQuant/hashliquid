// End to end on a local validator that runs the REAL exchange: Velocity's program and its SOL-PERP and USDT
// markets are copied from mainnet (scripts/localnet.sh). The only thing local is test USDT.
//   anchor build && scripts/localnet.sh                (from the repo root; RPC_PORT=18899 if 8899 is taken)
//   cd client && npm run test:e2e                      (RPC=http://127.0.0.1:18899 to match)
// Covers: a bunker that owns a Velocity account; deposits; an order, a cancel and a withdrawal each signed with a
// one-time key; a delegate that can trade but not withdraw; and the attacks (a wallet, a replay, another action).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL, type TransactionInstruction } from '@solana/web3.js'
import { createTransferInstruction, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import * as H from '../src/index.ts'

const V = H.V
const conn = new Connection(process.env.RPC || 'http://127.0.0.1:8899', 'confirmed')
const NET: H.Network = 'localnet'
const USDT = 1_000_000n
const SOL_PERP = 0, USDT_MARKET = 0

interface Sent { sig: string; cu: number; size: number; events: H.ProgramEvent[]; logs: string[] }
async function send(ixs: TransactionInstruction[], signers: Keypair[], { cu }: { cu?: number } = {}): Promise<Sent> {
  const tx = new Transaction().add(...(cu ? [H.cuIx(cu)] : []), ...ixs)
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash
  tx.sign(...signers)
  const raw = tx.serialize()
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true })
  const res = await conn.confirmTransaction(sig, 'confirmed')
  const info = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  const logs = info?.meta?.logMessages ?? []
  if (res.value.err) {
    // the name of the Anchor error, whichever program raised it
    const name = logs.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).filter(Boolean).pop() ?? null
    throw Object.assign(new Error(`tx failed: ${name || JSON.stringify(res.value.err)}\n${logs.slice(-12).join('\n')}`), { program: name, raw: res.value.err, logs })
  }
  return { sig, cu: info!.meta!.computeUnitsConsumed!, size: raw.length, events: H.hashliquid.decodeEvents(logs), logs }
}
const failsWith = (p: Promise<unknown>, name: string) => assert.rejects(p, (e: any) => { assert.equal(e.program, name, e.message); return true })
const fund = async (kp: Keypair, sol = 20) => { await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed') }

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('../../.localnet/admin.json', import.meta.url), 'utf8'))))
const wallet = Keypair.generate(), stranger = Keypair.generate(), thief = Keypair.generate(), agent = Keypair.generate(), plain = Keypair.generate()
let usdt: PublicKey, velocitySigner: PublicKey
const tokens = async (owner: PublicKey) => { try { return (await getAccount(conn, H.bunkerTokenAccount(owner, usdt))).amount } catch { return 0n } }
const giveUsdt = async (to: PublicKey, amount: bigint) => {
  const acc = await getOrCreateAssociatedTokenAccount(conn, admin, usdt, to, true)
  await mintTo(conn, admin, usdt, acc.address, admin, amount)
  return acc.address
}

// the bunker under test: 24 words, nothing else
const master = H.wordsToMaster(H.newWords())
const keys = H.bunkerKeys(master, NET)
const bunker = keys.address
const ledger = new H.SignedLedger()
const ctx = async (): Promise<H.SignContext> => ({ master, network: NET, bunkerKey: bunker, bunker: (await H.getBunker(conn, bunker))!, ledger })
const account = async (authority = bunker) => { const u = await V.getUser(conn, authority); assert.ok(u, 'no trading account'); return u }
/** Authorize, then execute: the two transactions of one signed action. Paid by a stranger. */
async function act(ix: TransactionInstruction, note?: string) {
  const p = H.prepareAction(await ctx(), ix, note)
  const authorized = await send([p.authorize], [stranger], { cu: H.CU.AUTHORIZE })
  const executed = await send([p.execute], [stranger], { cu: H.CU.EXECUTE })
  return { ...p, authorized, executed }
}

test('the exchange is the real one, copied from mainnet', async () => {
  for (const k of [admin, wallet, stranger, thief, agent, plain]) await fund(k)
  const state = await V.getState(conn)
  assert.ok(state, 'Velocity state not found: start scripts/localnet.sh')
  velocitySigner = state.signer
  assert.ok(state.whitelistMint.equals(PublicKey.default), 'no whitelist')
  const perp = (await V.getPerpMarket(conn, SOL_PERP))!
  const spot = (await V.getSpotMarket(conn, USDT_MARKET))!
  assert.equal(V.nameOf(perp.name), 'SOL-PERP')
  assert.equal(V.nameOf(spot.name), 'USDT')
  usdt = spot.mint
  const price = await V.getOraclePrice(conn, perp.oracle)
  assert.ok(price && price > 1n * V.PRICE_PRECISION && price < 100_000n * V.PRICE_PRECISION, `SOL oracle price ${price}`)
  console.log(`    Velocity: ${state.numberOfAuthorities} accounts on mainnet · SOL oracle ${Number(price) / 1e6}`)
  // every account type we decode is read to its last byte: no hidden padding
  for (const [name, address] of [['State', V.statePda()], ['PerpMarket', V.perpMarketPda(SOL_PERP)], ['SpotMarket', V.spotMarketPda(USDT_MARKET)]] as const) {
    const info = (await conn.getAccountInfo(address))!
    assert.equal(V.velocity.decodedSize(name, info.data), info.data.length, name)
  }
})

test('a plain wallet can use it here: account, deposit, order, cancel, withdraw', async () => {
  // not our product: this proves the copied exchange works on this validator and that we build its instructions right
  const me = plain.publicKey
  const acc = await giveUsdt(me, 1_000n * USDT)
  await send([V.initializeUserStatsIx({ authority: me, payer: me }), V.initializeUserIx({ authority: me, payer: me })], [plain], { cu: H.CU.SETUP })
  const info = (await conn.getAccountInfo(V.userPda(me)))!
  assert.equal(V.velocity.decodedSize('User', info.data), info.data.length, 'User decodes to its last byte')

  let u = await account(me)
  await send([V.depositIx({ authority: me, marketIndex: USDT_MARKET, amount: 1_000n * USDT, userTokenAccount: acc, remaining: await V.remainingAccounts(conn, u, { writableSpot: [USDT_MARKET] }) })], [plain], { cu: H.CU.SETUP })
  u = await account(me)
  assert.ok(V.spotBalance(u, USDT_MARKET) > 0n)

  const price = (await V.getOraclePrice(conn, (await V.getPerpMarket(conn, SOL_PERP))!.oracle))!
  // a resting bid 20% under the oracle: it stays open, which is all this needs
  const params = V.perpOrder({ marketIndex: SOL_PERP, direction: V.DIRECTION.LONG, baseAssetAmount: V.BASE_PRECISION, orderType: V.ORDER_TYPE.LIMIT, price: V.toTick((price * 80n) / 100n, (await V.getPerpMarket(conn, SOL_PERP))!) })
  const placed = await send([V.placePerpOrderIx({ authority: me, params, remaining: await V.remainingAccounts(conn, u, { readablePerp: [SOL_PERP] }) })], [plain], { cu: H.CU.EXECUTE })
  console.log(`    place_perp_order directly: ${placed.cu} CU`)
  u = await account(me)
  const [order] = V.openOrders(u)
  assert.ok(order, 'the order is open')
  assert.equal(order.baseAssetAmount, V.BASE_PRECISION)

  await send([V.cancelOrderIx({ authority: me, orderId: order.orderId, remaining: await V.remainingAccounts(conn, u, { readablePerp: [SOL_PERP] }) })], [plain], { cu: H.CU.EXECUTE })
  u = await account(me)
  assert.equal(V.openOrders(u).length, 0)

  await send([V.withdrawIx({ authority: me, signer: velocitySigner, marketIndex: USDT_MARKET, amount: 400n * USDT, toTokenAccount: acc, remaining: await V.remainingAccounts(conn, u, { writableSpot: [USDT_MARKET] }) })], [plain], { cu: H.CU.EXECUTE })
  assert.equal(await tokens(me), 400n * USDT)
})

const oraclePrice = async () => (await V.getOraclePrice(conn, (await V.getPerpMarket(conn, SOL_PERP))!.oracle))!
/** A bid for `size` SOL-PERP `pct`% of the oracle price: far enough under it to rest. */
const restingBid = async (size: bigint, pct = 80n) =>
  V.perpOrder({ marketIndex: SOL_PERP, direction: V.DIRECTION.LONG, baseAssetAmount: size, orderType: V.ORDER_TYPE.LIMIT, price: V.toTick(((await oraclePrice()) * pct) / 100n, (await V.getPerpMarket(conn, SOL_PERP))!) })
const perpAccounts = async (u: H.V.User | null) => V.remainingAccounts(conn, u, { readablePerp: [SOL_PERP] })
const usdtAccounts = async (u: H.V.User | null) => V.remainingAccounts(conn, u, { writableSpot: [USDT_MARKET] })

test('a bunker opens and owns a trading account on the exchange', async () => {
  // one transaction, paid by an ordinary wallet: the bunker, then its Velocity account
  const sent = await send([H.openIx({ payer: wallet.publicKey, keys }), H.initTradingIx({ bunker, payer: wallet.publicKey })], [wallet], { cu: H.CU.SETUP })
  console.log(`    open + init_trading: ${sent.size} bytes, ${sent.cu} CU`)
  const b = (await H.getBunker(conn, bunker))!
  assert.ok(H.eq(b.keyHash, keys.keyHash))
  assert.equal(b.nonce, 0n)
  assert.ok(!H.hasPending(b))

  const u = await account()
  assert.equal(u.authority.toBase58(), bunker.toBase58(), 'the exchange account belongs to the bunker, not to a wallet')
  assert.ok(u.delegate.equals(PublicKey.default))
  assert.equal(V.nameOf(u.name), 'HashLiquid')
  // the address is the keys: other words give another bunker, and opening again changes nothing
  assert.notEqual(H.bunkerKeys(H.wordsToMaster(H.newWords()), NET).address.toBase58(), bunker.toBase58())
  await send([H.openIx({ payer: thief.publicKey, keys })], [thief])
  assert.ok(H.eq((await H.getBunker(conn, bunker))!.keyHash, keys.keyHash))
  // a bunker can't be opened at an address that doesn't commit to its keys
  const fake = { ...keys, keyHash: new Uint8Array(32).fill(7) }
  await assert.rejects(send([H.openIx({ payer: thief.publicKey, keys: fake })], [thief]))
})

test('deposit: tokens sent to the bunker go into its own account, and nowhere else', async () => {
  await giveUsdt(bunker, 1_000n * USDT)           // an ordinary transfer to the bunker's token account
  assert.equal(await tokens(bunker), 1_000n * USDT)
  const ix = H.depositIx({ bunker, marketIndex: USDT_MARKET, amount: 1_000n * USDT, mint: usdt, remaining: await usdtAccounts(await account()) })

  // somebody tries to route the bunker's tokens into their own exchange account
  const hijack = new Transaction().add(ix).instructions[0]
  const mine = { user: V.userPda(plain.publicKey), stats: V.userStatsPda(plain.publicKey) }
  const keysCopy = hijack.keys.map((k) => ({ ...k }))
  keysCopy[2].pubkey = mine.user
  keysCopy[3].pubkey = mine.stats
  await failsWith(send([{ ...hijack, keys: keysCopy } as TransactionInstruction], [thief], { cu: H.CU.SETUP }), 'NotThisBunkersAccount')

  // anyone can send the real one
  const sent = await send([ix], [stranger], { cu: H.CU.SETUP })
  console.log(`    deposit: ${sent.cu} CU`)
  assert.equal(await tokens(bunker), 0n)
  const held = V.tokenAmount(await account(), (await V.getSpotMarket(conn, USDT_MARKET))!)
  assert.ok(held <= 1_000n * USDT && held >= 1_000n * USDT - 2n, `the exchange holds ${held} for the bunker`)
})

test('an order: signed with a one-time key, sent by anyone, placed by the bunker', async () => {
  const u = await account()
  const params = await restingBid(V.BASE_PRECISION)
  const ix = V.placePerpOrderIx({ authority: bunker, params, remaining: await perpAccounts(u) })

  // nothing is pending: there is nothing to execute
  await failsWith(send([H.executeIx({ bunker, action: H.actionOf(ix) })], [thief], { cu: H.CU.EXECUTE }), 'NothingPending')
  // a made-up signature (with a salt the program accepts, so the signature itself is what fails)
  const next9 = new Uint8Array(32).fill(9)
  const ground = H.grindSalt(H.PROGRAM_ID, bunker, (await H.getBunker(conn, bunker))!.nonce, H.actionOf(ix).hash, next9)
  const garbage = { sig: new Uint8Array(H.SIG_LEN).fill(7), nextKeyHash: next9, salt: ground.salt, action: H.actionOf(ix).hash }
  await failsWith(send([H.authorizeIx({ bunker, signed: garbage })], [thief], { cu: H.CU.AUTHORIZE }), 'BadSignature')
  // a salt that makes the signature too costly to verify is refused before anything is walked
  let costly = 0
  while (H.verifyCost(H.messageDigest(H.PROGRAM_ID, bunker, (await H.getBunker(conn, bunker))!.nonce, H.actionOf(ix).hash, next9, costly)) <= 3600) costly++
  await failsWith(send([H.authorizeIx({ bunker, signed: { ...garbage, salt: costly } })], [thief], { cu: H.CU.AUTHORIZE }), 'TooCostly')
  // a wallet can't place it on the bunker's account either: the exchange only answers to the bunker
  await assert.rejects(send([V.placePerpOrderIx({ authority: bunker, signer: thief.publicKey, params, remaining: await perpAccounts(u) })], [thief], { cu: H.CU.EXECUTE }))

  const p = H.prepareAction(await ctx(), ix, 'bid 1 SOL-PERP')
  const authorized = await send([p.authorize], [stranger], { cu: H.CU.AUTHORIZE })
  console.log(`    authorize: ${authorized.size} / 1232 bytes, ${authorized.cu} CU, ${p.signed.cost} hash steps`)
  assert.ok(authorized.size <= 1232)
  let b = (await H.getBunker(conn, bunker))!
  assert.equal(b.nonce, 1n)
  assert.ok(H.eq(b.keyHash, H.bunkerKeyHash(master, keys.seed, 1)), 'the bunker now answers to key 1')
  assert.ok(H.eq(b.pending, p.action.hash))

  // what was signed is that order, to the byte: a bigger one doesn't pass
  const bigger = V.placePerpOrderIx({ authority: bunker, params: { ...params, baseAssetAmount: 5n * V.BASE_PRECISION }, remaining: await perpAccounts(u) })
  await failsWith(send([H.executeIx({ bunker, action: H.actionOf(bigger) })], [thief], { cu: H.CU.EXECUTE }), 'WrongAction')
  assert.equal(V.openOrders(await account()).length, 0)

  const executed = await send([p.execute], [stranger], { cu: H.CU.EXECUTE })
  console.log(`    execute (place_perp_order): ${executed.size} / 1232 bytes, ${executed.cu} CU`)
  const [order] = V.openOrders(await account())
  assert.ok(order, 'the order is on the exchange')
  assert.equal(order.baseAssetAmount, V.BASE_PRECISION)
  assert.equal(order.price, params.price)
  b = (await H.getBunker(conn, bunker))!
  assert.ok(!H.hasPending(b))

  // it runs once, and the signature can't come back
  await failsWith(send([p.execute], [thief], { cu: H.CU.EXECUTE }), 'NothingPending')
  await failsWith(send([p.authorize], [thief], { cu: H.CU.AUTHORIZE }), 'BadNextKey')
  assert.equal(V.openOrders(await account()).length, 1)
})

test('one key, one message; a pending action can be called off', async () => {
  const u = await account()
  const c = await ctx()
  const first = V.placePerpOrderIx({ authority: bunker, params: await restingBid(2n * V.BASE_PRECISION), remaining: await perpAccounts(u) })
  const p = H.prepareAction(c, first)
  // the same key is asked to sign something else: the client refuses
  const second = V.placePerpOrderIx({ authority: bunker, params: await restingBid(3n * V.BASE_PRECISION, 70n), remaining: await perpAccounts(u) })
  assert.throws(() => H.prepareAction(c, second), (e: any) => e.code === 'KEY_ALREADY_USED')
  // asked again for the first, it gives the same bytes; and they can be rebuilt from the ledger alone
  assert.deepEqual(Uint8Array.from(H.prepareAction(c, first).authorize.data), Uint8Array.from(p.authorize.data))
  const rebuilt = H.fromRecord({ bunker, record: ledger.get(bunker, c.bunker.nonce)! })
  assert.deepEqual(Uint8Array.from(rebuilt.authorize.data), Uint8Array.from(p.authorize.data))
  assert.deepEqual(Uint8Array.from(rebuilt.execute!.data), Uint8Array.from(p.execute.data))

  await send([rebuilt.authorize], [stranger], { cu: H.CU.AUTHORIZE })
  assert.ok(H.hasPending((await H.getBunker(conn, bunker))!))
  // changed her mind before it ran: the next key authorizes "nothing", which replaces it
  const off = H.prepareCancel(await ctx())
  await send([off.authorize], [stranger], { cu: H.CU.AUTHORIZE })
  const b = (await H.getBunker(conn, bunker))!
  assert.ok(!H.hasPending(b))
  assert.equal(b.nonce, 3n)
  await failsWith(send([p.execute], [thief], { cu: H.CU.EXECUTE }), 'NothingPending')
  assert.equal(V.openOrders(await account()).length, 1, 'only the first order is there')
})

test('a real position: the signed order is matched on the exchange, then closed the same way', async () => {
  const market = (await V.getPerpMarket(conn, SOL_PERP))!
  const price = await oraclePrice()
  // a keeper needs its own exchange account; on mainnet Velocity's keepers do this job
  await send([V.initializeUserStatsIx({ authority: stranger.publicKey, payer: stranger.publicKey }), V.initializeUserIx({ authority: stranger.publicKey, payer: stranger.publicKey })], [stranger], { cu: H.CU.SETUP })
  const fill = async (orderId: number) => {
    const taker = await account(), maker = await account(plain.publicKey)
    const remaining = await V.remainingAccounts(conn, taker, { writablePerp: [SOL_PERP] })
    for (const k of [V.userPda(plain.publicKey), V.userStatsPda(plain.publicKey)]) remaining.push({ pubkey: k, isSigner: false, isWritable: true })
    void maker
    return send([V.fillPerpOrderIx({ filler: stranger.publicKey, user: V.userPda(bunker), userStats: V.userStatsPda(bunker), orderId, remaining })], [stranger], { cu: 1_000_000 })
  }

  // somebody offers 1 SOL-PERP at the oracle price…
  const ask = V.perpOrder({ marketIndex: SOL_PERP, direction: V.DIRECTION.SHORT, baseAssetAmount: V.BASE_PRECISION, orderType: V.ORDER_TYPE.LIMIT, price: V.toTick(price, market), postOnly: V.POST_ONLY.MUST_POST_ONLY })
  await send([V.placePerpOrderIx({ authority: plain.publicKey, params: ask, remaining: await perpAccounts(await account(plain.publicKey)) })], [plain], { cu: H.CU.EXECUTE })
  // …and the bunker's key signs a bid that crosses it
  const bid = V.perpOrder({ marketIndex: SOL_PERP, direction: V.DIRECTION.LONG, baseAssetAmount: V.BASE_PRECISION, orderType: V.ORDER_TYPE.LIMIT, price: V.toTick((price * 101n) / 100n, market) })
  await act(V.placePerpOrderIx({ authority: bunker, params: bid, remaining: await perpAccounts(await account()) }), 'buy 1 SOL-PERP')
  const bidId = V.openOrders(await account()).find((o) => o.price === bid.price)!.orderId
  const filled = await fill(bidId)
  console.log(`    fill_perp_order (keeper): ${filled.cu} CU`)

  let pos = V.perpPosition(await account(), SOL_PERP)
  assert.ok(pos, 'the bunker holds a position')
  assert.equal(pos.baseAssetAmount, V.BASE_PRECISION, 'long 1 SOL-PERP')
  assert.equal(-pos.quoteEntryAmount, (ask.price * V.BASE_PRECISION) / V.BASE_PRECISION, 'bought at the maker price')
  assert.equal(V.perpPosition(await account(plain.publicKey), SOL_PERP)!.baseAssetAmount, -V.BASE_PRECISION)

  // closing is another signed order: reduce-only, against a bid
  const makerBid = V.perpOrder({ marketIndex: SOL_PERP, direction: V.DIRECTION.LONG, baseAssetAmount: V.BASE_PRECISION, orderType: V.ORDER_TYPE.LIMIT, price: V.toTick(price, market), postOnly: V.POST_ONLY.MUST_POST_ONLY })
  await send([V.placePerpOrderIx({ authority: plain.publicKey, params: makerBid, remaining: await perpAccounts(await account(plain.publicKey)) })], [plain], { cu: H.CU.EXECUTE })
  const close = V.perpOrder({ marketIndex: SOL_PERP, direction: V.DIRECTION.SHORT, baseAssetAmount: V.BASE_PRECISION, orderType: V.ORDER_TYPE.LIMIT, price: V.toTick((price * 99n) / 100n, market), reduceOnly: true })
  await act(V.placePerpOrderIx({ authority: bunker, params: close, remaining: await perpAccounts(await account()) }), 'close')
  const closeId = V.openOrders(await account()).find((o) => o.reduceOnly)!.orderId
  await fill(closeId)
  pos = V.perpPosition(await account(), SOL_PERP)
  assert.equal(pos?.baseAssetAmount ?? 0n, 0n, 'flat again')
  assert.equal((await H.getBunker(conn, bunker))!.nonce, 5n)
})

test('cancel and withdraw: signed; the money goes only where the key said', async () => {
  let u = await account()
  const [order] = V.openOrders(u)
  await act(V.cancelOrderIx({ authority: bunker, orderId: order.orderId, remaining: await perpAccounts(u) }), 'cancel')
  u = await account()
  assert.equal(V.openOrders(u).length, 0)

  // a wallet can't withdraw from the bunker's account: on the exchange only the authority can, and that is the bunker
  const thiefAcc = await giveUsdt(thief.publicKey, 1n)
  await assert.rejects(send([V.withdrawIx({ authority: bunker, signer: velocitySigner, marketIndex: USDT_MARKET, amount: 100n * USDT, toTokenAccount: thiefAcc, remaining: await usdtAccounts(u) })], [thief], { cu: H.CU.EXECUTE }))

  const safe = Keypair.generate().publicKey
  const safeAcc = await giveUsdt(safe, 1n)
  const ix = V.withdrawIx({ authority: bunker, signer: velocitySigner, marketIndex: USDT_MARKET, amount: 300n * USDT, toTokenAccount: safeAcc, remaining: await usdtAccounts(u) })
  const p = H.prepareAction(await ctx(), ix, 'withdraw 300 USDT')
  await send([p.authorize], [stranger], { cu: H.CU.AUTHORIZE })
  // the pending withdrawal can't be pointed at another token account
  const redirected = V.withdrawIx({ authority: bunker, signer: velocitySigner, marketIndex: USDT_MARKET, amount: 300n * USDT, toTokenAccount: thiefAcc, remaining: await usdtAccounts(u) })
  await failsWith(send([H.executeIx({ bunker, action: H.actionOf(redirected) })], [thief], { cu: H.CU.EXECUTE }), 'WrongAction')
  const executed = await send([p.execute], [thief], { cu: H.CU.EXECUTE })   // even the thief can send it: it pays `safe`
  console.log(`    execute (withdraw): ${executed.size} / 1232 bytes, ${executed.cu} CU`)
  assert.equal(await tokens(safe), 300n * USDT + 1n)
  assert.equal(await tokens(thief.publicKey), 1n)
})

test('a delegate can trade for the bunker and can never withdraw', async () => {
  let u = await account()
  await act(V.updateUserDelegateIx({ authority: bunker, delegate: agent.publicKey }), 'set delegate')
  u = await account()
  assert.equal(u.delegate.toBase58(), agent.publicKey.toBase58())

  // the delegate (an ordinary key: a wallet, an agent) trades directly on the exchange, one transaction, no words
  const placed = await send([V.placePerpOrderIx({ authority: bunker, signer: agent.publicKey, params: await restingBid(V.BASE_PRECISION), remaining: await perpAccounts(u) })], [agent], { cu: H.CU.EXECUTE })
  console.log(`    delegate places an order directly: ${placed.cu} CU`)
  u = await account()
  assert.equal(V.openOrders(u).length, 1)
  await send([V.cancelOrdersIx({ authority: bunker, signer: agent.publicKey, remaining: await perpAccounts(u) })], [agent], { cu: H.CU.EXECUTE })

  // but it can't take the money out, nor make itself or anyone else the delegate
  const agentAcc = await giveUsdt(agent.publicKey, 1n)
  await assert.rejects(send([V.withdrawIx({ authority: bunker, signer: velocitySigner, marketIndex: USDT_MARKET, amount: 50n * USDT, toTokenAccount: agentAcc, remaining: await usdtAccounts(await account()) })], [agent], { cu: H.CU.EXECUTE }))
  assert.equal(await tokens(agent.publicKey), 1n)

  // the words take the delegate away
  await act(V.updateUserDelegateIx({ authority: bunker, delegate: PublicKey.default }), 'remove delegate')
  u = await account()
  assert.ok(u.delegate.equals(PublicKey.default))
  await assert.rejects(send([V.placePerpOrderIx({ authority: bunker, signer: agent.publicKey, params: await restingBid(V.BASE_PRECISION), remaining: await perpAccounts(u) })], [agent], { cu: H.CU.EXECUTE }))
  assert.equal((await H.getBunker(conn, bunker))!.nonce, 9n, 'nine keys used so far, each once')
})

test('withdraw everything: ask for more than there is, reduce-only, and the exchange pays out what is free', async () => {
  // this is what the page's "withdraw all" signs: the exact amount moves with interest and fees, so it can't be named in advance
  const u = await account()
  const market = (await V.getSpotMarket(conn, USDT_MARKET))!
  const held = V.tokenAmount(u, market)
  // the round trip above cost fees: they sit on the closed position as PnL not yet settled, and stay behind to cover it
  const unsettled = V.perpPosition(u, SOL_PERP)?.quoteAssetAmount ?? 0n
  assert.ok(held > 600n * USDT && unsettled < 0n, `holds ${held}, unsettled ${unsettled}`)
  const owner = Keypair.generate().publicKey
  const to = await giveUsdt(owner, 1n)
  await act(V.withdrawIx({ authority: bunker, signer: velocitySigner, marketIndex: USDT_MARKET, amount: held * 2n, toTokenAccount: to, remaining: await usdtAccounts(u), reduceOnly: true }), 'withdraw all')
  const got = (await tokens(owner)) - 1n
  const free = held + unsettled
  assert.ok(got <= free && free - got <= 2n, `paid ${got}, free was ${free}`)
  const left = V.tokenAmount(await account(), (await V.getSpotMarket(conn, USDT_MARKET))!)
  assert.ok(left >= -unsettled && left + unsettled <= 2n, `what stays covers the unsettled loss: ${left}`)
  console.log(`    paid ${got} of ${held}; ${left} stays against ${unsettled} of unsettled PnL`)
})
