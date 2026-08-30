import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { join } from 'path'
import type {
  AgentRunEventsResult,
  ResolveAgentInteractionInput,
  StartConversationAgentRunInput
} from '../../shared/agentRunApi'
import type { AgentRunEvent, AgentRunSnapshot } from '../../shared/agentRuntime'
import { agentRunProfile } from '../../shared/agentToolCatalog'
import { normalizeToolCallLimit } from '../../shared/agentLimits'
import { normalizePermissionMode } from '../../shared/permissions'
import { resolveMaxOutputTokens } from '../../shared/contextBudget'
import { refreshProviderTargetMetadata } from '../../shared/providerInstances'
import type { ProviderInstance } from '../../shared/settings'
import type { ProviderSettings } from '../../shared/settings'
import { providerDefinition, type ProviderKind } from '../../shared/providerRegistry'
import {
  capabilitiesFromTools,
  createPromptModelProfile,
  PromptComposer
} from '../../shared/prompts'
import type { ProviderChatMessage, ProviderTarget } from '../../shared/providerRuntime'
import { resolveProviderContext } from '../providers/providerRuntime'
import { loadStoredSettings } from '../ipc/settings'
import { createCheckpoint, beginCheckpointCapture } from './checkpoints'
import { CheckpointTitleStore } from './checkpointTitleStore'
import { ConversationCompactionStore } from './conversationCompactionStore'
import {
  ConversationRunPreparer,
  type PreparedConversationAgentRun
} from './conversationRunPreparer'
import { AgentRunKernel, type AgentKernelRunResult } from './agentRunKernel'
import { AgentRunStore } from './agentRunStore'
import { AgentMessageMaterializer } from './agentMessageMaterializer'
import { AgentToolRuntime } from './agentToolRuntime'
import { CommandService } from './commandService'
import { McpClientManager } from './mcpClientManager'
import { ToolOutputStore } from './toolOutputStore'
import { WorkspaceReadService } from './workspaceReadService'
import { AgentContextManager } from './agentContextManager'
import { clearWorkspaceInstructionScope } from './workspaceRules'
import type { AgentCollaborationToolHandler } from './agentToolRuntime'
import { getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import { checkpointFallbackTitleFromPaths } from '../../shared/checkpointTitles'
import { getBundledSkillAssetsPath } from './bundledSkillAssets'
import { ConversationGoalStore } from './conversationGoalStore'
import { NativeBrowserSessionService } from './nativeBrowserSessionService'
import type {
  ConversationGoal,
  CreateConversationGoalInput,
  UpdateConversationGoalInput
} from '../../shared/conversationGoals'

interface ActiveConversationRun {
  input: StartConversationAgentRunInput
  prepared: PreparedConversationAgentRun
  capture: { promise: Promise<string | null> | null }
}

export interface CollaborationKernelRunInput {
  id: string
  threadId: string
  workspaceRoot: string
  target: ProviderTarget
  messages: ProviderChatMessage[]
  projectInstructions: { content: string; sources: readonly string[] }
  projectMemory?: string
  collaborationInstructions: string
  maxToolRounds?: number
  collaboration: AgentCollaborationToolHandler
  beforeModelStep?: (
    messages: ProviderChatMessage[],
    signal: AbortSignal,
    toolRounds: number
  ) => Promise<ProviderChatMessage[]>
  onEvent?: (event: AgentRunEvent) => void
  onWorkspaceWillMutate?: () => Promise<void>
}

function checkpointLabel(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  return normalized.length > 72 ? `${normalized.slice(0, 71)}…` : normalized || 'Agent changes'
}

export class AgentRuntimeCoordinator {
  readonly store: AgentRunStore
  readonly kernel: AgentRunKernel
  readonly tools: AgentToolRuntime
  readonly browser: NativeBrowserSessionService
  readonly goals: ConversationGoalStore
  private readonly messages: AgentMessageMaterializer
  private readonly mcp = new McpClientManager()
  private readonly commands: CommandService
  private readonly outputs: ToolOutputStore
  private readonly activeConversations = new Map<string, ActiveConversationRun>()
  private readonly observers = new Map<string, Set<(event: AgentRunEvent) => void>>()
  private readonly publishExternal: (event: AgentRunEvent) => void
  private readonly settings: () => ProviderSettings
  private readonly skillAssetsPath: () => string

  constructor(
    private readonly db: Database.Database,
    userDataRoot: string,
    publish: (event: AgentRunEvent) => void,
    publishGoal: (goal: ConversationGoal) => void = () => undefined,
    options: {
      settings?: () => ProviderSettings
      skillAssetsPath?: () => string
    } = {}
  ) {
    this.publishExternal = publish
    this.settings = options.settings ?? (() => loadStoredSettings() as unknown as ProviderSettings)
    this.skillAssetsPath = options.skillAssetsPath ?? getBundledSkillAssetsPath
    this.store = new AgentRunStore(db)
    this.messages = new AgentMessageMaterializer(db, this.store)
    this.goals = new ConversationGoalStore(db, publishGoal)
    this.outputs = new ToolOutputStore(join(userDataRoot, 'tool-outputs'))
    this.commands = new CommandService(db, join(userDataRoot, 'command-outputs'))
    this.browser = new NativeBrowserSessionService({
      artifactRoot: join(userDataRoot, 'browser-artifacts'),
      maxTotalSessions: 6
    })
    this.tools = new AgentToolRuntime(
      db,
      new WorkspaceReadService(),
      this.commands,
      this.outputs,
      this.mcp,
      undefined,
      undefined,
      this.browser
    )
    this.kernel = new AgentRunKernel(this.store, undefined, undefined, (event) =>
      this.publishEvent(event)
    )
    this.tools.setChildLauncher({
      launch: (task, context, parent) => this.launchChild(task, context, parent)
    })
    this.recoverInterruptedRuns()
    this.goals.pauseActiveAfterRestart()
    void this.outputs
      .cleanup()
      .catch((error) => console.warn('[AgentRuntime] Could not clean old tool output:', error))
  }

  private recoverInterruptedRuns(): void {
    const recovered = this.store.recoverInterrupted()
    for (const run of recovered) {
      const events = this.store.listEvents(run.id, 0, 10_000)
      const started = events.find((event) => event.type === 'run.started')
      const outputMessageId = String(started?.payload.outputMessageId || '')
      const latestUserMessage = this.db
        .prepare(
          `SELECT id, timestamp FROM messages
           WHERE conversation_id = ? AND role = 'user' AND timestamp <= ?
           ORDER BY timestamp DESC, rowid DESC LIMIT 1`
        )
        .get(run.threadId, run.startedAt) as { id: string; timestamp: number } | undefined
      this.persistCompactionFromLedger(run.threadId, events, latestUserMessage)
      if ((run.surface === 'conversation' || run.surface === 'research') && outputMessageId) {
        this.messages.materialize(run.id)
      }
      this.store.appendEvent({
        id: `${run.id}:finalized`,
        runId: run.id,
        type: 'run.finalized',
        payload: {
          outputMessageId: outputMessageId || null,
          persisted: Boolean(outputMessageId),
          recovered: true
        }
      })
    }
  }

  private persistCompactionFromLedger(
    conversationId: string,
    events: readonly AgentRunEvent[],
    anchor?: { id: string; timestamp: number }
  ): boolean {
    const payload = [...events]
      .reverse()
      .find(
        (event) => event.type === 'compaction.completed' && event.payload.compacted === true
      )?.payload
    if (!payload || typeof payload.summary !== 'string' || !anchor) return false
    new ConversationCompactionStore(this.db).save({
      conversationId,
      summary: payload.summary,
      compactedThroughMessageId: anchor.id,
      compactedThroughTimestamp: anchor.timestamp,
      originalTokens: Number(payload.originalTokens || 0),
      summaryTokens: Number(payload.summaryTokens || 0),
      messagesCompacted: Number(payload.messagesCompacted || 0),
      strategy: String(payload.strategy || 'deterministic') as 'model' | 'deterministic',
      promptVersion: String(payload.promptVersion || 'legacy'),
      provider: String(payload.provider || 'unknown') as ProviderKind,
      model: String(payload.model || 'unknown')
    })
    return true
  }

  private publishEvent(event: AgentRunEvent): void {
    this.publishExternal(event)
    for (const observer of this.observers.get(event.runId) ?? []) observer(event)
  }

  async runCollaborationParticipant(
    input: CollaborationKernelRunInput
  ): Promise<AgentKernelRunResult> {
    if (input.onEvent) this.observers.set(input.id, new Set([input.onEvent]))
    const currentSettings = this.settings()
    const configuredThreshold = Number(currentSettings.autoCompactThreshold)
    const configuredInstances = Array.isArray(currentSettings.providerInstances)
      ? (currentSettings.providerInstances as ProviderInstance[])
      : []
    const target = refreshProviderTargetMetadata(input.target, configuredInstances)
    const resolved = await resolveProviderContext(target)
    const contextLength = Math.max(1_024, resolved.contextLength ?? 32_768)
    const maxOutputTokens = resolveMaxOutputTokens(contextLength, target.maxOutputTokens)
    const session = await this.tools.createSession({
      runId: input.id,
      surface: 'collaboration',
      workspaceRoot: input.workspaceRoot,
      webSearchEnabled: true,
      collaboration: input.collaboration,
      instructionScopeId: input.id,
      onWorkspaceWillMutate: input.onWorkspaceWillMutate
    })
    const catalog = session.catalog()
    const permissionMode = normalizePermissionMode(currentSettings.commandPermissionMode)
    const provider = providerDefinition(input.target.providerKind).transport
    const composed = new PromptComposer().compose({
      platform:
        process.platform === 'win32'
          ? 'windows'
          : process.platform === 'darwin'
            ? 'macos'
            : 'linux',
      capabilities: capabilitiesFromTools(getAgentToolDefinitions(catalog)),
      permissionMode,
      model: createPromptModelProfile({
        id: `${target.providerKind}:${target.model}`,
        name: target.model,
        provider,
        providerKind: target.providerKind,
        providerModelId: target.model
      }),
      project: {
        workspaceRoot: input.workspaceRoot,
        instructions: input.projectInstructions.content,
        instructionSources: input.projectInstructions.sources,
        memory: input.projectMemory ?? ''
      },
      currentDate: new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }).format(new Date()),
      toolRoundLimit: normalizeToolCallLimit(input.maxToolRounds ?? currentSettings.toolCallLimit),
      activeSkillIds: [],
      skillAssetsPath: this.skillAssetsPath()
    })
    const messages: ProviderChatMessage[] = [
      {
        role: 'system',
        content: `${composed.content}\n\n## Collaboration role\n${input.collaborationInstructions}`
      },
      ...(composed.projectInstructionsMessage
        ? [{ role: 'user' as const, content: composed.projectInstructionsMessage }]
        : []),
      ...input.messages
    ]
    try {
      return await this.kernel.start({
        id: input.id,
        threadId: input.threadId,
        profile: agentRunProfile(catalog),
        provider: target.providerKind,
        model: target.model,
        workspaceRoot: input.workspaceRoot,
        promptContext: {
          version: 'sidekick-collaboration-kernel-v1',
          contextLength,
          contextReliable: resolved.reliable
        },
        catalog: session.catalog,
        messages,
        request: {
          target: { ...target, contextLength },
          maxOutputTokens,
          purpose: 'conversation',
          temperature: 0.2
        },
        maxToolRounds: normalizeToolCallLimit(input.maxToolRounds ?? currentSettings.toolCallLimit),
        permissionMode,
        toolRouter: session.router,
        verificationController: session.verificationController,
        beforeModelStep: input.beforeModelStep,
        contextManager: new AgentContextManager({
          target: { ...target, contextLength },
          contextLength,
          maxOutputTokens,
          threshold: Math.max(
            0.5,
            Math.min(0.95, Number.isFinite(configuredThreshold) ? configuredThreshold : 0.8)
          ),
          enabled: currentSettings.autoCompactEnabled !== false
        })
      })
    } finally {
      this.observers.delete(input.id)
      clearWorkspaceInstructionScope(input.id)
    }
  }

  async startConversation(input: StartConversationAgentRunInput): Promise<AgentRunSnapshot> {
    if (!input.id || !input.conversationId || !input.assistantMessageId) {
      throw new Error('Invalid conversation run identity')
    }
    const active = this.store.latest(input.conversationId)
    if (active && !['completed', 'failed', 'cancelled', 'interrupted'].includes(active.phase)) {
      throw new Error('This conversation already has an active run')
    }
    const capture = { promise: null as Promise<string | null> | null }
    let workspaceRoot: string | null = null
    const ensureCapture = async (): Promise<void> => {
      if (!workspaceRoot || capture.promise) {
        await capture.promise
        return
      }
      capture.promise = beginCheckpointCapture(
        workspaceRoot,
        input.conversationId,
        input.assistantMessageId
      ).catch((error) => {
        console.warn('[History] Could not begin run capture:', error)
        return null
      })
      await capture.promise
    }
    const prepared = await new ConversationRunPreparer(
      this.db,
      this.tools,
      this.goals,
      this.settings,
      this.skillAssetsPath
    ).prepare(input, ensureCapture)
    workspaceRoot = prepared.workspaceRoot
    this.activeConversations.set(input.id, { input, prepared, capture })
    const run = this.kernel.start(prepared.kernelInput)
    if (prepared.goalId) this.goals.bindRun(prepared.goalId, input.id)
    void run
      .then((result) => this.finalizeConversation(input.id, result))
      .catch((error) => this.finalizeUnexpectedFailure(input.id, error))
    return this.store.get(input.id)!
  }

  private async finishCheckpointCapture(
    active: ActiveConversationRun,
    phase: AgentKernelRunResult['phase'] | 'interrupted'
  ): Promise<string | null> {
    if (!active.capture.promise || !active.prepared.workspaceRoot) return null
    const captureId = await active.capture.promise
    if (!captureId) return null

    const requestLabel = checkpointLabel(active.prepared.latestUserMessage?.content || '')
    const phaseLabel = phase === 'completed' ? requestLabel : `${requestLabel} (${phase})`
    const checkpoint = await createCheckpoint(
      active.prepared.workspaceRoot,
      phaseLabel,
      captureId
    ).catch((error) => {
      console.warn('[History] Could not finish run checkpoint:', error)
      return null
    })
    if (!checkpoint) return null

    const outcomeLabel = checkpointFallbackTitleFromPaths(checkpoint.changedPaths)
    const storedLabel = phase === 'completed' ? outcomeLabel : `${outcomeLabel} (${phase})`
    new CheckpointTitleStore(this.db).recordCreated(
      active.prepared.workspaceRoot,
      checkpoint.hash,
      storedLabel
    )
    return checkpoint.hash
  }

  private async finalizeUnexpectedFailure(runId: string, error: unknown): Promise<void> {
    console.error('[AgentRuntime] Run finalization failed:', error)
    const active = this.activeConversations.get(runId)
    if (active?.prepared.goalId) {
      const goal = this.goals.get(active.prepared.goalId)
      if (goal?.status === 'active') {
        this.goals.pause(goal.id, 'The goal run failed during finalization. Resume to retry.')
      }
    }
    const checkpointHash = active ? await this.finishCheckpointCapture(active, 'interrupted') : null
    if (active && checkpointHash) {
      this.db
        .prepare(
          `UPDATE messages
           SET checkpoint_hash = ?, checkpoint_workspace_root = ?
           WHERE id = ? AND conversation_id = ?`
        )
        .run(
          checkpointHash,
          active.prepared.workspaceRoot,
          active.input.assistantMessageId,
          active.input.conversationId
        )
    }
    clearWorkspaceInstructionScope(runId)
    this.activeConversations.delete(runId)
    if (this.store.get(runId)) {
      const finalized = this.store.appendEvent({
        id: `${runId}:finalized`,
        runId,
        type: 'run.finalized',
        payload: {
          checkpointHash,
          persisted: false,
          error: error instanceof Error ? error.message : String(error)
        }
      })
      this.publishEvent(finalized)
    }
  }

  private async finalizeConversation(runId: string, result: AgentKernelRunResult): Promise<void> {
    const active = this.activeConversations.get(runId)
    if (!active) return
    try {
      const events = this.store.listAllEvents(runId)
      const checkpointHash = await this.finishCheckpointCapture(active, result.phase)
      this.messages.materialize(runId, {
        checkpointHash,
        checkpointWorkspaceRoot: active.prepared.workspaceRoot,
        fallbackContent:
          result.content ||
          (result.phase === 'failed' ? `Error: ${result.error || 'Agent run failed'}` : '')
      })
      this.db
        .prepare('UPDATE conversations SET active_skills = ?, updated_at = ? WHERE id = ?')
        .run(
          JSON.stringify(active.prepared.toolSession.persistentSkillIds()),
          Date.now(),
          active.input.conversationId
        )
      const compactionPersisted = this.persistCompactionFromLedger(
        active.input.conversationId,
        events,
        active.prepared.latestUserMessage
          ? {
              id: active.prepared.latestUserMessage.id,
              timestamp: active.prepared.latestUserMessage.timestamp
            }
          : undefined
      )
      const compaction = active.prepared.latestCompaction()
      if (!compactionPersisted && compaction && active.prepared.latestUserMessage) {
        new ConversationCompactionStore(this.db).save({
          conversationId: active.input.conversationId,
          summary: compaction.summary,
          compactedThroughMessageId: active.prepared.latestUserMessage.id,
          compactedThroughTimestamp: active.prepared.latestUserMessage.timestamp,
          originalTokens: compaction.originalTokens,
          summaryTokens: compaction.summaryTokens,
          messagesCompacted: compaction.messagesCompacted,
          strategy: compaction.strategy,
          promptVersion: compaction.promptVersion,
          provider: compaction.provider,
          model: compaction.model
        })
      }
      const finalized = this.store.appendEvent({
        id: `${runId}:finalized`,
        runId,
        type: 'run.finalized',
        payload: {
          assistantMessageId: active.input.assistantMessageId,
          checkpointHash,
          persisted: true
        }
      })
      this.publishEvent(finalized)
    } finally {
      if (active.prepared.goalId) {
        const goal = this.goals.get(active.prepared.goalId)
        if (goal?.currentRunId === runId) {
          if (result.phase === 'failed' || result.phase === 'cancelled') {
            this.goals.pause(
              goal.id,
              result.phase === 'failed'
                ? 'The agent run failed. Resume when you are ready to retry.'
                : 'The agent run was stopped.'
            )
          } else {
            this.goals.releaseRun(goal.id, runId)
          }
        }
      }
      clearWorkspaceInstructionScope(runId)
      this.activeConversations.delete(runId)
    }
  }

  private async launchChild(
    task: string,
    context: string | undefined,
    parentContext: {
      runId: string
      conversationId?: string
      workspaceRoot?: string
      signal: AbortSignal
    }
  ): Promise<unknown> {
    const parent = this.activeConversations.get(parentContext.runId)
    if (!parent) throw new Error('Parent run is no longer active')
    const id = randomUUID()
    const parentInput = parent.prepared.kernelInput
    const target = parentInput.request.target
    const session = await this.tools.createSession({
      runId: id,
      surface: 'subagent',
      workspaceRoot: parentContext.workspaceRoot,
      webSearchEnabled: true,
      instructionScopeId: id,
      onWorkspaceWillMutate: parent.prepared.onWorkspaceWillMutate
    })
    const system = parentInput.messages.find((message) => message.role === 'system')
    const childMessages: ProviderChatMessage[] = [
      ...(system ? [system] : []),
      {
        role: 'user',
        content: `${task}${context ? `\n\nRelevant context:\n${context}` : ''}\n\nComplete this bounded task and return a concise result to the parent agent.`
      }
    ]
    const contextLength = target.contextLength ?? 32_768
    const result = await this.kernel.start({
      id,
      threadId: parentContext.conversationId || parentContext.runId,
      parentRunId: parentContext.runId,
      profile: agentRunProfile(session.catalog()),
      provider: target.providerKind,
      model: target.model,
      workspaceRoot: parentContext.workspaceRoot,
      catalog: session.catalog,
      messages: childMessages,
      request: { ...parentInput.request, purpose: 'sub-agent' },
      maxToolRounds: parentInput.maxToolRounds,
      permissionMode: parentInput.permissionMode,
      toolRouter: session.router,
      verificationController: session.verificationController,
      contextManager: new AgentContextManager({
        target,
        contextLength,
        maxOutputTokens: parentInput.request.maxOutputTokens ?? 4_096,
        threshold: 0.8,
        enabled: true
      })
    })
    clearWorkspaceInstructionScope(id)
    return {
      childRunId: id,
      status: result.phase,
      content: result.content,
      error: result.error
    }
  }

  stop(runId: string): boolean {
    const stopped = this.kernel.stop(runId)
    if (stopped) this.tools.cancelRun(runId)
    return stopped
  }

  currentGoal(conversationId: string): ConversationGoal | null {
    return this.goals.current(conversationId)
  }

  createGoal(input: CreateConversationGoalInput): ConversationGoal {
    return this.goals.create(input)
  }

  editGoal(input: UpdateConversationGoalInput): ConversationGoal {
    return this.goals.edit(input)
  }

  pauseGoal(goalId: string): ConversationGoal {
    const goal = this.goals.pause(goalId)
    if (goal.currentRunId) this.stop(goal.currentRunId)
    for (const [runId, active] of this.activeConversations) {
      if (active.prepared.goalId === goalId) this.stop(runId)
    }
    return this.goals.get(goalId) ?? goal
  }

  resumeGoal(goalId: string): ConversationGoal {
    return this.goals.resume(goalId)
  }

  clearGoal(goalId: string): ConversationGoal {
    const existing = this.goals.get(goalId)
    if (existing?.currentRunId) this.stop(existing.currentRunId)
    for (const [runId, active] of this.activeConversations) {
      if (active.prepared.goalId === goalId) this.stop(runId)
    }
    return this.goals.clear(goalId)
  }

  resolveInteraction(input: ResolveAgentInteractionInput): void {
    this.kernel.resolveInteraction(input.interactionId, input.response, input.cancelled === true)
  }

  events(runId: string, afterSequence = 0): AgentRunEventsResult {
    const run = this.store.get(runId)
    const events = this.store.listEvents(runId, afterSequence, 10_000)
    const nextSequence = events.at(-1)?.sequence ?? afterSequence
    return {
      run,
      events,
      pendingInteractions: this.store.listPendingInteractions(runId),
      journal: {
        version: 1,
        afterSequence,
        nextSequence,
        hasMore: Boolean(run && nextSequence < run.lastSequence)
      }
    }
  }

  latest(threadId: string): AgentRunEventsResult {
    const run = this.store.latest(threadId)
    const events = run ? this.store.listEvents(run.id, 0, 10_000) : []
    const nextSequence = events.at(-1)?.sequence ?? 0
    return {
      run,
      events,
      pendingInteractions: run ? this.store.listPendingInteractions(run.id) : [],
      journal: {
        version: 1,
        afterSequence: 0,
        nextSequence,
        hasMore: Boolean(run && nextSequence < run.lastSequence)
      }
    }
  }

  hasActiveRuns(): boolean {
    return this.kernel.hasActiveRuns()
  }

  async close(): Promise<void> {
    this.commands.cancelAll()
    await this.kernel.stopAll()
    await Promise.all([this.tools.close(), this.mcp.close()])
  }
}
