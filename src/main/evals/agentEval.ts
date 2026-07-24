export type AgentEvalCategory =
  | 'provider'
  | 'streaming'
  | 'recovery'
  | 'workspace'
  | 'projects'
  | 'planning'
  | 'collaboration'

export interface AgentEvalScenarioDefinition {
  name: string
  category: AgentEvalCategory
  weight: number
}

export interface AgentEvalMetric {
  name: string
  category?: AgentEvalCategory
  weight?: number
  earnedPoints?: number
  passed: boolean
  latencyMs: number
  promptTokens?: number
  completionTokens?: number
  timeToFirstEventMs?: number
  details?: Record<string, unknown>
  error?: string
}

export interface AgentEvalReport {
  schemaVersion: 3
  endpoint: string
  model: string
  providerKind: string
  suite: string
  scenarioVersion: string
  startedAt: string
  completedAt: string
  runtime: {
    node: string
    platform: NodeJS.Platform
    architecture: string
    revision?: string
  }
  catalog: Record<string, unknown>
  summary: {
    passed: boolean
    passedCases: number
    totalCases: number
    completedScenarios: number
    passRate: number
    earnedPoints: number
    maxPoints: number
    score: number
    medianLatencyMs: number
    p95LatencyMs: number
    byCategory: Record<
      string,
      {
        passedCases: number
        totalCases: number
        passRate: number
        earnedPoints: number
        maxPoints: number
        score: number
      }
    >
  }
  metrics: AgentEvalMetric[]
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

export function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const bounded = Math.min(1, Math.max(0, percentileValue))
  const position = bounded * (sorted.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/** Remove credential-like text before provider errors are written to logs or artifacts. */
export function redactEvalError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  return message
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .slice(0, 2_000)
}

export function safeEvalEndpoint(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return redactEvalError(value).split(/[?#]/, 1)[0]
  }
}

export function createAgentEvalReport(input: {
  endpoint: string
  model: string
  providerKind?: string
  suite?: string
  scenarioVersion?: string
  startedAt: string
  completedAt: string
  catalog?: Record<string, unknown>
  metrics: AgentEvalMetric[]
  plannedMetrics?: AgentEvalScenarioDefinition[]
  revision?: string
}): AgentEvalReport {
  const plannedMetrics =
    input.plannedMetrics ??
    input.metrics.map((metric) => ({
      name: metric.name,
      category: metric.category || 'provider',
      weight: metric.weight ?? 1
    }))
  const metricByName = new Map(input.metrics.map((metric) => [metric.name, metric]))
  const passedCases = plannedMetrics.filter(
    (planned) => metricByName.get(planned.name)?.passed
  ).length
  const earnedPoints = plannedMetrics.reduce(
    (total, planned) => total + (metricByName.get(planned.name)?.passed ? planned.weight : 0),
    0
  )
  const maxPoints = plannedMetrics.reduce((total, planned) => total + planned.weight, 0)
  const latencies = input.metrics.map((metric) => metric.latencyMs)
  const byCategory: AgentEvalReport['summary']['byCategory'] = {}
  for (const planned of plannedMetrics) {
    const category = planned.category
    const current = byCategory[category] || {
      passedCases: 0,
      totalCases: 0,
      passRate: 0,
      earnedPoints: 0,
      maxPoints: 0,
      score: 0
    }
    current.totalCases += 1
    current.maxPoints += planned.weight
    if (metricByName.get(planned.name)?.passed) {
      current.passedCases += 1
      current.earnedPoints += planned.weight
    }
    current.passRate = rounded(current.passedCases / current.totalCases)
    current.score = current.maxPoints
      ? rounded((current.earnedPoints / current.maxPoints) * 100)
      : 0
    byCategory[category] = current
  }
  const metrics = input.metrics.map((metric) => {
    const planned = plannedMetrics.find((candidate) => candidate.name === metric.name)
    const weight = planned?.weight ?? metric.weight ?? 1
    return {
      ...metric,
      category: planned?.category ?? metric.category,
      weight,
      earnedPoints: metric.passed ? weight : 0
    }
  })
  return {
    schemaVersion: 3,
    endpoint: safeEvalEndpoint(input.endpoint),
    model: input.model,
    providerKind: input.providerKind || 'unknown',
    suite: input.suite || 'full',
    scenarioVersion: input.scenarioVersion || '1',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      revision: input.revision || undefined
    },
    catalog: input.catalog || {},
    summary: {
      passed: plannedMetrics.length > 0 && passedCases === plannedMetrics.length,
      passedCases,
      totalCases: plannedMetrics.length,
      completedScenarios: input.metrics.length,
      passRate: plannedMetrics.length ? rounded(passedCases / plannedMetrics.length) : 0,
      earnedPoints: rounded(earnedPoints),
      maxPoints: rounded(maxPoints),
      score: maxPoints ? rounded((earnedPoints / maxPoints) * 100) : 0,
      medianLatencyMs: rounded(percentile(latencies, 0.5)),
      p95LatencyMs: rounded(percentile(latencies, 0.95)),
      byCategory
    },
    metrics
  }
}
