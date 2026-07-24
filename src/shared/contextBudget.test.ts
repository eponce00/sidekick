import { describe, expect, it } from 'vitest'
import {
  calculateContextCapacity,
  calculateRequestBudget,
  estimateTextTokens,
  resolveMaxOutputTokens
} from './contextBudget'

describe('calculateRequestBudget', () => {
  it('applies the compaction threshold after reserving the configured output budget', () => {
    const budget = calculateRequestBudget({
      messages: [],
      tools: [],
      contextLength: 180_000,
      reservedOutputTokens: 32_000,
      compactionThreshold: 0.8
    })

    expect(budget.safetyMarginTokens).toBe(3_600)
    expect(budget.effectiveInputLimit).toBe(144_400)
    expect(budget.compactionTriggerTokens).toBe(115_520)
    expect(budget.compactionTriggerTokens).toBeLessThan(budget.effectiveInputLimit)
  })

  it('exposes the same capacity math for the context indicator', () => {
    expect(
      calculateContextCapacity({
        contextLength: 180_000,
        reservedOutputTokens: 32_000,
        compactionThreshold: 0.8
      })
    ).toEqual({
      contextLength: 180_000,
      reservedOutputTokens: 32_000,
      safetyMarginTokens: 3_600,
      effectiveInputLimit: 144_400,
      compactionTriggerTokens: 115_520
    })
  })

  it('triggers before the usable input budget is exhausted', () => {
    const budget = calculateRequestBudget({
      messages: [{ role: 'user', content: 'x'.repeat(116_000 * 4) }],
      tools: [],
      contextLength: 180_000,
      reservedOutputTokens: 32_000,
      compactionThreshold: 0.8
    })

    expect(budget.requestTokens).toBeLessThan(budget.effectiveInputLimit)
    expect(budget.shouldCompact).toBe(true)
  })

  it('uses the same configured output budget for regular and collaboration runs', () => {
    expect(resolveMaxOutputTokens(180_000, 32_000)).toBe(32_000)
    expect(resolveMaxOutputTokens(180_000, 16_000)).toBe(16_000)
    expect(resolveMaxOutputTokens(180_000)).toBe(32_768)
  })

  it('does not treat dense numeric JSON like ordinary prose', () => {
    const dense = JSON.stringify({
      coordinates: Array.from({ length: 4_000 }, (_, index) => [index / 100, -index / 100])
    })

    expect(estimateTextTokens(dense)).toBeGreaterThan(dense.length / 2)
    expect(estimateTextTokens('ordinary prose with several readable words')).toBeLessThan(20)
  })

  it('applies a positive calibration learned from real provider usage', () => {
    const withoutCalibration = calculateRequestBudget({
      messages: [{ role: 'user', content: 'small estimated prompt' }],
      tools: [],
      contextLength: 8_192,
      reservedOutputTokens: 2_048,
      compactionThreshold: 0.8
    })
    const calibrated = calculateRequestBudget({
      messages: [{ role: 'user', content: 'small estimated prompt' }],
      tools: [],
      contextLength: 8_192,
      reservedOutputTokens: 2_048,
      compactionThreshold: 0.8,
      estimationBiasTokens: withoutCalibration.compactionTriggerTokens
    })

    expect(calibrated.requestTokens).toBeGreaterThan(withoutCalibration.requestTokens)
    expect(calibrated.shouldCompact).toBe(true)
  })
})
