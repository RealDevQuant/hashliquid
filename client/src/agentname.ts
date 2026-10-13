/*
  agentname.ts — an agent's configuration lives in the 32-byte name of the bunker's trading account on the
  venue. Only the account's owner (the bunker, moved by the 24 words) can write it, so nobody can spoof
  "Bob's bot" or change how it trades. The site writes it when the account is created or with one signed move;
  the service reads it back from the chain.

    "HL1 H23 Bob"      Bob hired Ash Two at aggressiveness 3: the chart says "Ash Two for Bob"
    "HL1 C12 Bob's bot" Bob's own agent, built on base 1 (trend), aggressiveness 2
*/
export const AGENT_TAG = 'HL1'
export const NAME_BYTES = 32
export const MAX_LABEL_BYTES = NAME_BYTES - (AGENT_TAG.length + 1 + 3 + 1)   // 24

export type Base = 1 | 2 | 3 | 4        // 1 trend · 2 mean reversion · 3 momentum · 4 the owner's own prompt (kept off chain under the bunker's address)
export type Aggr = 1 | 2 | 3            // 1 careful · 2 standard · 3 all in
export interface AgentConfig { kind: 'hired' | 'custom'; base: Base; aggr: Aggr; label: string }

const enc = new TextEncoder(), dec = new TextDecoder()

/** A label people typed: no control characters, single spaces, at most MAX_LABEL_BYTES bytes of UTF-8 (whole characters). */
export function sanitizeLabel(s: string): string {
  const clean = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim()
  let out = ''
  for (const ch of clean) { if (enc.encode(out + ch).length > MAX_LABEL_BYTES) break; out += ch }
  return out.trim()
}

export function encodeAgentName(c: AgentConfig): Uint8Array {
  const label = sanitizeLabel(c.label)
  const text = `${AGENT_TAG} ${c.kind === 'hired' ? 'H' : 'C'}${c.base}${c.aggr} ${label}`
  const bytes = enc.encode(text)
  if (bytes.length > NAME_BYTES) throw new Error('agent name too long')
  const out = new Uint8Array(NAME_BYTES).fill(0x20)
  out.set(bytes)
  return out
}

/** The configuration in a trading account's name, or null when the name is not one. */
export function decodeAgentName(bytes: Uint8Array): AgentConfig | null {
  let text: string
  try { text = dec.decode(bytes).replace(/\0+$/, '').trimEnd() } catch { return null }
  const m = /^HL1 ([HC])([1234])([123])(?: (.*))?$/.exec(text)
  if (!m) return null
  return { kind: m[1] === 'H' ? 'hired' : 'custom', base: Number(m[2]) as Base, aggr: Number(m[3]) as Aggr, label: sanitizeLabel(m[4] ?? '') }
}
