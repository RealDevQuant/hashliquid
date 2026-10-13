/*
  store.ts — what each agent has done, on disk (one JSON line per decision), the exit plan of every open
  position, the daily counters, and the public feed the site reads. The feed is a single JSON file in a public
  Vercel Blob store; the site and the terminal fetch it directly.
*/
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { put } from '@vercel/blob'
import { FEED_PATH } from './config.ts'

export type Kind = 'open' | 'close' | 'adjust_stop' | 'hold'
export interface Move {
  t: number                 // unix seconds
  agent: string
  market: string            // "SOL-PERP"
  kind: Kind
  side?: 'long' | 'short'   // the side of the order sent (a close is the opposite side of the position)
  size?: number             // base asset
  price?: number            // the oracle at the time
  notional?: number         // USDT
  stop?: number
  target?: number
  invalidation?: string
  riskPct?: number
  thesis: string            // the agent's words, in English
  confidence?: number
  txs: string[]
  error?: string            // when the move was vetoed or failed, why
  by?: 'model' | 'guard'    // who decided: the model, or the stop/target guard
}

// AGENTS_DATA points the tests at a scratch folder, so they never touch the live service's files
export const dataDir = process.env.AGENTS_DATA ? pathToFileURL(process.env.AGENTS_DATA.replace(/\/?$/, '/')) : new URL('./data/', import.meta.url)
mkdirSync(dataDir, { recursive: true })
mkdirSync(new URL('clients/', dataDir), { recursive: true })
const fileOf = (agent: string) => new URL(`${agent}.jsonl`, dataDir)

export function logMove(m: Move): void { appendFileSync(fileOf(m.agent), JSON.stringify(m) + '\n') }

/** A file is replaced in one step, so a kill in the middle of a write never leaves it half written. */
function writeAtomic(file: URL, text: string): void { const tmp = new URL(file.href + '.tmp'); writeFileSync(tmp, text); renameSync(tmp, file) }
/** The last `limit` lines of a log, skipping a line that was cut short. */
function parseLines(text: string, limit: number): Move[] { const out: Move[] = []; for (const l of text.split('\n').filter(Boolean).slice(-limit)) { try { out.push(JSON.parse(l) as Move) } catch { /* a half-written line */ } } return out }

/** What an agent did on a hired bunker: kept apart from the agent's own public log. `book` = "ash1@<bunker>". */
export function logClientMove(book: string, m: Move): void { appendFileSync(new URL(`clients/${book.replace('@', '.')}.jsonl`, dataDir), JSON.stringify(m) + '\n') }

/** The bunkers seen last per delegate (an agent's hired bunkers, or every custom agent under 'custom'): what the service falls back on when the chain can't be listed. */
export interface ClientEntry { bunker: string; cfg: { kind: 'hired' | 'custom'; base: 1 | 2 | 3; aggr: 1 | 2 | 3; label: string } | null; since?: number }   // since = first seen, unix seconds
const clientsFile = new URL('clients.json', dataDir)
export const readClients = (): Record<string, { t: number; bunkers: ClientEntry[] }> => (existsSync(clientsFile) ? JSON.parse(readFileSync(clientsFile, 'utf8')) : {})
export function saveClients(key: string, bunkers: ClientEntry[]): void { const all = readClients(); all[key] = { t: Math.floor(Date.now() / 1000), bunkers }; writeAtomic(clientsFile, JSON.stringify(all, null, 1)) }
export function readClientMoves(book: string, limit = 200): Move[] {
  const f = new URL(`clients/${book.replace('@', '.')}.jsonl`, dataDir)
  if (!existsSync(f)) return []
  return parseLines(readFileSync(f, 'utf8'), limit)
}

export function readMoves(agent: string, limit = 200): Move[] {
  const f = fileOf(agent)
  if (!existsSync(f)) return []
  return parseLines(readFileSync(f, 'utf8'), limit)
}

/* ---- exit plans: one per open position, fed back to the model and watched by the guard ---- */
export interface Plan {
  side: 'long' | 'short'; entry: number; stop: number; target: number | null; invalidation: string; thesis: string; openedAt: number; initialRisk: number; atr: number | null
  filled?: boolean          // false while the entry order rests on the book
  entryOrderId?: number     // the venue's ids of the orders this plan placed (a hired bunker may hold others)
  exitOrderId?: number
  closingAt?: number        // set when a closing order was sent; the guard finishes the job
}
type Plans = Record<string, Record<string, Plan>>   // agent → market → plan
const plansFile = new URL('plans.json', dataDir)
export const readPlans = (): Plans => (existsSync(plansFile) ? JSON.parse(readFileSync(plansFile, 'utf8')) : {})
export function savePlan(agent: string, market: string, plan: Plan | null): void {
  const all = readPlans()
  all[agent] ??= {}
  if (plan) all[agent][market] = plan; else delete all[agent][market]
  writeAtomic(plansFile, JSON.stringify(all, null, 1))
}

/* ---- daily counters and the equity peak, per agent ---- */
/** Risk is measured on trading PnL (equity minus net deposits), so a deposit or a withdrawal never looks like a gain or a loss. */
export interface Counters { day: string; dayStartEquity: number; opens: number; lastCloseAt: Record<string, number>; peakEquity: number; startEquity?: number; dayStartPnl?: number; peakPnl?: number }
type AllCounters = Record<string, Counters>
const countersFile = new URL('counters.json', dataDir)
const today = () => new Date().toISOString().slice(0, 10)
export function counters(agent: string, equity: number, pnl: number): Counters {
  const all: AllCounters = existsSync(countersFile) ? JSON.parse(readFileSync(countersFile, 'utf8')) : {}
  let c = all[agent]
  if (!c || c.day !== today()) c = { day: today(), dayStartEquity: equity, dayStartPnl: pnl, opens: 0, lastCloseAt: c?.lastCloseAt ?? {}, peakEquity: Math.max(c?.peakEquity ?? 0, equity), peakPnl: Math.max(c?.peakPnl ?? pnl, pnl), startEquity: c?.startEquity ?? equity }
  c.startEquity ??= c.dayStartEquity
  c.dayStartPnl ??= pnl
  c.peakPnl = Math.max(c.peakPnl ?? pnl, pnl)
  c.peakEquity = Math.max(c.peakEquity, equity)
  all[agent] = c
  writeAtomic(countersFile, JSON.stringify(all, null, 1))
  return c
}
export function saveCounters(agent: string, c: Counters): void {
  const all: AllCounters = existsSync(countersFile) ? JSON.parse(readFileSync(countersFile, 'utf8')) : {}
  all[agent] = c
  writeAtomic(countersFile, JSON.stringify(all, null, 1))
}

/* ---- the public feed ---- */
export interface FeedPosition { market: string; side: 'long' | 'short'; size: number; entry: number; unrealized: number; stop?: number; target?: number | null; invalidation?: string }
export interface FeedOrder { market: string; side: 'long' | 'short'; size: number; price: number; reduceOnly: boolean; orderId: number }
export interface FeedAgent {
  id: string; name: string; color: string; initials: string; avatar: string; persona: string
  bunker: string; equity: number; collateral: number; realized: number
  dayPnlPct: number | null; opensToday: number; peakEquity: number
  startEquity: number; allTimePnl: number; allTimePct: number
  delegate: string; clients: number; aum: number          // the key that trades hired bunkers, how many, their equity
  trades: FeedTrade[]; wins: number; losses: number
  strategy: string
  positions: FeedPosition[]; orders: FeedOrder[]
  lastThesis: string | null; lastAt: number | null
  moves: Move[]            // newest last, the last ~100, hold moves included
}
/** One round trip, paired from the agent's own log: the entry and the exit, with the result. */
export interface FeedTrade { market: string; side: 'long' | 'short'; size: number; entry: number; exit: number | null; openedAt: number; closedAt: number | null; pnl: number | null; pnlPct: number | null; reason: string; txs: string[] }
/** A bunker an agent trades for somebody: Ash for Bob. */
export interface FeedHired { agent: string; bunker: string; label: string; aggr: number; equity: number; positions: FeedPosition[]; trades: FeedTrade[] }
/** A user's own agent. */
export interface FeedCustom {
  bunker: string; label: string; base: number; aggr: number; color: string; initials: string; strategy: string
  equity: number; startEquity: number; allTimePnl: number; positions: FeedPosition[]; trades: FeedTrade[]; wins: number; losses: number
  lastThesis: string | null; lastAt: number | null; moves: Move[]; queued: boolean
}
export interface FeedMetrics { agentsDeployed: number; hiredBunkers: number; customAgents: number; positionsOpen: number; tradesTotal: number; volumeUsd: number; aum: number }
export interface Feed { updatedAt: number; cadenceMinutes: number; agents: FeedAgent[]; hired: FeedHired[]; custom: FeedCustom[]; metrics: FeedMetrics }

const token = (): string => {
  const env = process.env.BLOB_READ_WRITE_TOKEN
  if (env) return env
  const f = new URL('../../.secrets/agents/blob.env', import.meta.url)
  const m = /BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?/.exec(readFileSync(f, 'utf8'))
  if (!m) throw new Error('no BLOB_READ_WRITE_TOKEN in .secrets/agents/blob.env')
  return m[1]
}

/** Writes the feed to the public store. Returns its URL. */
export async function publishFeed(feed: Feed): Promise<string> {
  const r = await put(FEED_PATH, JSON.stringify(feed), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60, token: token() })
  return r.url
}
