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
  'tool.output',
  'browser'
] as const

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number]

export type AgentExecutionHost = 'main' | 'subprocess'

export type AgentToolConcurrency = 'parallel' | 'exclusive'

export const TOOL_PRESENTATION_KINDS = [
  'generic',
  'terminal',
  'read',
  'diff',
  'search',
  'web',
  'files',
  'artifact',
  'task',
  'subagent',
  'browser'
] as const

export type ToolPresentationKind = (typeof TOOL_PRESENTATION_KINDS)[number]

/** Renderer-neutral description recorded with a tool call and its result. */
export interface ToolPresentationIntent {
  kind: ToolPresentationKind
  title: string
  subject?: string
  detail?: string
}

export interface AgentToolPresentationDefinition {
  kind: ToolPresentationKind
  call: (args: Readonly<Record<string, unknown>>) => ToolPresentationIntent
  result?: (
    args: Readonly<Record<string, unknown>>,
    result: Readonly<ToolExecutionResult>
  ) => ToolPresentationIntent
}

export interface AgentToolCatalogEntry {
  definition: AgentToolDefinition
  capability: AgentCapability
  risk: ToolRisk
  host: AgentExecutionHost
  /** Host-owned deadline. This metadata is never sent to the model. */
  timeoutMs?: number
  /** Only explicitly safe read operations may overlap sibling calls. */
  concurrency: AgentToolConcurrency
  /** Owns human presentation so the renderer never has to infer semantics from command text. */
  presentation: AgentToolPresentationDefinition
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

export const TOOL_RESULT_MEDIA_TYPES = ['image'] as const

export type ToolResultMediaType = (typeof TOOL_RESULT_MEDIA_TYPES)[number]

export const TOOL_RESULT_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
] as const

export type ToolResultImageMimeType = (typeof TOOL_RESULT_IMAGE_MIME_TYPES)[number]

export const MAX_TOOL_RESULT_MEDIA = 4
export const MAX_TOOL_RESULT_MEDIA_BYTES = 8 * 1024 * 1024
export const MAX_TOOL_RESULT_MEDIA_DATA_URL_LENGTH =
  Math.ceil((MAX_TOOL_RESULT_MEDIA_BYTES * 4) / 3) + 256

export type ToolResultMediaSource =
  | {
      type: 'data_url'
      dataUrl: string
    }
  | {
      /** Absolute host path to a durable artifact resolved immediately before provider I/O. */
      type: 'file'
      path: string
    }

/**
 * Typed non-text output from a first-party tool. Tool media is part of the durable
 * result ledger; provider adapters materialize it into their native multimodal form.
 */
export interface ToolResultMediaAttachment {
  type: 'image'
  mimeType: ToolResultImageMimeType
  source: ToolResultMediaSource
  name?: string
  description?: string
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
  media?: ToolResultMediaAttachment[]
  timing: ToolExecutionTiming
}

export interface AgentToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export const AGENT_RUN_EVENT_TYPES = [
  'run.started',
  'context.snapshot',
  'context.changed',
  'run.phase',
  'assistant.delta',
  'assistant.completed',
  'tool.pending',
  'tool.running',
  'tool.output.delta',
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

function dataUrlDecodedBytes(encoded: string): number {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding)
}

/** Validate and clone tool media before it enters the append-only run ledger. */
export function normalizeToolResultMedia(
  value: readonly ToolResultMediaAttachment[] | undefined
): ToolResultMediaAttachment[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_TOOL_RESULT_MEDIA) {
    throw new Error(`A tool result can contain up to ${MAX_TOOL_RESULT_MEDIA} media attachments`)
  }
  const supportedMimeTypes = new Set<string>(TOOL_RESULT_IMAGE_MIME_TYPES)
  return value.map((candidate) => {
    if (!candidate || candidate.type !== 'image') {
      throw new Error('Unsupported tool result media attachment')
    }
    const mimeType = String(candidate.mimeType || '').toLowerCase()
    if (!supportedMimeTypes.has(mimeType)) {
      throw new Error(`Unsupported tool result image type: ${mimeType || 'unknown'}`)
    }
    const name = candidate.name?.trim()
    const description = candidate.description?.trim()
    if ((name?.length ?? 0) > 500 || (description?.length ?? 0) > 2_000) {
      throw new Error('Tool result media metadata is too long')
    }
    let source: ToolResultMediaSource
    if (candidate.source?.type === 'data_url') {
      const dataUrl = candidate.source.dataUrl
      const prefix = `data:${mimeType};base64,`
      if (
        typeof dataUrl !== 'string' ||
        dataUrl.length > MAX_TOOL_RESULT_MEDIA_DATA_URL_LENGTH ||
        !dataUrl.startsWith(prefix)
      ) {
        throw new Error('Invalid or oversized tool result image data URL')
      }
      const encoded = dataUrl.slice(prefix.length)
      if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
        throw new Error('Invalid tool result image base64 payload')
      }
      if (dataUrlDecodedBytes(encoded) > MAX_TOOL_RESULT_MEDIA_BYTES) {
        throw new Error('Tool result image exceeds the byte limit')
      }
      source = { type: 'data_url', dataUrl }
    } else if (candidate.source?.type === 'file') {
      const path = candidate.source.path
      if (typeof path !== 'string' || !path.trim() || path.length > 4_096 || path.includes('\0')) {
        throw new Error('Invalid tool result media file reference')
      }
      source = { type: 'file', path }
    } else {
      throw new Error('Tool result media source is missing')
    }
    return {
      type: 'image',
      mimeType: mimeType as ToolResultImageMimeType,
      source,
      ...(name ? { name } : {}),
      ...(description ? { description } : {})
    }
  })
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
  media?: readonly ToolResultMediaAttachment[]
  startedAt?: number
  completedAt?: number
}): ToolExecutionResult<TData> {
  const startedAt = input.startedAt ?? Date.now()
  const completedAt = input.completedAt ?? Date.now()
  const media = normalizeToolResultMedia(input.media)
  return {
    status: 'success',
    title: input.title,
    modelContent: input.modelContent ?? stringifyModelContent(input.data),
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.output ? { output: input.output } : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    ...(input.changes ? { changes: input.changes } : {}),
    ...(media?.length ? { media } : {}),
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
  media?: readonly ToolResultMediaAttachment[]
  status?: 'error' | 'cancelled' | 'denied'
  startedAt?: number
  completedAt?: number
}): ToolExecutionResult {
  const startedAt = input.startedAt ?? Date.now()
  const completedAt = input.completedAt ?? Date.now()
  const media = normalizeToolResultMedia(input.media)
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
    ...(media?.length ? { media } : {}),
    timing: { startedAt, completedAt }
  }
}

export function normalizeToolExecutionResult(
  title: string,
  value: unknown,
  startedAt = Date.now(),
  completedAt = Date.now()
): ToolExecutionResult {
  if (isToolExecutionResult(value)) {
    // Tool handlers often construct their typed result only after the work has
    // completed, so its default timing can be effectively zero. The registry
    // owns the actual execution envelope and must be the canonical clock.
    const result = { ...value, timing: { startedAt, completedAt } }
    const media = normalizeToolResultMedia(value.media)
    if (media?.length) result.media = media
    else delete result.media
    return result
  }
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
