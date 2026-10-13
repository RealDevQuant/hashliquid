/*
  velocity.ts — the exchange side: Velocity's addresses, the accounts we read and the instructions a trading
  account's authority can send. Encoding and account order come from Velocity's own IDL (idl/velocity.json).

  Nothing here knows about bunkers. Every builder takes the `authority` that will sign: a wallet, or a bunker's
  address (bunker.ts then wraps the instruction so the bunker signs it).

  Velocity reads the markets and oracles it needs from the accounts that follow an instruction's own, in this
  order: oracles, spot markets, perp markets (`remainingAccounts`).
*/
import { Buffer } from 'buffer'
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction, type AccountMeta, type Connection } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import velocityIdl from './idl/velocity.json' with { type: 'json' }
import { camel, createCodec, type Idl } from './codec.ts'
import { le16, type Bytes } from './wots.ts'

export const velocity = createCodec(velocityIdl as unknown as Idl)
export const VELOCITY_PROGRAM_ID = new PublicKey(velocity.idl.address)

/* ---------------- units (programs/velocity/src/math/constants.rs) ---------------- */

/** Base amounts carry 9 decimals. */
export const BASE_PRECISION = 1_000_000_000n
/** Prices and quote amounts carry 6 decimals. */
export const PRICE_PRECISION = 1_000_000n
export const QUOTE_PRECISION = 1_000_000n
/** The collateral (quote) spot market. */
export const QUOTE_SPOT_MARKET = 0

export const DIRECTION = Object.freeze({ LONG: 0, SHORT: 1 })
export const ORDER_TYPE = Object.freeze({ MARKET: 0, LIMIT: 1, TRIGGER_MARKET: 2, TRIGGER_LIMIT: 3, ORACLE: 4 })
export const MARKET_TYPE = Object.freeze({ SPOT: 0, PERP: 1 })
export const ORDER_STATUS = Object.freeze({ INIT: 0, OPEN: 1, FILLED: 2, CANCELED: 3 })
export const POST_ONLY = Object.freeze({ NONE: 0, MUST_POST_ONLY: 1, TRY_POST_ONLY: 2, SLIDE: 3 })

/* ---------------- addresses ---------------- */

const text = (s: string): Bytes => new TextEncoder().encode(s)
const find = (seeds: Bytes[]): PublicKey => PublicKey.findProgramAddressSync(seeds, VELOCITY_PROGRAM_ID)[0]

export const statePda = () => find([text('velocity_state')])
export const userPda = (authority: PublicKey, subAccountId = 0) => find([text('user'), authority.toBytes(), le16(subAccountId)])
export const userStatsPda = (authority: PublicKey) => find([text('user_stats'), authority.toBytes()])
export const perpMarketPda = (marketIndex: number) => find([text('perp_market'), le16(marketIndex)])
export const spotMarketPda = (marketIndex: number) => find([text('spot_market'), le16(marketIndex)])
export const spotVaultPda = (marketIndex: number) => find([text('spot_market_vault'), le16(marketIndex)])

/* ---------------- accounts (the fields we use; the decoder returns all of them) ---------------- */

export interface VelocityState { admin: PublicKey; signer: PublicKey; whitelistMint: PublicKey; numberOfMarkets: number; numberOfSpotMarkets: number; numberOfAuthorities: bigint; numberOfSubAccounts: bigint; [k: string]: any }
export interface PerpMarket { name: Bytes; oracle: PublicKey; oracleSource: number; status: number; marketIndex: number; baseAssetAmountLong: bigint; baseAssetAmountShort: bigint; orderStepSize: bigint; orderTickSize: bigint; [k: string]: any }
export interface SpotMarket { name: Bytes; mint: PublicKey; oracle: PublicKey; oracleSource: number; vault: PublicKey; decimals: number; marketIndex: number; status: number; [k: string]: any }
export interface SpotPosition { scaledBalance: bigint; openBids: bigint; openAsks: bigint; cumulativeDeposits: bigint; marketIndex: number; balanceType: number; openOrders: number }
export interface PerpPosition { baseAssetAmount: bigint; quoteAssetAmount: bigint; quoteEntryAmount: bigint; quoteBreakEvenAmount: bigint; openBids: bigint; openAsks: bigint; settledPnl: bigint; marketIndex: number; openOrders: number; [k: string]: any }
export interface Order { price: bigint; baseAssetAmount: bigint; baseAssetAmountFilled: bigint; quoteAssetAmountFilled: bigint; orderId: number; marketIndex: number; status: number; orderType: number; marketType: number; direction: number; reduceOnly: boolean; [k: string]: any }
export interface User { authority: PublicKey; delegate: PublicKey; name: Bytes; spotPositions: SpotPosition[]; perpPositions: PerpPosition[]; orders: Order[]; subAccountId: number; nextOrderId: number; openOrders: number; [k: string]: any }
export interface PythLazerOracle { price: bigint; publishTime: bigint; postedSlot: bigint; exponent: number; conf: bigint }

export const nameOf = (bytes: Bytes): string => new TextDecoder().decode(bytes).trim()
/** A 32-byte, space-padded account name. */
export const nameBytes = (s: string): Bytes => { const b = new Uint8Array(32).fill(32); b.set(text(s).subarray(0, 32)); return b }

async function fetchAccount<T>(conn: Connection, address: PublicKey, name: string): Promise<T | null> {
  const info = await conn.getAccountInfo(address, 'confirmed')
  return info ? velocity.decodeAccount<T>(name, info.data) : null
}
export const getState = (conn: Connection) => fetchAccount<VelocityState>(conn, statePda(), 'State')
export const getUser = (conn: Connection, authority: PublicKey, subAccountId = 0) => fetchAccount<User>(conn, userPda(authority, subAccountId), 'User')
export const getPerpMarket = (conn: Connection, marketIndex: number) => fetchAccount<PerpMarket>(conn, perpMarketPda(marketIndex), 'PerpMarket')
export const getSpotMarket = (conn: Connection, marketIndex: number) => fetchAccount<SpotMarket>(conn, spotMarketPda(marketIndex), 'SpotMarket')

/** Price of a Pyth Lazer oracle account, in PRICE_PRECISION (6 decimals). */
export async function getOraclePrice(conn: Connection, oracle: PublicKey): Promise<bigint | null> {
  const o = await fetchAccount<PythLazerOracle>(conn, oracle, 'PythLazerOracle').catch(() => null)
  if (!o) return null
  const shift = o.exponent + 6
  return shift >= 0 ? o.price * 10n ** BigInt(shift) : o.price / 10n ** BigInt(-shift)
}

/** The account's scaled balance in a spot market (9 decimals, before interest): positive a deposit, negative a borrow. */
export function spotBalance(user: User, marketIndex: number): bigint {
  const p = user.spotPositions.find((s) => s.marketIndex === marketIndex && s.scaledBalance > 0n)
  return p ? (p.balanceType === 0 ? p.scaledBalance : -p.scaledBalance) : 0n
}
/** That balance in the token's own units, with the interest it has accrued (what a full withdrawal would pay, rounded down). */
export function tokenAmount(user: User, market: SpotMarket): bigint {
  const scaled = spotBalance(user, market.marketIndex)
  const interest: bigint = scaled >= 0n ? market.cumulativeDepositInterest : market.cumulativeBorrowInterest
  return (scaled * interest) / 10n ** BigInt(19 - market.decimals)
}
export const perpPosition = (user: User, marketIndex: number): PerpPosition | null =>
  user.perpPositions.find((p) => p.marketIndex === marketIndex && (p.baseAssetAmount !== 0n || p.quoteAssetAmount !== 0n || p.openOrders !== 0)) ?? null
export const openOrders = (user: User): Order[] => user.orders.filter((o) => o.status === ORDER_STATUS.OPEN)

/* ---------------- the accounts Velocity reads after an instruction's own ---------------- */

export interface MarketNeeds { readablePerp?: number[]; writablePerp?: number[]; readableSpot?: number[]; writableSpot?: number[] }

/**
 * Oracles, then spot markets, then perp markets: the ones the instruction touches plus every market the
 * account already has a position or an order in (Velocity needs those to work out its margin).
 */
export async function remainingAccounts(conn: Connection, user: User | null, needs: MarketNeeds): Promise<AccountMeta[]> {
  const perp = new Map<number, boolean>(), spot = new Map<number, boolean>()
  const add = (m: Map<number, boolean>, i: number, writable: boolean) => m.set(i, (m.get(i) ?? false) || writable)
  for (const i of needs.readablePerp ?? []) add(perp, i, false)
  for (const i of needs.writablePerp ?? []) add(perp, i, true)
  for (const i of needs.readableSpot ?? []) add(spot, i, false)
  for (const i of needs.writableSpot ?? []) add(spot, i, true)
  if (user) {
    for (const p of user.perpPositions) if (p.baseAssetAmount !== 0n || p.quoteAssetAmount !== 0n || p.openOrders !== 0) add(perp, p.marketIndex, false)
    for (const s of user.spotPositions) if (s.scaledBalance !== 0n || s.openOrders !== 0) add(spot, s.marketIndex, false)
  }
  // perp PnL is in the quote market
  if (perp.size) add(spot, QUOTE_SPOT_MARKET, false)

  const oracles = new Map<string, PublicKey>()
  const spotMetas: AccountMeta[] = [], perpMetas: AccountMeta[] = []
  for (const [i, writable] of [...spot].sort((a, b) => a[0] - b[0])) {
    const m = await getSpotMarket(conn, i)
    if (!m) throw new Error(`no spot market ${i}`)
    if (!m.oracle.equals(PublicKey.default)) oracles.set(m.oracle.toBase58(), m.oracle)
    spotMetas.push({ pubkey: spotMarketPda(i), isSigner: false, isWritable: writable })
  }
  for (const [i, writable] of [...perp].sort((a, b) => a[0] - b[0])) {
    const m = await getPerpMarket(conn, i)
    if (!m) throw new Error(`no perp market ${i}`)
    oracles.set(m.oracle.toBase58(), m.oracle)
    perpMetas.push({ pubkey: perpMarketPda(i), isSigner: false, isWritable: writable })
  }
  return [...[...oracles.values()].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })), ...spotMetas, ...perpMetas]
}

/* ---------------- instructions ---------------- */

function build(name: string, accounts: Record<string, PublicKey>, args: Record<string, any>, remaining: AccountMeta[] = []): TransactionInstruction {
  const keys = velocity.instruction(name).accounts.map((a) => {
    const pubkey = accounts[camel(a.name)]
    if (!pubkey) throw new Error(`${name}: missing account ${camel(a.name)}`)
    return { pubkey, isSigner: !!a.signer, isWritable: !!a.writable }
  })
  return new TransactionInstruction({ programId: VELOCITY_PROGRAM_ID, keys: [...keys, ...remaining], data: Buffer.from(velocity.encodeInstruction(name, args)) })
}

export interface OrderParams {
  orderType: number; marketType: number; direction: number; userOrderId: number; baseAssetAmount: bigint; price: bigint; marketIndex: number
  reduceOnly: boolean; postOnly: number; bitFlags: number; maxTs: bigint | null; triggerPrice: bigint | null; triggerCondition: number
  oraclePriceOffset: bigint | null; auctionDuration: number | null; auctionStartPrice: bigint | null; auctionEndPrice: bigint | null
  builderIdx: number | null; builderFeeTenthBps: number | null
}
/** A perp order with everything optional switched off; pass what differs. */
export const perpOrder = (o: Partial<OrderParams> & Pick<OrderParams, 'marketIndex' | 'direction' | 'baseAssetAmount'>): OrderParams => ({
  orderType: ORDER_TYPE.MARKET, marketType: MARKET_TYPE.PERP, userOrderId: 0, price: 0n, reduceOnly: false, postOnly: POST_ONLY.NONE, bitFlags: 0,
  maxTs: null, triggerPrice: null, triggerCondition: 0, oraclePriceOffset: null, auctionDuration: null, auctionStartPrice: null, auctionEndPrice: null,
  builderIdx: null, builderFeeTenthBps: null, ...o,
})

/** Velocity only takes prices on a market's tick and sizes on its step: round down to them. */
export const toTick = (price: bigint, market: Pick<PerpMarket, 'orderTickSize'>): bigint => price - (price % market.orderTickSize)
export const toStep = (size: bigint, market: Pick<PerpMarket, 'orderStepSize'>): bigint => size - (size % market.orderStepSize)

/** For a wallet that is its own authority. A bunker's account is created through `initTradingIx` (bunker.ts). */
export const initializeUserStatsIx = (p: { authority: PublicKey; payer: PublicKey }) =>
  build('initialize_user_stats', { userStats: userStatsPda(p.authority), state: statePda(), authority: p.authority, payer: p.payer, rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId }, {})
export const initializeUserIx = (p: { authority: PublicKey; payer: PublicKey; subAccountId?: number; name?: string }) =>
  build('initialize_user', {
    user: userPda(p.authority, p.subAccountId ?? 0), userStats: userStatsPda(p.authority), state: statePda(), authority: p.authority, payer: p.payer,
    rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId,
  }, { subAccountId: p.subAccountId ?? 0, name: nameBytes(p.name ?? 'Main Account') })

/** `authority` signs and must own `userTokenAccount`. `user` defaults to the authority's own account. */
export const depositIx = (p: { authority: PublicKey; user?: PublicKey; userStats?: PublicKey; subAccountId?: number; marketIndex: number; amount: bigint; userTokenAccount: PublicKey; remaining: AccountMeta[]; tokenProgram?: PublicKey }) =>
  build('deposit', {
    state: statePda(), user: p.user ?? userPda(p.authority, p.subAccountId ?? 0), userStats: p.userStats ?? userStatsPda(p.authority), authority: p.authority,
    spotMarketVault: spotVaultPda(p.marketIndex), userTokenAccount: p.userTokenAccount, tokenProgram: p.tokenProgram ?? TOKEN_PROGRAM_ID,
  }, { marketIndex: p.marketIndex, amount: p.amount, reduceOnly: false }, p.remaining)

/** Only the account's authority can withdraw; `toTokenAccount` can be any token account of the market's mint. */
export const withdrawIx = (p: { authority: PublicKey; signer: PublicKey; subAccountId?: number; marketIndex: number; amount: bigint; toTokenAccount: PublicKey; remaining: AccountMeta[]; reduceOnly?: boolean; tokenProgram?: PublicKey }) =>
  build('withdraw', {
    state: statePda(), user: userPda(p.authority, p.subAccountId ?? 0), userStats: userStatsPda(p.authority), authority: p.authority,
    spotMarketVault: spotVaultPda(p.marketIndex), velocitySigner: p.signer, userTokenAccount: p.toTokenAccount, tokenProgram: p.tokenProgram ?? TOKEN_PROGRAM_ID,
  }, { marketIndex: p.marketIndex, amount: p.amount, reduceOnly: p.reduceOnly ?? true }, p.remaining)

/** `signer` = the account's authority or its delegate; `authority` says whose account it is. */
export const placePerpOrderIx = (p: { authority: PublicKey; signer?: PublicKey; subAccountId?: number; params: OrderParams; remaining: AccountMeta[] }) =>
  build('place_perp_order', { state: statePda(), user: userPda(p.authority, p.subAccountId ?? 0), authority: p.signer ?? p.authority }, { params: p.params }, p.remaining)

/** `orderId` null cancels the account's latest order. */
export const cancelOrderIx = (p: { authority: PublicKey; signer?: PublicKey; subAccountId?: number; orderId: number | null; remaining: AccountMeta[] }) =>
  build('cancel_order', { state: statePda(), user: userPda(p.authority, p.subAccountId ?? 0), authority: p.signer ?? p.authority }, { orderId: p.orderId }, p.remaining)

/** Cancels every open order of the account. */
export const cancelOrdersIx = (p: { authority: PublicKey; signer?: PublicKey; subAccountId?: number; remaining: AccountMeta[] }) =>
  build('cancel_orders', { state: statePda(), user: userPda(p.authority, p.subAccountId ?? 0), authority: p.signer ?? p.authority }, { marketType: null, marketIndex: null, direction: null }, p.remaining)

/** Renames the account (32 bytes). Owner only: HashLiquid keeps an agent's configuration here, see agentname.ts. */
export const updateUserNameIx = (p: { authority: PublicKey; subAccountId?: number; name: Bytes }) =>
  build('update_user_name', { user: userPda(p.authority, p.subAccountId ?? 0), authority: p.authority }, { subAccountId: p.subAccountId ?? 0, name: p.name })

/** A delegate can deposit and trade for the account. It cannot withdraw. The default key removes it. */
export const updateUserDelegateIx = (p: { authority: PublicKey; subAccountId?: number; delegate: PublicKey }) =>
  build('update_user_delegate', { user: userPda(p.authority, p.subAccountId ?? 0), authority: p.authority }, { subAccountId: p.subAccountId ?? 0, delegate: p.delegate })

/** What keepers send to fill an order (here for local tests: on mainnet Velocity's keepers do it). */
export const fillPerpOrderIx = (p: { filler: PublicKey; user: PublicKey; userStats: PublicKey; orderId: number | null; remaining: AccountMeta[] }) =>
  build('fill_perp_order', {
    state: statePda(), authority: p.filler, filler: userPda(p.filler), fillerStats: userStatsPda(p.filler), user: p.user, userStats: p.userStats,
  }, { orderId: p.orderId, makerOrderId: null }, p.remaining)
