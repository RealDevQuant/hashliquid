// Gives a wallet 5 SOL and 10,000 test USDT on the local validator (scripts/localnet.sh), where the USDT mint's
// authority is the throwaway key in .localnet/admin.json. Localnet only.
//
//   cd client && npm run fund -- <wallet address>          (RPC=http://127.0.0.1:18899 if you moved the port)
import { readFileSync } from 'node:fs'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import * as H from '../src/index.ts'

const RPC = process.env.RPC || 'http://127.0.0.1:8899'
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('localnet only')
const who = process.argv[2]
if (!who) throw new Error('usage: npm run fund -- <wallet address>')
const conn = new Connection(RPC, 'confirmed')
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('../../.localnet/admin.json', import.meta.url), 'utf8'))))
const airdrop = async (to: PublicKey, sol: number) => {
  const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL)
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, 'confirmed')
}

const usdt = (await H.V.getSpotMarket(conn, H.V.QUOTE_SPOT_MARKET))?.mint
if (!usdt) throw new Error(`no exchange at ${RPC}: start scripts/localnet.sh`)
if ((await conn.getBalance(admin.publicKey)) < LAMPORTS_PER_SOL) await airdrop(admin.publicKey, 5)
const wallet = new PublicKey(who)
await airdrop(wallet, 5)
const acc = await getOrCreateAssociatedTokenAccount(conn, admin, usdt, wallet, true)
await mintTo(conn, admin, usdt, acc.address, admin, 10_000_000_000n)
console.log(`${wallet.toBase58()}: +5 SOL, +10,000 test USDT`)
