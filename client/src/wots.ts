/*
  Ported from Shelter (github.com/sheltercash/shelter, MIT License, Copyright (c) 2026 Shelter) by way of BUNKERPAD.
  Only changes: types, and the key-label domain is "hashliquid:v1:" so the same words never derive Shelter's or
  BUNKERPAD's keys.

  wots.ts — the client half of programs/hashliquid/src/wots.rs, byte for byte. Runs in Node and the
  browser (only @noble/hashes). Winternitz one-time signatures, w = 256, SHA-256 truncated to 28 bytes,
  30 chains (28 message digits + 2 checksum digits), 840-byte signatures. This is NOT RFC 8554 LM-OTS (see wots.rs).

  Keys come from one 32-byte master secret (shown to the user as 24 words):
    seed              = H(4 ‖ master ‖ "hashliquid:v1:" ‖ network ‖ ":" ‖ label)    label = "bunker:<index>"
    anchor            = 32 zero bytes (a bunker's address already commits to its seed and first key)
    sk(nonce, i)      = H(3 ‖ master ‖ anchor ‖ seed ‖ nonce ‖ i)[..28]
    pub_seed(nonce)   = H(2 ‖ anchor ‖ seed ‖ nonce)
    key_hash(nonce)   = H(1 ‖ pub_seed ‖ top_0 ‖ … ‖ top_29)     top_i = chain i walked from sk to step 255
  Every signature names the hash of the next key, so one backup covers every rotation forever.

  ONE KEY, ONE MESSAGE. Two different messages signed with the same key number make forgery cheap. Callers
  must remember what they signed per (bunker, key number) and only ever resend those exact bytes (see
  SignedLedger in bunker.ts).
*/
import { sha256 } from '@noble/hashes/sha2'

export type Bytes = Uint8Array

export const N = 28, L1 = 28, L2 = 2, L = 30, MAX_STEP = 255, SIG_LEN = L * N
export const TAG = Object.freeze({ CHAIN: 0x00, KEY: 0x01, SEED: 0x02, SECRET: 0x03, LABEL: 0x04, MSG: 0x05 })
export const ZERO32: Bytes = new Uint8Array(32)

const u8 = (x: Bytes | number[]): Bytes => (x instanceof Uint8Array ? x : Uint8Array.from(x))
export function cat(...parts: Bytes[]): Bytes {
  const n = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
export const H = (...parts: (Bytes | number[])[]): Bytes => sha256(cat(...parts.map(u8)))
export const utf8 = (s: string): Bytes => new TextEncoder().encode(s)
export const le64 = (v: bigint | number): Bytes => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b }
export const le32 = (v: bigint | number): Bytes => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(v) >>> 0, true); return b }
export const le16 = (v: number): Bytes => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b }
export const hex = (b: Bytes): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const unhex = (s: string): Bytes => Uint8Array.from((s.match(/../g) ?? []).map((x) => parseInt(x, 16)))
export const eq = (a: Bytes, b: Bytes): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/* ---------------- keys ---------------- */

/** The public seed stored in a bunker. Scoped per cluster: the same words give other keys on devnet. */
export const labelSeed = (master: Bytes, network: string, label: string): Bytes =>
  H([TAG.LABEL], master, utf8(`hashliquid:v1:${network}:`), utf8(label))

export const pubSeed = (anchor: Bytes, seed: Bytes, nonce: bigint | number): Bytes => H([TAG.SEED], anchor, seed, le64(nonce))
const secret = (master: Bytes, anchor: Bytes, seed: Bytes, nonce: bigint | number, i: number): Bytes =>
  H([TAG.SECRET], master, anchor, seed, le64(nonce), [i]).subarray(0, N)

// one chain step: F(pub_seed, chain, step, x)
function step(ps: Bytes, chain: number, at: number, x: Bytes): Bytes {
  const buf = new Uint8Array(1 + 32 + 2 + N)
  buf[0] = TAG.CHAIN; buf.set(ps, 1); buf[33] = chain; buf[34] = at; buf.set(x, 35)
  return sha256(buf).subarray(0, N)
}
function walk(ps: Bytes, chain: number, from: number, to: number, x: Bytes): Bytes {
  let v = x
  for (let at = from; at < to; at++) v = step(ps, chain, at, v)
  return Uint8Array.from(v)
}

export function keyHashFromTops(ps: Bytes, tops: Bytes[]): Bytes { return H([TAG.KEY], ps, ...tops) }

/** The key hash for key number `nonce` of the key line with this anchor + seed. */
export function publicKeyHash(master: Bytes, anchor: Bytes, seed: Bytes, nonce: bigint | number): Bytes {
  const ps = pubSeed(anchor, seed, nonce)
  const tops: Bytes[] = []
  for (let i = 0; i < L; i++) tops.push(walk(ps, i, 0, MAX_STEP, secret(master, anchor, seed, nonce, i)))
  return keyHashFromTops(ps, tops)
}

/* ---------------- digits ---------------- */

export function digits(digest: Bytes): Bytes {
  const d = new Uint8Array(L)
  let csum = 0
  for (let i = 0; i < L1; i++) { d[i] = digest[i]; csum += MAX_STEP - digest[i] }
  d[L1] = csum >> 8; d[L1 + 1] = csum & 0xff
  return d
}
/** Hash steps the on-chain verifier walks for this digest. */
export const verifyCost = (digest: Bytes): number => digits(digest).reduce((a, x) => a + (MAX_STEP - x), 0)

/* ---------------- sign / verify ---------------- */

export function sign(master: Bytes, anchor: Bytes, seed: Bytes, nonce: bigint | number, digest: Bytes): Bytes {
  const ps = pubSeed(anchor, seed, nonce)
  const d = digits(digest)
  const out = new Uint8Array(SIG_LEN)
  for (let i = 0; i < L; i++) out.set(walk(ps, i, 0, d[i], secret(master, anchor, seed, nonce, i)), i * N)
  return out
}

export function recoverKeyHash(ps: Bytes, digest: Bytes, sig: Bytes): Bytes {
  const d = digits(digest)
  const tops: Bytes[] = []
  for (let i = 0; i < L; i++) tops.push(walk(ps, i, d[i], MAX_STEP, sig.subarray(i * N, (i + 1) * N)))
  return keyHashFromTops(ps, tops)
}
