// The client is driven by two IDLs. These checks fail when our copy is stale, or when the exchange's IDL stops
// having what we rely on (Velocity changes often: re-copy idl/velocity.json from its SDK and run this).
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import * as H from '../src/index.ts'

const V = H.V
const built = new URL('../../target/idl/hashliquid.json', import.meta.url)
const k = () => Keypair.generate().publicKey

test('idl/hashliquid.json is the IDL of the current build', { skip: !existsSync(built) && 'no build' }, () => {
  assert.deepEqual(H.hashliquid.idl, JSON.parse(readFileSync(built, 'utf8')))
})

test('every instruction of our program builds with the accounts and flags it declares', () => {
  const keys = H.bunkerKeys(new Uint8Array(32).fill(7), 'localnet')
  const [bunker, wallet, mint] = [keys.address, k(), k()]
  const signed = { sig: new Uint8Array(H.SIG_LEN), nextKeyHash: new Uint8Array(32), salt: 0, action: new Uint8Array(32) }
  const built: Record<string, ReturnType<typeof H.openIx>> = {
    open: H.openIx({ payer: wallet, keys }),
    init_trading: H.initTradingIx({ bunker, payer: wallet }),
    deposit: H.depositIx({ bunker, marketIndex: 0, amount: 1n, mint, remaining: [] }),
    authorize: H.authorizeIx({ bunker, signed }),
    execute: H.executeIx({ bunker, action: { data: Uint8Array.of(1), accounts: [] } }),
  }
  assert.deepEqual(Object.keys(built).sort(), H.hashliquid.idl.instructions.map((i) => i.name).sort(), 'one builder per instruction')
  for (const ix of H.hashliquid.idl.instructions) {
    const b = built[ix.name]
    ix.accounts.forEach((a, i) => {
      assert.equal(b.keys[i].isSigner, !!a.signer, `${ix.name}.${a.name} signer`)
      assert.equal(b.keys[i].isWritable, !!a.writable, `${ix.name}.${a.name} writable`)
    })
    assert.deepEqual(Array.from(b.data.subarray(0, 8)), ix.discriminator, ix.name)
  }
  // the two instructions a one-time key drives ask for no wallet signature at all
  for (const name of ['authorize', 'execute']) assert.equal(H.hashliquid.instruction(name).accounts.some((a) => a.signer), false, name)
})

test('the exchange discriminators hard-coded in the program are the ones in its IDL', () => {
  const src = readFileSync(new URL('../../programs/hashliquid/src/lib.rs', import.meta.url), 'utf8')
  for (const [constant, name] of [['INITIALIZE_USER_STATS', 'initialize_user_stats'], ['INITIALIZE_USER', 'initialize_user'], ['DEPOSIT', 'deposit']]) {
    const m = new RegExp(`pub const ${constant}: \\[u8; 8\\] = \\[([^\\]]+)\\]`).exec(src)
    assert.ok(m, constant)
    assert.deepEqual(m[1].split(',').map((x) => Number(x.trim())), V.velocity.instruction(name).discriminator, name)
  }
  assert.ok(src.includes(`pubkey!("${V.VELOCITY_PROGRAM_ID.toBase58()}")`), 'the exchange program id')
})

test('the exchange instructions we send have the shape we assume', () => {
  const shape = (name: string) => V.velocity.instruction(name).accounts.map((a) => `${a.name}${a.writable ? ':w' : ''}${a.signer ? ':s' : ''}`).join(' ')
  // creating an account: the authority is named, only the payer signs at the top level
  assert.equal(shape('initialize_user'), 'user:w user_stats:w state:w authority payer:w:s rent system_program')
  assert.equal(shape('initialize_user_stats'), 'user_stats:w state:w authority payer:w:s rent system_program')
  assert.equal(shape('deposit'), 'state user:w user_stats:w authority:s spot_market_vault:w user_token_account:w token_program')
  assert.equal(shape('withdraw'), 'state user:w user_stats:w authority:s spot_market_vault:w velocity_signer user_token_account:w token_program')
  assert.equal(shape('place_perp_order'), 'state user:w authority:s')
  assert.equal(shape('cancel_order'), 'state user:w authority:s')
  assert.equal(shape('update_user_delegate'), 'user:w authority:s')
})

test('a wrapped exchange instruction names the bunker as its only program-signed account', () => {
  const bunker = H.bunkerKeys(new Uint8Array(32).fill(7), 'localnet').address
  const ix = V.placePerpOrderIx({ authority: bunker, params: V.perpOrder({ marketIndex: 0, direction: V.DIRECTION.LONG, baseAssetAmount: 1n }), remaining: [{ pubkey: k(), isSigner: false, isWritable: false }] })
  const action = H.actionOf(ix)
  assert.deepEqual(action.accounts.map((a) => a.flags), [0, H.FLAG.WRITABLE, H.FLAG.SIGNER, 0])
  const exec = H.executeIx({ bunker, action })
  // in the transaction nobody signs for the bunker: the program does
  assert.equal(exec.keys.filter((x) => x.isSigner).length, 0)
  assert.equal(exec.keys[0].pubkey.toBase58(), bunker.toBase58())
  assert.equal(exec.keys[1].pubkey.toBase58(), V.VELOCITY_PROGRAM_ID.toBase58())
  // an instruction to any other program is not an action
  assert.throws(() => H.actionOf({ ...ix, programId: PublicKey.default } as typeof ix), /only calls the exchange/)
  // nor is one the bunker doesn't sign
  const notOurs = V.placePerpOrderIx({ authority: k(), params: V.perpOrder({ marketIndex: 0, direction: 0, baseAssetAmount: 1n }), remaining: [] })
  const ctx = { master: new Uint8Array(32).fill(7), network: 'localnet' as const, bunkerKey: bunker, bunker: {} as H.Bunker, ledger: new H.SignedLedger() }
  assert.throws(() => H.prepareAction(ctx, notOurs), /not signed by the bunker/)
})

test('order parameters encode as the exchange expects', () => {
  const data = V.velocity.encodeInstruction('place_perp_order', { params: V.perpOrder({ marketIndex: 3, direction: V.DIRECTION.SHORT, baseAssetAmount: 5n, price: 7n, orderType: V.ORDER_TYPE.LIMIT, reduceOnly: true }) })
  // 8 discriminator + type, market type, direction, user id + 8 size + 8 price + 2 index + reduce, post, flags + 9 options
  assert.equal(data.length, 8 + 4 + 8 + 8 + 2 + 3 + 3 + 1 + 5)
  assert.deepEqual(Array.from(data.subarray(8, 12)), [V.ORDER_TYPE.LIMIT, V.MARKET_TYPE.PERP, V.DIRECTION.SHORT, 0])
  assert.equal(data[8 + 4 + 16], 3, 'market index')
  assert.equal(data[8 + 4 + 16 + 2], 1, 'reduce only')
})
