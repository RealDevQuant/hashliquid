import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LABEL_BYTES, NAME_BYTES, decodeAgentName, encodeAgentName, sanitizeLabel } from '../src/agentname.ts'

test('an agent config round-trips through the 32-byte account name', () => {
  for (const c of [
    { kind: 'hired' as const, base: 2 as const, aggr: 3 as const, label: 'Bob' },
    { kind: 'custom' as const, base: 1 as const, aggr: 1 as const, label: "Bob's bot" },
    { kind: 'custom' as const, base: 3 as const, aggr: 2 as const, label: 'Ξ degen 🚀' },
    { kind: 'hired' as const, base: 1 as const, aggr: 3 as const, label: '' },   // no owner name given: the aggressiveness must survive
  ]) {
    const bytes = encodeAgentName(c)
    assert.equal(bytes.length, NAME_BYTES)
    assert.deepEqual(decodeAgentName(bytes), c)
  }
})

test('labels are cut at whole characters and cleaned', () => {
  const long = sanitizeLabel('a'.repeat(40))
  assert.equal(long.length, MAX_LABEL_BYTES)
  const emoji = sanitizeLabel('🚀'.repeat(10))   // 4 bytes each: six fit, never half of one
  assert.equal(emoji, '🚀'.repeat(6))
  assert.equal(sanitizeLabel('  Bob\u0000\u001b[31m   the  bot '), 'Bob[31m the bot')
  assert.deepEqual(decodeAgentName(encodeAgentName({ kind: 'custom', base: 1, aggr: 2, label: '🚀'.repeat(10) }))?.label, '🚀'.repeat(6))
})

test('ordinary names are not agent configs', () => {
  const enc = new TextEncoder()
  const pad = (s: string) => { const b = new Uint8Array(NAME_BYTES).fill(0x20); b.set(enc.encode(s)); return b }
  assert.equal(decodeAgentName(pad('HashLiquid')), null)
  assert.equal(decodeAgentName(pad('HL1 X12 Bob')), null)
  assert.equal(decodeAgentName(pad('HL1 H14 Bob')), null)
  assert.equal(decodeAgentName(new Uint8Array(NAME_BYTES)), null)
})
