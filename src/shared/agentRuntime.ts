import type { AgentToolDefinition } from './agentToolDefinitions'
import type { ToolRisk } from './types'

export const AGENT_RUN_SURFACES = ['conversation', 'collaboration', 'subagent', 'research'] as const

export type AgentRunSurface = (typeof AGENT_RUN_SURFACES)[number]

export const AGENT_EXECUTION_MODES = ['act', 'plan'] as const

export type AgentExecutionMode = (typeof AGENT_EXECUTION_MODES)[number]

export const AGENT_CAPABILITIES = [
  'workspace.read',
  'workspace.write',
  'code.intelligence',
  'command.execute',
  'command.background',
  'wait',
  'web.search',
  'web.images',
  'web.fetch',
  'mcp',
  'skills',
  'todo',
  'artifacts',
  'subagents',
  'collaboration',
  'goal',
  'plan',
  'tool.output'
] as const

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number]

export type AgentExecutionHost = 'main'

export interface AgentToolCatalogEntry {
  definition: AgentToolDefinition
  capability: AgentCapability
  risk: ToolRisk
  host: AgentExecutionHost
}

export interface AgentRunProfile {
  surface: AgentRunSurface
  executionMode: AgentExecutionMode
  capabilities: readonly AgentCapability[]
}

export const TOOL_EXECUTION_STATUSES = [
  'pending',
  'running',
  'success',
  'error',
  'cancelled',
  'denied'
] as const

export type ToolExecutionStatus = (typeof TOOL_EXECUTION_STATUSES)[number]

export const TOOL_ERROR_CODES = [
  'invalid_arguments',
  'unknown_tool',
  'not_found',
  'permission_denied',
  'workspace_scope',
  'stale_read',
  'conflict',
  'timeout',
  'cancelled',
  'unsupported',
  'output_truncated',
  'command_failed',
  'transient',
  'loop_detected',
  'internal'
] as const

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

export const TOOL_RECOVERY_ACTIONS = [
  'correct_input',
  'refresh_state',
  'retry_later',
  'change_strategy',
  'stop'
] as const

export type ToolRecoveryAction = (typeof TOOL_RECOVERY_ACTIONS)[number]

export interface ToolExecutionError {
  code: ToolErrorCode
  message: string
  /** Whether another attempt may succeed after following recoveryAction. */
  retryable: boolean
  /** Machine-readable instruction for the next model step. */
  recoveryAction: ToolRecoveryAction
  recovery?: string
}

export interface ToolOutputReference {
  truncated: boolean
  originalBytes?: number
  returnedBytes?: number
  originalEstimatedTokens?: number
  returnedEstimatedTokens?: number
  fullOutputHandle?: string
  continuation?: Record<string, unknown>
}

export interface ToolDiagnostic {
  severity: 'error' | 'warning' | 'information' | 'hint'
  message: string
  filePath?: string
  line?: number
  column?: number
  source?: string
  code?: string
  state?: 'new' | 'existing' | 'resolved'
}

export interface ToolWorkspaceChange {
  path: string
  kind: 'create' | 'update' | 'delete' | 'move'
  previousPath?: string
  beforeHash?: string
  afterHash?: string
}

export interface ToolExecutionTiming {
  startedAt: number
  completedAt: number
}

export interface ToolExecutionResult<TData = unknown> {
  status: Extract<ToolExecutionStatus, 'success' | 'error' | 'cancelled' | 'denied'>
  title: string
  modelContent: string
  data?: TData
  error?: ToolExecutionError
  output?: ToolOutputReference
  diagnostics?: ToolDiagnostic[]
  changes?: ToolWorkspaceChange[]
  timing: ToolExecutionTiming
}

export interface AgentToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export const AGENT_RUN_EVENT_TYPES = [
  'run.started',
  'run.phase',
  'assistant.delta',
  'assistant.completed',
  'tool.pending',
  'tool.running',
  'tool.completed',
  'permission.requested',
  'permission.resolved',
  'question.requested',
  'question.resolved',
  'usage.updated',
  'compaction.started',
  'compaction.completed',
  'verification.updated',
  'plan.mode_changed',
  'run.retrying',
  'run.steered',
  'run.completed',
  'run.finalized'
] as const

export type AgentRunEventType = (typeof AGENT_RUN_EVENT_TYPES)[number]

export interface AgentRunEvent<TPayload = Record<string, unknown>> {
  id: string
  runId: string
  sequence: number
  type: AgentRunEventType
  timestamp: number
  payload: TPayload
}

/** True when a run began in Plan mode or entered it after a model recommendation. */
export function agentRunUsesPlan(events: readonly AgentRunEvent[]): boolean {
  return events.some(
    (event) =>
      (event.type === 'run.started' && event.payload.executionMode === 'plan') ||
      (event.type === 'plan.mode_changed' && event.payload.to === 'plan')
  )
}

export interface AgentRunSnapshot {
  id: string
  threadId: string
  surface: AgentRunSurface
  executionMode: AgentExecutionMode
  phase:
    | 'queued'
    | 'streaming'
    | 'awaiting_permission'
    | 'awaiting_user'
    | 'executing_tool'
    | 'compacting'
    | 'stopping'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
  provider: string
  model: string
  lastSequence: number
  startedAt: number
  updatedAt: number
  completedAt?: number
  error?: ToolExecutionError
}

export type AgentRunPhase = AgentRunSnapshot['phase']

export interface StartAgentRunInput {
  id: string
  threadId: string
  parentRunId?: string
  profile: AgentRunProfile
  provider: string
  model: string
  workspaceRoot?: string
  /** Durable message/artifact that receives the final projected run output. */
  outputMessageId?: string
  promptContext?: Record<string, unknown>
}

export interface AppendAgentRunEventInput<TPayload = Record<string, unknown>> {
  id: string
  runId: string
  type: AgentRunEventType
  payload: TPayload
  timestamp?: number
}

export type PendingInteractionKind = 'permission' | 'question' | 'tool_limit' | 'plan_approval'

export interface PendingAgentInteraction {
  id: string
  runId: string
  kind: PendingInteractionKind
  status: 'pending' | 'resolved' | 'cancelled'
  request: Record<string, unknown>
  response?: Record<string, unknown>
  createdAt: number
  resolvedAt?: number
}

export interface CreateAgentInteractionInput {
  id: string
  runId: string
  kind: PendingInteractionKind
  request: Record<string, unknown>
}

function stringifyModelContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function failureFromUnknown(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.ok === false ||
    record.success === false ||
    record.cancelled === true ||
    (typeof record.error === 'string' && record.error.length > 0)
  )
}

function defaultRecoveryAction(
  code: ToolErrorCode,
  retryable: boolean | undefined
): ToolRecoveryAction {
  if (code === 'invalid_arguments') return 'correct_input'
  if (code === 'stale_read' || code === 'conflict') return 'refresh_state'
  if (code === 'timeout' || code === 'transient') return 'retry_later'
  if (
    code === 'unknown_tool' ||
    code === 'not_found' ||
    code === 'workspace_scope' ||
    code === 'unsupported' ||
    code === 'command_failed' ||
    code === 'output_truncated'
  ) {
    return 'change_strategy'
  }
  if (code === 'permission_denied' || code === 'cancelled' || code === 'loop_detected') {
    return 'stop'
  }
  return retryable ? 'retry_later' : 'stop'
}

export function toolExecutionSucceeded<TData>(input: {
  title: string
  data?: TData
  modelContent?: string
  output?: ToolOutputReference
  diagnostics?: ToolDiagnostic[]
  changes?: ToolWorkspaceChange[]
  startedAt?: number
  completedAt?: number
}): ToolExecutionResult<TData> {
  const startedAt = input.startedAt ?? Date.now()
  const completedAt = input.completedAt ?? Date.now()
  return {
    status: 'success',
    title: input.title,
    modelContent: input.modelContent ?? stringifyModelContent(input.data),
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.output ? { output: input.output } : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    ...(input.changes ? { changes: input.changes } : {}),
    timing: { startedAt, completedAt }
  }
}

export function toolExecutionFailed(input: {
  title: string
  code: ToolErrorCode
  message: string
  retryable?: boolean
  recoveryAction?: ToolRecoveryAction
  recovery?: string
  data?: unknown
  modelContent?: string
  output?: ToolOutputReference
  status?: 'error' | 'cancelled' | 'denied'
  startedAt?: number
  completedAt?: number
}): ToolExecutionResult {
  const startedAt = input.startedAt ?? Date.now()
  const completedAt = input.completedAt ?? Date.now()
  const error: ToolExecutionError = {
    code: input.code,
    message: input.message,
    retryable: input.retryable ?? false,
    recoveryAction: input.recoveryAction ?? defaultRecoveryAction(input.code, input.retryable),
    ...(input.recovery ? { recovery: input.recovery } : {})
  }
  const data =
    input.data ??
    ({
      ok: false,
      success: false,
      error: input.message,
      code: input.code,
      retryable: error.retryable,
      recoveryAction: error.recoveryAction,
      ...(input.recovery ? { recovery: input.recovery } : {})
    } satisfies Record<string, unknown>)
  return {
    status: input.status ?? 'error',
    title: input.title,
    modelContent: input.modelContent ?? stringifyModelContent(data),
    data,
    error,
    ...(input.output ? { output: input.output } : {}),
    timing: { startedAt, completedAt }
  }
}

export function normalizeToolExecutionResult(
  title: string,
  value: unknown,
  startedAt = Date.now(),
  completedAt = Date.now()
): ToolExecutionResult {
  if (isToolExecutionResult(value)) return value
  if (failureFromUnknown(value)) {
    const record = value as Record<string, unknown>
    const message =
      typeof record.error === 'string' && record.error
        ? record.error
        : record.cancelled === true
          ? 'Tool execution was cancelled'
          : 'Tool execution failed'
    return toolExecutionFailed({
      title,
      code: record.cancelled === true ? 'cancelled' : 'internal',
      message,
      status: record.cancelled === true ? 'cancelled' : 'error',
      data: value,
      startedAt,
      completedAt
    })
  }
  return toolExecutionSucceeded({ title, data: value, startedAt, completedAt })
}

export function isToolExecutionResult(value: unknown): value is ToolExecutionResult {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const timing = record.timing as Record<string, unknown> | undefined
  return (
    ['success', 'error', 'cancelled', 'denied'].includes(String(record.status)) &&
    typeof record.title === 'string' &&
    typeof record.modelContent === 'string' &&
    Boolean(
      timing && typeof timing.startedAt === 'number' && typeof timing.completedAt === 'number'
    )
  )
}

export function hasAgentCapability(profile: AgentRunProfile, capability: AgentCapability): boolean {
  return profile.capabilities.includes(capability)
}
