/*
  burn.ts — buyback and burn, as the site applies it.
  The service burns half of what the house agents make every 24 hours. On every withdrawal from a bunker that runs
  (or ran) an agent, 2% of the trading gain inside the withdrawal goes to the burn wallet in the same transaction,
  and the service turns it into coin and burns it with the daily run. The addresses are fixed here on purpose.
*/
export const BURN_WALLET = '2uVbmno7mD7kSM4Rf97iE7cc4TpBRngv2UiWsK6NRDFz'
export const BURN_MINT = ''            // the coin's mint address, set at launch
export const BURN_SHARE_PCT = 50
export const BURN_FEE_PCT = 2
