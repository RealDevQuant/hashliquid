// Drives the real web page in headless Chrome against the local validator that runs the copied exchange:
// test wallet → 24 words → bunker → deposit → an order signed with key #0 → its cancellation signed with key #1 →
// a withdrawal signed with key #2. Then checks the chain. Localnet only.
// Needs Chrome and puppeteer-core (PUPPETEER=/path/to/node_modules/puppeteer-core).
//
//   scripts/localnet.sh                                   (repo root)
//   cd web && VITE_RPC_URL=http://127.0.0.1:8899 npm run dev
//   cd client && npm run test:ui                          (BASE=http://localhost:5183, SHOTS=dir for screenshots)
// With HERO=web/public/app.png it also saves the picture the landing page shows: the real trade panel, with a real order.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Connection, PublicKey } from '@solana/web3.js'
import * as H from '../src/index.ts'

const V = H.V
const RPC = process.env.RPC || 'http://127.0.0.1:8899'
const BASE = process.env.BASE || 'http://localhost:5183'
const SHOTS = process.env.SHOTS
const HERO = process.env.HERO
/** Every element on the page that shows text, by the font it is rendered in. */
const fontsInUse = () => {
  const seen = new Set<string>()
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    if (!el.offsetParent || !el.textContent?.trim()) continue
    seen.add(getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim())
  }
  return [...seen]
}
// the two typefaces of the site: the sans everywhere, the serif only for the one italic word
const FONTS = ['Inter Variable', 'Geist Mono Variable']
const fontsOk = (fonts: string[], why: string) => assert.ok(fonts.includes(FONTS[0]) && fonts.every((f) => FONTS.includes(f)), `${why}: ${fonts.join(', ')}`)
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PUPPETEER = process.env.PUPPETEER || 'puppeteer-core'   // a path to a puppeteer-core install, when it is not in node_modules
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('localnet only')
const missing = !existsSync(PUPPETEER) ? 'puppeteer-core not found' : !existsSync(CHROME) ? 'Chrome not found' : false
const conn = new Connection(RPC, 'confirmed')

test('a bunker from the page: deposit, order, cancel, withdraw', { skip: missing, timeout: 240_000 }, async () => {
  const puppeteer = createRequire(import.meta.url)(PUPPETEER)
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
    page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
    const shot = async (name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }) }
    const click = async (sel: string) => { await page.waitForSelector(`${sel}:not([disabled])`, { timeout: 60_000 }); await page.click(sel) }
    const idle = () => page.waitForFunction(() => document.getElementById('busy')?.textContent === '', { timeout: 120_000 })
    const type = async (field: string, value: string) => {
      const sel = `input[data-field="${field}"]`
      await page.waitForSelector(sel)
      await page.$eval(sel, (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, value)
    }
    const text = (sel: string) => page.$eval(sel, (e: Element) => (e.textContent ?? '').trim())
    const lastLog = () => page.evaluate(() => { const l = document.querySelector('#log div'); return l ? `${l.className}: ${l.textContent}` : '(no log shown)' })
    const drawer = async () => { await click('.nav [data-action="account"]'); await page.waitForSelector('.drawer') }
    const closeDrawer = async () => { await click('.drawer [data-action="closeDrawer"]'); await page.waitForFunction(() => !document.querySelector('.drawer')) }

    await page.goto(`${BASE}/app.html`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.gate', { timeout: 30_000 })
    assert.equal(await page.$('.pill'), null, 'no network badge in the header')
    assert.equal(await page.$('#oracle'), null, 'no market panel before a wallet')
    await shot('1-gate')

    // the way in: a wallet created in the browser, funded with the drawer's button (the dev server's faucet)
    await click('[data-action="browserWallet"]')
    await page.waitForSelector('.term', { timeout: 30_000 })
    await page.waitForSelector('#oracle', { timeout: 30_000 })
    assert.match(await text('#oracle'), /^[\d,]+\.\d+$/, 'the oracle price of the copied market')
    assert.ok((await page.$$('.t-market')).length >= 1, 'markets listed')
    await drawer()
    const wallet = new PublicKey(await text('#wallet-address'))
    await click('[data-action="fund"]')
    await idle()
    assert.equal(await text('#wallet-tokens'), '10,000.00', await lastLog())
    assert.ok((await conn.getBalance(wallet)) > 4_000_000_000, 'SOL for fees')
    await closeDrawer()

    // 24 words, generated in the page: they are the bunker
    await click('[data-action="newWords"]')
    await page.waitForSelector('.words li')
    assert.equal((await page.$$('.words li')).length, 24)
    await click('[data-action="confirmWords"]')
    await click('[data-action="createBunker"]')
    await idle()
    await page.waitForSelector('#collateral', { timeout: 30_000 }).catch(async () => assert.fail(await lastLog()))
    await drawer()
    const bunker = new PublicKey(await text('#bunker-address'))
    assert.equal((await V.getUser(conn, bunker))!.authority.toBase58(), bunker.toBase58(), 'the exchange account belongs to the bunker')
    await type('deposit', '500')
    await click('[data-action="depositUsdt"]')
    await idle()
    await closeDrawer()
    assert.equal(await text('#collateral'), '500.00 USDT', await lastLog())
    fontsOk(await page.evaluate(fontsInUse), 'the two typefaces, nothing else, on the whole page')
    assert.ok(await page.$eval('.nav .brand img', (img: HTMLImageElement) => img.complete && img.naturalWidth > 0), 'the logo shows in the app header')

    // buy 1 SOL-PERP: signed with key #0. Nobody is selling on this validator, so it rests. (BTC is the first market shown: pick SOL.)
    await click('[data-action="market"][data-arg="0"]'); await idle()
    await click('[data-action="sizeMode"][data-arg="base"]'); await idle()   // the test counts in SOL, the page counts in dollars by default
    await type('size', '1')
    await shot('2-ready')
    await click('[data-action="order"]')
    await idle()
    await click('[data-action="tab"][data-arg="orders"]')
    await page.waitForSelector('tr.order', { timeout: 30_000 }).catch(async () => assert.fail(await lastLog()))
    let user = (await V.getUser(conn, bunker))!
    assert.equal(V.openOrders(user).length, 1)
    assert.equal(V.openOrders(user)[0].baseAssetAmount, V.BASE_PRECISION)
    assert.equal((await H.getBunker(conn, bunker))!.nonce, 1n, 'key #0 signed the order; the bunker answers to key #1')
    await shot('3-order')
    if (HERO) {
      // the terminal as it really is at this moment, the chart included
      await page.waitForFunction(() => !!document.querySelector('#chart-slot canvas'), { timeout: 30_000 }).catch(() => {})
      await page.screenshot({ path: HERO, clip: { x: 0, y: 68, width: 1440, height: 832 } })
    }

    // cancel it: key #1
    await click('tr.order [data-action="cancel"]')
    await idle()
    await page.waitForFunction(() => !document.querySelector('tr.order'), { timeout: 30_000 }).catch(async () => assert.fail(await lastLog()))
    user = (await V.getUser(conn, bunker))!
    assert.equal(V.openOrders(user).length, 0)

    // take 200 back to the wallet: key #2
    await drawer()
    await type('withdraw', '200')
    await click('[data-action="withdraw"]')
    await idle()
    assert.equal(await text('#wallet-tokens'), '9,700.00', await lastLog())
    await closeDrawer()
    assert.equal(await text('#collateral'), '300.00 USDT')
    assert.equal((await H.getBunker(conn, bunker))!.nonce, 3n)
    await shot('4-withdrawn')

    // hire Ash One: key #3 names the agent's key as the account's trading delegate; then fire it with key #4
    await click('[data-action="hire"][data-arg="ash1"]')
    await idle()
    await page.waitForSelector('#hired-name', { timeout: 30_000 }).catch(async () => assert.fail(await lastLog()))
    assert.equal(await text('#hired-name'), 'Ash One')
    assert.equal((await V.getUser(conn, bunker))!.delegate.toBase58(), 'HfW4gexkK6B3ko8jusAMKtbDce4255dwDNSBMcFwioY9', 'the delegate on chain is the agent\'s key')
    assert.equal((await H.getBunker(conn, bunker))!.nonce, 4n)
    await shot('4b-hired')
    await click('[data-action="fire"]')
    await idle()
    await page.waitForSelector('[data-action="hire"]', { timeout: 30_000 }).catch(async () => assert.fail(await lastLog()))
    assert.ok((await V.getUser(conn, bunker))!.delegate.equals(PublicKey.default), 'fired: no delegate')
    assert.equal((await H.getBunker(conn, bunker))!.nonce, 5n)

    // the same page on a phone (the viewport change reloads it: wallet and words come back by themselves)
    await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 })
    await page.waitForSelector('[data-action="order"]:not([disabled])', { timeout: 30_000 })
    await shot('5-phone')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px on a phone`)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('the landing page: one typeface, nothing overflowing, and it leads to the app', { skip: missing, timeout: 120_000 }, async () => {
  const puppeteer = createRequire(import.meta.url)(PUPPETEER)
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
    await page.goto(`${BASE}/?intro=0`, { waitUntil: 'networkidle0' })
    await page.evaluate(() => document.fonts.ready)
    assert.equal(await page.$eval('h1', (e: Element) => e.textContent?.trim()), 'Trade perps from a wallet no private key can move')
    assert.match(await page.$eval('.l-meet-h', (e: Element) => e.textContent?.trim() ?? ''), /^Three traders\. Three bunkers\./)
    fontsOk(await page.evaluate(fontsInUse), 'the two typefaces, nothing else, on the whole page')
    // the logo is in the header and in the footer, and the site has its icons
    const logos: boolean[] = await page.$$eval('.brand img', (imgs: HTMLImageElement[]) => imgs.map((img) => img.complete && img.naturalWidth > 0))
    assert.ok(logos.length >= 2 && logos.every(Boolean), `the logo loads wherever it appears (${logos.length} places)`)
    for (const href of await page.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"]', (ls: HTMLLinkElement[]) => ls.map((l) => l.href))) {
      assert.equal((await fetch(href)).status, 200, `site icon ${href}`)
    }
    // the picture in the hero is there and is a real file
    assert.ok(await page.$eval('.l-shot > img', (img: HTMLImageElement) => img.complete && img.naturalWidth > 0), 'hero picture loads')
    const hedges = /unaudited|audit|experimental|fake|beta\b|not yet|no reset|nobody to call|velocity/i
    assert.ok(!hedges.test(await page.evaluate(() => document.body.innerText)), 'the landing makes no hedges')
    // outside links stay hidden until their addresses are set
    const hiddenLinks = await page.$$eval('a[data-link]', (as: HTMLAnchorElement[]) => as.map((a) => a.hidden || !!a.href))
    assert.ok(hiddenLinks.every(Boolean))
    assert.deepEqual(await page.$$eval('.nav-links a:not([hidden])', (as: HTMLAnchorElement[]) => as.map((a) => a.textContent?.trim())), ['Why', 'How it works', 'Agents', 'Docs'])
    // every in-page link points at a section that exists
    const dangling = await page.$$eval('a[href^="#"]', (as: HTMLAnchorElement[]) => as.map((a) => a.getAttribute('href')!).filter((h) => !document.querySelector(h)))
    assert.deepEqual(dangling, [])
    const text: string = await page.evaluate(() => document.body.innerText)
    assert.ok(!/velocity/i.test(text), 'the exchange is not named')
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/landing-desktop.png`, fullPage: true })
    // the wide sections fill the page: their frame spans the viewport minus the gutters, not a fixed 1120px
    const wide = await page.$eval('.n6-wrap', (e: Element) => e.getBoundingClientRect().width)
    assert.ok(wide > 1100, `the content column spans ${wide}px of 1440`)

    // the docs page: same font, every section linked from its table of contents, the exchange not named
    await page.goto(`${BASE}/docs.html`, { waitUntil: 'networkidle0' })
    await page.evaluate(() => document.fonts.ready)
    assert.equal(await page.$eval('h1', (e: Element) => e.textContent?.trim()), 'HashLiquid')
    fontsOk(await page.evaluate(fontsInUse), 'the two typefaces, nothing else, on the docs')
    const toc = await page.$$eval('.docs-toc a', (as: HTMLAnchorElement[]) => as.map((a) => a.getAttribute('href')!).filter((h) => !document.querySelector(h)))
    assert.deepEqual(toc, [], 'every docs link has its section')
    const docsText: string = await page.evaluate(() => document.body.innerText)
    assert.ok(!hedges.test(docsText), 'the docs make no hedges')
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/docs-desktop.png`, fullPage: true })

    for (const width of [390, 768]) {
      await page.setViewport({ width, height: 844, isMobile: width < 500, deviceScaleFactor: 1 })
      for (const path of ['/?intro=0', '/docs.html']) {
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle0' })
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        assert.ok(overflow <= 0, `${path} scrolls sideways by ${overflow}px at ${width}px`)
      }
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/landing-${width}.png`, fullPage: true })
    }

    // the call to action opens the app
    await page.setViewport({ width: 1280, height: 900 })
    await page.goto(`${BASE}/?intro=0`, { waitUntil: 'networkidle0' })
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('.l-hero .n6-cta .btn:not(.ghost)')])
    assert.ok(page.url().endsWith('/app.html'))
    await page.waitForSelector('.gate', { timeout: 30_000 })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('deploy: create your own agent from the page, in four steps', { skip: missing, timeout: 180_000 }, async () => {
  const puppeteer = createRequire(import.meta.url)(PUPPETEER)
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 1000, deviceScaleFactor: 2 })
    const errors: string[] = []
    page.on('pageerror', (e: Error) => errors.push(String(e)))
    const click = async (sel: string) => { await page.waitForSelector(`${sel}:not([disabled])`, { timeout: 30_000 }); await page.click(sel) }
    const idle = () => page.waitForFunction(() => document.getElementById('busy')?.textContent === '', { timeout: 120_000 })
    const type = (field: string, value: string) => page.$eval(`input[data-field="${field}"]`, (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, value)
    const text = (sel: string) => page.$eval(sel, (e: Element) => (e.textContent ?? '').trim())
    const shot = (name: string) => SHOTS ? page.screenshot({ path: `${SHOTS}/deploy-${name}.png`, fullPage: true }) : Promise.resolve()

    await page.goto(`${BASE}/deploy.html?create=1`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('.deploy', { timeout: 30_000 })
    assert.equal(await page.$('#chart-slot'), null, 'no chart on the deploy page')
    await click('[data-action="browserWallet"]')
    await page.waitForSelector('[data-action="fund"]', { timeout: 30_000 })
    await click('[data-action="fund"]'); await idle()
    await click('[data-action="newWords"]'); await click('[data-action="confirmWords"]')
    await page.waitForSelector('[data-action="pick"][data-arg="custom"]', { timeout: 30_000 })
    await shot('1-choose')
    await click('[data-action="pick"][data-arg="custom"]')
    await type('agentName', "Bob's bot")
    // the fourth strategy opens the prompt box; a look at it, then back to the second
    await click('[data-action="base"][data-arg="4"]')
    await page.waitForSelector('textarea[data-field="prompt"]', { timeout: 10_000 })
    await page.type('textarea[data-field="prompt"]', 'Trade SOL only. Long on a 1h close above the 4h EMA20 with rising volume, short the mirror image. Stop under the last swing, take profit at 2R, never add to a loser.')
    assert.match(await text('.dp-prompt .count'), /^1[0-9]{2}\/1500/)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/deploy-2b-prompt.png`, fullPage: true })
    await click('[data-action="base"][data-arg="2"]')
    await click('[data-action="aggr"][data-arg="2"]')
    await type('fund', '120')
    await shot('2-filled')
    await click('[data-action="deployGo"]'); await idle()
    await page.waitForSelector('.dp-done', { timeout: 60_000 }).catch(async () => assert.fail(await text('.gate-err, .dim.small')))
    assert.match(await text('.dp-done h1'), /Bob's bot is live/)
    await shot('3-done')
    // on chain: the account is named after the agent and its delegate is the custom agents' key
    const words = await page.evaluate(() => sessionStorage.getItem('hashliquid:words:localnet'))
    const bunker = H.bunkerKeys(H.wordsToMaster(words!), 'localnet').address
    const u = (await V.getUser(conn, bunker))!
    assert.deepEqual(H.decodeAgentName(u.name), { kind: 'custom', base: 2, aggr: 2, label: "Bob's bot" })
    assert.equal(u.delegate.toBase58(), 'AWbgyQC5W872ii5Vwegc8Y7rMpSVPwgWRe1yPpQittPy')
    const held = Number(V.tokenAmount(u, (await V.getSpotMarket(conn, V.QUOTE_SPOT_MARKET))!)) / 1e6
    assert.ok(held > 119.9 && held < 120.1, `120 USDT deposited, holds ${held}`)
    assert.equal((await H.getBunker(conn, bunker))!.nonce, 1n, 'one key: switching the agent on (the name was free, at creation)')
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
