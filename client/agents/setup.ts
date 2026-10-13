/*
  setup.ts — funds the agents from one wallet, once. Idempotent: run it again and it only does what is missing.
    1. the funding wallet keeps RESERVE SOL, sends PAYER_SOL to the agents' fee payer, swaps the rest for USDT on
       Jupiter and hands the USDT to the fee payer
    2. for each agent: open the bunker and its trading account, move its share of USDT in, deposit it
  Nothing secret is printed: addresses and balances only.

    WALLET=/path/to/funding-wallet.json node agents/setup.ts
  Options (env): RESERVE=0.1 (SOL left in the funding wallet), PAYER_SOL=0.15 (SOL for fees and rent), RPC, FEE.
*/
import { readFileSync } from 'node:fs'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import * as H from '../src/index.ts'
import { AGENTS } from './config.ts'
import { V, NET, conn, sender, payer, agentChain, send, log, solBalance, tokenBalance, user, clearPending } from './chain.ts'

const WALLET = process.env.WALLET
if (!WALLET) throw new Error('set WALLET to the funding wallet keypair file')
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(WALLET, 'utf8'))))
const RESERVE = Number(process.env.RESERVE ?? '0.1')
const PAYER_SOL = Number(process.env.PAYER_SOL ?? '0.15')
const PAYER_MIN = Number(process.env.PAYER_MIN ?? '0.05')   // below this the fee payer gets PAYER_SOL more
const MIN_USDT = BigInt(Math.round(Number(process.env.MIN_USDT ?? '30') * 1e6))   // below this total, SOL is swapped for more
const QUOTE = V.QUOTE_SPOT_MARKET
const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2)

/** A transaction signed by the funding wallet (and paid by it). */
async function sendAsFunder(ixs: Parameters<typeof send>[0], what: string): Promise<string> {
  const tx = new Transaction().add(H.cuIx(200_000), H.priorityFeeIx(5_000), ...ixs)
  tx.feePayer = funder.publicKey
  const latest = await conn.getLatestBlockhash('confirmed')
  tx.recentBlockhash = latest.blockhash
  tx.sign(funder)
  const sig = await sender.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 })
  await confirmed(sig, what)
  log(`${what}: ${sig}`)
  return sig
}

/** Waits for a signature by polling (the public RPC has no working websocket). */
async function confirmed(sig: string, what: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0]
    if (st?.err) throw new Error(`${what} failed: ${JSON.stringify(st.err)}`)
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`${what}: not confirmed within 2 minutes (check the signature ${sig} before running again)`)
}

async function swapForUsdt(mint: PublicKey, lamports: bigint): Promise<void> {
  const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint.toBase58()}&amount=${lamports}&slippageBps=50`)).json()
  if (!q.outAmount) throw new Error(`Jupiter quote failed: ${JSON.stringify(q).slice(0, 200)}`)
  const r = await (await fetch('https://lite-api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, userPublicKey: funder.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }) })).json()
  if (!r.swapTransaction) throw new Error(`Jupiter swap failed: ${JSON.stringify(r).slice(0, 200)}`)
  const tx = VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, 'base64'))
  tx.sign([funder])
  const sig = await sender.sendRawTransaction(tx.serialize(), { maxRetries: 5 })
  await confirmed(sig, 'swap')
  log(`swap ${Number(lamports) / 1e9} SOL → ${usd(BigInt(q.outAmount))} USDT: ${sig}`)
}

async function main() {
  if (NET !== 'mainnet') throw new Error('setup is for mainnet')
  const quote = (await V.getSpotMarket(conn, QUOTE))!
  const mint = quote.mint
  const agents = AGENTS.map(agentChain)
  log(`funder ${funder.publicKey.toBase58()} · ${await solBalance(funder.publicKey)} SOL · ${usd(await tokenBalance(funder.publicKey, mint))} USDT`)
  log(`fee payer ${payer.publicKey.toBase58()} · ${await solBalance(payer.publicKey)} SOL · ${usd(await tokenBalance(payer.publicKey, mint))} USDT`)
  for (const a of agents) log(`${a.def.id} bunker ${a.bunker.toBase58()}`)

  // 1. SOL for fees to the payer, the rest to USDT, USDT to the payer
  const already = agents.filter((a) => a.ledger.get(a.bunker, 0n) !== null || false)
  if ((await solBalance(payer.publicKey)) < PAYER_MIN) {
    await sendAsFunder([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: payer.publicKey, lamports: Math.round(PAYER_SOL * LAMPORTS_PER_SOL) })], `${PAYER_SOL} SOL to the fee payer`)
  }
  const deposited = async () => { let s = 0n; for (const a of agents) { const u = await user(a); if (u) s += V.tokenAmount(u, quote) } return s }
  let funderUsdt = await tokenBalance(funder.publicKey, mint)
  const total = (await tokenBalance(payer.publicKey, mint)) + funderUsdt + (await deposited())
  if (total < MIN_USDT) {
    // everything above the reserve becomes collateral
    const sol = await solBalance(funder.publicKey)
    const toSwap = sol - RESERVE - 0.01
    if (toSwap < 0.05) throw new Error(`only ${sol} SOL in the funder: nothing left to swap after the ${RESERVE} reserve`)
    await swapForUsdt(mint, BigInt(Math.round(toSwap * LAMPORTS_PER_SOL)))
    funderUsdt = await tokenBalance(funder.publicKey, mint)
  }
  if (funderUsdt > 0n) {
    const to = getAssociatedTokenAddressSync(mint, payer.publicKey)
    await sendAsFunder([
      createAssociatedTokenAccountIdempotentInstruction(funder.publicKey, to, payer.publicKey, mint),
      createTransferInstruction(getAssociatedTokenAddressSync(mint, funder.publicKey), to, funder.publicKey, funderUsdt),
    ], `${usd(funderUsdt)} USDT to the fee payer`)
  }
  void already

  // 2. each agent: bunker + trading account, then its share of the USDT
  const unfunded: typeof agents = []
  for (const a of agents) { const u = await user(a); if (!u || V.tokenAmount(u, quote) === 0n) unfunded.push(a) }
  const share = unfunded.length ? (await tokenBalance(payer.publicKey, mint)) / BigInt(unfunded.length) : 0n
  for (const a of agents) {
    const b = await H.getBunker(conn, a.bunker)
    if (!b || !(await user(a))) {
      await send([...(b ? [] : [H.openIx({ payer: payer.publicKey, keys: a.keys })]), ...((await user(a)) ? [] : [H.initTradingIx({ bunker: a.bunker, payer: payer.publicKey, name: `HashLiquid ${a.def.name}` })])], H.CU.SETUP, `${a.def.id} open + init_trading`)
    }
    await clearPending(a)
    const u = (await user(a))!
    const held = V.tokenAmount(u, quote)
    if (held === 0n && share > 0n) {
      const to = H.bunkerTokenAccount(a.bunker, mint)
      await send([
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, a.bunker, mint),
        createTransferInstruction(getAssociatedTokenAddressSync(mint, payer.publicKey), to, payer.publicKey, share),
        H.depositIx({ bunker: a.bunker, marketIndex: QUOTE, amount: share, mint, remaining: await V.remainingAccounts(conn, u, { writableSpot: [QUOTE] }) }),
      ], H.CU.SETUP, `${a.def.id} deposit ${usd(share)} USDT`)
    }
    log(`${a.def.id} · bunker ${a.bunker.toBase58()} · key #${(await H.getBunker(conn, a.bunker))!.nonce} · ${usd(V.tokenAmount((await user(a))!, quote))} USDT on the exchange`)
  }
  log(`done · fee payer ${await solBalance(payer.publicKey)} SOL · funder ${await solBalance(funder.publicKey)} SOL`)
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
