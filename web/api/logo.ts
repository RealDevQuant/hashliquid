// The logo of a user-made agent. POST /api/logo?bunker=<address> with the image as the body (png, jpg or webp,
// at most 300 KB). Accepted only for a bunker whose trading account on chain already carries a custom agent's
// name ("HL1 C.."), so an upload costs its author a real account. Stored in the public Blob store as
// logos/<bunker>; the store refuses a second write for the same path, so the first upload wins and a logo cannot
// be replaced afterwards. The site shows <store>/logos/<bunker> when it exists.
// No Solana SDK here: the account address is derived with sha256 + ed25519 and read with one JSON-RPC call.
import { put } from '@vercel/blob'
import { sha256 } from '@noble/hashes/sha256'
import { ed25519 } from '@noble/curves/ed25519'
import bs58 from 'bs58'

const MAX_BYTES = 300 * 1024
const TYPES: [number[], string, string][] = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png', 'png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg', 'jpg'],
  [[0x52, 0x49, 0x46, 0x46], 'image/webp', 'webp'],   // RIFF…WEBP
]
const VENUE = 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P'
const RPC = process.env.RPC_URL ?? 'https://solana-rpc.publicnode.com'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const utf8 = (s: string) => new TextEncoder().encode(s)
const concat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out }
const onCurve = (bytes: Uint8Array) => { try { ed25519.ExtendedPoint.fromHex(bytes); return true } catch { return false } }

/** The venue's trading account (sub-account 0) of an authority: the program-derived address, as the SDK computes it. */
function userAccount(authority: Uint8Array): Uint8Array {
  const program = bs58.decode(VENUE)
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat([utf8('user'), authority, new Uint8Array([0, 0]), new Uint8Array([bump]), program, utf8('ProgramDerivedAddress')]))
    if (!onCurve(h)) return h
  }
  throw new Error('no program address')
}

/** True when the bunker's trading account exists on the venue and is named as a custom agent. */
async function isCustomAgent(bunker: string): Promise<boolean> {
  const account = bs58.encode(userAccount(bs58.decode(bunker)))
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [account, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 72, length: 32 } }] }) })
  if (!r.ok) throw new Error(`rpc ${r.status}`)
  const body = (await r.json()) as { result?: { value?: { owner: string; data: [string, string] } | null }; error?: unknown }
  if (body.error) throw new Error('rpc error')
  const v = body.result?.value
  if (!v || v.owner !== VENUE) return false
  const name = new TextDecoder().decode(Uint8Array.from(atob(v.data[0]), (ch) => ch.charCodeAt(0))).replace(/\0+$/, '').trimEnd()   // bytes 72..104: the name
  return /^HL1 C[123][123]( |$)/.test(name)
}

export async function POST(request: Request): Promise<Response> {
  const bunker = new URL(request.url).searchParams.get('bunker') ?? ''
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(bunker)) return json(400, { error: 'bunker address missing' })
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_BYTES) return json(413, { error: `the image must be between 1 byte and ${MAX_BYTES / 1024} KB` })
  const match = TYPES.find(([magic]) => magic.every((b, i) => bytes[i] === b))
  if (!match || (match[2] === 'webp' && String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP')) return json(415, { error: 'png, jpg or webp only' })
  let custom = false
  try { custom = await isCustomAgent(bunker) } catch { return json(503, { error: 'could not read the chain, try again' }) }
  if (!custom) return json(403, { error: 'this bunker has no custom agent yet' })
  try {
    const r = await put(`logos/${bunker}`, Buffer.from(bytes), { access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: match[1], cacheControlMaxAge: 3600 })
    return json(200, { url: r.url })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/exists|overwrite/i.test(msg)) return json(409, { error: 'this bunker already has a logo' })
    return json(500, { error: 'could not save the logo' })
  }
}
