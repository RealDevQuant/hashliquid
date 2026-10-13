/*
  codec.ts — encodes instruction arguments and decodes accounts and events straight from an Anchor IDL, so
  the client can't drift from the programs. One codec per IDL: ours (idl/hashliquid.json, copied from
  ../target/idl by `npm run idl`) and the exchange's (idl/velocity.json, from Velocity's SDK, Apache-2.0).

  Rust names are snake_case, the objects here are camelCase. u64/i64/u128 are bigint, smaller integers are
  numbers, pubkeys are PublicKey, byte arrays are Uint8Array. A unit enum is its variant index; an enum with
  fields is { variant: 'Name', fields } (an array for a tuple variant, an object for a struct variant).

  Zero-copy accounts (bytemuck, repr(C)) read the same way as borsh ones: one field after the other. That is
  only right when the struct has no padding its fields don't spell out; the tests check decoded size against
  account size for every account type used.
*/
import { PublicKey } from '@solana/web3.js'

export type IdlType =
  | string
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { option: IdlType }
  | { defined: { name: string } }

export interface IdlField { name: string; type: IdlType }
interface IdlVariant { name: string; fields?: (IdlField | IdlType)[] }
interface IdlTypeDef { name: string; type: { kind: 'struct'; fields?: IdlField[] } | { kind: 'enum'; variants: IdlVariant[] } }
export interface IdlAccountMeta { name: string; writable?: boolean; signer?: boolean; address?: string }
export interface IdlInstruction { name: string; discriminator: number[]; accounts: IdlAccountMeta[]; args: IdlField[] }
export interface Idl {
  address: string
  instructions: IdlInstruction[]
  accounts: { name: string; discriminator: number[] }[]
  events?: { name: string; discriminator: number[] }[]
  errors?: { code: number; name: string; msg?: string }[]
  types: IdlTypeDef[]
}

/** snake_case → camelCase. A leading underscore (an argument the program ignores) is dropped. */
export const camel = (s: string): string => s.replace(/^_+/, '').replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
const isNamed = (f: IdlField | IdlType): f is IdlField => typeof f === 'object' && f !== null && 'name' in f && 'type' in f
const sameBytes = (a: Uint8Array, b: number[]) => b.every((x, i) => a[i] === x)

/* ---------------- writer ---------------- */

class Writer {
  private parts: Uint8Array[] = []
  push(b: Uint8Array) { this.parts.push(b) }
  int(v: bigint | number, bytes: number, signed = false) {
    let x = BigInt(v)
    const bits = BigInt(bytes * 8)
    const [min, max] = signed ? [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n] : [0n, (1n << bits) - 1n]
    if (x < min || x > max) throw new Error(`${v} does not fit ${signed ? 'i' : 'u'}${bytes * 8}`)
    if (x < 0n) x += 1n << bits
    const out = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) { out[i] = Number(x & 0xffn); x >>= 8n }
    this.push(out)
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((a, p) => a + p.length, 0))
    let o = 0
    for (const p of this.parts) { out.set(p, o); o += p.length }
    return out
  }
}

const INTS: Record<string, [number, boolean]> = {
  u8: [1, false], u16: [2, false], u32: [4, false], u64: [8, false], u128: [16, false],
  i8: [1, true], i16: [2, true], i32: [4, true], i64: [8, true], i128: [16, true],
}

type Types = Map<string, IdlTypeDef>

function write(TYPES: Types, w: Writer, type: IdlType, value: any, path: string): void {
  if (value === undefined) throw new Error(`missing value for ${path}`)
  if (typeof type === 'string') {
    if (type in INTS) return w.int(value, ...INTS[type])
    if (type === 'bool') return w.int(value ? 1 : 0, 1)
    if (type === 'pubkey') return w.push(new PublicKey(value).toBytes())
    if (type === 'bytes') { w.int(value.length, 4); return w.push(Uint8Array.from(value)) }
    throw new Error(`unsupported type ${type} at ${path}`)
  }
  if ('array' in type) {
    const [inner, len] = type.array
    if (value.length !== len) throw new Error(`${path} must have ${len} items, got ${value.length}`)
    if (inner === 'u8') return w.push(Uint8Array.from(value))
    for (let i = 0; i < len; i++) write(TYPES, w, inner, value[i], `${path}[${i}]`)
    return
  }
  if ('vec' in type) {
    w.int(value.length, 4)
    for (let i = 0; i < value.length; i++) write(TYPES, w, type.vec, value[i], `${path}[${i}]`)
    return
  }
  if ('option' in type) {
    if (value === null) return w.int(0, 1)
    w.int(1, 1)
    return write(TYPES, w, type.option, value, path)
  }
  const def = TYPES.get(type.defined.name)
  if (!def) throw new Error(`unknown type ${type.defined.name}`)
  if (def.type.kind === 'struct') {
    for (const f of def.type.fields ?? []) write(TYPES, w, f.type, value[camel(f.name)], `${path}.${camel(f.name)}`)
    return
  }
  const variants = def.type.variants
  const index = typeof value === 'number' ? value : variants.findIndex((v) => v.name === (typeof value === 'string' ? value : value.variant))
  const variant = variants[index]
  if (!variant) throw new Error(`unknown variant for ${def.name} at ${path}`)
  w.int(index, 1)
  ;(variant.fields ?? []).forEach((f, i) => {
    if (isNamed(f)) write(TYPES, w, f.type, value.fields[camel(f.name)], `${path}.${camel(f.name)}`)
    else write(TYPES, w, f, value.fields[i], `${path}.${i}`)
  })
}

/* ---------------- reader ---------------- */

class Reader {
  o = 0
  private buf: Uint8Array
  constructor(buf: Uint8Array) { this.buf = buf }
  take(n: number): Uint8Array {
    if (this.o + n > this.buf.length) throw new Error(`short buffer: need ${n} bytes at ${this.o}, have ${this.buf.length}`)
    const out = this.buf.subarray(this.o, this.o + n)
    this.o += n
    return out
  }
  int(bytes: number, signed: boolean): bigint {
    const b = this.take(bytes)
    let x = 0n
    for (let i = bytes - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i])
    if (signed && x >> BigInt(bytes * 8 - 1)) x -= 1n << BigInt(bytes * 8)
    return x
  }
}

function read(TYPES: Types, r: Reader, type: IdlType): any {
  if (typeof type === 'string') {
    if (type in INTS) {
      const [bytes, signed] = INTS[type]
      const v = r.int(bytes, signed)
      return bytes <= 4 ? Number(v) : v
    }
    if (type === 'bool') return r.int(1, false) !== 0n
    if (type === 'pubkey') return new PublicKey(r.take(32))
    if (type === 'bytes') return Uint8Array.from(r.take(Number(r.int(4, false))))
    throw new Error(`unsupported type ${type}`)
  }
  if ('array' in type) {
    const [inner, len] = type.array
    if (inner === 'u8') return Uint8Array.from(r.take(len))
    return Array.from({ length: len }, () => read(TYPES, r, inner))
  }
  if ('vec' in type) return Array.from({ length: Number(r.int(4, false)) }, () => read(TYPES, r, type.vec))
  if ('option' in type) return r.int(1, false) === 0n ? null : read(TYPES, r, type.option)
  const def = TYPES.get(type.defined.name)
  if (!def) throw new Error(`unknown type ${type.defined.name}`)
  if (def.type.kind === 'struct') {
    const out: Record<string, any> = {}
    for (const f of def.type.fields ?? []) out[camel(f.name)] = read(TYPES, r, f.type)
    return out
  }
  const index = Number(r.int(1, false))
  const variant = def.type.variants[index]
  if (!variant) throw new Error(`bad variant ${index} for ${def.name}`)
  if (!variant.fields?.length) return index
  const named = isNamed(variant.fields[0])
  const fields: any = named ? {} : []
  variant.fields.forEach((f, i) => {
    if (isNamed(f)) fields[camel(f.name)] = read(TYPES, r, f.type)
    else fields[i] = read(TYPES, r, f)
  })
  return { variant: variant.name, fields }
}

/* ---------------- public surface ---------------- */

export interface ProgramEvent { name: string; data: Record<string, any> }

export interface Codec {
  idl: Idl
  instruction(name: string): IdlInstruction
  /** Discriminator + borsh arguments of an instruction. `args` is keyed by camelCase argument name. */
  encodeInstruction(name: string, args?: Record<string, any>): Uint8Array
  /** Decodes an account. Checks its discriminator. */
  decodeAccount<T = Record<string, any>>(name: string, data: Uint8Array): T
  /** Bytes of the account that the decoder consumed (to compare with the account's real size). */
  decodedSize(name: string, data: Uint8Array): number
  /** Size in bytes of a fixed-size type as the program lays it out. */
  sizeOf(type: IdlType): number
  /** The program's events in a transaction's logs ("Program data: <base64>" lines). */
  decodeEvents(logs: string[] | null | undefined): ProgramEvent[]
  errorName(code: number): string | null
  errorMessage(code: number): string | null
}

export function createCodec(idl: Idl): Codec {
  const TYPES: Types = new Map(idl.types.map((t) => [t.name, t]))
  const errors = new Map((idl.errors ?? []).map((e) => [e.code, e]))

  const instruction = (name: string): IdlInstruction => {
    const ix = idl.instructions.find((i) => i.name === name)
    if (!ix) throw new Error(`no instruction ${name}`)
    return ix
  }
  const account = (name: string, data: Uint8Array) => {
    const acc = idl.accounts.find((a) => a.name === name)
    if (!acc) throw new Error(`no account ${name}`)
    if (!sameBytes(data, acc.discriminator)) throw new Error(`not a ${name} account`)
    const r = new Reader(data.subarray(8))
    return { value: read(TYPES, r, { defined: { name } }), size: r.o + 8 }
  }
  const sizeOf = (type: IdlType): number => {
    if (typeof type === 'string') {
      if (type in INTS) return INTS[type][0]
      if (type === 'bool') return 1
      if (type === 'pubkey') return 32
      throw new Error(`${type} has no fixed size`)
    }
    if ('array' in type) return sizeOf(type.array[0]) * type.array[1]
    if ('defined' in type) {
      const def = TYPES.get(type.defined.name)
      if (!def) throw new Error(`unknown type ${type.defined.name}`)
      if (def.type.kind === 'struct') return (def.type.fields ?? []).reduce((a, f) => a + sizeOf(f.type), 0)
      if (def.type.variants.every((v) => !v.fields?.length)) return 1
    }
    throw new Error('type has no fixed size')
  }

  return {
    idl,
    instruction,
    encodeInstruction(name, args = {}) {
      const ix = instruction(name)
      const w = new Writer()
      w.push(Uint8Array.from(ix.discriminator))
      for (const a of ix.args) write(TYPES, w, a.type, args[camel(a.name)], camel(a.name))
      return w.bytes()
    },
    decodeAccount: (name, data) => account(name, data).value,
    decodedSize: (name, data) => account(name, data).size,
    sizeOf,
    decodeEvents(logs) {
      const out: ProgramEvent[] = []
      for (const line of logs ?? []) {
        if (!line.startsWith('Program data: ')) continue
        let bytes: Uint8Array
        try { bytes = Uint8Array.from(atob(line.slice('Program data: '.length)), (c) => c.charCodeAt(0)) } catch { continue }
        const ev = (idl.events ?? []).find((e) => sameBytes(bytes, e.discriminator))
        if (!ev) continue
        try { out.push({ name: ev.name, data: read(TYPES, new Reader(bytes.subarray(8)), { defined: { name: ev.name } }) }) } catch { /* not ours */ }
      }
      return out
    },
    errorName: (code) => errors.get(code)?.name ?? null,
    errorMessage: (code) => errors.get(code)?.msg ?? null,
  }
}

/** The custom error number in a failed transaction's `err` ({ InstructionError: [i, { Custom: n }] }), or null. */
export function customError(err: any): number | null {
  const custom = err?.InstructionError?.[1]?.Custom
  return typeof custom === 'number' ? custom : null
}
