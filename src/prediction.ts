export type PredictionDirection = 'UP' | 'DOWN' | 'NEUTRAL'

export type PredictionResult = {
  model: string
  version: string
  generatedAt: number
  dataThrough: number
  interval: string
  horizonBars: number
  direction: PredictionDirection
  probabilityUp: number
  probabilityDown: number
  probabilityNeutral: number
  expectedReturnPct: number | null
  expectedLowPct: number | null
  expectedHighPct: number | null
  confidence: number
}

export type PredictionAssessment = {
  state: 'confirmed' | 'conflict' | 'low-confidence' | 'rule-neutral'
  label: string
  detail: string
}

function finiteProbability(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function nullableFinite(value: unknown) {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/** Validate the strict response returned by the local prediction service. */
export function parsePrediction(value: unknown): PredictionResult | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PredictionResult>
  if (typeof candidate.model !== 'string' || !candidate.model.trim()) return null
  if (typeof candidate.version !== 'string' || !candidate.version.trim()) return null
  if (typeof candidate.generatedAt !== 'number' || !Number.isFinite(candidate.generatedAt) || candidate.generatedAt <= 0) return null
  if (typeof candidate.dataThrough !== 'number' || !Number.isFinite(candidate.dataThrough) || candidate.dataThrough <= 0) return null
  if (typeof candidate.interval !== 'string' || !candidate.interval.trim()) return null
  const horizonBars = candidate.horizonBars
  if (typeof horizonBars !== 'number' || !Number.isInteger(horizonBars) || horizonBars < 1 || horizonBars > 100) return null
  if (!['UP', 'DOWN', 'NEUTRAL'].includes(candidate.direction ?? '')) return null
  if (![candidate.probabilityUp, candidate.probabilityDown, candidate.probabilityNeutral].every(finiteProbability)) return null
  if (!nullableFinite(candidate.expectedReturnPct) || !nullableFinite(candidate.expectedLowPct) || !nullableFinite(candidate.expectedHighPct)) return null
  if (!finiteProbability(candidate.confidence)) return null
  const probabilityTotal = Number(candidate.probabilityUp) + Number(candidate.probabilityDown) + Number(candidate.probabilityNeutral)
  if (Math.abs(probabilityTotal - 1) > 0.025) return null
  return {
    model: candidate.model.trim(),
    version: candidate.version.trim(),
    generatedAt: Number(candidate.generatedAt),
    dataThrough: Number(candidate.dataThrough),
    interval: candidate.interval.trim(),
    horizonBars: Number(horizonBars),
    direction: candidate.direction as PredictionDirection,
    probabilityUp: Number(candidate.probabilityUp),
    probabilityDown: Number(candidate.probabilityDown),
    probabilityNeutral: Number(candidate.probabilityNeutral),
    expectedReturnPct: candidate.expectedReturnPct === null ? null : Number(candidate.expectedReturnPct),
    expectedLowPct: candidate.expectedLowPct === null ? null : Number(candidate.expectedLowPct),
    expectedHighPct: candidate.expectedHighPct === null ? null : Number(candidate.expectedHighPct),
    confidence: Number(candidate.confidence),
  }
}

export function assessPrediction(prediction: PredictionResult | null, ruleDirection: '做多' | '做空' | '观望'): PredictionAssessment | null {
  if (!prediction) return null
  const probabilities = [prediction.probabilityUp, prediction.probabilityDown, prediction.probabilityNeutral].sort((left, right) => right - left)
  const directionalProbability = prediction.direction === 'UP' ? prediction.probabilityUp : prediction.direction === 'DOWN' ? prediction.probabilityDown : prediction.probabilityNeutral
  const margin = probabilities[0] - probabilities[1]
  if (prediction.direction === 'NEUTRAL' || directionalProbability < 0.55 || prediction.confidence < 0.55 || margin < 0.08) {
    return { state: 'low-confidence', label: '模型信号偏弱', detail: '方向概率或置信度不足，不能作为独立交易依据' }
  }
  if (ruleDirection === '观望') {
    return { state: 'rule-neutral', label: '规则分析仍建议观望', detail: '模型给出方向，但结构分析尚未确认，继续等待价格确认' }
  }
  const sameDirection = (ruleDirection === '做多' && prediction.direction === 'UP') || (ruleDirection === '做空' && prediction.direction === 'DOWN')
  if (sameDirection) return { state: 'confirmed', label: '模型与规则同向', detail: '方向一致，但预测仍属于概率结果，不代表确定走势' }
  return { state: 'conflict', label: '模型与规则冲突', detail: '两个判断来源方向不一致，综合建议观望' }
}
