import assert from 'node:assert/strict'
import test from 'node:test'
import { isStepAligned, toBinanceOrderParams, validateBinanceOrder, type BinanceOrderInput } from '../src/binanceOrders.ts'
import { calculateTechnicalIndicators } from '../src/technicalIndicators.ts'

test('market orders omit limit price while limit and conditional-limit orders retain Binance fields', () => {
  const market: BinanceOrderInput = { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01' }
  assert.equal(validateBinanceOrder(market), null)
  assert.deepEqual(toBinanceOrderParams(market), {
    symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01', price: undefined, timeInForce: undefined,
    stopPrice: undefined, reduceOnly: undefined, closePosition: undefined, positionSide: undefined,
    workingType: undefined, priceProtect: undefined, activationPrice: undefined, callbackRate: undefined,
  })

  const conditionalLimit: BinanceOrderInput = {
    symbol: 'ETHUSDT', side: 'SELL', type: 'STOP', quantity: '0.5', price: '3100.25', stopPrice: '3110.5',
    timeInForce: 'IOC', workingType: 'MARK_PRICE', priceProtect: true,
  }
  assert.equal(validateBinanceOrder(conditionalLimit), null)
  const params = toBinanceOrderParams(conditionalLimit)
  assert.equal(params.price, '3100.25')
  assert.equal(params.stopPrice, '3110.5')
  assert.equal(params.timeInForce, 'IOC')
  assert.equal(params.workingType, 'MARK_PRICE')
  assert.equal(params.priceProtect, true)
})

test('conditional and trailing orders require valid trigger settings', () => {
  assert.match(validateBinanceOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', quantity: '1' }) ?? '', /触发价格/)
  assert.equal(validateBinanceOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', closePosition: true, stopPrice: '62000' }), null)
  const closeParams = toBinanceOrderParams({ symbol: 'BTCUSDT', side: 'BUY', type: 'TAKE_PROFIT_MARKET', closePosition: true, stopPrice: '65000', positionSide: 'SHORT' })
  assert.equal(closeParams.quantity, undefined)
  assert.equal(closeParams.closePosition, true)
  assert.equal(closeParams.positionSide, 'SHORT')
  assert.equal(closeParams.stopPrice, '65000')
  assert.match(validateBinanceOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', quantity: '1', reduceOnly: true, positionSide: 'LONG', stopPrice: '62000' }) ?? '', /双向持仓/)
  assert.match(validateBinanceOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'TRAILING_STOP_MARKET', quantity: '1', callbackRate: '6' }) ?? '', /回调率/)
  assert.equal(validateBinanceOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'TRAILING_STOP_MARKET', quantity: '1', callbackRate: '0.5' }), null)
})

test('Binance precision alignment uses decimal strings without floating point drift', () => {
  assert.equal(isStepAligned('0.003', '0.001'), true)
  assert.equal(isStepAligned('0.0031', '0.001'), false)
  assert.equal(isStepAligned('123.45', '0.05'), true)
  assert.equal(isStepAligned('123.44', '0.05'), false)
  assert.equal(isStepAligned('1e-5', '0.00001'), true)
  assert.equal(isStepAligned('.5', '0.25'), true)
})

test('flat RSI is neutral and stochastic D waits for three real K readings', () => {
  const flat = Array.from({ length: 40 }, (_, index) => ({ time: index, open: 100, high: 101, low: 99, close: 100, volume: 10 }))
  const flatIndicators = calculateTechnicalIndicators(flat)
  assert.equal(flatIndicators.rsi.at(-1)?.value, 50)
  assert.equal(flatIndicators.stochasticD[0]?.time, 15)
  assert.equal(flatIndicators.stochasticD[0]?.value, 50)
})

test('ADX and ATR use Wilder warmup and remain bounded on a clean trend', () => {
  const rising = Array.from({ length: 60 }, (_, index) => {
    const close = 100 + index
    return { time: index, open: close - 0.4, high: close + 0.5, low: close - 0.5, close, volume: 100 }
  })
  const indicators = calculateTechnicalIndicators(rising)
  assert.equal(indicators.atr[0]?.time, 14)
  assert.equal(indicators.adx[0]?.time, 27)
  assert.ok(indicators.adx.at(-1)!.value <= 100)
  assert.ok(indicators.adx.at(-1)!.value > 90)
  assert.ok(indicators.plusDi.at(-1)!.value > indicators.minusDi.at(-1)!.value)
})
