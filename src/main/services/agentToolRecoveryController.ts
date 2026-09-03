import { createHash, type Hash } from 'crypto'
import type { ToolExecutionResult } from '../../shared/agentRuntime'

export interface ToolRecoveryGuardrails {
  exactFailureWarning: number
  exactFailureLimit: number
  sameToolFailureWarning: number
  sameToolFailureLimit: number
  noProgressWarning: number
  noProgressLimit: number
  failedTurnWarning: number
  failedTurnLimit: number
}

export const DEFAULT_TOOL_RECOVERY_GUARDRAILS: ToolRecoveryGuardrails = {
  exactFailureWarning: 2,
  exactFailureLimit: 5,
  sameToolFailureWarning: 3,
  sameToolFailureLimit: 8,
  noProgressWarning: 2,
  noProgressLimit: 5,
  failedTurnWarning: 3,
  failedTurnLimit: 6
}

export interface ToolRecoveryObservation {
  warning?: string
  stopReason?: string
  reason?: 'exact_failure' | 'same_tool_failure' | 'no_progress' | 'failed_turn'
  count?: number
}

function updateCanonicalHash(hash: Hash, value: unknown, seen = new WeakSet<object>()): void {
  if (value === null) {
    hash.update('null;')
    return
  }
  if (typeof value !== 'object') {
    hash.update(`${typeof value}:`)
    hash.update(
      typeof value === 'number' && !Number.isFinite(value)
        ? String(value)
        : (JSON.stringify(value) ?? String(value))
    )
    hash.update(';')
    return
  }
  if (seen.has(value)) {
    hash.update('circular;')
    return
  }
  seen.add(value)
  if (Array.isArray(value)) {
    hash.update('array[')
    for (const item of value) updateCanonicalHash(hash, item, seen)
    hash.update('];')
    return
  }
  hash.update('object{')
  for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    hash.update(JSON.stringify(key))
    hash.update(':')
    updateCanonicalHash(hash, item, seen)
  }
  hash.update('};')
}

export function canonicalToolFingerprint(name: string, value: unknown): string {
  const hash = createHash('sha256')
  updateCanonicalHash(hash, name.toLowerCase())
  updateCanonicalHash(hash, value)
  return hash.digest('hex')
}

function warning(reason: string, count: number, instruction: string): string {
  return `<sidekick_tool_guard trust="app-policy" reason="${reason}" count="${count}">\n${instruction}\n</sidekick_tool_guard>`
}

function madeMaterialProgress(result: ToolExecutionResult): boolean {
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) return false
  const fields = (result.data as Record<string, unknown>).fields
  return (
    Array.isArray(fields) &&
    fields.some(
      (field) =>
        Boolean(field) &&
        typeof field === 'object' &&
        !Array.isArray(field) &&
        (field as Record<string, unknown>).status === 'filled'
    )
  )
}

/**
 * Run-scoped, tool-agnostic guardrails. Recoverability describes how a model may
 * correct an error; this controller independently decides when repetition is no
 * longer making progress.
 */
export class AgentToolRecoveryController {
  private readonly exactFailures = new Map<string, number>()
  private readonly exactFailuresByTool = new Map<string, Set<string>>()
  private readonly failuresByTool = new Map<string, number>()
  private readonly failureDetails = new Map<
    string,
    { toolName: string; message: string; count: number }
  >()
  private readonly readResults = new Map<string, { output: string; count: number }>()
  private consecutiveFailedTurns = 0

  constructor(private readonly limits = DEFAULT_TOOL_RECOVERY_GUARDRAILS) {}

  observeCall(input: {
    name: string
    arguments: Record<string, unknown>
    result: ToolExecutionResult
    readOnly: boolean
  }): ToolRecoveryObservation {
    const toolName = input.name.toLowerCase()
    if (input.result.status === 'success') {
      if (input.readOnly) this.clearToolFailures(toolName)
      else this.clearFailures()
      if (!input.readOnly) return {}
      const callFingerprint = canonicalToolFingerprint(toolName, input.arguments)
      const outputFingerprint = canonicalToolFingerprint('result', input.result.modelContent)
      const previous = this.readResults.get(callFingerprint)
      const count = previous?.output === outputFingerprint ? previous.count + 1 : 1
      this.readResults.set(callFingerprint, { output: outputFingerprint, count })
      if (count >= this.limits.noProgressLimit) {
        return {
          reason: 'no_progress',
          count,
          stopReason: `${input.name} was stopped after ${count} identical read-only calls returned the same result.`
        }
      }
      if (count >= this.limits.noProgressWarning) {
        return {
          reason: 'no_progress',
          count,
          warning: warning(
            'no_progress',
            count,
            `${input.name} returned the same result for the same arguments ${count} times. Use the information already returned or choose a materially different query.`
          )
        }
      }
      return {}
    }

    if (input.result.status !== 'error') return {}
    if (madeMaterialProgress(input.result)) {
      this.clearFailures()
      return {}
    }
    const errorCode = input.result.error?.code ?? 'internal'
    const exact = canonicalToolFingerprint(toolName, {
      arguments: input.arguments,
      errorCode
    })
    const exactCount = (this.exactFailures.get(exact) ?? 0) + 1
    this.exactFailures.set(exact, exactCount)
    const signatures = this.exactFailuresByTool.get(toolName) ?? new Set<string>()
    signatures.add(exact)
    this.exactFailuresByTool.set(toolName, signatures)
    const toolCount = (this.failuresByTool.get(toolName) ?? 0) + 1
    this.failuresByTool.set(toolName, toolCount)
    const message = input.result.error?.message ?? 'Unknown tool failure'
    const detailKey = canonicalToolFingerprint(toolName, { errorCode, message })
    const detail = this.failureDetails.get(detailKey)
    this.failureDetails.set(detailKey, {
      toolName: input.name,
      message,
      count: (detail?.count ?? 0) + 1
    })

    if (exactCount >= this.limits.exactFailureLimit) {
      return {
        reason: 'exact_failure',
        count: exactCount,
        stopReason: `${input.name} was stopped after ${exactCount} identical failed calls. The arguments and error code did not change.${this.failureSummary(toolName)}`
      }
    }
    if (toolCount >= this.limits.sameToolFailureLimit) {
      return {
        reason: 'same_tool_failure',
        count: toolCount,
        stopReason: `${input.name} was stopped after ${toolCount} consecutive failures, including attempts with changed arguments.${this.failureSummary(toolName)}`
      }
    }
    if (exactCount >= this.limits.exactFailureWarning) {
      return {
        reason: 'exact_failure',
        count: exactCount,
        warning: warning(
          'exact_failure',
          exactCount,
          `${input.name} failed with the same arguments and error code ${exactCount} times. Do not submit this call unchanged. Follow the recovery action or choose a different strategy.`
        )
      }
    }
    if (toolCount >= this.limits.sameToolFailureWarning) {
      return {
        reason: 'same_tool_failure',
        count: toolCount,
        warning: warning(
          'same_tool_failure',
          toolCount,
          `${input.name} has failed ${toolCount} consecutive times. Re-read the error and change strategy instead of making another minor argument variation.`
        )
      }
    }
    return {}
  }

  observeTurn(successCount: number, failureCount: number): ToolRecoveryObservation {
    if (successCount > 0 || failureCount === 0) {
      this.consecutiveFailedTurns = 0
      return {}
    }
    this.consecutiveFailedTurns++
    if (this.consecutiveFailedTurns >= this.limits.failedTurnLimit) {
      return {
        reason: 'failed_turn',
        count: this.consecutiveFailedTurns,
        stopReason: `The run was stopped after ${this.consecutiveFailedTurns} consecutive tool turns in which every call failed.${this.failureSummary()}`
      }
    }
    if (this.consecutiveFailedTurns >= this.limits.failedTurnWarning) {
      return {
        reason: 'failed_turn',
        count: this.consecutiveFailedTurns,
        warning: warning(
          'failed_turn',
          this.consecutiveFailedTurns,
          `Every tool call failed in ${this.consecutiveFailedTurns} consecutive turns. Stop repeating the current approach: inspect the structured recovery actions, select another tool, or explain the blocker.`
        )
      }
    }
    return {}
  }

  private clearToolFailures(toolName: string): void {
    this.failuresByTool.delete(toolName)
    for (const signature of this.exactFailuresByTool.get(toolName) ?? []) {
      this.exactFailures.delete(signature)
    }
    this.exactFailuresByTool.delete(toolName)
    for (const [key, detail] of this.failureDetails) {
      if (detail.toolName.toLowerCase() === toolName) this.failureDetails.delete(key)
    }
  }

  private clearFailures(): void {
    this.exactFailures.clear()
    this.exactFailuresByTool.clear()
    this.failuresByTool.clear()
    this.failureDetails.clear()
  }

  private failureSummary(toolName?: string): string {
    const details = [...this.failureDetails.values()]
      .filter((detail) => !toolName || detail.toolName.toLowerCase() === toolName)
      .sort(
        (left, right) => right.count - left.count || left.toolName.localeCompare(right.toolName)
      )
      .slice(0, 4)
      .map(({ toolName, message, count }) => {
        const missing = /Missing required fields:\s*([^.]*)\./i.exec(message)?.[1]?.trim()
        const issue = missing
          ? `omitted required ${missing.includes(',') ? 'fields' : 'field'}: ${missing}`
          : `failed with ${message.replace(/\s+/g, ' ').slice(0, 180)}`
        return `${toolName} ${issue} (${count} ${count === 1 ? 'call' : 'calls'})`
      })
    return details.length ? ` Recent failures: ${details.join('; ')}.` : ''
  }
}
