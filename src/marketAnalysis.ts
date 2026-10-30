import { calculateTechnicalIndicators, latestIndicator, type AnalysisIndicatorKey } from './technicalIndicators'

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
  indicatorSignals: IndicatorSignal[]
  supportingIndicators: number
  opposingIndicators: number
}

export type IndicatorSignal = { key: AnalysisIndicatorKey; label: string; reading: string; direction: 'bullish' | 'bearish' | 'neutral'; reason: string }
export type AnalysisSettings = Record<AnalysisIndicatorKey, boolean>
export type AnalysisTimeframe = '15m' | '1h' | '4h' | '1d'
export type MultiTimeframeAnalysis = { byTimeframe: Record<AnalysisTimeframe, MarketAnalysis>; direction: MarketDirection; agreement: number; status: string; bullishWeight: number; bearishWeight: number }

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
  return { environment: '数据不足', direction: '观望', support: null, resistance: null, stopLoss: null, takeProfit: null, entry, status, rr: null, atr: null, indicatorSignals: [], supportingIndicators: 0, opposingIndicators: 0 }
}

const analysisCache = new WeakMap<AnalysisCandle, { candleCount: number; livePrice: number | null; settingsKey: string; result: MarketAnalysis }>()

/** 只用已收盘 K 线识别环境，并计算可供图表展示的参考价位。 */
export function analyzeMarket(candles: AnalysisCandle[], livePrice: number | null = null, settings?: AnalysisSettings): MarketAnalysis {
  const settingsKey = settings ? Object.entries(settings).filter(([, enabled]) => enabled).map(([key]) => key).sort().join(',') : 'default'
  const latestClosed = candles[candles.length - 2]
  if (latestClosed) {
    const cached = analysisCache.get(latestClosed)
    if (cached && cached.candleCount === candles.length && cached.livePrice === livePrice && cached.settingsKey === settingsKey) return cached.result
    const result = withIndicatorContext(calculateMarket(candles, livePrice), candles, settings)
    analysisCache.set(latestClosed, { candleCount: candles.length, livePrice, settingsKey, result })
    return result
  }
  return withIndicatorContext(calculateMarket(candles, livePrice), candles, settings)
}

function withIndicatorContext(result: MarketAnalysis, candles: AnalysisCandle[], settings?: AnalysisSettings): MarketAnalysis {
  if (!settings || candles.length < 2) return result
  const closed = candles.slice(0, -1)
  if (!closed.length) return result
  const computed = calculateTechnicalIndicators(closed)
  const last = closed[closed.length - 1]
  const ema20 = latestIndicator(computed.ema20)
  const ema50 = latestIndicator(computed.ema50)
  const sma200 = latestIndicator(computed.sma200)
  const rsi = latestIndicator(computed.rsi)
  const macd = latestIndicator(computed.macd)
  const macdSignal = latestIndicator(computed.macdSignal)
  const bollingerMid = latestIndicator(computed.bollingerMiddle)
  const vwap = latestIndicator(computed.vwap)
  const stochastic = latestIndicator(computed.stochasticK)
  const atr = latestIndicator(computed.atr)
  const adx = latestIndicator(computed.adx)
  const plusDi = latestIndicator(computed.plusDi)
  const minusDi = latestIndicator(computed.minusDi)
  const obv = computed.obv
  const obvChange = obv.length > 10 ? obv.at(-1)!.value - obv.at(-11)!.value : null
  const avgVolume = latestIndicator(computed.volumeSma20)
  const volumeRatio = avgVolume && avgVolume > 0 ? (last.volume ?? 0) / avgVolume : null
  const emaBull = ema20 !== null && ema50 !== null && last.close > ema20 && ema20 > ema50
  const emaBear = ema20 !== null && ema50 !== null && last.close < ema20 && ema20 < ema50
  const add = (key: AnalysisIndicatorKey, label: string, reading: string, direction: IndicatorSignal['direction'], reason: string) => {
    if (settings[key]) signals.push({ key, label, reading, direction, reason })
  }
  const signals: IndicatorSignal[] = []
  add('structure', '价位结构', `${result.environment} · ${result.direction}`, result.direction === '做多' ? 'bullish' : result.direction === '做空' ? 'bearish' : 'neutral', result.status)
  add('ema20', 'EMA 趋势', ema20 === null || ema50 === null ? '数据不足' : `EMA20 ${last.close >= ema20 ? '上方' : '下方'} EMA50 ${ema20 >= ema50 ? '上方' : '下方'}`, emaBull ? 'bullish' : emaBear ? 'bearish' : 'neutral', emaBull ? '收盘价位于 EMA20 上方，短期均线高于 EMA50' : emaBear ? '收盘价位于 EMA20 下方，短期均线低于 EMA50' : '均线排列未形成明确方向')
  add('ema50', 'EMA50 趋势', ema50 === null ? '数据不足' : last.close >= ema50 ? '价格在 EMA50 上方' : '价格在 EMA50 下方', ema50 === null ? 'neutral' : last.close >= ema50 ? 'bullish' : 'bearish', '用收盘价相对 EMA50 判断中短期方向')
  add('sma200', 'SMA200 趋势', sma200 === null ? '数据不足' : last.close >= sma200 ? '价格在 SMA200 上方' : '价格在 SMA200 下方', sma200 === null ? 'neutral' : last.close >= sma200 ? 'bullish' : 'bearish', '用收盘价相对 SMA200 判断长期趋势')
  add('rsi', 'RSI(14)', rsi === null ? '数据不足' : rsi.toFixed(1), rsi !== null && rsi >= 55 && rsi < 70 ? 'bullish' : rsi !== null && rsi <= 45 && rsi > 30 ? 'bearish' : 'neutral', rsi === null ? '需要更多历史数据' : rsi >= 70 ? '进入超买区，追涨风险上升' : rsi <= 30 ? '进入超卖区，留意反转但不单独视为买入信号' : rsi >= 55 ? '动量偏强' : rsi <= 45 ? '动量偏弱' : '动量处于中性区')
  add('macd', 'MACD(12,26,9)', macd === null || macdSignal === null ? '数据不足' : macd >= macdSignal ? 'MACD 在线上' : 'MACD 在线下', macd !== null && macdSignal !== null && macd > macdSignal ? 'bullish' : macd !== null && macdSignal !== null && macd < macdSignal ? 'bearish' : 'neutral', '比较 MACD 线与信号线的相对位置')
  add('bollinger', '布林带(20,2)', bollingerMid === null ? '数据不足' : last.close >= bollingerMid ? '收盘在中轨上方' : '收盘在中轨下方', bollingerMid === null ? 'neutral' : last.close >= bollingerMid ? 'bullish' : 'bearish', '以布林带中轨判断方向；轨道触及本身不作为反转确认')
  add('vwap', '日内 VWAP', vwap === null ? '数据不足' : last.close >= vwap ? '价格在 VWAP 上方' : '价格在 VWAP 下方', vwap === null ? 'neutral' : last.close >= vwap ? 'bullish' : 'bearish', 'VWAP 按 UTC 日重置，比较收盘价与日内成交均价')
  add('stochastic', '随机指标(14,3)', stochastic === null ? '数据不足' : stochastic.toFixed(1), stochastic !== null && stochastic >= 55 && stochastic < 80 ? 'bullish' : stochastic !== null && stochastic <= 45 && stochastic > 20 ? 'bearish' : 'neutral', stochastic === null ? '需要更多历史数据' : stochastic >= 80 ? '处于高位区，避免仅凭超买追单' : stochastic <= 20 ? '处于低位区，等待价格确认' : '比较收盘价在近期高低区间中的位置')
  add('volume', '成交量', volumeRatio === null ? '数据不足' : `${volumeRatio.toFixed(2)}× 20期均量`, volumeRatio !== null && volumeRatio >= 1.3 && last.close > last.open ? 'bullish' : volumeRatio !== null && volumeRatio >= 1.3 && last.close < last.open ? 'bearish' : 'neutral', volumeRatio === null ? '需要更多成交量数据' : volumeRatio >= 1.3 ? '相对均量放大，方向按本周期收盘K线判断' : '成交量未显著高于均量')
  add('obv', 'OBV', obvChange === null ? '数据不足' : obvChange >= 0 ? '近10期上升' : '近10期下降', obvChange === null || obvChange === 0 ? 'neutral' : obvChange > 0 ? 'bullish' : 'bearish', '用 OBV 近10期变化观察成交量累积方向')
  add('adx', 'ADX(14)', adx === null ? '数据不足' : adx.toFixed(1), adx !== null && adx >= 25 && plusDi !== null && minusDi !== null && plusDi > minusDi ? 'bullish' : adx !== null && adx >= 25 && plusDi !== null && minusDi !== null && minusDi > plusDi ? 'bearish' : 'neutral', adx === null ? '需要更多历史数据' : adx >= 25 && plusDi !== null && minusDi !== null ? `趋势强度较高，+DI ${plusDi.toFixed(1)} / -DI ${minusDi.toFixed(1)}` : '趋势强度偏低或处于整理')
  add('atr', 'ATR(14)', atr === null ? '数据不足' : `${atr.toPrecision(5)} (${(atr / last.close * 100).toFixed(2)}%)`, 'neutral', 'ATR 衡量波动，不单独判断方向')

  const votes = signals.filter((signal) => signal.direction !== 'neutral')
  const supportingIndicators = votes.filter((signal) => signal.direction === (result.direction === '做空' ? 'bearish' : 'bullish')).length
  const opposingIndicators = result.direction === '观望' ? 0 : votes.length - supportingIndicators
  const enabledDirectional = signals.filter((signal) => signal.key !== 'atr' && signal.key !== 'adx')
  if (!settings.structure) {
    const bull = enabledDirectional.filter((signal) => signal.direction === 'bullish').length
    const bear = enabledDirectional.filter((signal) => signal.direction === 'bearish').length
    const direction: MarketDirection = bull >= 2 && bull > bear ? '做多' : bear >= 2 && bear > bull ? '做空' : '观望'
    const environment: MarketAnalysis['environment'] = direction === '做多' ? '上升趋势' : direction === '做空' ? '下降趋势' : '过渡整理'
    return { ...result, environment, direction, support: null, resistance: null, stopLoss: null, takeProfit: null, rr: null, status: `${direction === '观望' ? '技术指标方向未形成一致信号，暂时观望' : '按已启用指标综合方向观察'} · 未启用价位结构，暂不提供结构性价位`, indicatorSignals: signals, supportingIndicators: bull + bear, opposingIndicators: 0 }
  }
  const status = votes.length && opposingIndicators > 0 ? `${result.status} · ${supportingIndicators}项支持、${opposingIndicators}项反向，注意指标分歧` : result.status
  return { ...result, status, indicatorSignals: signals, supportingIndicators, opposingIndicators }
}

export function analyzeMultipleTimeframes(candlesByInterval: Partial<Record<AnalysisTimeframe, AnalysisCandle[]>>, livePrice: number | null, activeInterval: AnalysisTimeframe, settings: AnalysisSettings): MultiTimeframeAnalysis {
  const intervals: AnalysisTimeframe[] = ['15m', '1h', '4h', '1d']
  const byTimeframe = Object.fromEntries(intervals.map((interval) => [interval, analyzeMarket(candlesByInterval[interval] ?? [], interval === activeInterval ? livePrice : null, settings)])) as Record<AnalysisTimeframe, MarketAnalysis>
  const weights: Record<AnalysisTimeframe, number> = { '15m': 1, '1h': 2, '4h': 3, '1d': 4 }
  let bullishWeight = 0
  let bearishWeight = 0
  let bullishCount = 0
  let bearishCount = 0
  intervals.forEach((interval) => {
    const analysis = byTimeframe[interval]
    if (analysis.direction === '做多') { bullishWeight += weights[interval]; bullishCount += 1 }
    if (analysis.direction === '做空') { bearishWeight += weights[interval]; bearishCount += 1 }
  })
  const directionalCount = bullishCount + bearishCount
  const direction: MarketDirection = bullishCount >= 2 && bullishWeight > bearishWeight ? '做多' : bearishCount >= 2 && bearishWeight > bullishWeight ? '做空' : '观望'
  const availableCount = intervals.filter((interval) => byTimeframe[interval].environment !== '数据不足').length
  const agreement = availableCount ? Math.round(Math.max(bullishCount, bearishCount) / availableCount * 100) : 0
  const status = !directionalCount
    ? '多周期方向信号不足，等待更多已收盘 K 线或指标信号'
    : directionalCount < 2
      ? '当前只有一个周期给出方向性信号，多周期确认不足'
      : direction === '观望'
        ? '多周期方向相互冲突，综合建议观望'
        : `${bullishCount}个周期偏多、${bearishCount}个周期偏空；高周期权重${bullishWeight > bearishWeight ? '支持做多' : '支持做空'}，一致度${agreement}%`
  return { byTimeframe, direction, agreement, status, bullishWeight, bearishWeight }
}

function calculateMarket(candles: AnalysisCandle[], livePrice: number | null): MarketAnalysis {
  const closed = candles.slice(0, -1)
  const entry = livePrice ?? closed[closed.length - 1]?.close ?? null
  if (closed.length < 35 || entry === null || !Number.isFinite(entry) || entry <= 0) return noAnalysis(entry)

  const recent = closed.slice(-1000)
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

  const ema20 = ema(closes.slice(-200), 20)
  const ema50 = ema(closes.slice(-400), Math.min(50, closes.length))
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
  let rangeTrade: 'long' | 'short' | null = null
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
      rangeTrade = 'long'
      status = '震荡区间下沿收盘反转，参考区间上沿止盈'
    } else if (nearResistance && lastClose < previousClose) {
      direction = '做空'
      rangeTrade = 'short'
      status = '震荡区间上沿收盘反转，参考区间下沿止盈'
    } else {
      status = nearSupport || nearResistance ? '价格靠近区间边缘，等待收盘反转确认' : '价格处于区间中部，暂不追单'
    }
  } else {
    environment = '过渡整理'
    status = '趋势与区间特征交错，等待方向进一步明确'
  }

  if (direction === '观望') return { environment, direction, support, resistance, stopLoss: null, takeProfit: null, entry, status, rr: null, atr, indicatorSignals: [], supportingIndicators: 0, opposingIndicators: 0 }

  const isLong = direction === '做多'
  if (rangeTrade) {
    const boundary = rangeTrade === 'long' ? support : resistance
    const oppositeBoundary = rangeTrade === 'long' ? resistance : support
    const stopLoss = rangeTrade === 'long' ? boundary - atr * 0.35 : boundary + atr * 0.35
    const takeProfit = rangeTrade === 'long' ? oppositeBoundary - atr * 0.12 : oppositeBoundary + atr * 0.12
    const risk = Math.abs(entry - stopLoss)
    const reward = rangeTrade === 'long' ? takeProfit - entry : entry - takeProfit
    const rr = risk > 0 ? reward / risk : 0
    const minimumRangeRiskReward = 1.35

    if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0 || reward <= 0 || rr < minimumRangeRiskReward) {
      return {
        environment,
        direction: '观望',
        support,
        resistance,
        stopLoss: null,
        takeProfit: null,
        entry,
        status: `${status} · 扣除边界缓冲后盈亏空间不足，暂不交易`,
        rr: null,
        atr,
        indicatorSignals: [],
        supportingIndicators: 0,
        opposingIndicators: 0,
      }
    }

    return { environment, direction, support, resistance, stopLoss, takeProfit, entry, status: `${status} · 参考盈亏比 1:${rr.toFixed(1)}`, rr, atr, indicatorSignals: [], supportingIndicators: 0, opposingIndicators: 0 }
  }

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
  return { environment, direction, support, resistance, stopLoss, takeProfit, entry, status: `${status} · 参考盈亏比 1:${rr.toFixed(1)}`, rr, atr, indicatorSignals: [], supportingIndicators: 0, opposingIndicators: 0 }
}
