/** 自动市场分析使用的 K 线数据。 */
export type AnalysisCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export type MarketDirection = '做多' | '做空' | '观望'

export type MarketAnalysis = {
  environment: '上升趋势' | '下降趋势' | '震荡区间' | '突破观察' | '突破确认' | '过渡整理' | '数据不足'
  direction: MarketDirection
  support: number | null
  resistance: number | null
  stopLoss: number | null
  takeProfit: number | null
  entry: number | null
  status: string
  rr: number | null
  atr: number | null
}

type Pivot = { price: number; hits: number; latest: number }

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function ema(values: number[], period: number) {
  if (!values.length) return 0
  const alpha = 2 / (period + 1)
  return values.slice(1).reduce((value, next) => value + alpha * (next - value), values[0])
}

function calcAtr(candles: AnalysisCandle[]) {
  const ranges = candles.slice(-15).map((candle, index, rows) => {
    const originalIndex = candles.length - rows.length + index
    const previousClose = candles[originalIndex - 1]?.close ?? candle.close
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose))
  })
  return average(ranges.slice(-14))
}

function findPivots(candles: AnalysisCandle[], side: 'high' | 'low') {
  const pivots: Pivot[] = []
  for (let index = 2; index < candles.length - 2; index += 1) {
    const value = candles[index][side]
    const neighborhood = candles.slice(index - 2, index + 3).map((candle) => candle[side])
    const isPivot = side === 'high'
      ? value === Math.max(...neighborhood) && neighborhood.filter((item) => item === value).length === 1
      : value === Math.min(...neighborhood) && neighborhood.filter((item) => item === value).length === 1
    if (isPivot) pivots.push({ price: value, hits: 1, latest: index })
  }
  return pivots
}

function mergeLevels(pivots: Pivot[], tolerance: number, recentLength: number) {
  const levels: Pivot[] = []
  for (const pivot of pivots) {
    const match = levels.find((level) => Math.abs(level.price - pivot.price) <= tolerance)
    if (match) {
      match.price = (match.price * match.hits + pivot.price) / (match.hits + 1)
      match.hits += 1
      match.latest = Math.max(match.latest, pivot.latest)
    } else {
      levels.push({ ...pivot })
    }
  }
  return levels.map((level) => ({
    ...level,
    score: level.hits * 2 + level.latest / Math.max(1, recentLength),
  }))
}

function noAnalysis(entry: number | null, status = '等待更多已收盘 K 线') : MarketAnalysis {
  return { environment: '数据不足', direction: '观望', support: null, resistance: null, stopLoss: null, takeProfit: null, entry, status, rr: null, atr: null }
}

const analysisCache = new WeakMap<AnalysisCandle, { candleCount: number; livePrice: number | null; result: MarketAnalysis }>()

/** 只用已收盘 K 线识别环境，并计算可供图表展示的参考价位。 */
export function analyzeMarket(candles: AnalysisCandle[], livePrice: number | null = null): MarketAnalysis {
  const latestClosed = candles[candles.length - 2]
  if (latestClosed) {
    const cached = analysisCache.get(latestClosed)
    if (cached && cached.candleCount === candles.length && cached.livePrice === livePrice) return cached.result
    const result = calculateMarket(candles, livePrice)
    analysisCache.set(latestClosed, { candleCount: candles.length, livePrice, result })
    return result
  }
  return calculateMarket(candles, livePrice)
}

function calculateMarket(candles: AnalysisCandle[], livePrice: number | null): MarketAnalysis {
  const closed = candles.slice(0, -1)
  const entry = livePrice ?? closed[closed.length - 1]?.close ?? null
  if (closed.length < 35 || entry === null || !Number.isFinite(entry) || entry <= 0) return noAnalysis(entry)

  const recent = closed.slice(-100)
  const closes = recent.map((candle) => candle.close)
  const atr = calcAtr(recent)
  if (!Number.isFinite(atr) || atr <= 0) return { ...noAnalysis(entry, '波动不足，暂无法计算有效止损'), atr: 0 }

  const tolerance = Math.max(atr * 0.4, entry * 0.0005)
  const highPivots = mergeLevels(findPivots(recent, 'high'), tolerance, recent.length)
  const lowPivots = mergeLevels(findPivots(recent, 'low'), tolerance, recent.length)
  const below = lowPivots.filter((level) => level.price < entry).sort((a, b) => {
    const distance = Math.abs(a.price - entry) - Math.abs(b.price - entry)
    return Math.abs(distance) > tolerance ? distance : b.score - a.score
  })
  const above = highPivots.filter((level) => level.price > entry).sort((a, b) => {
    const distance = Math.abs(a.price - entry) - Math.abs(b.price - entry)
    return Math.abs(distance) > tolerance ? distance : b.score - a.score
  })
  const support = below[0]?.price ?? Math.min(...recent.slice(-30).map((candle) => candle.low))
  const resistance = above[0]?.price ?? Math.max(...recent.slice(-30).map((candle) => candle.high))

  const ema20 = ema(closes.slice(-60), 20)
  const ema50 = ema(closes.slice(-100), Math.min(50, closes.length))
  const emaGap = ema20 - ema50
  const movement = closes.slice(-21).reduce((sum, close, index, rows) => index === 0 ? sum : sum + Math.abs(close - rows[index - 1]), 0)
  const efficiency = movement > 0 ? Math.abs(closes[closes.length - 1] - closes[Math.max(0, closes.length - 21)]) / movement : 0
  const spread = Math.abs(emaGap)
  const priorRange = recent.slice(-22, -2)
  const priorHigh = Math.max(...priorRange.map((candle) => candle.high))
  const priorLow = Math.min(...priorRange.map((candle) => candle.low))
  const lastTwo = recent.slice(-2)
  const lastClose = lastTwo[lastTwo.length - 1].close
  const previousClose = lastTwo[lastTwo.length - 2].close
  const breakoutBuffer = atr * 0.12
  const brokeUp = lastClose > priorHigh + breakoutBuffer
  const brokeDown = lastClose < priorLow - breakoutBuffer
  const confirmedUp = brokeUp && previousClose > priorHigh
  const confirmedDown = brokeDown && previousClose < priorLow

  let environment: MarketAnalysis['environment']
  let direction: MarketDirection = '观望'
  let status: string
  if (confirmedUp || confirmedDown) {
    environment = '突破确认'
    direction = confirmedUp ? '做多' : '做空'
    status = confirmedUp ? '连续收盘站上前区间，向上突破确认' : '连续收盘跌破前区间，向下突破确认'
  } else if (brokeUp || brokeDown) {
    environment = '突破观察'
    status = brokeUp ? '收盘突破前高，等待后续 K 线确认' : '收盘跌破前低，等待后续 K 线确认'
  } else if (spread >= atr * 0.28 && efficiency >= 0.24) {
    const rising = emaGap > 0
    environment = rising ? '上升趋势' : '下降趋势'
    direction = rising ? '做多' : '做空'
    status = rising ? '均线与价格结构偏多，顺势观察' : '均线与价格结构偏空，顺势观察'
  } else if (spread <= atr * 0.24 && efficiency <= 0.3) {
    environment = '震荡区间'
    const width = Math.max(atr, resistance - support)
    const close = recent[recent.length - 1].close
    const nearSupport = close - support <= Math.max(atr * 0.55, width * 0.16)
    const nearResistance = resistance - close <= Math.max(atr * 0.55, width * 0.16)
    if (nearSupport && lastClose > previousClose) {
      direction = '做多'
      status = '震荡区间下沿出现回升，偏向反弹观察'
    } else if (nearResistance && lastClose < previousClose) {
      direction = '做空'
      status = '震荡区间上沿出现回落，偏向回落观察'
    } else {
      status = nearSupport || nearResistance ? '价格靠近区间边缘，等待收盘反转确认' : '价格处于区间中部，暂不追单'
    }
  } else {
    environment = '过渡整理'
    status = '趋势与区间特征交错，等待方向进一步明确'
  }

  if (direction === '观望') return { environment, direction, support, resistance, stopLoss: null, takeProfit: null, entry, status, rr: null, atr }

  const isLong = direction === '做多'
  const structuralStop = isLong ? support - atr * 0.35 : resistance + atr * 0.35
  const minimumDistanceStop = isLong ? entry - atr * 0.75 : entry + atr * 0.75
  const stopLoss = isLong ? Math.min(structuralStop, minimumDistanceStop) : Math.max(structuralStop, minimumDistanceStop)
  const risk = Math.abs(entry - stopLoss)
  let takeProfit = isLong ? entry + risk * 2 : entry - risk * 2
  const targetLevel = isLong ? resistance : support
  if (Number.isFinite(targetLevel)) {
    const bufferedTarget = isLong ? targetLevel - atr * 0.12 : targetLevel + atr * 0.12
    const targetDistance = isLong ? bufferedTarget - entry : entry - bufferedTarget
    if (targetDistance >= risk * 1.35) takeProfit = isLong ? Math.min(takeProfit, bufferedTarget) : Math.max(takeProfit, bufferedTarget)
  }
  const rr = Math.abs(takeProfit - entry) / risk
  return { environment, direction, support, resistance, stopLoss, takeProfit, entry, status: `${status} · 参考盈亏比 1:${rr.toFixed(1)}`, rr, atr }
}
