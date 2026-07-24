import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import {
  normalizeAgentPlanCompletion,
  normalizeAgentPlanContract,
  type AgentPlanCompletion,
  type AgentPlanContract,
  type AgentPlanRecord,
  type AgentPlanReview,
  type AgentPlanStage
} from '../../shared/agentPlans'
import type { TodoItem } from '../../shared/types'

interface AgentPlanRow {
  run_id: string
  stage: AgentPlanStage
  planner_model: string
  executor_model: string
  revision: string | null
  contract_json: string | null
  completion_json: string | null
  updated_at: number
}

export interface AgentPlanTerminalDecision {
  continue: boolean
  prompt?: string
  error?: string
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

function mapRow(row: AgentPlanRow): AgentPlanRecord {
  return {
    runId: row.run_id,
    stage: row.stage,
    plannerModel: row.planner_model,
    executorModel: row.executor_model,
    ...(row.revision ? { revision: row.revision } : {}),
    ...(row.contract_json ? { contract: parseJson<AgentPlanContract>(row.contract_json) } : {}),
    ...(row.completion_json
      ? { completion: parseJson<AgentPlanCompletion>(row.completion_json) }
      : {}),
    updatedAt: row.updated_at
  }
}

function revisionFor(contract: AgentPlanContract): string {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex').slice(0, 24)
}

export class AgentPlanService {
  private stageValue: AgentPlanStage
  private planningTerminalAttempts = 0
  private completionTerminalAttempts = 0

  constructor(
    private readonly db: Database.Database,
    private readonly runId: string,
    private readonly plannerModel: string,
    private readonly executorModel: string,
    initialStage: AgentPlanStage
  ) {
    this.stageValue = initialStage
  }

  stage(): AgentPlanStage {
    return this.stageValue
  }

  get(): AgentPlanRecord | null {
    const row = this.db
      .prepare('SELECT * FROM agent_run_plans WHERE run_id = ?')
      .get(this.runId) as AgentPlanRow | undefined
    return row ? mapRow(row) : null
  }

  private persist(
    stage: AgentPlanStage,
    revision?: string,
    contract?: AgentPlanContract,
    completion?: AgentPlanCompletion
  ): void {
    this.stageValue = stage
    this.db
      .prepare(
        `INSERT INTO agent_run_plans
         (run_id, stage, planner_model, executor_model, revision, contract_json,
          completion_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           stage = excluded.stage,
           planner_model = excluded.planner_model,
           executor_model = excluded.executor_model,
           revision = excluded.revision,
           contract_json = COALESCE(excluded.contract_json, agent_run_plans.contract_json),
           completion_json = excluded.completion_json,
           updated_at = excluded.updated_at`
      )
      .run(
        this.runId,
        stage,
        this.plannerModel,
        this.executorModel,
        revision ?? null,
        contract ? JSON.stringify(contract) : null,
        completion ? JSON.stringify(completion) : null,
        Date.now()
      )
  }

  enter(): void {
    this.planningTerminalAttempts = 0
    this.persist('planning')
  }

  prepareReview(value: unknown): AgentPlanReview {
    const contract = normalizeAgentPlanContract(value)
    const revision = revisionFor(contract)
    this.planningTerminalAttempts = 0
    this.persist('planning', revision, contract)
    return {
      revision,
      contract,
      plannerModel: this.plannerModel,
      executorModel: this.executorModel
    }
  }

  approve(revision: string): AgentPlanReview {
    const record = this.requireRevision(revision)
    const contract = record.contract!
    const todos: TodoItem[] = contract.steps.map((step, index) => ({
      id: index + 1,
      title: step.title,
      description: step.description,
      status: index === 0 ? 'in-progress' : 'not-started'
    }))
    this.db
      .prepare(
        `INSERT INTO agent_run_todos (run_id, todo_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET todo_json = excluded.todo_json, updated_at = excluded.updated_at`
      )
      .run(this.runId, JSON.stringify(todos), Date.now())
    this.completionTerminalAttempts = 0
    this.persist('executing', record.revision, contract)
    return {
      revision: record.revision!,
      contract,
      plannerModel: record.plannerModel,
      executorModel: record.executorModel
    }
  }

  revise(revision: string): AgentPlanReview {
    const record = this.requireRevision(revision)
    this.planningTerminalAttempts = 0
    this.persist('planning', record.revision, record.contract)
    return {
      revision: record.revision!,
      contract: record.contract!,
      plannerModel: record.plannerModel,
      executorModel: record.executorModel
    }
  }

  keep(revision: string): AgentPlanReview {
    const record = this.requireRevision(revision)
    this.persist('kept', record.revision, record.contract)
    return {
      revision: record.revision!,
      contract: record.contract!,
      plannerModel: record.plannerModel,
      executorModel: record.executorModel
    }
  }

  complete(value: unknown): {
    accepted: boolean
    errors: string[]
    completion?: AgentPlanCompletion
  } {
    let completion: AgentPlanCompletion
    try {
      completion = normalizeAgentPlanCompletion(value)
    } catch (error) {
      return { accepted: false, errors: [error instanceof Error ? error.message : String(error)] }
    }
    const record = this.get()
    if (!record?.contract || !record.revision || record.stage !== 'executing') {
      return { accepted: false, errors: ['No approved plan is currently being executed'] }
    }
    const errors: string[] = []
    if (completion.revision !== record.revision) errors.push('The plan revision is stale')
    const results = new Map(completion.requirements.map((item) => [item.id, item]))
    for (const requirement of record.contract.requirements) {
      const result = results.get(requirement.id)
      if (!result) errors.push(`Missing completion evidence for ${requirement.id}`)
      else if (result.status !== 'passed') {
        errors.push(`Approved requirement ${requirement.id} did not pass`)
      } else if (!result.evidence.trim())
        errors.push(`Completion evidence is empty for ${requirement.id}`)
    }
    for (const result of completion.requirements) {
      if (!record.contract.requirements.some(({ id }) => id === result.id)) {
        errors.push(`Completion references unknown requirement ${result.id}`)
      }
    }
    const todoRow = this.db
      .prepare('SELECT todo_json FROM agent_run_todos WHERE run_id = ?')
      .get(this.runId) as { todo_json: string } | undefined
    const todos = parseJson<TodoItem[]>(todoRow?.todo_json ?? null) ?? []
    const missingPlanSteps = record.contract.steps.filter(
      (step, index) =>
        !todos.some((todo) => todo.id === index + 1 && todo.title.trim() === step.title.trim())
    )
    if (missingPlanSteps.length) {
      errors.push(
        `${missingPlanSteps.length} approved plan step(s) are missing from the durable todo list`
      )
    }
    const unfinished = todos.filter((todo) => todo.status !== 'completed')
    if (unfinished.length) {
      errors.push(`${unfinished.length} approved plan step(s) are still unfinished`)
    }
    if (errors.length) return { accepted: false, errors }
    this.persist('executing', record.revision, record.contract, completion)
    return { accepted: true, errors: [], completion }
  }

  afterTerminalTurn(): AgentPlanTerminalDecision {
    if (this.stageValue === 'planning') {
      this.planningTerminalAttempts++
      if (this.planningTerminalAttempts <= 2) {
        return {
          continue: true,
          prompt:
            'You are still in Plan mode. Do not finish with prose alone. Use present_plan with a structured contract containing verifiable requirements, concrete steps, and proportionate completion checks so the user can review it.'
        }
      }
      return {
        continue: false,
        error: 'The planner did not produce a reviewable plan contract after two reminders.'
      }
    }
    if (this.stageValue !== 'executing') return { continue: false }
    const record = this.get()
    if (record?.completion) return { continue: false }
    this.completionTerminalAttempts++
    if (this.completionTerminalAttempts <= 2) {
      return {
        continue: true,
        prompt:
          'The approved plan contract is not complete yet. Finish every remaining plan step, run the proportionate verification checks, update the todo list, then call complete_plan with evidence for every requirement before giving the final response.'
      }
    }
    return {
      continue: false,
      error:
        'The executor stopped without completing the approved plan contract after two reminders.'
    }
  }

  private requireRevision(revision: string): AgentPlanRecord {
    const record = this.get()
    if (!record?.contract || !record.revision) throw new Error('No plan contract is available')
    if (revision !== record.revision)
      throw new Error('The plan changed; review the latest revision')
    return record
  }
}
