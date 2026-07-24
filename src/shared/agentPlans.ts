export const AGENT_PLAN_STAGES = ['inactive', 'planning', 'executing', 'kept'] as const

export type AgentPlanStage = (typeof AGENT_PLAN_STAGES)[number]

export interface AgentPlanRequirement {
  id: string
  outcome: string
  acceptance: string
}

export interface AgentPlanStep {
  id: string
  title: string
  description: string
  requirementIds: string[]
  files?: string[]
}

export interface AgentPlanVerification {
  id: string
  description: string
  expected: string
  requirementIds: string[]
  command?: string
}

export interface AgentPlanContract {
  title: string
  objective: string
  summary: string
  requirements: AgentPlanRequirement[]
  steps: AgentPlanStep[]
  verification: AgentPlanVerification[]
  risks?: string[]
}

export interface AgentPlanRequirementResult {
  id: string
  status: 'passed' | 'not_applicable'
  evidence: string
}

export interface AgentPlanCompletion {
  revision: string
  summary: string
  requirements: AgentPlanRequirementResult[]
}

export interface AgentPlanRecord {
  runId: string
  stage: AgentPlanStage
  plannerModel: string
  executorModel: string
  revision?: string
  contract?: AgentPlanContract
  completion?: AgentPlanCompletion
  updatedAt: number
}

export interface AgentPlanReview {
  revision: string
  contract: AgentPlanContract
  plannerModel: string
  executorModel: string
}

export type AgentPlanReviewAction = 'approve' | 'revise' | 'keep'

const MAX_TEXT = 4_000
const MAX_ITEMS = 50

function requiredText(value: unknown, field: string, maxLength = MAX_TEXT): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim().slice(0, maxLength)
}

function optionalStrings(value: unknown, maximum = MAX_ITEMS): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .slice(0, maximum)
    .map((item) => item.trim().slice(0, 1_000))
  return strings.length ? strings : undefined
}

function uniqueIds<T extends { id: string }>(items: T[], field: string): T[] {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`${field} contains duplicate id ${item.id}`)
    seen.add(item.id)
  }
  return items
}

export function normalizeAgentPlanContract(value: unknown): AgentPlanContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plan must be an object')
  }
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.requirements) || input.requirements.length === 0) {
    throw new Error('plan.requirements must contain at least one verifiable outcome')
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error('plan.steps must contain at least one implementation step')
  }
  if (!Array.isArray(input.verification) || input.verification.length === 0) {
    throw new Error('plan.verification must contain at least one completion check')
  }

  const requirements = uniqueIds(
    input.requirements.slice(0, MAX_ITEMS).map((raw, index) => {
      const item = (raw ?? {}) as Record<string, unknown>
      return {
        id: requiredText(item.id, `requirements[${index}].id`, 80),
        outcome: requiredText(item.outcome, `requirements[${index}].outcome`),
        acceptance: requiredText(item.acceptance, `requirements[${index}].acceptance`)
      }
    }),
    'requirements'
  )
  const requirementIds = new Set(requirements.map(({ id }) => id))
  const normalizeRequirementIds = (value: unknown, field: string): string[] => {
    const ids = optionalStrings(value) ?? []
    if (!ids.length) throw new Error(`${field} must reference at least one requirement`)
    for (const id of ids) {
      if (!requirementIds.has(id)) throw new Error(`${field} references unknown requirement ${id}`)
    }
    return [...new Set(ids)]
  }
  const steps = uniqueIds(
    input.steps.slice(0, MAX_ITEMS).map((raw, index) => {
      const item = (raw ?? {}) as Record<string, unknown>
      const files = optionalStrings(item.files, 30)
      return {
        id: requiredText(item.id, `steps[${index}].id`, 80),
        title: requiredText(item.title, `steps[${index}].title`, 300),
        description: requiredText(item.description, `steps[${index}].description`),
        requirementIds: normalizeRequirementIds(
          item.requirement_ids ?? item.requirementIds,
          `steps[${index}].requirement_ids`
        ),
        ...(files ? { files } : {})
      }
    }),
    'steps'
  )
  const verification = uniqueIds(
    input.verification.slice(0, MAX_ITEMS).map((raw, index) => {
      const item = (raw ?? {}) as Record<string, unknown>
      return {
        id: requiredText(item.id, `verification[${index}].id`, 80),
        description: requiredText(item.description, `verification[${index}].description`),
        expected: requiredText(item.expected, `verification[${index}].expected`),
        requirementIds: normalizeRequirementIds(
          item.requirement_ids ?? item.requirementIds,
          `verification[${index}].requirement_ids`
        ),
        ...(typeof item.command === 'string' && item.command.trim()
          ? { command: item.command.trim().slice(0, 2_000) }
          : {})
      }
    }),
    'verification'
  )
  for (const requirement of requirements) {
    if (!steps.some((step) => step.requirementIds.includes(requirement.id))) {
      throw new Error(`requirement ${requirement.id} is not covered by an implementation step`)
    }
    if (!verification.some((check) => check.requirementIds.includes(requirement.id))) {
      throw new Error(`requirement ${requirement.id} is not covered by a verification check`)
    }
  }
  const risks = optionalStrings(input.risks, 20)

  return {
    title: requiredText(input.title, 'plan.title', 300),
    objective: requiredText(input.objective, 'plan.objective'),
    summary: requiredText(input.summary, 'plan.summary'),
    requirements,
    steps,
    verification,
    ...(risks ? { risks } : {})
  }
}

export function normalizeAgentPlanCompletion(value: unknown): AgentPlanCompletion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('completion must be an object')
  }
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.requirements) || input.requirements.length === 0) {
    throw new Error('completion.requirements must contain evidence for every requirement')
  }
  return {
    revision: requiredText(input.revision, 'completion.revision', 128),
    summary: requiredText(input.summary, 'completion.summary'),
    requirements: uniqueIds(
      input.requirements.slice(0, MAX_ITEMS).map((raw, index) => {
        const item = (raw ?? {}) as Record<string, unknown>
        if (item.status !== 'passed' && item.status !== 'not_applicable') {
          throw new Error(
            `completion.requirements[${index}].status must be passed or not_applicable`
          )
        }
        return {
          id: requiredText(item.id, `completion.requirements[${index}].id`, 80),
          status: item.status,
          evidence: requiredText(item.evidence, `completion.requirements[${index}].evidence`)
        }
      }),
      'completion.requirements'
    )
  }
}
