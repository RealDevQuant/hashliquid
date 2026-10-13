// The instructions an owner wrote for a user-made agent (base 4). POST /api/prompt?bunker=<address> with the text as
// the body (UTF-8, at most 1,500 characters). Accepted only for a bunker whose trading account on chain is already
// named as a prompt-driven custom agent ("HL1 C4."), so a prompt costs its author a real account. Stored in the
// public Blob store as prompts/<bunker>, written once: the store refuses a second write. The agents' service reads
// it from there, and the site shows it on the agent's card.
import { put } from '@vercel/blob'
import { sha256 } from '@noble/hashes/sha256'
import { ed25519 } from '@noble/curves/ed25519'
import bs58 from 'bs58'

const MAX_CHARS = 1500
const VENUE = 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P'
const RPC = process.env.RPC_URL ?? 'https://solana-rpc.publicnode.com'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const utf8 = (s: string) => new TextEncoder().encode(s)
const concat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out }
const onCurve = (bytes: Uint8Array) => { try { ed25519.ExtendedPoint.fromHex(bytes); return true } catch { return false } }
function userAccount(authority: Uint8Array): Uint8Array {
  const program = bs58.decode(VENUE)
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat([utf8('user'), authority, new Uint8Array([0, 0]), new Uint8Array([bump]), program, utf8('ProgramDerivedAddress')]))
    if (!onCurve(h)) return h
  }
  throw new Error('no program address')
}
/** True when the bunker's trading account exists on the venue and is named as a prompt-driven custom agent. */
async function isPromptedAgent(bunker: string): Promise<boolean> {
  const account = bs58.encode(userAccount(bs58.decode(bunker)))
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [account, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 72, length: 32 } }] }) })
  if (!r.ok) throw new Error(`rpc ${r.status}`)
  const body = (await r.json()) as { result?: { value?: { owner: string; data: [string, string] } | null }; error?: unknown }
  if (body.error) throw new Error('rpc error')
  const v = body.result?.value
  if (!v || v.owner !== VENUE) return false
  const name = new TextDecoder().decode(Uint8Array.from(atob(v.data[0]), (ch) => ch.charCodeAt(0))).replace(/\0+$/, '').trimEnd()
  return /^HL1 C4[123]( |$)/.test(name)
}
/** The text as the service will use it: no control characters, trimmed, capped. */
const clean = (t: string) => t.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/\s+\n/g, '\n').trim().slice(0, MAX_CHARS)

export async function POST(request: Request): Promise<Response> {
  const bunker = new URL(request.url).searchParams.get('bunker') ?? ''
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(bunker)) return json(400, { error: 'bunker address missing' })
  const raw = await request.text()
  if (raw.length > MAX_CHARS * 4) return json(413, { error: `the prompt must be at most ${MAX_CHARS} characters` })
  const text = clean(raw)
  if (!text) return json(400, { error: 'the prompt is empty' })
  let ok = false
  try { ok = await isPromptedAgent(bunker) } catch { return json(503, { error: 'could not read the chain, try again' }) }
  if (!ok) return json(403, { error: 'this bunker has no prompt-driven agent yet' })
  try {
    const r = await put(`prompts/${bunker}`, text, { access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: 'text/plain; charset=utf-8', cacheControlMaxAge: 300 })
    return json(200, { url: r.url })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/exists|overwrite/i.test(msg)) return json(409, { error: 'this bunker already has a prompt' })
    return json(500, { error: 'could not save the prompt' })
  }
}
