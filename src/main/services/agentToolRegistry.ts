import type { AgentToolDefinition } from '../../shared/agentToolDefinitions'
import {
  getAgentToolCatalog,
  getAgentToolEntry,
  type AgentToolCatalogOptions
} from '../../shared/agentToolCatalog'
import {
  normalizeToolExecutionResult,
  toolExecutionFailed,
  type AgentToolCall,
  type ToolErrorCode,
  type ToolExecutionResult,
  type ToolRecoveryAction
} from '../../shared/agentRuntime'
import { readIncompleteToolInputError } from '../../shared/toolCalls'
import {
  ToolExecutionPipeline,
  ToolRuntimeTimeoutError,
  type ToolExecutionAfterHook,
  type ToolExecutionAroundHook,
  type ToolExecutionBeforeHook,
  type ToolExecutionGuard
} from './toolExecutionPipeline'

export interface AgentToolExecutionContext {
  runId: string
  conversationId?: string
  workspaceRoot?: string
  signal: AbortSignal
  onOutput?: (data: { chunk: string; stream: 'stdout' | 'stderr' }) => void
}

export interface ExecuteAgentToolInput {
  catalog: AgentToolCatalogOptions
  call: AgentToolCall
  title: string
  context: AgentToolExecutionContext
}

export type AgentToolExecutor = (
  args: Record<string, unknown>,
  context: AgentToolExecutionContext
) => Promise<unknown>

export class AgentToolExecutionError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly retryable = false,
    readonly recovery?: string,
    readonly recoveryAction?: ToolRecoveryAction
  ) {
    super(message)
    this.name = 'AgentToolExecutionError'
  }
}

export interface AgentToolArgumentIssue {
  path: string
  code:
    | 'required'
    | 'type'
    | 'enum'
    | 'minimum'
    | 'maximum'
    | 'minLength'
    | 'maxLength'
    | 'pattern'
    | 'minItems'
    | 'maxItems'
  message: string
}

export interface PreparedAgentToolCall {
  call: AgentToolCall
  repairs: string[]
}

function propertyMatchesType(value: unknown, type: string): boolean {
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value))
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'string') return typeof value === 'string'
  return true
}

function schemaTypes(schema: Record<string, unknown>): string[] {
  const type = schema.type
  if (Array.isArray(type)) return type.filter((value): value is string => typeof value === 'string')
  return typeof type === 'string' ? [type] : []
}

function childPath(parent: string, child: string): string {
  return parent ? `${parent}.${child}` : child
}

function collectSchemaIssues(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  issues: AgentToolArgumentIssue[]
): void {
  const alternatives = [schema.anyOf, schema.oneOf].find(Array.isArray) as
    | Record<string, unknown>[]
    | undefined
  if (alternatives?.length) {
    const candidates = alternatives.map((candidate) => {
      const candidateIssues: AgentToolArgumentIssue[] = []
      collectSchemaIssues(candidate, value, path, candidateIssues)
      return candidateIssues
    })
    if (candidates.some((candidate) => candidate.length === 0)) return
    issues.push(...candidates.sort((left, right) => left.length - right.length)[0])
    return
  }

  const types = schemaTypes(schema)
  if (types.length && !types.some((type) => propertyMatchesType(value, type))) {
    issues.push({
      path,
      code: 'type',
      message: `${path || 'arguments'} must be ${types.join(' or ')}`
    })
    return
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined
  if (enumValues && !enumValues.some((candidate) => Object.is(candidate, value))) {
    issues.push({
      path,
      code: 'enum',
      message: `${path} must be one of: ${enumValues.map(String).join(', ')}`
    })
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      issues.push({ path, code: 'minimum', message: `${path} must be at least ${schema.minimum}` })
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      issues.push({ path, code: 'maximum', message: `${path} must be at most ${schema.maximum}` })
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      issues.push({
        path,
        code: 'minLength',
        message: `${path} must contain at least ${schema.minLength} character(s)`
      })
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      issues.push({
        path,
        code: 'maxLength',
        message: `${path} must contain at most ${schema.maxLength} character(s)`
      })
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          issues.push({
            path,
            code: 'pattern',
            message: `${path} must match pattern ${schema.pattern}`
          })
        }
      } catch {
        // A malformed external schema should not make every tool call impossible.
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push({
        path,
        code: 'minItems',
        message: `${path} must contain at least ${schema.minItems} item(s)`
      })
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      issues.push({
        path,
        code: 'maxItems',
        message: `${path} must contain at most ${schema.maxItems} item(s)`
      })
    }
    const itemSchema = schema.items
    if (itemSchema && typeof itemSchema === 'object' && !Array.isArray(itemSchema)) {
      value.forEach((item, index) =>
        collectSchemaIssues(
          itemSchema as Record<string, unknown>,
          item,
          `${path}[${index}]`,
          issues
        )
      )
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const properties =
      schema.properties && typeof schema.properties === 'object'
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : []
    for (const requiredName of required) {
      if (record[requiredName] === undefined || record[requiredName] === null) {
        const requiredPath = childPath(path, requiredName)
        issues.push({
          path: requiredPath,
          code: 'required',
          message: `${requiredPath} is required`
        })
      }
    }
    for (const [name, propertyValue] of Object.entries(record)) {
      const property = properties[name]
      if (!property || propertyValue === undefined || propertyValue === null) continue
      collectSchemaIssues(property, propertyValue, childPath(path, name), issues)
    }
  }
}

function conditionalIssues(
  toolName: string,
  args: Record<string, unknown>
): AgentToolArgumentIssue[] {
  const required = (path: string): AgentToolArgumentIssue => ({
    path,
    code: 'required',
    message: `${path} is required when ${
      toolName === 'manage_todo_list' ? 'operation is write' : `status is ${String(args.status)}`
    }`
  })
  if (
    toolName === 'manage_todo_list' &&
    args.operation === 'write' &&
    !Array.isArray(args.todoList)
  ) {
    return [required('todoList')]
  }
  if (
    toolName === 'update_goal' &&
    args.status === 'complete' &&
    !String(args.verification || '').trim()
  ) {
    return [required('verification')]
  }
  if (
    toolName === 'update_goal' &&
    args.status === 'blocked' &&
    !String(args.blocker_key || '').trim()
  ) {
    return [required('blocker_key')]
  }
  return []
}

function canonicalArgumentKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function parseArrayString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : value
  } catch {
    return value
  }
}

/** Normalize only unambiguous syntax differences; never invent semantic arguments. */
export function normalizeAgentToolArguments(
  tool: AgentToolDefinition,
  args: Record<string, unknown>
): { arguments: Record<string, unknown>; repairs: string[] } {
  const properties = tool.function.parameters.properties ?? {}
  const normalized = { ...args }
  const repairs: string[] = []
  const expectedByCanonical = new Map<string, string[]>()
  for (const name of Object.keys(properties)) {
    const key = canonicalArgumentKey(name)
    expectedByCanonical.set(key, [...(expectedByCanonical.get(key) ?? []), name])
  }
  if (
    'file_path' in properties &&
    !('file_path' in normalized) &&
    typeof normalized.path === 'string'
  ) {
    normalized.file_path = normalized.path
    delete normalized.path
    repairs.push('path → file_path')
  }
  const knownAliases: Record<string, string> = {
    oldText: 'old_string',
    oldString: 'old_string',
    newText: 'new_string',
    newString: 'new_string'
  }
  for (const [sourceName, targetName] of Object.entries(knownAliases)) {
    if (!(targetName in properties) || targetName in normalized || !(sourceName in normalized))
      continue
    normalized[targetName] = normalized[sourceName]
    delete normalized[sourceName]
    repairs.push(`${sourceName} → ${targetName}`)
  }
  for (const sourceName of Object.keys(normalized)) {
    if (sourceName in properties) continue
    const matches = expectedByCanonical.get(canonicalArgumentKey(sourceName)) ?? []
    if (matches.length !== 1 || matches[0] in normalized) continue
    const targetName = matches[0]
    normalized[targetName] = normalized[sourceName]
    delete normalized[sourceName]
    repairs.push(`${sourceName} → ${targetName}`)
  }
  for (const [name, property] of Object.entries(properties)) {
    if (
      property.type === 'boolean' &&
      typeof normalized[name] === 'string' &&
      /^(?:true|false)$/i.test(normalized[name] as string)
    ) {
      normalized[name] = String(normalized[name]).toLowerCase() === 'true'
      repairs.push(`${name}: parsed boolean`)
    }
    if (property.type !== 'array' || !(name in normalized)) continue
    const parsed = parseArrayString(normalized[name])
    if (parsed !== normalized[name]) {
      normalized[name] = parsed
      repairs.push(`${name}: parsed JSON array`)
    }
  }
  return { arguments: normalized, repairs }
}

export function prepareAgentToolCall(
  catalog: AgentToolCatalogOptions,
  call: AgentToolCall
): PreparedAgentToolCall {
  const entries = getAgentToolCatalog(catalog)
  const exact = entries.find(({ definition }) => definition.function.name === call.name)
  const caseMatches = exact
    ? []
    : entries.filter(
        ({ definition }) => definition.function.name.toLowerCase() === call.name.toLowerCase()
      )
  const entry = exact ?? (caseMatches.length === 1 ? caseMatches[0] : undefined)
  if (!entry) return { call, repairs: [] }
  const repairs =
    entry.definition.function.name === call.name
      ? []
      : [`${call.name} → ${entry.definition.function.name}`]
  const normalized = normalizeAgentToolArguments(entry.definition, call.arguments)
  return {
    call: { ...call, name: entry.definition.function.name, arguments: normalized.arguments },
    repairs: [...repairs, ...normalized.repairs]
  }
}

export function validateAgentToolArguments(
  tool: AgentToolDefinition,
  args: Record<string, unknown>
): AgentToolArgumentIssue[] {
  const issues: AgentToolArgumentIssue[] = []
  collectSchemaIssues(tool.function.parameters, args, '', issues)
  issues.push(...conditionalIssues(tool.function.name, args))
  return issues
}

function invalidArgumentMessage(
  toolName: string,
  args: Record<string, unknown>,
  issues: AgentToolArgumentIssue[]
): string {
  const missing = issues.filter(({ code }) => code === 'required').map(({ path }) => path)
  const invalid = issues.filter(({ code }) => code !== 'required').map(({ message }) => message)
  const parts = [`${toolName} received invalid arguments.`]
  if (missing.length) parts.push(`Missing required fields: ${missing.join(', ')}.`)
  if (invalid.length) parts.push(`Invalid fields: ${invalid.join('; ')}.`)
  parts.push(`Received fields: ${Object.keys(args).sort().join(', ') || '(none)'}.`)
  return parts.join(' ')
}

export function validatePreparedAgentToolCall(
  catalog: AgentToolCatalogOptions,
  call: AgentToolCall,
  title: string,
  startedAt = Date.now(),
  repairs: readonly string[] = []
): ToolExecutionResult | null {
  const catalogEntry = getAgentToolEntry(catalog, call.name)
  if (!catalogEntry) {
    return toolExecutionFailed({
      title,
      code: 'unknown_tool',
      message: `Tool is not available in this run: ${call.name}`,
      recoveryAction: 'change_strategy',
      recovery: 'Choose a tool from the current tool catalog.',
      startedAt
    })
  }
  const incomplete = readIncompleteToolInputError(call.arguments)
  const invalid = incomplete
    ? [{ path: 'arguments', code: 'type' as const, message: incomplete }]
    : validateAgentToolArguments(catalogEntry.definition, call.arguments)
  if (!invalid.length) return null
  const message = incomplete
    ? `${call.name} received incomplete JSON arguments. ${incomplete}`
    : invalidArgumentMessage(call.name, call.arguments, invalid)
  return toolExecutionFailed({
    title,
    code: 'invalid_arguments',
    message,
    retryable: true,
    recoveryAction: 'correct_input',
    recovery:
      `Submit one corrected ${call.name} call with every required field. ` +
      `Do not repeat the unchanged arguments.${repairs.length ? ` SideKick normalized: ${repairs.join(', ')}.` : ''}`,
    data: {
      ok: false,
      success: false,
      error: message,
      code: 'invalid_arguments',
      retryable: true,
      recoveryAction: 'correct_input',
      issues: invalid,
      receivedFields: Object.keys(call.arguments).sort()
    },
    startedAt
  })
}

function executionError(
  title: string,
  error: unknown,
  startedAt: number,
  signal: AbortSignal
): ToolExecutionResult {
  if (error instanceof ToolRuntimeTimeoutError) {
    return toolExecutionFailed({
      title,
      code: 'timeout',
      message: error.message,
      retryable: true,
      recoveryAction: 'retry_later',
      recovery: 'Reduce the operation scope or request a longer shell timeout when justified.',
      startedAt
    })
  }
  if (error instanceof AgentToolExecutionError) {
    return toolExecutionFailed({
      title,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      recovery: error.recovery,
      recoveryAction: error.recoveryAction,
      status:
        error.code === 'cancelled'
          ? 'cancelled'
          : error.code === 'permission_denied'
            ? 'denied'
            : 'error',
      startedAt
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError')
  return toolExecutionFailed({
    title,
    code: cancelled ? 'cancelled' : 'internal',
    message: cancelled ? 'Tool execution was cancelled' : message,
    retryable: false,
    status: cancelled ? 'cancelled' : 'error',
    startedAt
  })
}

/**
 * The only entry point for main-process agent tool execution.
 *
 * The registry rejects tools outside the run profile, validates the shared
 * schema before side effects, catches every executor failure, and always
 * returns the canonical result envelope.
 */
export class AgentToolRegistry {
  private readonly pipeline = new ToolExecutionPipeline()
  private readonly scheduler = new Map<
    string,
    { exclusive: Promise<void>; readers: Set<Promise<unknown>> }
  >()

  registerGuard(guard: ToolExecutionGuard): () => void {
    return this.pipeline.registerGuard(guard)
  }

  registerBeforeExecute(hook: ToolExecutionBeforeHook): () => void {
    return this.pipeline.registerBefore(hook)
  }

  registerAroundExecute(hook: ToolExecutionAroundHook): () => void {
    return this.pipeline.registerAround(hook)
  }

  registerAfterExecute<T>(hook: ToolExecutionAfterHook<T>): () => void {
    return this.pipeline.registerAfter(hook)
  }

  private schedule<T>(
    runId: string,
    concurrency: 'parallel' | 'exclusive',
    body: () => Promise<T>
  ): Promise<T> {
    let state = this.scheduler.get(runId)
    if (!state) {
      state = { exclusive: Promise.resolve(), readers: new Set() }
      this.scheduler.set(runId, state)
    }
    if (concurrency === 'parallel') {
      const work = state.exclusive.then(body)
      state.readers.add(work)
      void work.then(
        () => state!.readers.delete(work),
        () => state!.readers.delete(work)
      )
      return work
    }
    const predecessors = Promise.allSettled([state.exclusive, ...state.readers])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    state.exclusive = gate
    return predecessors.then(body).finally(release)
  }

  async execute(
    input: ExecuteAgentToolInput,
    executor: AgentToolExecutor
  ): Promise<ToolExecutionResult> {
    const startedAt = Date.now()
    const prepared = prepareAgentToolCall(input.catalog, input.call)
    const invalid = validatePreparedAgentToolCall(
      input.catalog,
      prepared.call,
      input.title,
      startedAt,
      prepared.repairs
    )
    if (invalid) return invalid
    if (input.context.signal.aborted) {
      return toolExecutionFailed({
        title: input.title,
        code: 'cancelled',
        message: 'Tool execution was cancelled before it started',
        status: 'cancelled',
        startedAt
      })
    }
    try {
      const entry = getAgentToolEntry(input.catalog, prepared.call.name)
      const requestedShellTimeout =
        prepared.call.name === 'shell' && prepared.call.arguments.background !== true
          ? Math.max(1, Math.min(86_400, Number(prepared.call.arguments.timeout) || 30)) * 1_000 +
            5_000
          : undefined
      const value = await this.schedule(
        input.context.runId,
        entry?.concurrency ?? 'exclusive',
        () =>
          this.pipeline.execute({
            name: prepared.call.name,
            arguments: prepared.call.arguments,
            signal: input.context.signal,
            timeoutMs: requestedShellTimeout ?? entry?.timeoutMs,
            body: (signal) => executor(prepared.call.arguments, { ...input.context, signal })
          })
      )
      return normalizeToolExecutionResult(input.title, value, startedAt, Date.now())
    } catch (error) {
      return executionError(input.title, error, startedAt, input.context.signal)
    }
  }
}
