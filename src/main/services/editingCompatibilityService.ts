import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { providerKindForInstance } from '../../shared/providerRegistry'
import type {
  ProviderEditingCalibrationRequest,
  ProviderEditingCalibrationResult,
  ProviderTarget,
  ProviderToolCall
} from '../../shared/providerRuntime'
import { editingToolDefinitions } from '../../shared/agentToolDefinitions'
import { normalizeCompletedToolInput } from '../../shared/toolCalls'
import {
  EDITING_CALIBRATION_VERSION,
  editingDialectCandidatesForModel,
  validEditingCalibration,
  verifiedEditingDialectFallbacks,
  workspaceMutationRequestFromTool,
  type EditingCalibrationProbeKind,
  type EditingCalibrationProbeResult,
  type EditingContractCalibration,
  type EditingDialect,
  type EditingDialectCalibrationResult
} from '../../shared/workspaceMutations'
import { resolveMaxOutputTokens } from '../../shared/contextBudget'
import { completeProviderChat } from '../providers/providerRuntime'
import { resolveProviderInstanceById } from '../providers/providerResolver'
import { updateStoredProviderModel } from '../ipc/settings'
import { executeWorkspaceMutation } from './workspaceMutationService'
import { normalizeAgentToolArguments, validateAgentToolArguments } from './agentToolRegistry'

const PROBE_TIMEOUT_MS = 90_000
const LONG_CONTEXT_CHARACTERS = 28_000
const CALIBRATION_OUTPUT_TOKENS = 4_096

const EDIT_FILE = 'src/styles/theme.css'
const EDIT_BEFORE = `:root {
  --surface: #0f1115;
  --text: #f5f7fa;
}

.report-card {
  color: var(--text);
  background: var(--surface);
}
`
const EDIT_OLD = '  --surface: #0f1115;'
const EDIT_NEW = '  --surface: #ffffff;'
const MULTI_EDIT_FILE = 'src/styles/components.css'
const MULTI_EDIT_OLD = 'color: var(--legacy-accent);'
const MULTI_EDIT_NEW = 'color: var(--accent);'
const MULTI_EDIT_BEFORE = `.report-link {
  color: var(--legacy-accent);
}

.report-badge {
  color: var(--legacy-accent);
}
`
const WRITE_FILE = 'src/components/CalibrationCard.tsx'
const WRITE_MARKERS = ['export function CalibrationCard', 'data-sidekick="calibration-card"']

export interface EditingContractRecoveryResult {
  switched: boolean
  from: EditingDialect
  to?: EditingDialect
  calibration?: EditingContractCalibration
  reason?: string
}

type Complete = typeof completeProviderChat
type ResolveTarget = (request: ProviderEditingCalibrationRequest) => ProviderTarget
type PersistCalibration = (target: ProviderTarget, calibration: EditingContractCalibration) => void

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 600)
}

function objectArguments(call: ProviderToolCall): Record<string, unknown> {
  const raw = call.function.arguments
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  const normalized = normalizeCompletedToolInput(raw)
  if (!normalized.recovered || typeof normalized.arguments === 'string') {
    throw new Error('The model returned malformed or incomplete tool arguments')
  }
  if (!normalized.arguments || typeof normalized.arguments !== 'object') {
    throw new Error('The model returned no tool arguments')
  }
  return normalized.arguments as Record<string, unknown>
}

function expectedToolName(dialect: EditingDialect, kind: EditingCalibrationProbeKind): string {
  if (dialect === 'apply-patch') return 'apply_patch'
  if (kind === 'complete-write') return dialect === 'claude-edit' ? 'Write' : 'write'
  if (dialect === 'claude-edit') return 'Edit'
  if (dialect === 'search-replace') return 'search_replace'
  return 'edit'
}

function longProjectContext(): string {
  const paragraph =
    'Historical project note: the application uses flat visual hierarchy, accessible contrast, responsive spacing, deterministic validation, and small composable modules. These earlier notes are background only; the final request below is authoritative. '
  return paragraph
    .repeat(Math.ceil(LONG_CONTEXT_CHARACTERS / paragraph.length))
    .slice(0, LONG_CONTEXT_CHARACTERS)
}

function probeInstruction(kind: EditingCalibrationProbeKind): string {
  if (kind === 'localized-edit') {
    return `The existing file ${EDIT_FILE} contains exactly:

${EDIT_BEFORE}
Make one localized change: replace exactly ${JSON.stringify(EDIT_OLD)} with ${JSON.stringify(EDIT_NEW)}. Preserve every other byte. If the tool has replace_all, set it to false. Set accessLevel to auto. Call the provided editing tool now and return no prose.`
  }
  if (kind === 'multi-replace') {
    return `The existing file ${MULTI_EDIT_FILE} contains exactly:

${MULTI_EDIT_BEFORE}
Replace every occurrence of ${JSON.stringify(MULTI_EDIT_OLD)} with ${JSON.stringify(MULTI_EDIT_NEW)}. Both occurrences must change and every other byte must remain identical. If the tool has replace_all, set it to true. Set accessLevel to auto. Call the provided editing tool now and return no prose.`
  }
  return `Create ${WRITE_FILE} as a complete React TypeScript component. It must export a function named CalibrationCard, return an article element with data-sidekick="calibration-card", contain a heading and one explanatory paragraph, and be at least 250 characters. Set accessLevel to auto. Call the provided editing tool now and return no prose.`
}

function requestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  return parent ? AbortSignal.any([parent, timeout]) : timeout
}

function mergeCalibrationResults(
  previous: readonly EditingDialectCalibrationResult[],
  next: EditingDialectCalibrationResult
): EditingDialectCalibrationResult[] {
  return [...previous.filter(({ dialect }) => dialect !== next.dialect), next]
}

function calibrationRecord(
  target: ProviderTarget,
  results: EditingDialectCalibrationResult[],
  selectedDialect?: EditingDialect
): EditingContractCalibration | undefined {
  const verifiedDialects = editingDialectCandidatesForModel({
    providerKind: target.providerKind,
    model: target.model,
    upstreamModel: target.upstreamModel
  }).filter((dialect) => results.some((result) => result.dialect === dialect && result.passed))
  const selected =
    selectedDialect && verifiedDialects.includes(selectedDialect)
      ? selectedDialect
      : verifiedDialects[0]
  if (!selected) return undefined
  return {
    version: EDITING_CALIBRATION_VERSION,
    model: target.model,
    ...(target.upstreamModel ? { upstreamModel: target.upstreamModel } : {}),
    selectedDialect: selected,
    verifiedDialects,
    results,
    calibratedAt: Date.now(),
    source: 'active-probe'
  }
}

function persistEditingCalibration(
  target: ProviderTarget,
  calibration: EditingContractCalibration
): void {
  if (!target.providerInstanceId) return
  updateStoredProviderModel(target.providerInstanceId, target.model, (model) => ({
    ...model,
    editingCalibration: calibration
  }))
}

export class EditingCompatibilityService {
  private readonly calibrationInFlight = new Map<
    string,
    Promise<ProviderEditingCalibrationResult>
  >()
  private readonly recoveryInFlight = new Map<string, Promise<EditingContractRecoveryResult>>()

  private readonly complete: Complete
  private readonly resolveTarget: ResolveTarget
  private readonly persist: PersistCalibration

  constructor(
    dependencies: {
      complete?: Complete
      resolveTarget?: ResolveTarget
      persist?: PersistCalibration
    } = {}
  ) {
    this.complete = dependencies.complete ?? completeProviderChat
    this.resolveTarget = dependencies.resolveTarget ?? ((request) => this.configuredTarget(request))
    this.persist = dependencies.persist ?? persistEditingCalibration
  }

  private configuredTarget(request: ProviderEditingCalibrationRequest): ProviderTarget {
    const instance = resolveProviderInstanceById(request.providerInstanceId)
    const model = instance.models.find(({ id }) => id === request.model)
    if (!model) throw new Error(`Model ${request.model} is not configured for ${instance.name}`)
    if (!model.enabled) throw new Error(`Model ${request.model} is disabled for ${instance.name}`)
    return {
      providerInstanceId: instance.id,
      providerKind: providerKindForInstance(instance),
      model: model.id,
      contextLength: model.metadataOverrides?.contextLength ?? model.contextLength,
      maxOutputTokens: model.metadataOverrides?.maxOutputTokens ?? model.maxOutputTokens,
      editingDialect: model.editingDialect,
      upstreamModel: model.upstreamModel,
      editingCalibration: model.editingCalibration
    }
  }

  private async runProbe(
    target: ProviderTarget,
    dialect: EditingDialect,
    kind: EditingCalibrationProbeKind,
    signal?: AbortSignal
  ): Promise<EditingCalibrationProbeResult> {
    const startedAt = Date.now()
    const toolName = expectedToolName(dialect, kind)
    const tool = editingToolDefinitions(dialect).find(
      (definition) => definition.function.name === toolName
    )
    if (!tool) {
      return { kind, passed: false, latencyMs: 0, error: `${dialect} does not expose ${toolName}` }
    }
    const workspace = await fs.mkdtemp(join(tmpdir(), 'sidekick-edit-calibration-'))
    try {
      if (kind !== 'complete-write') {
        const filePath = kind === 'localized-edit' ? EDIT_FILE : MULTI_EDIT_FILE
        const content = kind === 'localized-edit' ? EDIT_BEFORE : MULTI_EDIT_BEFORE
        const absolutePath = join(workspace, filePath)
        await fs.mkdir(dirname(absolutePath), { recursive: true })
        await fs.writeFile(absolutePath, content, 'utf8')
      }
      const result = await this.complete(
        {
          target,
          messages: [
            {
              role: 'system',
              content:
                'This is a SideKick file-edit compatibility probe. Follow only the final request, call exactly one provided tool, include every required argument with complete content, and return no prose.'
            },
            {
              role: 'user',
              content: `<historical_context trust="untrusted-data">\n${longProjectContext()}\n</historical_context>\n\n${probeInstruction(kind)}`
            }
          ],
          tools: [tool],
          maxOutputTokens: Math.min(
            CALIBRATION_OUTPUT_TOKENS,
            resolveMaxOutputTokens(target.contextLength || 32_768, target.maxOutputTokens)
          ),
          temperature: 0,
          thinkingEnabled: false,
          purpose: 'editing-calibration'
        },
        requestSignal(signal)
      )
      if (!result.ok || !result.data) throw new Error(result.error || 'Provider probe failed')
      const call = result.data.message.tool_calls?.find(
        (candidate) => candidate.function.name === toolName
      )
      if (!call) {
        const returned = result.data.message.tool_calls
          ?.map((candidate) => candidate.function.name)
          .filter(Boolean)
          .join(', ')
        throw new Error(
          returned
            ? `Expected ${toolName}, but the model called ${returned}`
            : `The model did not call ${toolName}`
        )
      }
      const suppliedArgs = objectArguments(call)
      const normalized = normalizeAgentToolArguments(tool, suppliedArgs)
      const issues = validateAgentToolArguments(tool, normalized.arguments)
      if (issues.length) {
        throw new Error(
          `The model returned invalid ${toolName} arguments: ${issues.map(({ message }) => message).join('; ')}`
        )
      }
      const mutation = workspaceMutationRequestFromTool(toolName, normalized.arguments)
      const applied = await executeWorkspaceMutation(workspace, mutation)
      if (!applied.ok || !applied.changed) {
        throw new Error(applied.error || 'The generated mutation made no verified change')
      }
      if (kind === 'localized-edit') {
        const content = await fs.readFile(join(workspace, EDIT_FILE), 'utf8')
        if (content !== EDIT_BEFORE.replace(EDIT_OLD, EDIT_NEW)) {
          throw new Error('The tool call changed content outside the requested localized edit')
        }
      } else if (kind === 'multi-replace') {
        const content = await fs.readFile(join(workspace, MULTI_EDIT_FILE), 'utf8')
        if (content !== MULTI_EDIT_BEFORE.replaceAll(MULTI_EDIT_OLD, MULTI_EDIT_NEW)) {
          throw new Error(
            'The tool call did not replace every requested occurrence or changed unrelated content'
          )
        }
      } else {
        const content = await fs.readFile(join(workspace, WRITE_FILE), 'utf8')
        if (content.length < 250 || WRITE_MARKERS.some((marker) => !content.includes(marker))) {
          throw new Error('The generated file omitted required content or was incomplete')
        }
      }
      return { kind, passed: true, latencyMs: Date.now() - startedAt, toolName }
    } catch (error) {
      return {
        kind,
        passed: false,
        latencyMs: Date.now() - startedAt,
        toolName,
        error: boundedError(error)
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  }

  private async testDialect(
    target: ProviderTarget,
    dialect: EditingDialect,
    signal?: AbortSignal
  ): Promise<EditingDialectCalibrationResult> {
    const probes: EditingCalibrationProbeResult[] = []
    for (const kind of ['localized-edit', 'multi-replace', 'complete-write'] as const) {
      if (signal?.aborted) break
      probes.push(await this.runProbe(target, dialect, kind, signal))
    }
    return { dialect, passed: probes.length === 3 && probes.every(({ passed }) => passed), probes }
  }

  async calibrate(
    request: ProviderEditingCalibrationRequest
  ): Promise<ProviderEditingCalibrationResult> {
    const key = `${request.providerInstanceId}:${request.model}`
    const existing = this.calibrationInFlight.get(key)
    if (existing) return existing
    const pending = (async (): Promise<ProviderEditingCalibrationResult> => {
      try {
        const target = this.resolveTarget(request)
        const results: EditingDialectCalibrationResult[] = []
        for (const dialect of editingDialectCandidatesForModel({
          providerKind: target.providerKind,
          model: target.model,
          upstreamModel: target.upstreamModel
        })) {
          results.push(await this.testDialect(target, dialect))
        }
        const calibration = calibrationRecord(target, results)
        if (!calibration) {
          return {
            ok: false,
            results,
            error:
              'No editing contract passed the long-context localized-edit, multi-replace, and complete-write probes.'
          }
        }
        this.persist(target, calibration)
        return { ok: true, calibration, results }
      } catch (error) {
        return { ok: false, error: boundedError(error) }
      }
    })().finally(() => this.calibrationInFlight.delete(key))
    this.calibrationInFlight.set(key, pending)
    return pending
  }

  async recover(
    target: ProviderTarget,
    currentDialect: EditingDialect,
    signal?: AbortSignal
  ): Promise<EditingContractRecoveryResult> {
    if (!target.providerInstanceId || (target.editingDialect && target.editingDialect !== 'auto')) {
      return {
        switched: false,
        from: currentDialect,
        reason: target.providerInstanceId
          ? 'The editing contract is manually pinned.'
          : 'The provider model is not instance-scoped.'
      }
    }
    const key = `${target.providerInstanceId}:${target.model}`
    const existing = this.recoveryInFlight.get(key)
    if (existing) return existing
    const pending = (async (): Promise<EditingContractRecoveryResult> => {
      const calibrated = validEditingCalibration({
        providerKind: target.providerKind,
        model: target.model,
        dialect: target.editingDialect,
        upstreamModel: target.upstreamModel,
        calibration: target.editingCalibration
      })
      const savedFallback = verifiedEditingDialectFallbacks(
        {
          providerKind: target.providerKind,
          model: target.model,
          dialect: target.editingDialect,
          upstreamModel: target.upstreamModel,
          calibration: target.editingCalibration
        },
        currentDialect
      )[0]
      if (savedFallback && calibrated) {
        const promoted = { ...calibrated, selectedDialect: savedFallback, calibratedAt: Date.now() }
        this.persist(target, promoted)
        return { switched: true, from: currentDialect, to: savedFallback, calibration: promoted }
      }

      let results = calibrated?.results || []
      const candidates = editingDialectCandidatesForModel({
        providerKind: target.providerKind,
        model: target.model,
        upstreamModel: target.upstreamModel
      }).filter((dialect) => dialect !== currentDialect)
      for (const dialect of candidates) {
        if (signal?.aborted) break
        const result = await this.testDialect(target, dialect, signal)
        results = mergeCalibrationResults(results, result)
        if (!result.passed) continue
        const calibration = calibrationRecord(target, results, dialect)
        if (!calibration) continue
        this.persist(target, calibration)
        return { switched: true, from: currentDialect, to: dialect, calibration }
      }
      return {
        switched: false,
        from: currentDialect,
        reason: 'No alternative editing contract passed both compatibility probes.'
      }
    })()
      .catch((error) => ({
        switched: false,
        from: currentDialect,
        reason: boundedError(error)
      }))
      .finally(() => this.recoveryInFlight.delete(key))
    this.recoveryInFlight.set(key, pending)
    return pending
  }
}

export const editingCompatibilityService = new EditingCompatibilityService()
