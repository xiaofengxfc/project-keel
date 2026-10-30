export type IndicatorCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export type IndicatorPoint = { time: number; value: number }

export type TechnicalIndicatorSet = {
  ema20: IndicatorPoint[]
  ema50: IndicatorPoint[]
  sma200: IndicatorPoint[]
  bollingerUpper: IndicatorPoint[]
  bollingerMiddle: IndicatorPoint[]
  bollingerLower: IndicatorPoint[]
  vwap: IndicatorPoint[]
  rsi: IndicatorPoint[]
  macd: IndicatorPoint[]
  macdSignal: IndicatorPoint[]
  macdHistogram: IndicatorPoint[]
  stochasticK: IndicatorPoint[]
  stochasticD: IndicatorPoint[]
  atr: IndicatorPoint[]
  adx: IndicatorPoint[]
  plusDi: IndicatorPoint[]
  minusDi: IndicatorPoint[]
  obv: IndicatorPoint[]
  volume: IndicatorPoint[]
  volumeSma20: IndicatorPoint[]
}

export type ChartIndicatorKey = 'ema20' | 'ema50' | 'sma200' | 'bollinger' | 'vwap' | 'volume' | 'rsi' | 'macd' | 'stochastic' | 'atr' | 'adx' | 'obv'
export type AnalysisIndicatorKey = ChartIndicatorKey | 'structure'

export const DEFAULT_CHART_INDICATORS: Record<ChartIndicatorKey, boolean> = {
  ema20: true,
  ema50: true,
  sma200: false,
  bollinger: false,
  vwap: false,
  volume: true,
  rsi: false,
  macd: false,
  stochastic: false,
  atr: false,
  adx: false,
  obv: false,
}

export const DEFAULT_ANALYSIS_INDICATORS: Record<AnalysisIndicatorKey, boolean> = {
  ...DEFAULT_CHART_INDICATORS,
  structure: true,
}

function point(time: number, value: number | null): IndicatorPoint | null {
  return value === null || !Number.isFinite(value) ? null : { time, value }
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function emaValues(values: number[], period: number) {
  const result: Array<number | null> = []
  if (!values.length) return result
  const alpha = 2 / (period + 1)
  let current = values[0]
  values.forEach((value, index) => {
    if (index > 0) current = current + alpha * (value - current)
    result.push(index + 1 >= period ? current : null)
  })
  return result
}

function smaValues(values: number[], period: number) {
  return values.map((_, index) => index + 1 >= period ? average(values.slice(index - period + 1, index + 1)) : null)
}

function toPoints(candles: IndicatorCandle[], values: Array<number | null>) {
  return values.flatMap((value, index) => {
    const item = point(candles[index]?.time ?? 0, value)
    return item ? [item] : []
  })
}

function trueRanges(candles: IndicatorCandle[]) {
  return candles.map((candle, index) => {
    const previous = candles[index - 1]?.close ?? candle.close
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previous), Math.abs(candle.low - previous))
  })
}

function rsiValues(closes: number[], period: number) {
  const values: Array<number | null> = Array(closes.length).fill(null)
  if (closes.length <= period) return values
  let gains = 0
  let losses = 0
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index] - closes[index - 1]
    if (change >= 0) gains += change
    else losses -= change
  }
  let averageGain = gains / period
  let averageLoss = losses / period
  values[period] = averageGain === 0 && averageLoss === 0 ? 50 : averageLoss === 0 ? 100 : averageGain === 0 ? 0 : 100 - 100 / (1 + averageGain / averageLoss)
  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1]
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period
    values[index] = averageGain === 0 && averageLoss === 0 ? 50 : averageLoss === 0 ? 100 : averageGain === 0 ? 0 : 100 - 100 / (1 + averageGain / averageLoss)
  }
  return values
}

function adxValues(candles: IndicatorCandle[], period: number) {
  const result: Array<number | null> = Array(candles.length).fill(null)
  const plusValues: Array<number | null> = Array(candles.length).fill(null)
  const minusValues: Array<number | null> = Array(candles.length).fill(null)
  if (candles.length <= period) return { adx: result, plusDi: plusValues, minusDi: minusValues }

  const dx: Array<number | null> = Array(candles.length).fill(null)
  let smoothedTr = 0
  let smoothedPlus = 0
  let smoothedMinus = 0
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index]
    const previous = candles[index - 1]
    const range = Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close))
    const up = candle.high - previous.high
    const down = previous.low - candle.low
    const positive = up > down && up > 0 ? up : 0
    const negative = down > up && down > 0 ? down : 0
    if (index <= period) {
      smoothedTr += range
      smoothedPlus += positive
      smoothedMinus += negative
    } else {
      smoothedTr = smoothedTr - smoothedTr / period + range
      smoothedPlus = smoothedPlus - smoothedPlus / period + positive
      smoothedMinus = smoothedMinus - smoothedMinus / period + negative
    }
    if (index < period || smoothedTr === 0) continue
    const plusDi = smoothedPlus / smoothedTr * 100
    const minusDi = smoothedMinus / smoothedTr * 100
    plusValues[index] = plusDi
    minusValues[index] = minusDi
    const denominator = plusDi + minusDi
    dx[index] = denominator ? Math.abs(plusDi - minusDi) / denominator * 100 : 0
  }

  const firstAdxIndex = period * 2 - 1
  if (candles.length <= firstAdxIndex) return { adx: result, plusDi: plusValues, minusDi: minusValues }
  let currentAdx = average(dx.slice(period, firstAdxIndex + 1).filter((value): value is number => value !== null))
  result[firstAdxIndex] = currentAdx
  for (let index = firstAdxIndex + 1; index < candles.length; index += 1) {
    const currentDx = dx[index]
    if (currentDx === null) continue
    currentAdx = (currentAdx * (period - 1) + currentDx) / period
    result[index] = currentAdx
  }
  return { adx: result, plusDi: plusValues, minusDi: minusValues }
}

function wilderValues(values: number[], period: number) {
  const result: Array<number | null> = Array(values.length).fill(null)
  if (values.length < period) return result
  let current = average(values.slice(0, period))
  result[period - 1] = current
  for (let index = period; index < values.length; index += 1) {
    current = (current * (period - 1) + values[index]) / period
    result[index] = current
  }
  return result
}

function stochasticDValues(stochasticK: Array<number | null>, period: number) {
  return stochasticK.map((value, index) => {
    if (value === null || index < period - 1) return null
    const window = stochasticK.slice(index - period + 1, index + 1)
    if (window.some((item) => item === null)) return null
    return average(window as number[])
  })
}

export function calculateTechnicalIndicators(candles: IndicatorCandle[]): TechnicalIndicatorSet {
  const closes = candles.map((candle) => candle.close)
  const highs = candles.map((candle) => candle.high)
  const lows = candles.map((candle) => candle.low)
  const volume = candles.map((candle) => candle.volume ?? 0)
  const ema20Values = emaValues(closes, 20)
  const ema50Values = emaValues(closes, 50)
  const sma200Values = smaValues(closes, 200)
  const middle = smaValues(closes, 20)
  const upper = middle.map((value, index) => value === null ? null : value + 2 * Math.sqrt(average(closes.slice(Math.max(0, index - 19), index + 1).map((close) => (close - value) ** 2))))
  const lower = middle.map((value, index) => value === null ? null : value - 2 * Math.sqrt(average(closes.slice(Math.max(0, index - 19), index + 1).map((close) => (close - value) ** 2))))
  const ranges = trueRanges(candles)
  const atrValues = [null, ...wilderValues(ranges.slice(1), 14)]
  const rsi = rsiValues(closes, 14)
  const ema12 = emaValues(closes, 12)
  const ema26 = emaValues(closes, 26)
  const macdBase = ema12.map((value, index) => value === null || ema26[index] === null ? null : value - (ema26[index] ?? value))
  const macdStart = macdBase.findIndex((value) => value !== null)
  const macdSignalTail = macdStart < 0 ? [] : emaValues(macdBase.slice(macdStart).map((value) => value ?? 0), 9)
  const macdSignal = [...Array<number | null>(Math.max(0, macdStart)).fill(null), ...macdSignalTail.map((value, index) => macdBase[macdStart + index] === null ? null : value)]
  const macdHistogram = macdBase.map((value, index) => value === null || macdSignal[index] === null ? null : value - (macdSignal[index] ?? 0))
  const stochasticK = closes.map((close, index) => {
    if (index < 13) return null
    const high = Math.max(...highs.slice(index - 13, index + 1))
    const low = Math.min(...lows.slice(index - 13, index + 1))
    return high === low ? 50 : (close - low) / (high - low) * 100
  })
  const stochasticD = stochasticDValues(stochasticK, 3)
  const vwapValues: Array<number | null> = []
  let cumulativeVolume = 0
  let cumulativePriceVolume = 0
  let vwapDay = -1
  candles.forEach((candle, index) => {
    const day = Math.floor(candle.time / 86_400)
    if (day !== vwapDay) { vwapDay = day; cumulativeVolume = 0; cumulativePriceVolume = 0 }
    const currentVolume = volume[index]
    cumulativeVolume += currentVolume
    cumulativePriceVolume += ((candle.high + candle.low + candle.close) / 3) * currentVolume
    vwapValues.push(cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : candle.close)
  })
  const adx = adxValues(candles, 14)
  const obvValues: Array<number | null> = []
  let obv = 0
  candles.forEach((candle, index) => {
    if (index > 0) obv += candle.close > candles[index - 1].close ? volume[index] : candle.close < candles[index - 1].close ? -volume[index] : 0
    obvValues.push(obv)
  })
  return {
    ema20: toPoints(candles, ema20Values),
    ema50: toPoints(candles, ema50Values),
    sma200: toPoints(candles, sma200Values),
    bollingerUpper: toPoints(candles, upper),
    bollingerMiddle: toPoints(candles, middle),
    bollingerLower: toPoints(candles, lower),
    vwap: toPoints(candles, vwapValues),
    rsi: toPoints(candles, rsi),
    macd: toPoints(candles, macdBase),
    macdSignal: toPoints(candles, macdSignal),
    macdHistogram: toPoints(candles, macdHistogram),
    stochasticK: toPoints(candles, stochasticK),
    stochasticD: toPoints(candles, stochasticD),
    atr: toPoints(candles, atrValues),
    adx: toPoints(candles, adx.adx),
    plusDi: toPoints(candles, adx.plusDi),
    minusDi: toPoints(candles, adx.minusDi),
    obv: toPoints(candles, obvValues),
    volume: toPoints(candles, volume),
    volumeSma20: toPoints(candles, smaValues(volume, 20)),
  }
}

export function latestIndicator(points: IndicatorPoint[]) {
  return points.at(-1)?.value ?? null
}
