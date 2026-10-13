// @solana/web3.js expects Node's Buffer as a global.
import { Buffer } from 'buffer'

;(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer
