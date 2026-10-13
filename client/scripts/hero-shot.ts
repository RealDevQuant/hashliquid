// A real picture of the terminal for the landing page, taken on the local validator: a bunker with collateral,
// the BTC market selected, a position opened through the page and filled by a keeper, the chart with live
// candles. Nothing in it is mocked.
//
//   scripts/localnet.sh  ·  VITE_RPC_URL=http://127.0.0.1:8899 npm --prefix web run dev
//   RPC=http://127.0.0.1:8899 BASE=http://localhost:5183 OUT=web/public/terminal.png node client/scripts/hero-shot.ts
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import * as H from '../src/index.ts'

const V = H.V
const RPC = process.env.RPC || 'http://127.0.0.1:8899'
const BASE = process.env.BASE || 'http://localhost:5183'
const OUT = process.env.OUT || 'web/public/terminal.png'
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PUPPETEER = process.env.PUPPETEER || 'puppeteer-core'   // a path to a puppeteer-core install, when it is not in node_modules
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('localnet only')
const conn = new Connection(RPC, 'confirmed')
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('../../.localnet/admin.json', import.meta.url), 'utf8'))))
const BTC = 1   // market index of BTC-PERP on the cloned exchange
const USDT = 1_000_000n

async function send(ixs: TransactionInstruction[], signers: Keypair[], cu = 600_000) {
  const tx = new Transaction().add(H.cuIx(cu), ...ixs)
  tx.feePayer = signers[0].publicKey
  const latest = await conn.getLatestBlockhash()
  tx.recentBlockhash = latest.blockhash
  tx.sign(...signers)
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true })
  const res = await conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed')
  if (res.value.err) {
    const info = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    throw new Error((info?.meta?.logMessages ?? []).slice(-6).join('\n'))
  }
}
const fund = async (kp: Keypair) => { await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed') }

/** Somebody on the other side of the book, and a keeper to match the trade: both plain accounts on the exchange. */
async function counterparty(usdtMint: PublicKey) {
  const maker = Keypair.generate(), keeper = Keypair.generate()
  await fund(maker); await fund(keeper)
  const acc = await getOrCreateAssociatedTokenAccount(conn, admin, usdtMint, maker.publicKey)
  await mintTo(conn, admin, usdtMint, acc.address, admin, 200_000n * USDT)
  for (const k of [maker, keeper]) await send([V.initializeUserStatsIx({ authority: k.publicKey, payer: k.publicKey }), V.initializeUserIx({ authority: k.publicKey, payer: k.publicKey })], [k])
  const u = await V.getUser(conn, maker.publicKey)
  await send([V.depositIx({ authority: maker.publicKey, marketIndex: 0, amount: 200_000n * USDT, userTokenAccount: acc.address, remaining: await V.remainingAccounts(conn, u, { writableSpot: [0] }) })], [maker])
  return { maker, keeper }
}

async function main() {
  const puppeteer = createRequire(import.meta.url)(PUPPETEER)
  if ((await conn.getBalance(admin.publicKey)) < LAMPORTS_PER_SOL) await fund(admin)
  const quote = (await V.getSpotMarket(conn, 0))!
  const btc = (await V.getPerpMarket(conn, BTC))!
  const price = (await V.getOraclePrice(conn, btc.oracle))!
  console.log('BTC oracle', Number(price) / 1e6)
  const { maker, keeper } = await counterparty(quote.mint)
  console.log('counterparty ready')
  // the maker offers 0.2 BTC at the oracle price
  const ask = V.perpOrder({ marketIndex: BTC, direction: V.DIRECTION.SHORT, baseAssetAmount: 200_000_000n, orderType: V.ORDER_TYPE.LIMIT, price: V.toTick(price, btc), postOnly: V.POST_ONLY.MUST_POST_ONLY })
  await send([V.placePerpOrderIx({ authority: maker.publicKey, params: ask, remaining: await V.remainingAccounts(conn, await V.getUser(conn, maker.publicKey), { readablePerp: [BTC] }) })], [maker])

  console.log('maker ask placed')
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1600, height: 960, deviceScaleFactor: 2 })
    const click = async (sel: string) => { await page.waitForSelector(`${sel}:not([disabled])`, { timeout: 60_000 }); await page.click(sel) }
    const idle = () => page.waitForFunction(() => document.getElementById('busy')?.textContent === '', { timeout: 120_000 })
    const type = (field: string, value: string) => page.$eval(`input[data-field="${field}"]`, (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, value)
    const text = (sel: string) => page.$eval(sel, (e: Element) => (e.textContent ?? '').trim())

    await page.goto(`${BASE}/app.html`, { waitUntil: 'networkidle0' })
    await click('[data-action="browserWallet"]')
    await page.waitForSelector('#oracle', { timeout: 30_000 })
    await click('.nav [data-action="account"]')
    await click('[data-action="fund"]'); await idle()
    await click('.drawer [data-action="closeDrawer"]')
    await click('[data-action="newWords"]'); await click('[data-action="confirmWords"]')
    await click('[data-action="createBunker"]'); await idle()
    await click('.nav [data-action="account"]')
    const bunker = new PublicKey(await text('#bunker-address'))
    await type('deposit', '5000'); await click('[data-action="deposit"]'); await idle()
    await click('.drawer [data-action="closeDrawer"]')

    // BTC: buy 0.1 at market through the page, then the keeper matches it against the maker
    await click(`[data-action="market"][data-arg="${BTC}"]`)
    await page.waitForFunction(() => document.querySelector('.t-stat.big span')?.textContent?.startsWith('BTC'))
    await type('size', '0.1')
    await click('[data-action="order"]'); await idle()
    const user = (await V.getUser(conn, bunker))!
    const order = V.openOrders(user).find((o) => o.marketIndex === BTC)
    if (!order) throw new Error('the order is not on the book')
    const remaining = await V.remainingAccounts(conn, user, { writablePerp: [BTC] })
    for (const k of [V.userPda(maker.publicKey), V.userStatsPda(maker.publicKey)]) remaining.push({ pubkey: k, isSigner: false, isWritable: true })
    await send([V.fillPerpOrderIx({ filler: keeper.publicKey, user: V.userPda(bunker), userStats: V.userStatsPda(bunker), orderId: order.orderId, remaining })], [keeper], 1_000_000)
    // a resting bid below the market too, so the chart shows an order line
    await type('size', '0.05'); await click('[data-action="type"][data-arg="limit"]')
    await type('limit', (Number(price) / 1e6 * 0.97).toFixed(1))
    await click('[data-action="order"]'); await idle()

    await page.waitForFunction(() => document.querySelector('#pos-size')?.textContent?.startsWith('Long'), { timeout: 30_000 })
    await page.waitForFunction(() => !!document.querySelector('#chart-slot canvas'), { timeout: 30_000 })
    await new Promise((r) => setTimeout(r, 2500))   // candles in, lines drawn
    await page.screenshot({ path: OUT, clip: { x: 0, y: 68, width: 1600, height: 892 } })
    console.log(`saved ${OUT} · BTC at ${Number(price) / 1e6}`)
  } finally {
    await browser.close()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
