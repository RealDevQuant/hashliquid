/*
  wallet.ts — the wallet that pays fees and sends collateral in. Phantom when it is there, or a wallet created in
  this browser (a keypair kept in localStorage) for whoever doesn't want to connect anything.
  It never sees the 24 words: those sign the bunker's moves, this signs transactions.
*/
import { Keypair, PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js'

export interface Wallet {
  name: string
  publicKey: PublicKey
  signTransaction(tx: Transaction): Promise<Transaction>
  /** For transactions built elsewhere (a swap from the aggregator). */
  signVersioned(tx: VersionedTransaction): Promise<VersionedTransaction>
  /** Created and kept in this browser. */
  local: boolean
}

interface PhantomProvider {
  isPhantom?: boolean
  connect(opts?: { onlyIfTrusted: boolean }): Promise<{ publicKey: { toBytes(): Uint8Array } }>
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>
}
const phantom = (): PhantomProvider | null => {
  const p = (window as unknown as { solana?: PhantomProvider }).solana
  return p?.isPhantom ? p : null
}
export const hasPhantom = (): boolean => !!phantom()

/** `silent`: only if the site is already trusted, without opening Phantom (used when the page reloads). */
export async function connectPhantom(silent = false): Promise<Wallet> {
  const p = phantom()
  if (!p) throw new Error('Phantom is not installed.')
  const r = await p.connect(silent ? { onlyIfTrusted: true } : undefined)
  return { name: 'Phantom', publicKey: new PublicKey(r.publicKey.toBytes()), signTransaction: (tx) => p.signTransaction(tx), signVersioned: (tx) => p.signTransaction(tx), local: false }
}

const LOCAL_KEY = 'hashliquid:browser-wallet'
export const hasBrowserWallet = (): boolean => !!localStorage.getItem(LOCAL_KEY)

/** The wallet kept in this browser; created the first time. */
export function connectBrowserWallet(): Wallet {
  let kp: Keypair
  const saved = localStorage.getItem(LOCAL_KEY)
  if (saved) kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)))
  else { kp = Keypair.generate(); localStorage.setItem(LOCAL_KEY, JSON.stringify(Array.from(kp.secretKey))) }
  return { name: 'Browser wallet', publicKey: kp.publicKey, signTransaction: async (tx) => { tx.partialSign(kp); return tx }, signVersioned: async (tx) => { tx.sign([kp]); return tx }, local: true }
}

/** The browser wallet's secret key as the JSON array Phantom and the Solana CLI import. */
export const browserWalletSecret = (): string | null => localStorage.getItem(LOCAL_KEY)

/** Imports a secret key (the same JSON array) as the browser wallet. */
export function importBrowserWallet(json: string): Wallet {
  const bytes = Uint8Array.from(JSON.parse(json))
  const kp = Keypair.fromSecretKey(bytes)   // throws on anything that isn't a 64-byte secret key
  localStorage.setItem(LOCAL_KEY, JSON.stringify(Array.from(kp.secretKey)))
  return connectBrowserWallet()
}
