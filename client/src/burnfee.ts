/*
  burnfee.ts — the buyback-and-burn share taken from withdrawals of bunkers that run (or ran) an agent.

  A withdrawal has two parts: the owner's own money, and trading gain. The venue's account already keeps the net
  deposits (deposits minus withdrawals), so the gain inside a withdrawal is simply what exceeds the net deposits
  still inside: withdraw 500 from 1000 deposited + 100 made and no fee is due; withdraw the remaining 600 and 100 of
  it is gain. No state to keep, and the same answer whether the money leaves in one go or in pieces.
  The site adds the fee as a transfer to the burn wallet in the same transaction as the withdrawal.
*/
export const BURN_FEE_BPS = 200n   // 2% of the gain in a withdrawal

/** The part of `amount` that is trading gain, given the account's net deposits (both in the token's smallest unit). */
export function gainInWithdrawal(amount: bigint, netDeposits: bigint): bigint {
  const principal = netDeposits > 0n ? netDeposits : 0n
  return amount > principal ? amount - principal : 0n
}

/** The buyback-and-burn share of a withdrawal. */
export function burnFee(amount: bigint, netDeposits: bigint): bigint {
  return (gainInWithdrawal(amount, netDeposits) * BURN_FEE_BPS) / 10_000n
}
