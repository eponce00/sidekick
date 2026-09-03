import type Database from 'better-sqlite3'
import { agentRunProfile, getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import { normalizeToolCallLimit } from '../../shared/agentLimits'
import type { StartConversationAgentRunInput } from '../../shared/agentRunApi'
import { normalizePermissionMode } from '../../shared/permissions'
import { estimateProviderRequestTokens, resolveMaxOutputTokens } from '../../shared/contextBudget'
import {
  capabilitiesFromTools,
  createPromptModelProfile,
  createResearchProfilePrompt,
  PromptComposer,
  RESEARCH_PROFILE_PROMPT_VERSION,
  type PromptLocation
} from '../../shared/prompts'
import { providerKindForTransport } from '../../shared/providerRegistry'
import type {
  ProviderChatMessage,
  ProviderTarget,
  ProviderThinkingBlock,
  ProviderToolCall
} from '../../shared/providerRuntime'
import { formatCompactionContext } from '../../shared/compactionPrompt'
import type { PinnedModel } from '../../shared/models'
import type { ProviderSettings } from '../../shared/settings'
import { refreshProviderTargetMetadata } from '../../shared/providerInstances'
import { resolveProviderContext } from '../providers/providerRuntime'
import { beginWorkspaceInstructionScope } from './workspaceRules'
import { ProjectStore } from './projectStore'
import { ConversationCompactionStore } from './conversationCompactionStore'
import { AgentContextManager, type AgentCompactionRecord } from './agentContextManager'
import type { AgentToolRuntime, AgentToolRuntimeSession } from './agentToolRuntime'
import type { StartAgentKernelRunInput } from './agentRunKernel'
import { ConversationGoalStore } from './conversationGoalStore'
import type { ConversationGoal } from '../../shared/conversationGoals'
import { loadContextUsageByOutputMessage } from './agentRunContextUsage'
import { AgentPlanService } from './agentPlanService'
import type { AgentKernelRuntimeTransition } from './agentRunKernel'
import { parseMessageImages } from '../../shared/messageImages'
import {
  formatMessageContextAttachments,
  parseMessageContextAttachments
} from '../../shared/messageContextAttachments'
import { normalizeToolResultMedia, type ToolResultMediaAttachment } from '../../shared/agentRuntime'

export interface MessageRow {
  id: string
  role: 'user' | 'agent' | 'system'
  content: string
  thinking: string | null
  segments: string | null
  images: string | null
  attachments?: string | null
  token_usage: string | null
  timestamp: number
}

export interface PreparedConversationAgentRun {
  kernelInput: StartAgentKernelRunInput
  toolSession: AgentToolRuntimeSession
  workspaceRoot: string | null
  latestUserMessage: MessageRow | null
  onWorkspaceWillMutate: () => Promise<void>
  latestCompaction: () => AgentCompactionRecord | null
  goalId?: string
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function providerMessage(row: MessageRow): ProviderChatMessage {
  const images = parseMessageImages(row.images).map((image) => image.dataUrl)
  const attachmentContext = formatMessageContextAttachments(
    parseMessageContextAttachments(row.attachments)
  )
  const content = [row.content.trim(), attachmentContext].filter(Boolean).join('\n\n')
  return {
    role: row.role === 'agent' ? 'assistant' : row.role,
    // Renderer segments are a projection for people, never provider input. Re-serializing
    // them caused user-visible strings such as "Recorded activity" to become model speech.
    content,
    ...(images.length ? { images } : {})
  }
}

interface ProviderHistoryEventRow {
  run_id: string
  provider: string
  model: string
  type: string
  payload_json: string
}

function durableToolMedia(value: unknown): ToolResultMediaAttachment[] {
  if (!Array.isArray(value)) return []
  try {
    return normalizeToolResultMedia(value as ToolResultMediaAttachment[]) || []
  } catch {
    // A malformed historic attachment must not poison the entire conversation transcript.
    return []
  }
}

const LEGACY_VERBOSE_BROWSER_ACTIONS = new Set([
  'browser_click',
  'browser_fill_form',
  'browser_hover',
  'browser_navigate',
  'browser_press',
  'browser_resize',
  'browser_scroll',
  'browser_select',
  'browser_tabs',
  'browser_type',
  'browser_wait'
])
const LEGACY_BROWSER_RECEIPT_THRESHOLD = 4_000

function compactLegacyBrowserReceipt(
  name: string,
  content: string
): { content: string; compacted: boolean } {
  if (!LEGACY_VERBOSE_BROWSER_ACTIONS.has(name) || content.length <= LEGACY_BROWSER_RECEIPT_THRESHOLD) {
    return { content, compacted: false }
  }
  try {
    const value = JSON.parse(content) as Record<string, unknown>
    const observation =
      value.observation && typeof value.observation === 'object'
        ? (value.observation as Record<string, unknown>)
        : undefined
    const tab =
      observation?.tab && typeof observation.tab === 'object'
        ? (observation.tab as Record<string, unknown>)
        : undefined
    const screenshot =
      observation?.screenshot && typeof observation.screenshot === 'object'
        ? (observation.screenshot as Record<string, unknown>)
        : undefined
    return {
      compacted: true,
      content: JSON.stringify({
        historicalBrowserReceipt: true,
        action: typeof value.action === 'string' ? value.action : name,
        ...(typeof value.targetMode === 'string' ? { targetMode: value.targetMode } : {}),
        ...(typeof value.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
        page: {
          ...(typeof tab?.title === 'string' ? { title: tab.title } : {}),
          ...(typeof tab?.url === 'string' ? { url: tab.url } : {}),
          ...(observation?.viewport && typeof observation.viewport === 'object'
            ? { viewport: observation.viewport }
            : {})
        },
        visual: {
          ...(typeof observation?.screenshotChanged === 'boolean'
            ? { changed: observation.screenshotChanged }
            : {}),
          ...(typeof screenshot?.sha256 === 'string' ? { sha256: screenshot.sha256 } : {})
        },
        ...(value.quiescence && typeof value.quiescence === 'object'
          ? { quiescence: value.quiescence }
          : {}),
        note:
          'SideKick compacted this legacy full-page action receipt. Inspect the current page only if it is still relevant.'
      })
    }
  } catch {
    return { content, compacted: false }
  }
}

/**
 * Rebuild provider history from the append-only run ledger. UI segments are intentionally
 * excluded: they are a human projection and are neither protocol messages nor model input.
 */
export function durableProviderHistory(
  db: Database.Database,
  conversationId: string,
  rows: readonly MessageRow[],
  currentTarget: Pick<ProviderTarget, 'providerKind' | 'model'>
): ProviderChatMessage[] {
  const eventRows = db
    .prepare(
      `SELECT e.run_id, r.provider, r.model, e.type, e.payload_json
       FROM agent_runs r
       JOIN agent_run_events e ON e.run_id = r.id
       WHERE r.thread_id = ?
       ORDER BY r.started_at ASC, e.sequence ASC`
    )
    .all(conversationId) as ProviderHistoryEventRow[]
  const outputByRun = new Map<string, string>()
  const messagesByOutput = new Map<string, ProviderChatMessage[]>()

  for (const event of eventRows) {
    const payload = parseJson<Record<string, unknown>>(event.payload_json, {})
    if (event.type === 'run.started') {
      const outputMessageId = String(payload.outputMessageId || '')
      if (outputMessageId) {
        outputByRun.set(event.run_id, outputMessageId)
        messagesByOutput.set(outputMessageId, [])
      }
      continue
    }
    const outputMessageId = outputByRun.get(event.run_id)
    if (!outputMessageId) continue
    const history = messagesByOutput.get(outputMessageId)!
    if (event.type === 'assistant.completed') {
      const calls = Array.isArray(payload.toolCalls)
        ? (payload.toolCalls as Array<Record<string, unknown>>).map(
            (call): ProviderToolCall => ({
              id: String(call.id || ''),
              function: {
                name: String(call.name || ''),
                arguments:
                  call.arguments && typeof call.arguments === 'object'
                    ? (call.arguments as Record<string, unknown>)
                    : {}
              }
            })
          )
        : []
      const sameProviderGeneration =
        event.provider === currentTarget.providerKind && event.model === currentTarget.model
      const thinkingBlocks =
        sameProviderGeneration && Array.isArray(payload.thinkingBlocks)
          ? (payload.thinkingBlocks as ProviderThinkingBlock[])
          : []
      history.push({
        role: 'assistant',
        content: typeof payload.content === 'string' && payload.content ? payload.content : null,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(thinkingBlocks.length ? { thinking_blocks: thinkingBlocks } : {})
      })
      continue
    }
    if (event.type === 'tool.completed') {
      const result =
        payload.result && typeof payload.result === 'object'
          ? (payload.result as Record<string, unknown>)
          : {}
      const name = String(payload.name || '')
      const rawContent = typeof result.modelContent === 'string' ? result.modelContent : ''
      const receipt = compactLegacyBrowserReceipt(name, rawContent)
      const media = receipt.compacted ? [] : durableToolMedia(result.media)
      history.push({
        role: 'tool',
        tool_call_id: String(payload.toolCallId || ''),
        content: receipt.content,
        ...(media.length ? { media } : {})
      })
    }
  }

  return rows.flatMap((row) => {
    if (row.role !== 'agent') return [providerMessage(row)]
    const durable = messagesByOutput.get(row.id)
    return durable?.length ? durable : [providerMessage(row)]
  })
}

function storedPromptTokens(
  row: MessageRow,
  runUsage: ReturnType<typeof loadContextUsageByOutputMessage>
): number | null {
  const durableUsage = runUsage.get(row.id)
  if (durableUsage && durableUsage.promptTokens > 0) return durableUsage.promptTokens
  const usage = parseJson<Record<string, unknown>>(row.token_usage, {})
  const promptTokens = Number(usage.promptTokens)
  return Number.isFinite(promptTokens) && promptTokens > 0 ? Math.ceil(promptTokens) : null
}

function afterCompaction(
  rows: MessageRow[],
  compaction: ReturnType<ConversationCompactionStore['latest']>
): MessageRow[] {
  if (!compaction) return rows
  if (compaction.compactedThroughMessageId) {
    const index = rows.findIndex((row) => row.id === compaction.compactedThroughMessageId)
    if (index >= 0) return rows.slice(index + 1)
  }
  if (compaction.compactedThroughTimestamp != null) {
    return rows.filter((row) => row.timestamp > compaction.compactedThroughTimestamp!)
  }
  return rows
}

function compactionContext(summary: string): ProviderChatMessage {
  return {
    role: 'user',
    content: formatCompactionContext(summary)
  }
}

function goalContract(goal: ConversationGoal): ProviderChatMessage {
  const plan = goal.plan.length
    ? `\nCurrent durable plan:\n${goal.plan.map((item) => `- [${item.status}] ${item.title}`).join('\n')}`
    : ''
  return {
    role: 'system',
    content: `<sidekick_goal_contract trust="app-policy" goal_id="${goal.id}" revision="${goal.revision}">
The user has attached a persistent goal to this conversation. The objective is both the current request and the completion criterion:

${goal.objective}${plan}

Keep making concrete progress until the whole objective is genuinely achieved. For substantive work, maintain the durable plan with manage_todo_list. Do not stop because one model response ended, because the task is difficult, or because the context was compacted. Use update_goal(status="complete") only after all required work is done and include concrete verification evidence. Use update_goal(status="blocked") only for a real impasse that prevents meaningful progress; SideKick requires the same blocker on three consecutive goal turns before it becomes terminal. Use ask_user when a specific user decision is required. The goal does not expand filesystem, shell, network, MCP, or permission access.
</sidekick_goal_contract>`
  }
}

function goalContinuation(goal: ConversationGoal): string {
  const remaining = goal.plan.filter((item) => item.status !== 'completed')
  return `<sidekick_goal_continuation trust="app-policy" goal_id="${goal.id}" revision="${goal.revision}">
The previous response ended without completing or pausing the persistent goal. Continue now with the next concrete action toward:

${goal.objective}

${remaining.length ? `Remaining plan items:\n${remaining.map((item) => `- ${item.title}`).join('\n')}\n` : ''}Do not merely restate progress. Work, verify, and call update_goal only when its strict complete or blocked contract is satisfied.
</sidekick_goal_continuation>`
}

function modelTarget(model: PinnedModel): ProviderTarget {
  return {
    providerInstanceId: model.providerInstanceId,
    providerKind: model.providerKind ?? providerKindForTransport(model.provider),
    model: model.providerModelId || model.name,
    contextLength: model.contextLength,
    maxOutputTokens: model.maxOutputTokens,
    editingDialect: model.editingDialect,
    upstreamModel: model.upstreamModel,
    editingCalibration: model.editingCalibration
  }
}

export class ConversationRunPreparer {
  constructor(
    private readonly db: Database.Database,
    private readonly tools: AgentToolRuntime,
    private readonly goals: ConversationGoalStore,
    private readonly settings: () => ProviderSettings,
    private readonly skillAssetsPath: () => string
  ) {}

  async prepare(
    input: StartConversationAgentRunInput,
    onWorkspaceWillMutate: () => Promise<void>
  ): Promise<PreparedConversationAgentRun> {
    const surface = input.mode === 'research' ? 'research' : 'conversation'
    const initialPlanStage = input.mode === 'plan' ? 'planning' : 'inactive'
    const requestedPlanningModel = input.plannerModel ?? input.model
    const planningModel =
      input.mode !== 'plan' && requestedPlanningModel.supportsTools === false
        ? input.model
        : requestedPlanningModel
    const goal =
      surface === 'conversation' && input.mode !== 'plan'
        ? this.goals.runnable(input.conversationId)
        : null
    if (goal && input.model.supportsTools === false) {
      throw new Error('Persistent goals require a tool-capable model so completion can be verified')
    }
    if (input.mode === 'plan' && planningModel.supportsTools === false) {
      throw new Error('Plan mode requires a tool-capable planning model')
    }
    const currentSettings = this.settings()
    const project = new ProjectStore(this.db).getConversationContext(input.conversationId)
    const workspaceRoot = project.workspaceRoot
    const rules = workspaceRoot
      ? await beginWorkspaceInstructionScope(input.id, workspaceRoot)
      : { content: '', sources: [], truncated: false }
    const memory = workspaceRoot
      ? ((
          this.db
            .prepare('SELECT content FROM workspace_memory WHERE workspace_path = ?')
            .get(workspaceRoot) as { content: string } | undefined
        )?.content ?? '')
      : ''
    const conversation = this.db
      .prepare('SELECT active_skills FROM conversations WHERE id = ?')
      .get(input.conversationId) as { active_skills: string | null } | undefined
    if (!conversation) throw new Error('Conversation not found')
    const activeSkillIds = parseJson<string[]>(conversation.active_skills, [])
    const executionTarget = refreshProviderTargetMetadata(
      modelTarget(input.model),
      currentSettings.providerInstances || []
    )
    const planningTarget = refreshProviderTargetMetadata(
      modelTarget(planningModel),
      currentSettings.providerInstances || []
    )
    const planService =
      surface === 'conversation' && input.model.supportsTools !== false
        ? new AgentPlanService(
            this.db,
            input.id,
            planningTarget.model,
            executionTarget.model,
            initialPlanStage
          )
        : null
    const toolSession = await this.tools.createSession({
      runId: input.id,
      surface,
      workspaceRoot: workspaceRoot ?? undefined,
      webSearchEnabled: true,
      browserEnabled: input.model.supportsVision !== false,
      capabilities: input.model.supportsTools === false ? [] : undefined,
      persistentSkillIds: activeSkillIds,
      mcpConfigs: currentSettings.mcpServers,
      instructionScopeId: input.id,
      onWorkspaceWillMutate,
      plan: planService
        ? {
            stage: () => planService.stage(),
            complete: (completion) => planService.complete(completion)
          }
        : undefined,
      goal: goal
        ? {
            execute: async (args) => {
              const status = args.status === 'blocked' ? 'blocked' : 'complete'
              if (status === 'complete') {
                const completed = this.goals.complete(
                  goal.id,
                  typeof args.summary === 'string' ? args.summary : '',
                  typeof args.verification === 'string' ? args.verification : ''
                )
                return {
                  status: completed.status,
                  summary: completed.completionSummary,
                  verification: completed.completionVerification
                }
              }
              const blocked = this.goals.reportBlocked(
                goal.id,
                typeof args.blocker_key === 'string' ? args.blocker_key : '',
                typeof args.summary === 'string' ? args.summary : ''
              )
              return {
                status: blocked.status,
                blockedStreak: blocked.blockedStreak,
                message:
                  blocked.status === 'blocked'
                    ? 'Goal blocked after the same impasse was confirmed three consecutive times.'
                    : `Blocker recorded ${blocked.blockedStreak}/3. Keep trying materially different approaches or ask the user for the needed decision.`
              }
            },
            onTodosUpdated: (todos) => {
              this.goals.updatePlan(goal.id, todos)
            }
          }
        : undefined
    })
    const permissionMode = normalizePermissionMode(currentSettings.commandPermissionMode)
    const composeRuntimePrompt = (
      model: PinnedModel,
      planStage: 'inactive' | 'planning' | 'executing'
    ) => {
      const runtimeCatalog = { ...toolSession.catalog(), planStage }
      const toolDefinitions =
        model.supportsTools === false ? [] : getAgentToolDefinitions(runtimeCatalog)
      return new PromptComposer().compose({
        platform:
          process.platform === 'win32'
            ? 'windows'
            : process.platform === 'darwin'
              ? 'macos'
              : 'linux',
        capabilities: capabilitiesFromTools(toolDefinitions),
        permissionMode,
        model: createPromptModelProfile(model),
        project: {
          workspaceRoot,
          instructions: rules.content,
          instructionSources: rules.sources,
          memory,
          latestTransition: project.latestTransition,
          homeWorkspaceRoot: project.homeWorkspaceRoot,
          homeProjectName: project.homeProjectName,
          isDetached: project.isDetached
        },
        currentDate: new Intl.DateTimeFormat('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }).format(new Date()),
        location: input.userLocation as PromptLocation | undefined,
        toolRoundLimit: normalizeToolCallLimit(currentSettings.toolCallLimit),
        activeSkillIds: runtimeCatalog.activeSkillIds ?? activeSkillIds,
        skillAssetsPath: this.skillAssetsPath()
      })
    }
    const initialActPrompt = composeRuntimePrompt(input.model, 'inactive')
    const planningPrompt = composeRuntimePrompt(planningModel, 'planning')
    const prompt = input.mode === 'plan' ? planningPrompt : initialActPrompt
    const catalog = toolSession.catalog()
    const toolDefinitions =
      input.model.supportsTools === false ? [] : getAgentToolDefinitions(catalog)
    const rows = this.db
      .prepare(
        `SELECT id, role, content, thinking, segments, images, attachments, token_usage, timestamp
         FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC, rowid ASC`
      )
      .all(input.conversationId) as MessageRow[]
    const compactionStore = new ConversationCompactionStore(this.db)
    const priorCompaction = compactionStore.latest(input.conversationId)
    const projected = afterCompaction(rows, priorCompaction)
    const runUsage = loadContextUsageByOutputMessage(this.db, input.conversationId)
    const promptPrefix: ProviderChatMessage[] = [
      { role: 'system', content: prompt.content },
      ...(surface === 'research'
        ? [
            {
              role: 'system' as const,
              content: createResearchProfilePrompt()
            }
          ]
        : []),
      ...(goal ? [goalContract(goal)] : []),
      ...(prompt.projectInstructionsMessage
        ? [{ role: 'user', content: prompt.projectInstructionsMessage }]
        : []),
      ...(priorCompaction ? [compactionContext(priorCompaction.summary)] : [])
    ]
    const providerHistory = durableProviderHistory(
      this.db,
      input.conversationId,
      projected.filter((row) => row.role !== 'system'),
      executionTarget
    )
    const messages: ProviderChatMessage[] = [...promptPrefix, ...providerHistory]
    if (goal && projected.at(-1)?.role === 'agent') {
      messages.push({ role: 'user', content: goalContinuation(goal) })
    }
    const [resolvedExecutionContext, resolvedPlanningContext] = await Promise.all([
      resolveProviderContext(executionTarget),
      resolveProviderContext(planningTarget)
    ])
    const latestUsageIndex = projected.findLastIndex(
      (row) => row.role === 'agent' && storedPromptTokens(row, runUsage) !== null
    )
    const latestPromptTokens =
      latestUsageIndex >= 0 ? storedPromptTokens(projected[latestUsageIndex], runUsage) : null
    const previousRequestMessages =
      latestUsageIndex >= 0
        ? [
            ...promptPrefix,
            ...durableProviderHistory(
              this.db,
              input.conversationId,
              projected.slice(0, latestUsageIndex).filter((row) => row.role !== 'system'),
              executionTarget
            )
          ]
        : []
    const initialEstimationBiasTokens = latestPromptTokens
      ? Math.max(
          0,
          latestPromptTokens -
            estimateProviderRequestTokens(previousRequestMessages, toolDefinitions)
        )
      : 0
    let latestRunCompaction: AgentCompactionRecord | null = null
    const thinkingEnabled = (target: ProviderTarget): boolean | undefined =>
      target.providerKind === 'ollama' || target.providerKind === 'ollama-cloud'
        ? currentSettings.ollamaThinkingEnabled !== false
        : target.providerKind === 'openrouter'
          ? currentSettings.openRouterThinkingEnabled === true
          : undefined
    const createRuntime = (
      target: ProviderTarget,
      model: PinnedModel,
      resolved: Awaited<ReturnType<typeof resolveProviderContext>>
    ): Pick<AgentKernelRuntimeTransition, 'provider' | 'model' | 'request' | 'contextManager'> & {
      contextLength: number
      contextReliable: boolean
    } => {
      const contextLength = Math.max(1_024, resolved.contextLength ?? 32_768)
      const maxOutputTokens = resolveMaxOutputTokens(contextLength, model.maxOutputTokens)
      return {
        provider: target.providerKind,
        model: target.model,
        contextLength,
        contextReliable: resolved.reliable,
        request: {
          target: { ...target, contextLength },
          maxOutputTokens,
          purpose: surface === 'research' ? 'research' : 'conversation',
          thinkingEnabled: thinkingEnabled(target)
        },
        contextManager: new AgentContextManager({
          target: { ...target, contextLength },
          contextLength,
          maxOutputTokens,
          threshold: Math.max(0.5, Math.min(0.95, currentSettings.autoCompactThreshold ?? 0.8)),
          enabled: currentSettings.autoCompactEnabled !== false,
          focusChainEnabled: currentSettings.focusChainEnabled,
          previousSummary: priorCompaction?.summary,
          initialEstimationBiasTokens:
            model.id === input.model.id ? initialEstimationBiasTokens : 0,
          onCompacted: (record) => {
            latestRunCompaction = record
          }
        })
      }
    }
    const executionRuntime = createRuntime(executionTarget, input.model, resolvedExecutionContext)
    const planningRuntime = createRuntime(planningTarget, planningModel, resolvedPlanningContext)
    const initialRuntime = input.mode === 'plan' ? planningRuntime : executionRuntime
    const transitionFor = (
      runtime: typeof initialRuntime,
      systemPrompt: string,
      revision?: string
    ): AgentKernelRuntimeTransition => ({
      profile: agentRunProfile(toolSession.catalog()),
      provider: runtime.provider,
      model: runtime.model,
      request: runtime.request,
      contextManager: runtime.contextManager,
      systemPrompt,
      ...(revision ? { revision } : {})
    })
    return {
      workspaceRoot,
      latestUserMessage: [...rows].reverse().find((row) => row.role === 'user') ?? null,
      onWorkspaceWillMutate,
      latestCompaction: () => latestRunCompaction,
      ...(goal ? { goalId: goal.id } : {}),
      toolSession,
      kernelInput: {
        id: input.id,
        threadId: input.conversationId,
        outputMessageId: input.assistantMessageId,
        profile: agentRunProfile(catalog),
        provider: initialRuntime.provider,
        model: initialRuntime.model,
        workspaceRoot: workspaceRoot ?? undefined,
        promptContext: {
          version: prompt.version,
          sectionIds: [...prompt.sectionIds],
          modelFamily: prompt.modelFamily,
          contextLength: initialRuntime.contextLength,
          contextReliable: initialRuntime.contextReliable,
          plannerModel: planningRuntime.model,
          executorModel: executionRuntime.model,
          projectId: project.projectId,
          projectContextVersion: project.contextVersion,
          researchProfileVersion:
            surface === 'research' ? RESEARCH_PROFILE_PROMPT_VERSION : undefined
        },
        catalog: toolSession.catalog,
        messages,
        request: initialRuntime.request,
        maxToolRounds: normalizeToolCallLimit(currentSettings.toolCallLimit),
        permissionMode,
        toolRouter: toolSession.router,
        verificationController: toolSession.verificationController,
        contextManager: initialRuntime.contextManager,
        planController: planService
          ? {
              stage: () => planService.stage(),
              enter: async () => {
                planService.enter()
                return transitionFor(
                  planningRuntime,
                  composeRuntimePrompt(planningModel, 'planning').content
                )
              },
              prepareReview: async (plan) => planService.prepareReview(plan),
              approve: async (revision) => {
                const approved = planService.approve(revision)
                const executionPrompt = composeRuntimePrompt(input.model, 'executing')
                const approvedExecutionPrompt = `${executionPrompt.content}

<approved_plan_contract trust="user-approved" revision="${approved.revision}">
${JSON.stringify(approved.contract)}
</approved_plan_contract>`
                return transitionFor(executionRuntime, approvedExecutionPrompt, revision)
              },
              revise: async (revision) => planService.revise(revision),
              keep: async (revision) => planService.keep(revision),
              afterTerminalTurn: async () => planService.afterTerminalTurn()
            }
          : undefined,
        goalController: goal
          ? {
              onUsage: (usage) => {
                this.goals.addUsage(goal.id, usage.promptTokens, usage.completionTokens)
              },
              afterTerminalTurn: async () => {
                const latest = this.goals.get(goal.id)
                if (!latest || latest.status !== 'active') return { continue: false }
                const continued = this.goals.continue(goal.id)
                return { continue: true, prompt: goalContinuation(continued) }
              }
            }
          : undefined
      }
    }
  }
}
