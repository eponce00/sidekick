import type { AgentKernelScenarioResult } from './agentScenarioHarness'
import { TOOL_ERROR_CODES } from '../../shared/agentRuntime'
import { createHash } from 'node:crypto'
import type { ToolWorkspaceChange } from '../../shared/agentRuntime'

export interface ReliabilityMutationExpectation {
  path: string
  before: string
  after: string
}

function failureCategory(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  if (/timed?\s*out|timeout|deadline/i.test(text)) return 'timeout'
  if (/unauthori[sz]ed|forbidden|\b40[13]\b|invalid.*api.?key/i.test(text)) return 'authentication'
  if (/rate.?limit|\b429\b/i.test(text)) return 'rate_limit'
  if (/context.{0,30}(length|window|exceed)|maximum.{0,20}tokens/i.test(text))
    return 'context_limit'
  if (/out of memory|cuda|engine.*(dead|fail|unavailable)|\b50[0234]\b/i.test(text))
    return 'backend_unavailable'
  if (/fetch failed|econn|socket|network|stream.*(fail|clos|end)/i.test(text)) return 'transport'
  if (/abort|cancel/i.test(text)) return 'cancelled'
  return 'unclassified'
}

export function shouldStopReliabilityBatch(
  summary: ReturnType<typeof summarizeReliabilityRun>,
  expectedCancellation = false
): boolean {
  if (summary.phase === 'cancelled') return !expectedCancellation
  return (
    summary.phase === 'failed' &&
    (summary.modelTurns === 0 ||
      ['timeout', 'authentication', 'rate_limit', 'backend_unavailable', 'transport'].includes(
        summary.terminalFailure ?? ''
      ))
  )
}

function mutationEvidence(
  changes: ToolWorkspaceChange[] | undefined,
  expectation: ReliabilityMutationExpectation | undefined
) {
  const hash = (content: string) => createHash('sha256').update(content).digest('hex')
  const state = (value: string | undefined) => {
    if (!value) return 'absent'
    if (!expectation) return 'unclassified'
    if (value === hash(expectation.after)) return 'expected'
    if (value === hash(expectation.before)) return 'initial'
    if (value === hash(expectation.after.replace(/\n$/, '')))
      return 'expected_without_final_newline'
    if (value === hash(expectation.after + '\n')) return 'expected_extra_final_newline'
    return 'other'
  }
  return {
    evidenceAvailable: changes !== undefined,
    fileCount: changes?.length ?? 0,
    nonTargetFileCount: expectation
      ? (changes?.filter((change) => change.path !== expectation.path).length ?? 0)
      : null,
    unchangedUpdateCount:
      changes?.filter(
        (change) =>
          change.kind === 'update' &&
          change.beforeHash !== undefined &&
          change.beforeHash === change.afterHash
      ).length ?? 0,
    operations: (changes ?? []).map((change) => ({
      kind: ['create', 'update', 'delete', 'move'].includes(change.kind) ? change.kind : 'unknown',
      target: expectation ? change.path === expectation.path : null,
      before:
        expectation && change.path === expectation.path ? state(change.beforeHash) : 'unclassified',
      after:
        expectation && change.path === expectation.path ? state(change.afterHash) : 'unclassified'
    }))
  }
}

export function summarizeReliabilityRun(
  result: AgentKernelScenarioResult,
  injectedToolCallIds: ReadonlySet<string> = new Set(),
  expectation?: ReliabilityMutationExpectation
) {
  const patches = result.events.filter(
    (event) => event.type === 'tool.completed' && event.payload.name === 'apply_patch'
  )
  const status = (event: (typeof patches)[number]): unknown =>
    (event.payload.result as { status?: string } | undefined)?.status
  // Only fixture-owned IDs establish injection provenance; never infer it from model text.
  // Keep diagnostics bounded and categorical: no arguments, paths, content or raw errors.
  const toolOutcomes = result.events
    .filter((event) => event.type === 'tool.completed')
    .map((event) => {
      const output = event.payload.result as
        | { status?: string; error?: { code?: string; message?: string } }
        | undefined
      const code = output?.error?.code
      const message = output?.error?.message ?? ''
      const injected = injectedToolCallIds.has(String(event.payload.toolCallId))
      const category =
        output?.status !== 'error'
          ? null
          : injected
            ? 'fixture_injected'
            : event.payload.name !== 'apply_patch'
              ? 'other'
              : /Invalid patch|Invalid (?:Add|Update|Delete) File|Invalid hunk|no file operations/.test(
                    message
                  )
                ? 'patch_grammar'
                : /multiple matches|ambiguous/.test(message)
                  ? 'ambiguous_context'
                  : /context|exact source text|not found in/.test(message)
                    ? 'patch_context'
                    : 'other'
      return {
        tool:
          typeof event.payload.name === 'string' &&
          ['read', 'apply_patch'].includes(event.payload.name)
            ? event.payload.name
            : 'other',
        status: ['success', 'error', 'cancelled', 'denied'].includes(output?.status ?? '')
          ? output!.status
          : 'unknown',
        code: TOOL_ERROR_CODES.includes(code as (typeof TOOL_ERROR_CODES)[number]) ? code : null,
        injected,
        category
      }
    })
  return {
    phase: result.phase,
    terminalFailure:
      result.phase === 'failed'
        ? failureCategory(result.error)
        : result.phase === 'cancelled'
          ? 'cancelled'
          : null,
    modelTurns: result.events.filter((event) => event.type === 'usage.updated').length,
    firstPatchAccepted: patches.length ? status(patches[0]) === 'success' : null,
    successfulPatches: patches.filter((event) => status(event) === 'success').length,
    toolErrors: result.events.filter(
      (event) =>
        event.type === 'tool.completed' &&
        (event.payload.result as { status?: string } | undefined)?.status === 'error'
    ).length,
    injectedToolErrors: toolOutcomes.filter((item) => item.status === 'error' && item.injected)
      .length,
    unforcedToolErrors: toolOutcomes.filter((item) => item.status === 'error' && !item.injected)
      .length,
    cleanOneShotEligible: patches.length > 0 && injectedToolCallIds.size === 0,
    toolOutcomes,
    mutationOutcomes: patches
      .filter((event) => status(event) === 'success')
      .map((event) =>
        mutationEvidence(
          (event.payload.result as { changes?: ToolWorkspaceChange[] } | undefined)?.changes,
          expectation
        )
      ),
    toolRounds: result.toolRounds,
    terminalEvents: result.events.filter((event) => event.type === 'run.completed').length
  }
}
