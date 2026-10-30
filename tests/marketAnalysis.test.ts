import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeMarket, analyzeMultipleTimeframes, type AnalysisCandle } from '../src/marketAnalysis.ts'
import { calculateTechnicalIndicators, DEFAULT_ANALYSIS_INDICATORS } from '../src/technicalIndicators.ts'
import { tradableUsdtPerpetuals } from '../src/binanceSymbols.ts'

function rangeCandles(phase: number): AnalysisCandle[] {
  const closes = Array.from({ length: 101 }, (_, index) => 100 + Math.sin(index * 0.32 + phase) * 8)
  closes[99] = 91.5
  closes[100] = 93
  const candles = closes.map((close, index) => {
    const open = closes[Math.max(0, index - 1)]
    return {
      time: index,
      open,
      high: Math.max(open, close) + 0.8,
      low: Math.min(open, close) - 0.8,
      close,
    }
  })
  const close = closes.at(-1)!
  candles.push({ time: closes.length, open: close, high: close + 1, low: close - 1, close })
  return candles
}

test('range midpoint stays flat and does not provide stop or target levels', () => {
  const candles = Array.from({ length: 102 }, (_, index) => {
    const close = 100 + Math.sin(index * 0.32) * 8
    const open = 100 + Math.sin((index - 1) * 0.32) * 8
    return { time: index, open, high: Math.max(open, close) + 0.8, low: Math.min(open, close) - 0.8, close }
  })

  const analysis = analyzeMarket(candles)

  assert.equal(analysis.environment, '震荡区间')
  assert.equal(analysis.direction, '观望')
  assert.equal(analysis.stopLoss, null)
  assert.equal(analysis.takeProfit, null)
})

test('confirmed rebound at the lower range edge gives a bounded long plan', () => {
  const analysis = analyzeMarket(rangeCandles(1.4))

  assert.equal(analysis.environment, '震荡区间')
  assert.equal(analysis.direction, '做多')
  assert.ok(analysis.support !== null && analysis.stopLoss !== null && analysis.stopLoss < analysis.support)
  assert.ok(analysis.resistance !== null && analysis.takeProfit !== null && analysis.takeProfit < analysis.resistance)
  assert.ok(analysis.rr !== null && analysis.rr >= 1.35)
})

test('confirmed rejection at the upper range edge gives a bounded short plan', () => {
  const mirrored = rangeCandles(1.4).map((candle) => ({
    ...candle,
    open: 200 - candle.open,
    high: 200 - candle.low,
    low: 200 - candle.high,
    close: 200 - candle.close,
  }))
  const analysis = analyzeMarket(mirrored)

  assert.equal(analysis.environment, '震荡区间')
  assert.equal(analysis.direction, '做空')
  assert.ok(analysis.resistance !== null && analysis.stopLoss !== null && analysis.stopLoss > analysis.resistance)
  assert.ok(analysis.support !== null && analysis.takeProfit !== null && analysis.takeProfit > analysis.support)
  assert.ok(analysis.rr !== null && analysis.rr >= 1.35)
})

test('range setup with insufficient reward stays flat without misleading levels', () => {
  const closes = Array.from({ length: 102 }, (_, index) => index % 2 === 0 ? 96 : 94)
  closes[99] = 93
  closes[100] = 94
  const candles = closes.map((close, index) => ({
    time: index,
    open: close,
    high: 110,
    low: 90,
    close,
  }))

  const analysis = analyzeMarket(candles)

  assert.equal(analysis.environment, '震荡区间')
  assert.equal(analysis.direction, '观望')
  assert.match(analysis.status, /盈亏空间不足/)
  assert.equal(analysis.stopLoss, null)
  assert.equal(analysis.takeProfit, null)
  assert.equal(analysis.rr, null)
})

test('technical indicator set provides long-history overlay and oscillator data', () => {
  const candles = Array.from({ length: 240 }, (_, index) => {
    const close = 100 + index * 0.12 + Math.sin(index * 0.18) * 2
    return { time: index, open: close - 0.2, high: close + 0.8, low: close - 0.8, close, volume: 1000 + index * 3 }
  })
  const indicators = calculateTechnicalIndicators(candles)
  assert.ok(indicators.ema20.length > 200)
  assert.ok(indicators.sma200.length > 0)
  assert.ok(indicators.rsi.at(-1)!.value >= 0 && indicators.rsi.at(-1)!.value <= 100)
  assert.ok(indicators.macd.length > 0)
  assert.ok(indicators.bollingerUpper.length > 0)
  assert.ok(indicators.obv.length === candles.length)
})

test('multi-timeframe analysis reports weighted consensus and enabled indicator readings', () => {
  const base = Array.from({ length: 120 }, (_, index) => {
    const close = 100 + index * 0.2 + Math.sin(index * 0.2)
    return { time: index, open: close - 0.1, high: close + 0.6, low: close - 0.6, close, volume: 1000 }
  })
  const frames = { '15m': base, '1h': base, '4h': base, '1d': base }
  const result = analyzeMultipleTimeframes(frames, base.at(-1)!.close, '1h', DEFAULT_ANALYSIS_INDICATORS)
  assert.deepEqual(Object.keys(result.byTimeframe).sort(), ['15m', '1d', '1h', '4h'])
  assert.ok(result.agreement >= 0 && result.agreement <= 100)
  assert.ok(result.byTimeframe['1h'].indicatorSignals.length > 0)
  const withoutRsi = analyzeMarket(base, base.at(-1)!.close, { ...DEFAULT_ANALYSIS_INDICATORS, rsi: false })
  assert.ok(withoutRsi.indicatorSignals.every((signal) => signal.key !== 'rsi'))
  assert.match(result.status, /周期|方向|信号/)
})

test('Binance search catalog keeps only trading USDT perpetual contracts', () => {
  const catalog = tradableUsdtPerpetuals([
    { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING' },
    { symbol: 'BTCUSDT_250628', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'CURRENT_QUARTER', status: 'TRADING' },
    { symbol: 'ETHUSDC', baseAsset: 'ETH', quoteAsset: 'USDC', marginAsset: 'USDC', contractType: 'PERPETUAL', status: 'TRADING' },
    { symbol: 'OLDUSDT', baseAsset: 'OLD', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL', status: 'BREAK' },
  ])
  assert.deepEqual(catalog, [{ symbol: 'BTCUSDT', baseAsset: 'BTC' }])
})
