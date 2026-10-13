/*
  burn.ts — buyback and burn.

  Once a day (after BURN.hourUtc, UTC) the service takes BURN.share of what each house agent made in the last 24
  hours (trading result only: equity minus net deposits, so deposits and withdrawals never count), withdraws it from
  the agent's bunker with a one-time key to the burn wallet, then turns everything the burn wallet holds (the house
  shares plus the 2% the site collects on withdrawals from bunkers that ran an agent) into the coin on the open
  market and burns it. Every step is a transaction anyone can read. Nothing is burned without a confirmed swap.

  State in data/burns.json: the last day run, each agent's result at the last run (the checkpoint), what is still
  owed when the venue could not release the whole share (margin in use), and the record of every burn.
*/
import { readFileSync } from 'node:fs'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createBurnInstruction, getAccount, getAssociatedTokenAddressSync, getMint } from '@solana/spl-token'
import * as H from '../src/index.ts'
import { V, account, act, agentChain, clearPending, conn, log, payer, secrets, send, sender, sleep, solBalance, tokenBalance } from './chain.ts'
import { AGENTS, BURN } from './config.ts'
import { readBurnState, saveBurnState, type BurnRecord, type FeedBurns } from './store.ts'

export interface BurnCtx { quote: H.V.SpotMarket; names: Map<number, string>; oracles: Map<number, number> }
const today = () => new Date().toISOString().slice(0, 10)
const r2 = (x: number) => Math.round(x * 100) / 100
const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2)

/** The burn wallet: one address, one job. Its key lives in .secrets/agents/burner.json. */
export function burner(): Keypair { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('burner.json', secrets), 'utf8')))) }

/** True when today's run is still to do. Cheap: the loop asks every pass. */
export function burnDue(): boolean {
  if (!BURN.mint) return false
  return readBurnState().lastDay !== today() && new Date().getUTCHours() >= BURN.hourUtc
}

/** What the burn wallet would turn `amount` USDT into, from the aggregator. */
async function quote(usdt: PublicKey, mint: PublicKey, amount: bigint) {
  const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${usdt.toBase58()}&outputMint=${mint.toBase58()}&amount=${amount}&slippageBps=${BURN.slippageBps}`)).json()
  if (!q.outAmount) throw new Error(`no route for the coin: ${JSON.stringify(q).slice(0, 160)}`)
  return q
}

/** The day's run. `dry` computes everything, fetches the quote and sends nothing. */
export async function dailyBurn(c: BurnCtx, dry: boolean): Promise<void> {
  if (!BURN.mint) { log('burn: no coin set (BURN.mint in config.ts): nothing to do'); return }
  const mint = new PublicKey(BURN.mint), usdt = c.quote.mint
  const b = burner()
  const st = readBurnState()
  const day = today()
  const burnerUsdt = getAssociatedTokenAddressSync(usdt, b.publicKey)
  const parts: Record<string, number> = {}
  const txs: string[] = []
  log(`burn ${day}${dry ? ' (dry)' : ''} · coin ${mint.toBase58()} · burn wallet ${b.publicKey.toBase58()} · ${await solBalance(b.publicKey)} SOL · ${usd(await tokenBalance(b.publicKey, usdt))} USDT waiting`)

  // 0. fees for the burn wallet's own transactions
  if ((await solBalance(b.publicKey)) < 0.005 && !dry) await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: b.publicKey, lamports: Math.round(0.02 * LAMPORTS_PER_SOL) })], 50_000, 'burn wallet: 0.02 SOL for fees')

  // 1. the house share: BURN.share of each agent's positive 24h result, released from its bunker with one key
  const state = (await V.getState(conn))!
  for (const def of AGENTS) {
    const a = agentChain(def)
    const u = await V.getUser(conn, a.bunker)
    if (!u) continue
    const acct = account(u, c.quote, c.names, c.oracles)
    const cp = st.checkpoint[def.id]
    const gain = cp == null ? 0 : r2(acct.pnl - cp)
    const due = r2(Math.max(0, gain) * BURN.share + (st.owed[def.id] ?? 0))
    const notional = acct.positions.reduce((s, p) => s + p.size * (c.oracles.get(p.marketIndex) ?? p.entry), 0)
    const free = Math.max(0, r2(acct.equity - notional * 0.25 - 1))   // what the venue lets out with the positions kept, with margin to spare
    const take = r2(Math.min(due, free))
    log(`burn ${def.id}: result ${acct.pnl} USDT (checkpoint ${cp ?? 'none: set now'}) · 24h gain ${gain} · share due ${due} · free ${free} → ${dry ? 'dry run' : take >= BURN.minUsd ? `withdraw ${take}` : 'carried to tomorrow'}`)
    if (dry) continue
    st.checkpoint[def.id] = acct.pnl
    let owed = due
    if (take >= BURN.minUsd) {
      const before = await tokenBalance(b.publicKey, usdt)
      try {
        await clearPending(a)
        const sigs = await act(a, V.withdrawIx({ authority: a.bunker, signer: state.signer, marketIndex: V.QUOTE_SPOT_MARKET, amount: BigInt(Math.round(take * 1e6)), toTokenAccount: burnerUsdt, remaining: await V.remainingAccounts(conn, u, { writableSpot: [V.QUOTE_SPOT_MARKET] }), reduceOnly: true }), 'burn share', [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, burnerUsdt, b.publicKey, usdt)])
        txs.push(...sigs)
        const got = r2(Number((await tokenBalance(b.publicKey, usdt)) - before) / 1e6)
        parts[def.id] = got
        owed = r2(Math.max(0, due - got))
      } catch (e) { log(`burn ${def.id}: the venue did not release the share (${e instanceof Error ? e.message.split('\n')[0] : e}); carried`) }
    }
    st.owed[def.id] = owed
    saveBurnState(st)
  }

  // 2. everything the burn wallet holds becomes coin, and the coin becomes ash
  const bal = await tokenBalance(b.publicKey, usdt)
  const houseUsd = Object.values(parts).reduce((s, x) => s + x, 0)
  parts.fees = r2(Number(bal) / 1e6 - houseUsd)
  if (Number(bal) / 1e6 < BURN.minUsd) { log(`burn: ${usd(bal)} USDT in the burn wallet, below ${BURN.minUsd}: waiting for more`); if (!dry) { st.lastDay = day; saveBurnState(st) } return }
  const q = await quote(usdt, mint, bal)
  const info = await conn.getAccountInfo(mint)
  if (!info) throw new Error('the coin mint is not on chain')
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  const decimals = (await getMint(conn, mint, 'confirmed', program)).decimals
  log(`burn: ${usd(bal)} USDT → about ${(Number(q.outAmount) / 10 ** decimals).toLocaleString('en-US')} coin (${q.priceImpactPct ?? '?'}% impact)${dry ? ' · dry run: nothing sent' : ''}`)
  if (dry) return
  const tokenAta = getAssociatedTokenAddressSync(mint, b.publicKey, false, program)
  const held = async () => { try { return (await getAccount(conn, tokenAta, 'confirmed', program)).amount } catch { return 0n } }
  const before = await held()
  const r = await (await fetch('https://lite-api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, userPublicKey: b.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }) })).json()
  if (!r.swapTransaction) throw new Error(`swap failed: ${JSON.stringify(r).slice(0, 200)}`)
  const tx = VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, 'base64'))
  tx.sign([b])
  const swapSig = await sender.sendRawTransaction(tx.serialize(), { maxRetries: 5 })
  await conn.confirmTransaction(swapSig, 'confirmed')
  txs.push(swapSig)
  let received = 0n
  for (let i = 0; i < 10 && received === 0n; i++) { received = (await held()) - before; if (received === 0n) await sleep(2000) }
  if (received <= 0n) { log(`burn: the swap ${swapSig} confirmed but no coin arrived yet; the burn waits for the next run`); st.lastDay = day; saveBurnState(st); return }
  const burnSig = await send([createBurnInstruction(tokenAta, mint, b.publicKey, received, [], program)], 80_000, `burn ${(Number(received) / 10 ** decimals).toLocaleString('en-US')} coin`, [b])
  txs.push(burnSig)
  const rec: BurnRecord = { t: Math.floor(Date.now() / 1000), day, usd: r2(Number(bal) / 1e6), tokens: Number(received) / 10 ** decimals, parts, txs }
  st.burns.push(rec)
  st.lastDay = day
  saveBurnState(st)
  log(`burned ${rec.tokens.toLocaleString('en-US')} coin for ${rec.usd} USDT (${Object.entries(parts).map(([k, v]) => `${k} ${v}`).join(', ')}) · ${burnSig}`)
}

/** The public record. */
export function feedBurns(): FeedBurns {
  const st = readBurnState()
  return {
    mint: BURN.mint, burner: BURN.burner, sharePct: Math.round(BURN.share * 100), feePct: Number(H.BURN_FEE_BPS) / 100,
    totalUsd: r2(st.burns.reduce((s, x) => s + x.usd, 0)), totalTokens: st.burns.reduce((s, x) => s + x.tokens, 0), count: st.burns.length,
    last: st.burns.slice(-20).reverse(),
  }
}
