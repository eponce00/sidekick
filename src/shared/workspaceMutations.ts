import type { RequestedAccess } from './permissions'
import type { ProviderKind } from './providerRegistry'

export type EditingDialect = 'apply-patch' | 'claude-edit' | 'search-replace' | 'structured-edit'
export type EditingDialectPreference = 'auto' | EditingDialect
export const EDITING_DIALECTS: readonly EditingDialect[] = [
  'apply-patch',
  'claude-edit',
  'search-replace',
  'structured-edit'
]
export const EDITING_CALIBRATION_VERSION = 2

export type EditingCalibrationProbeKind = 'localized-edit' | 'multi-replace' | 'complete-write'

export interface EditingCalibrationProbeResult {
  kind: EditingCalibrationProbeKind
  passed: boolean
  latencyMs: number
  toolName?: string
  error?: string
}

export interface EditingDialectCalibrationResult {
  dialect: EditingDialect
  passed: boolean
  probes: EditingCalibrationProbeResult[]
}

/** Durable evidence collected against one exact provider model identity. */
export interface EditingContractCalibration {
  version: typeof EDITING_CALIBRATION_VERSION
  model: string
  upstreamModel?: string
  selectedDialect: EditingDialect
  verifiedDialects: EditingDialect[]
  results: EditingDialectCalibrationResult[]
  calibratedAt: number
  source: 'active-probe'
}

export type WorkspaceMutationRequest =
  | {
      kind: 'apply-patch'
      patch: string
      accessLevel: RequestedAccess
    }
  | {
      kind: 'replace'
      filePath: string
      oldText: string
      newText: string
      replaceAll: boolean
      accessLevel: RequestedAccess
    }
  | {
      kind: 'write'
      filePath: string
      content: string
      accessLevel: RequestedAccess
    }
  | {
      kind: 'delete'
      filePath: string
      accessLevel: RequestedAccess
    }

export type WorkspaceFileChangeAction = 'add' | 'update' | 'delete' | 'move'

export interface WorkspaceFileChange {
  path: string
  action: WorkspaceFileChangeAction
  movePath?: string
  additions: number
  deletions: number
  diff: string
  diffTruncated?: boolean
  beforeHash?: string
  afterHash?: string
}

export interface WorkspaceMutationResult {
  ok: boolean
  changed: boolean
  files: WorkspaceFileChange[]
  diff: string
  diffTruncated?: boolean
  additions: number
  deletions: number
  error?: string
  failure?: WorkspaceMutationFailure
}

export type WorkspaceMutationFailureCode =
  | 'multiple_matches'
  | 'text_not_found'
  | 'read_required'
  | 'stale_read'
  | 'conflict'

export interface WorkspaceMutationFailure {
  code: WorkspaceMutationFailureCode
  recovery: string
  matchCount?: number
  matchStartLines?: number[]
}

/** Keep verified mutation feedback useful without duplicating large diffs into model context. */
export function workspaceMutationResultForModel(
  result: WorkspaceMutationResult,
  maxDiffCharacters = 16_000,
  maxFiles = 200
): Record<string, unknown> {
  const diffTruncated = result.diffTruncated === true || result.diff.length > maxDiffCharacters
  const filesTruncated = result.files.length > maxFiles
  return {
    ok: result.ok,
    changed: result.changed,
    files: result.files.slice(0, maxFiles).map(({ diff: _diff, ...file }) => file),
    fileCount: result.files.length,
    filesTruncated,
    additions: result.additions,
    deletions: result.deletions,
    diff: diffTruncated ? result.diff.slice(0, maxDiffCharacters) : result.diff,
    diffTruncated,
    error: result.error,
    failure: result.failure
  }
}

export interface EditingModelTarget {
  providerKind?: ProviderKind
  model: string
  dialect?: EditingDialectPreference
  upstreamModel?: string
  calibration?: EditingContractCalibration
}

const OPENAI_PATCH_MODEL = /(?:^|[/:._-])(codex|chatgpt|gpt(?:[-_.]|$)|o[1-9](?:[-_.]|$))/i
const CLAUDE_MODEL = /(?:^|[/:._-])claude(?:[-_.]|$)/i
const GROK_MODEL = /(?:^|[/:._-])grok(?:[-_.]|$)/i

/**
 * Select the editing contract a model is most likely to have been trained to use.
 * Provider kind is only a hint: gateways such as OpenRouter and LiteLLM can serve
 * several model families, so the model id always takes precedence.
 */
export function editingDialectForModel(target: EditingModelTarget): EditingDialect {
  if (target.dialect && target.dialect !== 'auto') return target.dialect
  const calibrated = validEditingCalibration(target)
  if (calibrated) return calibrated.selectedDialect
  const model = `${target.upstreamModel || ''} ${target.model}`.trim()
  if (OPENAI_PATCH_MODEL.test(model)) return 'apply-patch'
  if (CLAUDE_MODEL.test(model) || target.providerKind === 'anthropic') return 'claude-edit'
  if (GROK_MODEL.test(model)) return 'search-replace'
  return 'structured-edit'
}

export function validEditingCalibration(
  target: EditingModelTarget
): EditingContractCalibration | undefined {
  const calibration = target.calibration
  if (
    !calibration ||
    calibration.version !== EDITING_CALIBRATION_VERSION ||
    calibration.model !== target.model ||
    !calibration.verifiedDialects.includes(calibration.selectedDialect)
  ) {
    return undefined
  }
  if (
    calibration.upstreamModel &&
    target.upstreamModel &&
    calibration.upstreamModel !== target.upstreamModel
  ) {
    return undefined
  }
  return calibration
}

export function editingDialectCandidatesForModel(target: EditingModelTarget): EditingDialect[] {
  const inferred = editingDialectForModel({
    providerKind: target.providerKind,
    model: target.model,
    upstreamModel: target.upstreamModel
  })
  return [inferred, ...EDITING_DIALECTS.filter((dialect) => dialect !== inferred)]
}

export function verifiedEditingDialectFallbacks(
  target: EditingModelTarget,
  currentDialect = editingDialectForModel(target)
): EditingDialect[] {
  const calibration = validEditingCalibration(target)
  if (!calibration || (target.dialect && target.dialect !== 'auto')) return []
  const verified = new Set(calibration.verifiedDialects)
  return editingDialectCandidatesForModel(target).filter(
    (dialect) => dialect !== currentDialect && verified.has(dialect)
  )
}

export const WORKSPACE_MUTATION_TOOL_NAMES = new Set([
  'apply_patch',
  'Edit',
  'Write',
  'search_replace',
  'edit',
  'write',
  'delete_file'
])

export function isWorkspaceMutationTool(name: string): boolean {
  return WORKSPACE_MUTATION_TOOL_NAMES.has(name)
}

const MAX_PATH_CHARACTERS = 4_096
const MAX_MUTATION_TEXT_CHARACTERS = 32_000_000

function stringArgument(
  args: Record<string, unknown>,
  key: string,
  maxCharacters = MAX_MUTATION_TEXT_CHARACTERS
): string {
  const value = args[key]
  if (typeof value !== 'string') throw new Error(`${key} is required`)
  if (value.length > maxCharacters) {
    throw new Error(`${key} exceeds the ${maxCharacters.toLocaleString()} character safety limit`)
  }
  return value
}

function pathArgument(args: Record<string, unknown>, key: string): string {
  return stringArgument(args, key, MAX_PATH_CHARACTERS)
}

function accessLevelArgument(args: Record<string, unknown>): RequestedAccess {
  // Authorization is host-owned. This field remains only in the internal legacy envelope.
  return args.accessLevel === 'confirm' ? 'confirm' : 'auto'
}

/** Convert the model-facing dialect into the single internal mutation protocol. */
export function workspaceMutationRequestFromTool(
  name: string,
  args: Record<string, unknown>
): WorkspaceMutationRequest {
  const accessLevel = accessLevelArgument(args)
  if (name === 'apply_patch') {
    return { kind: 'apply-patch', patch: stringArgument(args, 'patch'), accessLevel }
  }
  if (name === 'Edit' || name === 'search_replace' || name === 'edit') {
    return {
      kind: 'replace',
      filePath: pathArgument(args, 'file_path'),
      oldText: stringArgument(args, 'old_string'),
      newText: stringArgument(args, 'new_string'),
      replaceAll: args.replace_all === true,
      accessLevel
    }
  }
  if (name === 'Write' || name === 'write') {
    return {
      kind: 'write',
      filePath: pathArgument(args, 'file_path'),
      content: stringArgument(args, 'content'),
      accessLevel
    }
  }
  if (name === 'delete_file') {
    return { kind: 'delete', filePath: pathArgument(args, 'file_path'), accessLevel }
  }
  throw new Error(`Unsupported workspace mutation tool: ${name}`)
}

export function workspaceMutationTargetPaths(request: WorkspaceMutationRequest): string[] {
  if (request.kind !== 'apply-patch') return [request.filePath]
  const paths = new Set<string>()
  for (const line of request.patch.replace(/\r\n?/g, '\n').split('\n')) {
    const file = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    const value = file?.[1] ?? move?.[1]
    if (value?.trim()) paths.add(value.trim())
  }
  return [...paths].sort()
}
