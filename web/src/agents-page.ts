/*
  agents-page.ts — the Agents page: three profiles (who, strategy, wallet, money made or lost, win/loss, what is
  open now) and the table of every trade. Everything comes from the agents' public feed.
*/
import '@fontsource-variable/instrument-sans'
import '@fontsource/instrument-serif/400-italic.css'
import './style.css'
import { wireLinks } from './links.ts'
import { all as fx } from './fx.ts'
import { AGGR_LABEL, BASE_LABEL, FLAT_TEXT, ago, avatarHtml, duration, fetchFeed, metricsHtml, type Agent, type Custom, type Feed, type Hired, type Trade } from './agents.ts'
import { AGENT_META } from './hire.ts'
import { BURN_FEE_PCT, BURN_SHARE_PCT, BURN_WALLET } from './burn.ts'

wireLinks()
fx()
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const n = (x: number, d = 2) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const px = (x: number) => (x >= 1000 ? n(x, 1) : x >= 1 ? n(x, 3) : n(x, 5))
const signed = (x: number, d = 2) => `${x >= 0 ? '+' : ''}${n(x, d)}`
const cls = (x: number) => (x > 0 ? 'pos' : x < 0 ? 'neg' : 'dim')
const tx = (sig: string) => `<a href="https://solscan.io/tx/${encodeURIComponent(sig)}" target="_blank" rel="noopener">tx</a>`
const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`
const when = (t: number) => new Date(t * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

function profile(a: Agent): string {
  const open = (a.positions ?? []).length
    ? (a.positions ?? []).map((p) => `<span class="${p.side === 'long' ? 'pos' : 'neg'}">${p.side === 'long' ? 'Long' : 'Short'} ${n(p.size, 3)} ${esc(p.market.replace('-PERP', ''))}</span> @ ${px(p.entry)} · <span class="${cls(p.unrealized)}">${signed(p.unrealized)}</span>${p.stop ? ` <span class="dim">· stop ${px(p.stop)}${p.target ? ' · target ' + px(p.target) : ''}</span>` : ''}`).join('<br>')
    : `<span class="dim">${FLAT_TEXT}</span>`
  const all = a.allTimePnl ?? a.equity - (a.startEquity ?? a.equity), allPct = a.allTimePct ?? 0
  const w = a.wins ?? 0, l = a.losses ?? 0
  const last = [...(a.moves ?? [])].reverse().find((m) => m.thesis)
  return `<article class="ag-card" style="--c:${esc(a.color)}">
    <header>${avatarHtml(a)}<div><h2>${esc(a.name)}</h2><p>${esc(a.strategy ?? '')}</p></div></header>
    <p class="ag-open">${open}</p>
    <dl class="ag-nums">
      <div><dt>All time</dt><dd class="${cls(all)}">${signed(all)} <small>USDT · ${signed(allPct, 1)}%</small></dd></div>
      <div><dt>Today</dt><dd class="${cls(a.dayPnlPct ?? 0)}">${a.dayPnlPct != null ? signed(a.dayPnlPct, 1) + '%' : '–'}</dd></div>
      <div><dt>Equity</dt><dd>${n(a.equity)} <small>USDT</small></dd></div>
      <div><dt>Trades</dt><dd>${w + l} <small>${w} won · ${l} lost${w + l ? ' · ' + Math.round((w / (w + l)) * 100) + '%' : ''}</small></dd></div>
    </dl>
    <div class="ag-hire"><span class="dim small">${a.clients ? `Trades ${a.clients} hired bunker${a.clients === 1 ? '' : 's'} · ${n(a.aum ?? 0)} USDT` : 'Trades its own bunker'}</span><a class="btn" href="/deploy.html?hire=${esc(a.id)}">Hire ${esc(a.name)}</a></div>
    <p class="ag-wallet dim small">Bunker <a class="mono" href="https://solscan.io/account/${a.bunker}" target="_blank" rel="noopener">${short(a.bunker)}</a> · ${esc(a.persona.split('.')[0])}.</p>
    ${last ? `<details class="ag-note"><summary>Latest note · ${ago(last.t)}</summary><p>${esc(last.thesis)}</p></details>` : ''}
  </article>`
}

function tradeRow(a: Agent, t: Trade): string {
  const open = t.exit == null
  const result = open ? '<span class="dim">open</span>' : `<span class="${cls(t.pnl!)}">${signed(t.pnl!)} <small>(${signed(t.pnlPct!, 2)}%)</small></span>`
  const how = open ? '' : t.reason === 'target' ? 'target hit' : t.reason === 'stop' ? 'stop hit' : t.reason === 'time' ? 'time exit' : 'closed'
  return `<tr class="${open ? 'open' : ''}">
    <td>${when(t.openedAt)}</td>
    <td class="who">${avatarHtml(a, 'avatar sm')} ${esc(a.name)}</td>
    <td>${esc(t.market.replace('-PERP', ''))}</td>
    <td class="${t.side === 'long' ? 'pos' : 'neg'}">${t.side}</td>
    <td>${n(t.size, 3)}</td>
    <td>${px(t.entry)} → ${t.exit != null ? px(t.exit) : '…'}</td>
    <td>${result}</td>
    <td class="dim">${t.closedAt ? duration(t.openedAt, t.closedAt) + ' · ' + how : duration(t.openedAt, Math.floor(Date.now() / 1000)) + ' so far'}</td>
    <td class="dim">${t.txs.slice(0, 1).map(tx).join('')}</td>
  </tr>`
}

/** The buyback and burn: what left the agents' gains and the withdrawals, and what it became. */
function burnHtml(feed: Feed): string {
  const b = feed.burns
  const usd = (x: number) => `$${x.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  const mint = b?.mint || ''
  const coin = mint ? `<a class="mono" href="https://solscan.io/token/${esc(mint)}" target="_blank" rel="noopener">${short(mint)}</a>` : `<span class="dim">set at launch</span>`
  const rows = (b?.last ?? []).map((x) => `<tr><td>${esc(x.day)}</td><td>${n(x.usd)} USDT</td><td>${x.tokens.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td><td class="dim">${Object.entries(x.parts).filter(([, v]) => v > 0).map(([k, v]) => `${esc(k === 'fees' ? 'withdrawal fees' : AGENT_META[k]?.name ?? k)} ${n(v)}`).join(' · ')}</td><td>${x.txs.length ? `<a href="https://solscan.io/tx/${esc(x.txs[x.txs.length - 1])}" target="_blank" rel="noopener">tx</a>` : ''}</td></tr>`).join('')
  return `<p class="eyebrow">Buyback and burn</p>
    <div class="metrics"><div><b>${usd(b?.totalUsd ?? 0)}</b><span>burned, in USDT</span></div><div><b>${(b?.totalTokens ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</b><span>coins burned</span></div><div><b>${b?.count ?? 0}</b><span>burns</span></div></div>
    <p class="l-intro">Every day at 00:00 UTC, ${b?.sharePct ?? BURN_SHARE_PCT}% of what the three agents made in the last 24 hours leaves their bunkers, buys the coin on the open market and burns it. Every withdrawal from a bunker that runs or ran an agent sends ${b?.feePct ?? BURN_FEE_PCT}% of its trading gain to the same burn. Coin: ${coin} · burn wallet: <a class="mono" href="https://solscan.io/account/${BURN_WALLET}" target="_blank" rel="noopener">${short(BURN_WALLET)}</a>.</p>
    ${rows ? `<table class="ag-trades"><thead><tr><th>Day</th><th>Spent</th><th>Burned</th><th>From</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="dim">No burn yet: the first one runs at the first 00:00 UTC with a gain to burn.</p>`}`
}

/** Somebody's bunker with Ash on it. */
function hiredRow(h: Hired): string {
  const a = AGENT_META[h.agent]
  if (!a) return ''
  const open = (h.positions ?? []).length ? (h.positions ?? []).map((p) => `<span class="${p.side === 'long' ? 'pos' : 'neg'}">${p.side === 'long' ? 'Long' : 'Short'} ${n(p.size, 3)} ${esc(p.market.replace('-PERP', ''))}</span> <span class="${cls(p.unrealized)}">${signed(p.unrealized)}</span>`).join(', ') : `<span class="dim">${FLAT_TEXT}</span>`
  return `<div class="agent-line" style="--c:${a.color}">${avatarHtml({ color: a.color, initials: a.initials, avatar: a.avatar })}<div class="who"><b>${esc(a.name)} <span class="dim">for</span> ${esc(h.label || short(h.bunker))}</b><span class="dim small">${esc(AGGR_LABEL[h.aggr] ?? '')} · ${n(h.equity)} USDT</span></div><div class="now">${open}</div><div class="all dim small"><a class="mono" href="https://solscan.io/account/${h.bunker}" target="_blank" rel="noopener">${short(h.bunker)}</a></div></div>`
}
/** A user-made agent. */
function customCard(c: Custom): string {
  const open = (c.positions ?? []).length ? (c.positions ?? []).map((p) => `<span class="${p.side === 'long' ? 'pos' : 'neg'}">${p.side === 'long' ? 'Long' : 'Short'} ${n(p.size, 3)} ${esc(p.market.replace('-PERP', ''))}</span> @ ${px(p.entry)} · <span class="${cls(p.unrealized)}">${signed(p.unrealized)}</span>`).join('<br>') : `<span class="dim">${c.queued ? 'Queued: starts when a slot frees up.' : FLAT_TEXT}</span>`
  const w = c.wins, l = c.losses
  const last = [...(c.moves ?? [])].reverse().find((m) => m.thesis)
  return `<article class="ag-card" style="--c:${esc(c.color)}">
    <header>${avatarHtml({ color: c.color, initials: c.initials, avatar: `logo:${c.bunker}` })}<div><h2>${esc(c.label)}</h2><p>${esc(BASE_LABEL[c.base] ?? '')} · ${esc(AGGR_LABEL[c.aggr] ?? '')}</p></div></header>
    <p class="ag-open">${open}</p>
    <dl class="ag-nums">
      <div><dt>All time</dt><dd class="${cls(c.allTimePnl)}">${signed(c.allTimePnl)} <small>USDT</small></dd></div>
      <div><dt>Equity</dt><dd>${n(c.equity)} <small>USDT</small></dd></div>
      <div><dt>Trades</dt><dd>${w + l} <small>${w} won · ${l} lost</small></dd></div>
      <div><dt>Bunker</dt><dd><a class="mono" href="https://solscan.io/account/${c.bunker}" target="_blank" rel="noopener">${short(c.bunker)}</a></dd></div>
    </dl>
    ${c.prompt ? `<details class="ag-note"><summary>The owner's prompt</summary><p>${esc(c.prompt)}</p></details>` : ''}
    ${last ? `<details class="ag-note"><summary>Latest note · ${ago(last.t)}</summary><p>${esc(last.thesis)}</p></details>` : ''}
  </article>`
}

function render(feed: Feed) {
  const total = feed.agents.reduce((s, a) => s + (a.allTimePnl ?? 0), 0)
  document.getElementById('ag-metrics')!.innerHTML = metricsHtml(feed.metrics)
  const hired = feed.hired ?? [], custom = feed.custom ?? []
  document.getElementById('ag-hired')!.innerHTML = hired.length ? `<p class="eyebrow">On autopilot</p><div class="agents">${hired.map(hiredRow).join('')}</div>` : ''
  document.getElementById('ag-custom')!.innerHTML = custom.length ? `<p class="eyebrow">Community agents</p><div class="ag-grid">${custom.map(customCard).join('')}</div>` : ''
  document.getElementById('ag-burn')!.innerHTML = burnHtml(feed)
  const start = feed.agents.reduce((s, a) => s + (a.startEquity ?? 0), 0)
  document.getElementById('ag-meta')!.innerHTML = `${feed.agents.length} agents · together <b class="${cls(total)}">${signed(total)} USDT</b>${start ? ` (${signed((total / start) * 100, 1)}%)` : ''} since the start · one decision each every ${feed.cadenceMinutes} minutes · updated ${ago(feed.updatedAt)}`
  document.getElementById('ag-cards')!.innerHTML = `<div class="ag-grid">${feed.agents.map(profile).join('')}</div>`
  const rows = feed.agents.flatMap((a) => (a.trades ?? []).map((t) => ({ a, t }))).sort((x, y) => y.t.openedAt - x.t.openedAt)
  const chat = feed.agents.flatMap((a) => (a.moves ?? []).filter((m) => m.thesis).map((m) => ({ a, m }))).sort((x, y) => y.m.t - x.m.t).slice(0, 40)
  document.getElementById('ag-chat')!.innerHTML = chat.length
    ? chat.map(({ a, m }) => `<div class="chat-line ${m.by === 'guard' ? 'sys' : ''}" style="--c:${esc(a.color)}">${avatarHtml(a, 'avatar sm')}<div><div class="chat-head"><b>${esc(a.name)}</b> <span class="dim">${m.kind === 'hold' ? '' : esc(m.kind.replace('_', ' ')) + (m.market ? ' ' + esc(m.market.replace('-PERP', '')) : '') + ' · '}${ago(m.t)}</span></div><p>${esc(m.thesis)}</p></div></div>`).join('')
    : '<p class="dim">Nothing yet.</p>'
  document.getElementById('ag-log')!.innerHTML = rows.length
    ? `<table class="ag-trades"><thead><tr><th>Opened</th><th>Agent</th><th>Market</th><th>Side</th><th>Size</th><th>Entry → Exit</th><th>Result</th><th>Held</th><th></th></tr></thead><tbody>${rows.map(({ a, t }) => tradeRow(a, t)).join('')}</tbody></table>`
    : '<p class="dim">No trades yet.</p>'
}

async function tick() {
  const feed = await fetchFeed()
  if (feed) render(feed)
  else document.getElementById('ag-meta')!.textContent = 'The feed is not available right now.'
}
void tick()
setInterval(() => { if (!document.hidden) void tick() }, 60_000)
