/*
  words.ts — 24 BIP39 words ⇄ the 32-byte master secret every position key derives from (see wots.ts).
  The words are the entropy itself (256 bits), so one backup covers every account, market and key rotation.
*/
import { generateMnemonic, mnemonicToEntropy, validateMnemonic, entropyToMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'

export const newWords = (): string => generateMnemonic(wordlist, 256)
export const normalize = (words: string): string => words.trim().toLowerCase().split(/\s+/).join(' ')
export const validWords = (words: string): boolean => validateMnemonic(normalize(words), wordlist) && normalize(words).split(' ').length === 24
export function wordsToMaster(words: string): Uint8Array {
  if (!validWords(words)) throw new Error('Not a valid 24-word phrase.')
  return mnemonicToEntropy(normalize(words), wordlist)
}
export const masterToWords = (master: Uint8Array): string => entropyToMnemonic(master, wordlist)
