// The same vectors as programs/hashliquid/src/{wots,lib}.rs: both halves must agree byte for byte.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import * as H from '../src/index.ts'

const M = new Uint8Array(32).fill(7), S = new Uint8Array(32).fill(9), A = new Uint8Array(32).fill(6)
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n))
const sampleAccounts = [{ pubkey: key(1), flags: 0 }, { pubkey: key(2), flags: H.FLAG.WRITABLE }, { pubkey: key(3), flags: H.FLAG.SIGNER }]
const sampleAction = () => H.actionHash(H.V.VELOCITY_PROGRAM_ID, Uint8Array.of(9, 8, 7, 6, 5), sampleAccounts)

test('WOTS vectors match the Rust half (unchanged from Shelter / BUNKERPAD)', () => {
  const ps = H.pubSeed(A, S, 3)
  assert.equal(H.hex(ps), 'c5719eed840528d62b474e1e1610395fad60ef1f2ae0702bee76f592bb20502a')
  const kh = H.publicKeyHash(M, A, S, 3)
  assert.equal(H.hex(kh), '60c7d39670f4c52ddc53666c22de57cd5b1f26a6f3ca67b0f19b7b19fd90ca22')
  const dg = H.unhex('7cfc963eb0c04282a272d64044f74da3d9894a7bf82f47ed32c8c44b')
  const sig = H.sign(M, A, S, 3, dg)
  assert.equal(sig.length, 840)
  assert.equal(H.hex(sig.subarray(0, 28)), '37f1d79a91ea323841ddb0b764b7592849bc72a457dc5be9aa72546e')
  assert.equal(H.hex(sig.subarray(29 * 28)), '81f245dd4b1032fc812b68e20daa2a79240614471d9c04b417f54ab4')
  assert.ok(H.eq(H.recoverKeyHash(ps, dg, sig), kh))
})

test('action hash, message digest and bunker id match the Rust half', () => {
  assert.equal(H.hex(sampleAction()), '324365531a3396ea16c0c518abd5094b3ff151c0f752066feaf12e2a2f541806')
  assert.equal(H.hex(H.messageDigest(key(1), key(2), 3n, sampleAction(), new Uint8Array(32).fill(5), 42)), '4bd8d111fe6d40b700ed89b74e62bfebc32e76dac38ca6d8160f9a55')
  assert.equal(H.hex(H.bunkerId(new Uint8Array(32).fill(9), new Uint8Array(32).fill(5))), 'efc0019078245633355452f02df540bb30518b9a1531c1d72da4623b67b44a5e')
})

test('an action is its data and its accounts, to the byte', () => {
  const h = H.hex(sampleAction())
  const other = (data: number[], accounts = sampleAccounts) => H.hex(H.actionHash(H.V.VELOCITY_PROGRAM_ID, Uint8Array.from(data), accounts))
  assert.notEqual(other([9, 8, 7, 6, 4]), h)
  assert.notEqual(other([9, 8, 7, 6, 5], [sampleAccounts[0], { pubkey: key(2), flags: 0 }, sampleAccounts[2]]), h, 'a flag')
  assert.notEqual(other([9, 8, 7, 6, 5], [sampleAccounts[1], sampleAccounts[0], sampleAccounts[2]]), h, 'the order')
  assert.notEqual(other([9, 8, 7, 6, 5], sampleAccounts.slice(0, 2)), h, 'one account fewer')
  assert.notEqual(H.hex(H.actionHash(H.PROGRAM_ID, Uint8Array.of(9, 8, 7, 6, 5), sampleAccounts)), h, 'another program')
})

test('a bunker\'s keys: one line per bunker, scoped per network, signing verifies only what was signed', () => {
  const k = H.bunkerKeys(M, 'mainnet')
  assert.ok(H.eq(k.id, H.bunkerId(k.seed, k.keyHash)))
  assert.equal(k.address.toBase58(), H.bunkerPda(k.id).toBase58())
  assert.notEqual(H.bunkerKeys(M, 'devnet').address.toBase58(), k.address.toBase58())
  assert.notEqual(H.bunkerKeys(M, 'mainnet', 1).address.toBase58(), k.address.toBase58())

  const action = sampleAction()
  const next = H.bunkerKeyHash(M, k.seed, 1)
  const { salt, digest, cost } = H.grindSalt(H.PROGRAM_ID, k.address, 0n, action, next)
  assert.ok(cost <= 3600, `cost ${cost}`)
  const sig = H.sign(M, H.ZERO32, k.seed, 0, digest)
  const ps = H.pubSeed(H.ZERO32, k.seed, 0)
  assert.ok(H.eq(H.recoverKeyHash(ps, digest, sig), k.keyHash))
  // another action, another bunker, another key number, a flipped byte
  assert.ok(!H.eq(H.recoverKeyHash(ps, H.messageDigest(H.PROGRAM_ID, k.address, 0n, new Uint8Array(32).fill(1), next, salt), sig), k.keyHash))
  assert.ok(!H.eq(H.recoverKeyHash(ps, H.messageDigest(H.PROGRAM_ID, key(8), 0n, action, next, salt), sig), k.keyHash))
  assert.ok(!H.eq(H.recoverKeyHash(H.pubSeed(H.ZERO32, k.seed, 1), digest, sig), k.keyHash))
  const bad = Uint8Array.from(sig); bad[100] ^= 1
  assert.ok(!H.eq(H.recoverKeyHash(ps, digest, bad), k.keyHash))
})

test('the ledger lets a key sign one message, ever', () => {
  const k = H.bunkerKeys(M, 'localnet')
  const bunker: H.Bunker = { id: k.id, seed: k.seed, keyHash: k.keyHash, nonce: 0n, pending: H.ZERO32, pendingNonce: 0n, openedAt: 1n, bump: 255 }
  const ctx: H.SignContext = { master: M, network: 'localnet', bunkerKey: k.address, bunker, ledger: new H.SignedLedger() }
  const a = H.signActionHash(ctx, sampleAction())
  assert.deepEqual(H.signActionHash(ctx, sampleAction()).sig, a.sig, 'the same request gives the same bytes')
  assert.throws(() => H.signActionHash(ctx, new Uint8Array(32).fill(1)), (e: any) => e.code === 'KEY_ALREADY_USED')
  // other words, or the wrong network, are refused before anything is signed
  assert.throws(() => H.signActionHash({ ...ctx, master: new Uint8Array(32).fill(1), ledger: new H.SignedLedger() }, sampleAction()), /not this bunker/)
  assert.throws(() => H.signActionHash({ ...ctx, network: 'mainnet', ledger: new H.SignedLedger() }, sampleAction()), /not this bunker/)
  // a bunker that has moved on to key 1 isn't signed for with key 0
  const moved = { ...bunker, nonce: 1n }
  assert.throws(() => H.signActionHash({ ...ctx, bunker: moved, ledger: new H.SignedLedger() }, sampleAction()), /current key/)
})

test('the checksum stops a signature from being walked forward to another message', () => {
  const d = H.digits(new Uint8Array(28).fill(100))
  const up = new Uint8Array(28).fill(100); up[0] = 101
  const u = H.digits(up)
  assert.ok(u[0] > d[0])
  assert.ok(((u[28] << 8) | u[29]) < ((d[28] << 8) | d[29]))
})
