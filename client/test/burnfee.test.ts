import test from 'node:test'
import assert from 'node:assert/strict'
import { burnFee, gainInWithdrawal } from '../src/burnfee.ts'

const U = 1_000_000n   // one USDT

test('only the gain inside a withdrawal pays, whether it leaves in one go or in pieces', () => {
  // 1000 deposited, 100 made: net deposits 1000, balance 1100
  assert.equal(burnFee(1100n * U, 1000n * U), 2n * U)          // everything at once: 2% of 100
  assert.equal(burnFee(500n * U, 1000n * U), 0n)               // the first 500 is the owner's money
  assert.equal(burnFee(600n * U, 500n * U), 2n * U)            // after it, net deposits are 500: 100 of the next 600 is gain
  assert.equal(gainInWithdrawal(30n * U, 1000n * U), 0n)
})

test('an account that already took its deposits out is all gain', () => {
  assert.equal(burnFee(50n * U, -20n * U), 1n * U)             // net deposits below zero: the whole 50 is gain
  assert.equal(burnFee(0n, 10n * U), 0n)
})

test('a losing account pays nothing', () => {
  assert.equal(burnFee(900n * U, 1000n * U), 0n)
})
