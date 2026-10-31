import assert from 'node:assert/strict'
import test from 'node:test'
import { assessPrediction, parsePrediction } from '../src/prediction.ts'

const valid = {
  model: 'lightgbm_direction', version: '2026-10-31.1', generatedAt: 1_700_000_100_000, dataThrough: 1_700_000_000,
  interval: '1h', horizonBars: 3, direction: 'UP', probabilityUp: 0.7, probabilityDown: 0.2, probabilityNeutral: 0.1,
  expectedReturnPct: 0.8, expectedLowPct: -0.4, expectedHighPct: 1.7, confidence: 0.72,
}

test('prediction schema accepts calibrated probabilities and rejects malformed values', () => {
  assert.equal(parsePrediction(valid)?.direction, 'UP')
  assert.equal(parsePrediction({ ...valid, probabilityUp: 1.4 }), null)
  assert.equal(parsePrediction({ ...valid, probabilityNeutral: 0.4 }), null)
  assert.equal(parsePrediction({ ...valid, generatedAt: 'now' }), null)
})

test('prediction assessment keeps low-confidence and conflicting signals out of confirmation', () => {
  const prediction = parsePrediction(valid)
  assert.equal(assessPrediction(prediction, '做多')?.state, 'confirmed')
  assert.equal(assessPrediction(prediction, '做空')?.state, 'conflict')
  assert.equal(assessPrediction(prediction, '观望')?.state, 'rule-neutral')
  assert.equal(assessPrediction(parsePrediction({ ...valid, probabilityUp: 0.45, probabilityDown: 0.4, probabilityNeutral: 0.15 }), '做多')?.state, 'low-confidence')
})
