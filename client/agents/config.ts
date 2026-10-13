/*
  config.ts — the three agents, their personalities, and the limits the code enforces on them.
  The model proposes a move (direction, stop, target, invalidation); the code computes the size from the risk
  and checks everything in LIMITS before anything is signed.
*/

export interface AgentDef {
  id: string            // file names, feed ids
  name: string          // shown on the site
  color: string         // marker colour on the chart
  initials: string      // marker label
  avatar: string        // picture on the site (falls back to the initials when the file is missing)
  strategy: string      // one line for the site
  persona: string       // the voice the model writes in
  style: string         // how it trades (goes into the prompt)
}

export const AGENTS: AgentDef[] = [
  {
    id: 'ash1', name: 'Ash One', color: '#dc1fff', initials: 'A1', avatar: '/agents/ash1.png', strategy: 'Trend follower: rides the 4h direction, enters on 1h pullbacks, lets winners run.',
    persona: 'Ash One is a trend follower and half a meme: dry one-liners, crypto-twitter slang (ngmi, cooked, send it, chart is chart), never hedges, loves to roast whoever fades the trend. Calm underneath, allergic to chop.',
    style: 'Trades with the trend: the 4h EMA structure (EMA20 vs EMA50, price vs EMA20) decides the direction, the 1h decides the entry on a pullback to EMA20/50 that holds or on a close back above/below it. When the 4h and 1d disagree, the 4h wins. Stops below the last 1h swing or 1.5 ATR. Holds a winner and trails the stop.',
  },
  {
    id: 'ash2', name: 'Ash Two', color: '#9945ff', initials: 'A2', avatar: '/agents/ash2.png', strategy: 'Mean reversion: fades stretched moves and crowded sides, takes profit fast.',
    persona: 'Ash Two is a mean-reversion trader. Contrarian, dry humour, quotes the order book and funding more than the chart. Thinks crowded trades are the best trades to fade, and that trend followers are exit liquidity.',
    style: 'Fades stretched moves: RSI14 above 62 or below 38 on the 1h, price more than 1 ATR from the 1h VWAP, a 15m spike against the 1h mean, a lopsided book or funding paying one side. Enters at the stretch, stop just beyond it (1.5 ATR), target the VWAP or the 1h mean. Takes profit fast. Never fades a 4h trend that has volume behind it.',
  },
  {
    id: 'ash3', name: 'Ash Three', color: '#ff7a5c', initials: 'A3', avatar: '/agents/ash3.png', strategy: 'Momentum: breakouts with volume behind them, tight stops, trails winners.',
    persona: 'Ash Three is a momentum trader. Fast, blunt, impatient, writes like a trading desk chat. Loves breakouts, hates waiting, and tells the other two when they are late.',
    style: 'Trades momentum: breakouts of the 24h or 12h high/low on the 15m and 1h with volume above average, or a strong 15m impulse (volRatio above 1.5) in the direction of the 1h EMA20 slope. Stop back inside the range (1.5 ATR), target 1.5R or more, trails once 1R in profit. A breakout without volume is a trap, but a clean impulse with volume is a trade.',
  },
]

/** How hard the agents push. "crazy" = the house setting since 13/10: bigger size, all in. */
export const MODE: 'safe' | 'crazy' = 'crazy'

const SAFE = {
  positionShareOfEquity: 0.10, // every position is sized at this share of equity, never below the venue minimum
  targetLeverage: 1,           // notional = equity × share × this
  maxRiskPct: 3,               // of equity, lost if the stop is hit
  minStopPct: 0.3, maxStopPct: 10,
  minRewardRisk: 2,
  maxLeverage: 3,              // notional of all positions / equity, after the move
  maxMarketsOpen: 3,
  minOrderUsd: 9,
  maxOrderShareOfEquity: 2,
  slippagePct: 1,
  minEquityUsd: 5,
  cadenceMinutes: 30,
  guardMinutes: 5,
  maxOpensPerDay: 6,
  cooldownMinutes: 30,
  dailyLossStopPct: 8,
  drawdownKillPct: 20,
  defaultStopPct: 5,
  breakevenAtR: 1,
  trailAtr: 2,
  takerFeePct: 0.02,
  minSetupScore: 7,            // the model scores the setup 0–10; below this the code holds
  minSetupScoreCounterTrend: 9,// against the 4h trend: higher bar and half size
  minConfidence: 0.5,          // the model's own confidence gates, never sizes
  chaseAtr: 2,                 // no entry when price is more than this many 15m ATRs from the 15m EMA20
  maxHoursNoProgress: 24,      // a position that never reached +0.5R is closed after this long
}
const CRAZY = {
  ...SAFE,
  positionShareOfEquity: 0.5,  // half the equity as margin per position…
  targetLeverage: 5,           // …at 5x: one position ≈ 2.5 × equity of notional, two positions ≈ 5×
  maxRiskPct: 15,              // a 2% stop at 5x costs 10% of equity
  minStopPct: 0.5, maxStopPct: 6,
  maxLeverage: 5,
  maxMarketsOpen: 2,           // two markets at once
  maxOrderShareOfEquity: 6,
  cadenceMinutes: 10,
  guardMinutes: 2,
  maxOpensPerDay: 20,
  cooldownMinutes: 10,
  dailyLossStopPct: 35,
  drawdownKillPct: 60,
  defaultStopPct: 3,
  minRewardRisk: 2,            // the evidence says 2:1 or no trade, even in aggressive mode
  minSetupScore: 5,
  minSetupScoreCounterTrend: 7,
  minConfidence: 0.4,
  maxHoursNoProgress: 6,
}
/** The launch: round 1, then round 2 five minutes later. Agent → market. */
export const LAUNCH_ROUNDS: Record<string, string>[] = [
  { ash1: 'SOL-PERP', ash2: 'BTC-PERP', ash3: 'ETH-PERP' },
  { ash1: 'BTC-PERP', ash3: 'SOL-PERP', ash2: 'ETH-PERP' },
]
export const LAUNCH_GAP_MINUTES = 5

/** Hard limits, enforced in code. The model is told about them and cannot negotiate them. */
export const LIMITS = Object.freeze(MODE === 'crazy' ? CRAZY : SAFE)

export type Limits = typeof SAFE
/**
 * Hired bunkers (other people's money): the agent's own trades, entries and exits, sized with the careful
 * profile. Only sizing and the loss brakes differ from the house; stops, targets and timing are the agent's.
 */
export const CLIENT: Limits = Object.freeze({
  ...LIMITS,
  positionShareOfEquity: SAFE.positionShareOfEquity, targetLeverage: SAFE.targetLeverage, maxLeverage: SAFE.maxLeverage,
  maxMarketsOpen: SAFE.maxMarketsOpen, maxRiskPct: SAFE.maxRiskPct, maxOrderShareOfEquity: SAFE.maxOrderShareOfEquity,
  dailyLossStopPct: SAFE.dailyLossStopPct, drawdownKillPct: SAFE.drawdownKillPct,
})
/** Aggressiveness, chosen by the owner at hire or creation: the limits and how often the agent decides. */
export const AGGR: Record<1 | 2 | 3, { limits: Limits; cadenceMinutes: number; label: string }> = {
  1: { limits: CLIENT, cadenceMinutes: 60, label: 'careful' },
  2: { limits: Object.freeze({ ...CLIENT, positionShareOfEquity: 0.2, targetLeverage: 2, maxLeverage: 3, maxRiskPct: 6, cadenceMinutes: 30 }), cadenceMinutes: 30, label: 'standard' },
  3: { limits: CRAZY, cadenceMinutes: 10, label: 'all in' },
}
/** The three bases a custom agent starts from: the house agents' methods. */
export const BASES: Record<1 | 2 | 3, AgentDef> = { 1: AGENTS[0], 2: AGENTS[1], 3: AGENTS[2] }
export const CUSTOM_MODEL = 'claude-haiku-5-5'   // user agents think on the cheaper model
export const MAX_CUSTOM_AGENTS = 50               // beyond this a new one waits ("queued")
const PALETTE = ['#dc1fff', '#9945ff', '#ff7a5c', '#b366ff']
/** A user's own agent: a base method with the owner's name on it. */
export const PROMPT_BASE = 4             // base 4: the owner wrote the agent's instructions
export const MAX_PROMPT_CHARS = 1500
/** An owner's prompt as the model sees it: cleaned, capped, and fenced so it shapes the voice and the method, not the rules. */
export function ownerPrompt(text: string): string { return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/\s+\n/g, '\n').trim().slice(0, MAX_PROMPT_CHARS) }
export function customDef(cfg: { base: 1 | 2 | 3 | 4; label: string }, bunker: string, prompt?: string | null): AgentDef {
  const label = cfg.label || 'Agent'
  const initials = label.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || 'AG'
  const own = cfg.base === PROMPT_BASE ? ownerPrompt(prompt ?? '') : ''
  if (cfg.base === PROMPT_BASE && own) {
    const firstLine = own.split('\n')[0].slice(0, 90)
    return {
      id: `custom@${bunker}`, name: label, color: PALETTE[3], initials, avatar: `logo:${bunker}`,
      strategy: `Own prompt: ${firstLine}`,
      persona: `${label} trades one person's bunker, by the instructions its owner wrote. The owner's instructions, between the fences, set the method and the voice; the output format, the markets and HashLiquid's risk rules stay as the code enforces them, and theses stay civil and about the market.\n<<<\n${own}\n>>>`,
      style: 'As the owner wrote above: that is the method. Where the owner said nothing, trade with the 4h trend, enter on a 1h trigger, keep the stop where the idea is wrong.',
    }
  }
  const b = BASES[(cfg.base === PROMPT_BASE ? 1 : cfg.base) as 1 | 2 | 3]   // base 4 without a prompt yet: the trend method until the owner's text is there
  return {
    id: `custom@${bunker}`, name: label, color: PALETTE[cfg.base - 1], initials, avatar: `logo:${bunker}`,
    strategy: cfg.base === PROMPT_BASE ? 'Own prompt (not saved yet): trend method meanwhile' : b.strategy,
    persona: b.persona.replace(b.name, label) + ` ${label} belongs to one person's bunker and trades only that.`,
    style: b.style,
  }
}
export const MIN_CLIENT_EQUITY = 20   // USDT: below this a hired bunker is left alone (the venue's smallest order is about 9)
export const MAX_CLIENTS = 300        // per agent

export const MODEL = 'claude-sonnet-5-5'
export const MARKETS = ['SOL-PERP', 'BTC-PERP', 'ETH-PERP'] as const   // HYPE and ZEC come back once we are fully live
/** Minutes after the top of each cadence at which each agent decides, so they don't all move at once. */
export const OFFSETS: Record<string, number> = { ash1: 0, ash2: 4, ash3: 7 }   // two-minute windows inside the 10-minute cadence
export const FEED_PATH = 'agents.json'   // in the public Blob store the site reads
