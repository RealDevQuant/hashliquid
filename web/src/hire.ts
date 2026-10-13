/*
  hire.ts — hiring an agent. Each agent has a trading delegate: an ordinary key. Hiring sets that key as the
  delegate of your bunker's trading account, with one move signed by your one-time key. From then on the agent
  can place and cancel orders on that account. It cannot withdraw and cannot name another delegate: the venue
  keeps those for the account's owner, the bunker, which only your 24 words move. Firing is one more signed move.

  The keys are hard-coded here on purpose, never read from the feed: a tampered feed can't point you elsewhere.
*/
export const DELEGATES: Record<string, string> = {
  ash1: 'HfW4gexkK6B3ko8jusAMKtbDce4255dwDNSBMcFwioY9',
  ash2: '6Aje7eteQNdh1Wd3Q63s4kziRT4xrfT2b9ihi4xK6a3C',
  ash3: '34LsKSrFXuva1S3Ga9fXj7uC1y9FtEdbVWMSQium9Yv5',
}
/** The one key that trades every user-made agent's bunker. */
export const CUSTOM_DELEGATE = 'AWbgyQC5W872ii5Vwegc8Y7rMpSVPwgWRe1yPpQittPy'
/** Smallest collateral an agent will work with (the venue's smallest order is about 9 USDT). */
export const MIN_HIRE_USDT = 20

/** Who they are, for when the live feed isn't there. */
export const AGENT_META: Record<string, { name: string; initials: string; color: string; avatar: string; strategy: string }> = {
  ash1: { name: 'Ash One', initials: 'A1', color: '#dc1fff', avatar: '/agents/ash1.png', strategy: 'Trend follower: rides the 4h direction, enters on 1h pullbacks, lets winners run.' },
  ash2: { name: 'Ash Two', initials: 'A2', color: '#9945ff', avatar: '/agents/ash2.png', strategy: 'Mean reversion: fades stretched moves and crowded sides, takes profit fast.' },
  ash3: { name: 'Ash Three', initials: 'A3', color: '#ff7a5c', avatar: '/agents/ash3.png', strategy: 'Momentum: breakouts with volume behind them, tight stops, trails winners.' },
}
/** The agent whose delegate key this is, or null. */
export const agentOfDelegate = (key: string): string | null => Object.entries(DELEGATES).find(([, k]) => k === key)?.[0] ?? null
