import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeMarket, type AnalysisCandle } from '../src/marketAnalysis.ts'

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
