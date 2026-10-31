import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedLeverageOptions, buildCloseOrder, leverageForBalancePercent, leverageLimitForNotional, maximumLeverageForBrackets, orderSizeAtBalancePercent, partialCloseQuantity, percentageLeverageLimit, protectionOrderDirection, quantityFromAmount, quoteAsset } from '../src/binanceTrading.ts'

const brackets = [
  { bracket: 1, initialLeverage: 125, notionalFloor: '0', notionalCap: '50000' },
  { bracket: 2, initialLeverage: 50, notionalFloor: '50000', notionalCap: '250000' },
]

test('leverage limit follows the symbol notional bracket', () => {
  assert.equal(leverageLimitForNotional(brackets, 12_000), 125)
  assert.equal(leverageLimitForNotional(brackets, 60_000), 50)
  assert.equal(leverageLimitForNotional(brackets, 300_000), null)
  assert.equal(leverageLimitForNotional([], 12_000), null)
  assert.deepEqual(allowedLeverageOptions(brackets, 100), Array.from({ length: 125 }, (_, index) => index + 1))
  assert.ok(allowedLeverageOptions(brackets, 1_000).length <= allowedLeverageOptions(brackets, 1_000, 25).length)
})

test('symbol maximum leverage uses the lowest notional tier even when brackets are unsorted', () => {
  assert.equal(maximumLeverageForBrackets([
    { bracket: 2, initialLeverage: 50, notionalFloor: '50000', notionalCap: '250000' },
    { bracket: 1, initialLeverage: 125, notionalFloor: '0', notionalCap: '50000' },
  ]), 125)
})

test('coin and USDT amounts convert to step aligned quantities by rounding down', () => {
  assert.equal(quantityFromAmount(0.12345, 'asset', 100, '0.001'), '0.123')
  assert.equal(quantityFromAmount(25, 'usdt', 100, '0.001'), '0.25')
  assert.equal(quantityFromAmount(0, 'usdt', 100, '0.001'), '0')
})

test('percentage sliders respect notional bracket limits and partial close steps', () => {
  assert.equal(percentageLeverageLimit(brackets, 1_000, 100), 50)
  assert.equal(percentageLeverageLimit(brackets, 1_000, 25), 125)
  assert.equal(partialCloseQuantity(1.239, 50, '0.01'), '0.61')
  assert.equal(quoteAsset('ETHUSDT'), 'USDT')
  assert.equal(quoteAsset('BTCUSDC'), 'USDC')
})

test('order slider caps leverage at the requested notional tier', () => {
  assert.deepEqual(leverageForBalancePercent(brackets, 1_000, 100, 125), { maximum: 50, effective: 50, clamped: true })
  assert.deepEqual(leverageForBalancePercent(brackets, 1_000, 25, 50), { maximum: 125, effective: 50, clamped: false })
})

test('balance slider uses all available balance times leverage and rounds quantity down', () => {
  assert.deepEqual(orderSizeAtBalancePercent(100, 10, 100, 250, '0.001', 'asset'), {
    quantity: '4', notional: 1000, inputAmount: 4,
  })
  assert.deepEqual(orderSizeAtBalancePercent(100, 10, 25, 250, '0.001', 'usdt'), {
    quantity: '1', notional: 250, inputAmount: 250,
  })
})

test('close order direction and reduce-only params match one-way and hedge positions', () => {
  assert.deepEqual(buildCloseOrder({ positionAmt: 2, positionSide: 'BOTH' }), {
    side: 'SELL', positionSide: 'BOTH', reduceOnly: true, quantity: '2',
  })
  assert.deepEqual(buildCloseOrder({ positionAmt: -3, positionSide: 'SHORT' }), {
    side: 'BUY', positionSide: 'SHORT', reduceOnly: false, quantity: '3',
  })
  assert.equal(buildCloseOrder({ positionAmt: 0, positionSide: 'BOTH' }), null)
})

test('protection orders use the actual position direction or the requested opening direction', () => {
  assert.deepEqual(protectionOrderDirection('BOTH', 2, 'SELL'), { side: 'SELL', isLong: true })
  assert.deepEqual(protectionOrderDirection('SHORT', -2, 'BUY'), { side: 'BUY', isLong: false })
  assert.deepEqual(protectionOrderDirection('BOTH', null, 'SELL'), { side: 'SELL', isLong: true })
  assert.deepEqual(protectionOrderDirection('LONG', null, 'SELL'), { side: 'SELL', isLong: true })
  assert.equal(protectionOrderDirection('SHORT', null, 'SELL'), null)
  assert.equal(protectionOrderDirection('BOTH', 2, 'BUY'), null)
})
