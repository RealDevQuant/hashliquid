/*
  bunker.ts — the wallet side: a bunker's address and keys, the ledger of what each key signed, and the
  instructions of the HashLiquid program.

  A bunker is an account of our program that owns a trading account on Velocity. It has no private key: the only
  way to make it act is a one-time hash-based signature (wots.ts) over the exact Velocity instruction to send.
  Acting takes two transactions, because an 840-byte signature doesn't fit next to an instruction's accounts:
    1. authorize(sig, action_hash, next_key_hash, salt) — verifies the signature, retires the key, records the action.
    2. execute(data, flags) + the instruction's accounts — permissionless; the bunker signs exactly that instruction.
  `prepareAction` returns both.

  Key number n signs one action and names key n + 1. All of them come from 24 words (words.ts).
*/
import { Buffer } from 'buffer'
import { sha256 } from '@noble/hashes/sha2'
import { ComputeBudgetProgram, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction, type AccountMeta, type Connection } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import hashliquidIdl from './idl/hashliquid.json' with { type: 'json' }
import { camel, createCodec, type Idl } from './codec.ts'
import { VELOCITY_PROGRAM_ID, nameBytes, spotVaultPda, statePda, userPda, userStatsPda } from './velocity.ts'
import { H, N, TAG, ZERO32, cat, eq, hex, labelSeed, le32, le64, publicKeyHash, sign, unhex, utf8, verifyCost, type Bytes } from './wots.ts'

export const hashliquid = createCodec(hashliquidIdl as unknown as Idl)
export const PROGRAM_ID = new PublicKey(hashliquid.idl.address)

/** Compute limits measured on the real programs (with headroom). One cuIx per transaction, first. */
export const CU = Object.freeze({ AUTHORIZE: 1_400_000, EXECUTE: 600_000, SETUP: 400_000 })
export const cuIx = (units: number): TransactionInstruction => ComputeBudgetProgram.setComputeUnitLimit({ units })
/** A priority fee, in micro-lamports per compute unit. An `authorize` burns ~700k CU: at 10,000 µL/CU that is 0.007 SOL. */
export const priorityFeeIx = (microLamports: number): TransactionInstruction => ComputeBudgetProgram.setComputeUnitPrice({ microLamports })

export const NETWORKS = Object.freeze(['localnet', 'devnet', 'mainnet'] as const)
export type Network = (typeof NETWORKS)[number]
/** Key derivation is scoped per cluster: a missing label could make a devnet signature valid on mainnet. */
const net = (network: Network): Network => { if (!NETWORKS.includes(network)) throw new Error(`network must be one of ${NETWORKS.join(' | ')}`); return network }

/* ---------------- a bunker's address and keys ---------------- */

export const bunkerId = (seed: Bytes, keyHash: Bytes): Bytes => sha256(cat(seed, keyHash))
export const bunkerPda = (id: Bytes, programId = PROGRAM_ID): PublicKey => PublicKey.findProgramAddressSync([utf8('bunker'), id], programId)[0]

/** The public seed of bunker number `index` of these words. */
export const bunkerSeed = (master: Bytes, network: Network, index = 0): Bytes => labelSeed(master, net(network), `bunker:${index}`)
/** Hash of key number `nonce` of a bunker. */
export const bunkerKeyHash = (master: Bytes, seed: Bytes, nonce: bigint | number): Bytes => publicKeyHash(master, ZERO32, seed, nonce)

export interface BunkerKeys { seed: Bytes; keyHash: Bytes; id: Bytes; address: PublicKey }
/** Everything public about bunker `index` of these words: its seed, first key hash, id and address. */
export function bunkerKeys(master: Bytes, network: Network, index = 0, programId = PROGRAM_ID): BunkerKeys {
  const seed = bunkerSeed(master, network, index)
  const keyHash = bunkerKeyHash(master, seed, 0)
  const id = bunkerId(seed, keyHash)
  return { seed, keyHash, id, address: bunkerPda(id, programId) }
}

export interface Bunker { id: Bytes; seed: Bytes; keyHash: Bytes; nonce: bigint; pending: Bytes; pendingNonce: bigint; openedAt: bigint; bump: number }
export const decodeBunker = (data: Bytes) => hashliquid.decodeAccount<Bunker>('Bunker', data)
export async function getBunker(conn: Connection, address: PublicKey): Promise<Bunker | null> {
  const info = await conn.getAccountInfo(address, 'confirmed')
  return info ? decodeBunker(info.data) : null
}
export const hasPending = (b: Bunker): boolean => !eq(b.pending, ZERO32)

/* ---------------- actions: what a key signs ---------------- */

export const FLAG = Object.freeze({ WRITABLE: 1, SIGNER: 2 })

export interface Action { data: Bytes; accounts: { pubkey: PublicKey; flags: number }[]; hash: Bytes }

/** SHA-256("hashliquid:action" ‖ program ‖ len(data) ‖ data ‖ n ‖ (account ‖ flags) × n): programs/hashliquid/src/lib.rs. */
export function actionHash(program: PublicKey, data: Bytes, accounts: { pubkey: PublicKey; flags: number }[]): Bytes {
  return sha256(cat(utf8('hashliquid:action'), program.toBytes(), le32(data.length), data, Uint8Array.of(accounts.length), ...accounts.map((a) => cat(a.pubkey.toBytes(), Uint8Array.of(a.flags)))))
}

/** The action that sends this Velocity instruction, exactly: its bytes and its accounts with their flags. */
export function actionOf(ix: TransactionInstruction): Action {
  if (!ix.programId.equals(VELOCITY_PROGRAM_ID)) throw new Error('a bunker only calls the exchange')
  const accounts = ix.keys.map((k) => ({ pubkey: k.pubkey, flags: (k.isWritable ? FLAG.WRITABLE : 0) | (k.isSigner ? FLAG.SIGNER : 0) }))
  const data = Uint8Array.from(ix.data)
  return { data, accounts, hash: actionHash(VELOCITY_PROGRAM_ID, data, accounts) }
}

/** The 28-byte digest a bunker key signs. */
export function messageDigest(programId: PublicKey, bunker: PublicKey, nonce: bigint, action: Bytes, nextKeyHash: Bytes, salt: number): Bytes {
  return H([TAG.MSG], programId.toBytes(), bunker.toBytes(), le64(nonce), action, nextKeyHash, le32(salt)).subarray(0, N)
}

/** Lowest salt whose verification walks ≤ maxCost hash steps (keeps the on-chain verify well under 1.4M CU). */
export function grindSalt(programId: PublicKey, bunker: PublicKey, nonce: bigint, action: Bytes, nextKeyHash: Bytes, maxCost = 3600): { salt: number; digest: Bytes; cost: number } {
  for (let salt = 0; salt < 1 << 20; salt++) {
    const digest = messageDigest(programId, bunker, nonce, action, nextKeyHash, salt)
    const cost = verifyCost(digest)
    if (cost <= maxCost) return { salt, digest, cost }
  }
  throw new Error('no salt found')
}

/* ---------------- the ledger of what each key signed ---------------- */

export interface LedgerStore { get(k: string): string | null | undefined; set(k: string, v: string): unknown }
export interface SignedRecord { action: string; digest: string; sig: string; nextKeyHash: string; salt: number; data: string; accounts: [string, number][]; note?: string }

/**
 * Remembers what each key number signed. A key may sign ONE message: asked to sign anything else with a key
 * that already signed, it refuses, and the caller must send the first one (authorize always lands when the
 * signature is valid; a later authorize then replaces the action if it is no longer wanted).
 * `store` = { get(k) → string|null, set(k, string) }: localStorage in the browser, a Map in tests. It is per
 * device: on a new device read the chain first (the bunker's nonce) and never sign below it.
 */
export class SignedLedger {
  store: LedgerStore
  constructor(store: LedgerStore = new Map<string, string>()) { this.store = store }
  key(bunker: PublicKey, nonce: bigint): string { return `hashliquid:signed:${bunker.toBase58()}:${nonce}` }
  get(bunker: PublicKey, nonce: bigint): SignedRecord | null {
    const v = this.store.get(this.key(bunker, nonce))
    return v ? JSON.parse(v) : null
  }
  check(bunker: PublicKey, nonce: bigint, digestHex: string): SignedRecord | null {
    const prev = this.get(bunker, nonce)
    if (prev && prev.digest !== digestHex) {
      const e = new Error(`Key #${nonce} already signed a different action. Send that one first (it is the only thing this key may ever sign).`) as Error & { code: string; previous: SignedRecord }
      e.code = 'KEY_ALREADY_USED'; e.previous = prev
      throw e
    }
    return prev
  }
  put(bunker: PublicKey, nonce: bigint, rec: SignedRecord) { this.store.set(this.key(bunker, nonce), JSON.stringify(rec)) }
}

/* ---------------- signing ---------------- */

export interface SignContext {
  /** The 32-byte secret behind the 24 words. */
  master: Bytes
  network: Network
  /** Which bunker of these words. */
  index?: number
  /** The bunker's address and its account as it is on chain right now. */
  bunkerKey: PublicKey
  bunker: Bunker
  ledger: SignedLedger
  programId?: PublicKey
  maxCost?: number
}
export interface Signed { sig: Bytes; nextKeyHash: Bytes; salt: number; nonce: bigint; cost: number; action: Bytes }

/**
 * Signs one action hash with the bunker's current key and names the next. Deterministic: the same request
 * gives the same bytes, so sending it again is always safe. Refuses if the words aren't this bunker's, or if
 * the current key already signed something else.
 */
export function signActionHash(ctx: SignContext, action: Bytes, record: Pick<SignedRecord, 'data' | 'accounts' | 'note'> = { data: '', accounts: [] }): Signed {
  if (!ctx.ledger) throw new Error('signing needs a SignedLedger')
  const programId = ctx.programId ?? PROGRAM_ID
  const seed = bunkerSeed(ctx.master, ctx.network, ctx.index ?? 0)
  if (!eq(seed, ctx.bunker.seed)) throw new Error(`These words are not this bunker's on ${ctx.network}.`)
  const nonce = ctx.bunker.nonce
  if (!eq(bunkerKeyHash(ctx.master, seed, nonce), ctx.bunker.keyHash)) throw new Error("These words do not hold this bunker's current key.")

  const nextKeyHash = bunkerKeyHash(ctx.master, seed, nonce + 1n)
  const { salt, digest, cost } = grindSalt(programId, ctx.bunkerKey, nonce, action, nextKeyHash, ctx.maxCost)
  ctx.ledger.check(ctx.bunkerKey, nonce, hex(digest))
  const sig = sign(ctx.master, ZERO32, seed, nonce, digest)
  ctx.ledger.put(ctx.bunkerKey, nonce, { action: hex(action), digest: hex(digest), sig: hex(sig), nextKeyHash: hex(nextKeyHash), salt, ...record })
  return { sig, nextKeyHash, salt, nonce, cost, action }
}

/* ---------------- instructions ---------------- */

function build(name: string, accounts: Record<string, PublicKey>, args: Record<string, any>, programId: PublicKey, remaining: AccountMeta[] = []): TransactionInstruction {
  const keys = hashliquid.instruction(name).accounts.map((a) => {
    const pubkey = accounts[camel(a.name)]
    if (!pubkey) throw new Error(`${name}: missing account ${camel(a.name)}`)
    return { pubkey, isSigner: !!a.signer, isWritable: !!a.writable }
  })
  return new TransactionInstruction({ programId, keys: [...keys, ...remaining], data: Buffer.from(hashliquid.encodeInstruction(name, args)) })
}

/** Opens the bunker these keys describe. Anyone can pay; opening an open bunker changes nothing. */
export function openIx(p: { payer: PublicKey; keys: BunkerKeys; programId?: PublicKey }) {
  const programId = p.programId ?? PROGRAM_ID
  return build('open', { bunker: bunkerPda(p.keys.id, programId), payer: p.payer, systemProgram: SystemProgram.programId }, { id: p.keys.id, seed: p.keys.seed, keyHash: p.keys.keyHash }, programId)
}

/** Creates the bunker's trading account on Velocity (and its stats account the first time). Anyone can pay. */
export function initTradingIx(p: { bunker: PublicKey; payer: PublicKey; subAccountId?: number; name?: string; nameBytes?: Bytes; programId?: PublicKey }) {
  const sub = p.subAccountId ?? 0
  return build('init_trading', {
    bunker: p.bunker, payer: p.payer, state: statePda(), user: userPda(p.bunker, sub), userStats: userStatsPda(p.bunker),
    venueProgram: VELOCITY_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId,
  }, { subAccountId: sub, name: p.nameBytes ?? nameBytes(p.name ?? 'HashLiquid') }, p.programId ?? PROGRAM_ID)
}

/** The token account a bunker receives a mint in before depositing it (its associated token account). */
export const bunkerTokenAccount = (bunker: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): PublicKey =>
  getAssociatedTokenAddressSync(mint, bunker, true, tokenProgram)

/**
 * Moves tokens the bunker holds into its own trading account. Anyone can send it. `remaining` = Velocity's
 * accounts for a deposit into that market (remainingAccounts(conn, user, { writableSpot: [marketIndex] })).
 */
export function depositIx(p: { bunker: PublicKey; subAccountId?: number; marketIndex: number; amount: bigint; mint: PublicKey; remaining: AccountMeta[]; tokenProgram?: PublicKey; programId?: PublicKey }) {
  const sub = p.subAccountId ?? 0
  const tokenProgram = p.tokenProgram ?? TOKEN_PROGRAM_ID
  return build('deposit', {
    bunker: p.bunker, state: statePda(), user: userPda(p.bunker, sub), userStats: userStatsPda(p.bunker), spotMarketVault: spotVaultPda(p.marketIndex),
    bunkerTokenAccount: bunkerTokenAccount(p.bunker, p.mint, tokenProgram), tokenProgram, venueProgram: VELOCITY_PROGRAM_ID,
  }, { subAccountId: sub, marketIndex: p.marketIndex, amount: p.amount }, p.programId ?? PROGRAM_ID, p.remaining)
}

/** No signer: the one-time signature is the authority, and anyone may pay the fee. */
export function authorizeIx(p: { bunker: PublicKey; signed: Pick<Signed, 'sig' | 'nextKeyHash' | 'salt' | 'action'>; programId?: PublicKey }) {
  return build('authorize', { bunker: p.bunker }, { sig: p.signed.sig, actionHash: p.signed.action, nextKeyHash: p.signed.nextKeyHash, salt: p.signed.salt }, p.programId ?? PROGRAM_ID)
}

/** Sends the pending action. Anyone may: it must be, to the byte, what the bunker's key signed. */
export function executeIx(p: { bunker: PublicKey; action: Pick<Action, 'data' | 'accounts'>; programId?: PublicKey }) {
  // the bunker can't sign a transaction: the program signs for it. Any other signer the action names must sign here.
  const remaining = p.action.accounts.map((a) => ({
    pubkey: a.pubkey, isWritable: (a.flags & FLAG.WRITABLE) !== 0, isSigner: (a.flags & FLAG.SIGNER) !== 0 && !a.pubkey.equals(p.bunker),
  }))
  return build('execute', { bunker: p.bunker, venueProgram: VELOCITY_PROGRAM_ID }, { data: p.action.data, flags: Uint8Array.from(p.action.accounts.map((a) => a.flags)) }, p.programId ?? PROGRAM_ID, remaining)
}

export interface Prepared { authorize: TransactionInstruction; execute: TransactionInstruction; signed: Signed; action: Action }

/**
 * Signs a Velocity instruction for the bunker and returns the two instructions that carry it out, each for
 * its own transaction: `authorize` first (with cuIx(CU.AUTHORIZE)), then `execute`.
 * The instruction must name the bunker as its authority.
 */
export function prepareAction(ctx: SignContext, velocityIx: TransactionInstruction, note?: string): Prepared {
  const action = actionOf(velocityIx)
  if (!action.accounts.some((a) => a.pubkey.equals(ctx.bunkerKey) && a.flags & FLAG.SIGNER)) throw new Error('this instruction is not signed by the bunker')
  const signed = signActionHash(ctx, action.hash, { data: hex(action.data), accounts: action.accounts.map((a) => [a.pubkey.toBase58(), a.flags]), note })
  return { authorize: authorizeIx({ bunker: ctx.bunkerKey, signed, programId: ctx.programId }), execute: executeIx({ bunker: ctx.bunkerKey, action, programId: ctx.programId }), signed, action }
}

/** Authorizes "nothing": retires the current key and clears a pending action that is no longer wanted. */
export function prepareCancel(ctx: SignContext): { authorize: TransactionInstruction; signed: Signed } {
  const signed = signActionHash(ctx, ZERO32, { data: '', accounts: [], note: 'cancel pending action' })
  return { authorize: authorizeIx({ bunker: ctx.bunkerKey, signed, programId: ctx.programId }), signed }
}

/** Both instructions for something a key already signed, rebuilt from the ledger (a resend: nothing new is signed). */
export function fromRecord(p: { bunker: PublicKey; record: SignedRecord; programId?: PublicKey }): { authorize: TransactionInstruction; execute: TransactionInstruction | null } {
  const signed = { sig: unhex(p.record.sig), nextKeyHash: unhex(p.record.nextKeyHash), salt: p.record.salt, action: unhex(p.record.action) }
  const action = { data: unhex(p.record.data), accounts: p.record.accounts.map(([k, flags]) => ({ pubkey: new PublicKey(k), flags })) }
  return {
    authorize: authorizeIx({ bunker: p.bunker, signed, programId: p.programId }),
    execute: p.record.accounts.length ? executeIx({ bunker: p.bunker, action, programId: p.programId }) : null,
  }
}
