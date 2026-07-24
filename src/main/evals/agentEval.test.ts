import { describe, expect, it } from 'vitest'
import { createAgentEvalReport, percentile, redactEvalError, safeEvalEndpoint } from './agentEval'

describe('agent evaluation reports', () => {
  it('calculates deterministic pass and latency summaries', () => {
    expect(percentile([40, 10, 20, 30], 0.5)).toBe(25)
    expect(percentile([40, 10, 20, 30], 0.95)).toBeCloseTo(38.5)

    const report = createAgentEvalReport({
      endpoint: 'https://example.test/v1',
      model: 'test-model',
      providerKind: 'litellm',
      suite: 'full',
      scenarioVersion: '2026-07-21',
      startedAt: '2026-07-20T00:00:00.000Z',
      completedAt: '2026-07-20T00:00:01.000Z',
      plannedMetrics: [
        { name: 'completion', category: 'provider', weight: 20 },
        { name: 'tool-loop', category: 'workspace', weight: 30 },
        { name: 'follow-up', category: 'collaboration', weight: 50 }
      ],
      metrics: [
        { name: 'completion', category: 'provider', passed: true, latencyMs: 10 },
        {
          name: 'tool-loop',
          category: 'workspace',
          passed: false,
          latencyMs: 40,
          error: 'failed'
        }
      ]
    })

    expect(report.schemaVersion).toBe(3)
    expect(report.summary).toEqual({
      passed: false,
      passedCases: 1,
      totalCases: 3,
      completedScenarios: 2,
      passRate: 0.33,
      earnedPoints: 20,
      maxPoints: 100,
      score: 20,
      medianLatencyMs: 25,
      p95LatencyMs: 38.5,
      byCategory: {
        provider: {
          passedCases: 1,
          totalCases: 1,
          passRate: 1,
          earnedPoints: 20,
          maxPoints: 20,
          score: 100
        },
        workspace: {
          passedCases: 0,
          totalCases: 1,
          passRate: 0,
          earnedPoints: 0,
          maxPoints: 30,
          score: 0
        },
        collaboration: {
          passedCases: 0,
          totalCases: 1,
          passRate: 0,
          earnedPoints: 0,
          maxPoints: 50,
          score: 0
        }
      }
    })
    expect(report.metrics.map(({ weight, earnedPoints }) => ({ weight, earnedPoints }))).toEqual([
      { weight: 20, earnedPoints: 20 },
      { weight: 30, earnedPoints: 0 }
    ])
  })

  it('redacts API-key-shaped values from recorded errors', () => {
    expect(redactEvalError('Bearer private-token and sk-example_1234567890')).toBe(
      'Bearer [REDACTED] and sk-[REDACTED]'
    )
    expect(safeEvalEndpoint('https://user:password@example.test/v1?token=private')).toBe(
      'https://example.test/v1'
    )
  })
})
