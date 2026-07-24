import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { join } from 'path'
import type {
  AgentRunEventsResult,
  ResolveAgentInteractionInput,
  StartConversationAgentRunInput
} from '../../shared/agentRunApi'
import {
  agentRunUsesPlan,
  type AgentRunEvent,
  type AgentRunSnapshot
} from '../../shared/agentRuntime'
import { agentRunProfile } from '../../shared/agentToolCatalog'
import { normalizeToolCallLimit } from '../../shared/agentLimits'
import { normalizePermissionMode } from '../../shared/permissions'
import { resolveMaxOutputTokens } from '../../shared/contextBudget'
import { refreshProviderTargetMetadata } from '../../shared/providerInstances'
import { editingCompatibilityService } from './editingCompatibilityService'
import type { ProviderInstance } from '../../shared/settings'
import { providerDefinition } from '../../shared/providerRegistry'
import {
  capabilitiesFromTools,
  createPromptModelProfile,
  PromptComposer
} from '../../shared/prompts'
import { projectAgentRunEvents } from '../../shared/agentEventProjection'
import type { ProviderChatMessage, ProviderTarget } from '../../shared/providerRuntime'
import { resolveProviderContext } from '../providers/providerRuntime'
import { loadStoredSettings } from '../ipc/settings'
import { createCheckpoint, beginCheckpointCapture, discardCheckpointCapture } from './checkpoints'
import { CheckpointTitleStore } from './checkpointTitleStore'
import { ConversationCompactionStore } from './conversationCompactionStore'
import {
  ConversationRunPreparer,
  type PreparedConversationAgentRun
} from './conversationRunPreparer'
import { AgentRunKernel, type AgentKernelRunResult } from './agentRunKernel'
import { AgentRunStore } from './agentRunStore'
import { AgentToolRuntime } from './agentToolRuntime'
import { CommandService } from './commandService'
import { McpClientManager } from './mcpClientManager'
import { ToolOutputStore } from './toolOutputStore'
import { WorkspaceReadService } from './workspaceReadService'
import { AgentContextManager } from './agentContextManager'
import { clearWorkspaceInstructionScope } from './workspaceRules'
import type { AgentCollaborationToolHandler } from './agentToolRuntime'
import { getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import { getBundledSkillAssetsPath } from './bundledSkillAssets'
import { ConversationGoalStore } from './conversationGoalStore'
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
  readonly goals: ConversationGoalStore
  private readonly mcp = new McpClientManager()
  private readonly commands: CommandService
  private readonly outputs: ToolOutputStore
  private readonly activeConversations = new Map<string, ActiveConversationRun>()
  private readonly observers = new Map<string, Set<(event: AgentRunEvent) => void>>()
  private readonly publishExternal: (event: AgentRunEvent) => void

  constructor(
    private readonly db: Database.Database,
    userDataRoot: string,
    publish: (event: AgentRunEvent) => void,
    publishGoal: (goal: ConversationGoal) => void = () => undefined
  ) {
    this.publishExternal = publish
    this.store = new AgentRunStore(db)
    this.goals = new ConversationGoalStore(db, publishGoal)
    this.outputs = new ToolOutputStore(join(userDataRoot, 'tool-outputs'))
    this.commands = new CommandService(db, join(userDataRoot, 'command-outputs'))
    this.tools = new AgentToolRuntime(
      db,
      new WorkspaceReadService(),
      this.commands,
      this.outputs,
      this.mcp
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
      if ((run.surface === 'conversation' || run.surface === 'research') && outputMessageId) {
        const projection = projectAgentRunEvents(events)
        const content = projection.content.trim()
          ? `${projection.content}\n\n_Run interrupted before completion._`
          : 'Run interrupted before completion. You can retry the last message.'
        this.db
          .prepare(
            `INSERT INTO messages
             (id, conversation_id, role, content, thinking, segments, token_usage, run_mode, timestamp)
             VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               content = excluded.content,
               thinking = excluded.thinking,
               segments = excluded.segments,
               token_usage = excluded.token_usage,
               run_mode = excluded.run_mode`
          )
          .run(
            outputMessageId,
            run.threadId,
            content,
            projection.thinking || null,
            projection.segments.length ? JSON.stringify(projection.segments) : null,
            JSON.stringify(projection.tokenUsage),
            run.surface === 'research'
              ? 'research'
              : agentRunUsesPlan(events)
                ? 'plan'
                : 'conversation',
            Date.now()
          )
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

  private publishEvent(event: AgentRunEvent): void {
    this.publishExternal(event)
    for (const observer of this.observers.get(event.runId) ?? []) observer(event)
  }

  async runCollaborationParticipant(
    input: CollaborationKernelRunInput
  ): Promise<AgentKernelRunResult> {
    if (input.onEvent) this.observers.set(input.id, new Set([input.onEvent]))
    const currentSettings = loadStoredSettings()
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
      editingTarget: {
        providerKind: target.providerKind,
        model: target.model,
        dialect: target.editingDialect,
        upstreamModel: target.upstreamModel,
        calibration: target.editingCalibration
      },
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
      skillAssetsPath: getBundledSkillAssetsPath()
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
        editingRecovery: {
          currentDialect: session.editingDialect,
          recover: async (signal) => {
            const result = await editingCompatibilityService.recover(
              target,
              session.editingDialect(),
              signal
            )
            if (result.switched && result.to) {
              session.setEditingDialect(result.to)
              if (result.calibration) target.editingCalibration = result.calibration
            }
            return result
          }
        },
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
    const prepared = await new ConversationRunPreparer(this.db, this.tools, this.goals).prepare(
      input,
      ensureCapture
    )
    workspaceRoot = prepared.workspaceRoot
    this.activeConversations.set(input.id, { input, prepared, capture })
    const run = this.kernel.start(prepared.kernelInput)
    if (prepared.goalId) this.goals.bindRun(prepared.goalId, input.id)
    void run
      .then((result) => this.finalizeConversation(input.id, result))
      .catch((error) => this.finalizeUnexpectedFailure(input.id, error))
    return this.store.get(input.id)!
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
    if (active?.capture.promise) {
      const captureId = await active.capture.promise
      if (captureId) discardCheckpointCapture(captureId)
    }
    clearWorkspaceInstructionScope(runId)
    this.activeConversations.delete(runId)
    if (this.store.get(runId)) {
      const finalized = this.store.appendEvent({
        id: `${runId}:finalized`,
        runId,
        type: 'run.finalized',
        payload: {
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
      const events = this.store.listEvents(runId, 0, 10_000)
      const projection = projectAgentRunEvents(events)
      const segments = projection.segments
      const usage = projection.tokenUsage
      let checkpointHash: string | null = null
      if (active.capture.promise && active.prepared.workspaceRoot) {
        const captureId = await active.capture.promise
        if (captureId) {
          if (result.phase === 'completed') {
            const label = checkpointLabel(active.prepared.latestUserMessage?.content || '')
            const checkpoint = await createCheckpoint(
              active.prepared.workspaceRoot,
              label,
              captureId
            ).catch((error) => {
              console.warn('[History] Could not create run checkpoint:', error)
              return null
            })
            checkpointHash = checkpoint?.hash ?? null
            if (checkpointHash) {
              new CheckpointTitleStore(this.db).recordCreated(
                active.prepared.workspaceRoot,
                checkpointHash,
                label
              )
            }
          } else discardCheckpointCapture(captureId)
        }
      }
      const content =
        result.content ||
        (result.phase === 'failed' ? `Error: ${result.error || 'Agent run failed'}` : '')
      this.db
        .prepare(
          `INSERT INTO messages
           (id, conversation_id, role, content, thinking, segments, token_usage,
            checkpoint_hash, checkpoint_workspace_root, run_mode, timestamp)
           VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             content = excluded.content,
             thinking = excluded.thinking,
             segments = excluded.segments,
             token_usage = excluded.token_usage,
             checkpoint_hash = excluded.checkpoint_hash,
             checkpoint_workspace_root = excluded.checkpoint_workspace_root,
             run_mode = excluded.run_mode`
        )
        .run(
          active.input.assistantMessageId,
          active.input.conversationId,
          content,
          result.thinking || null,
          segments.length ? JSON.stringify(segments) : null,
          JSON.stringify(usage),
          checkpointHash,
          checkpointHash ? active.prepared.workspaceRoot : null,
          active.input.mode === 'research'
            ? 'research'
            : agentRunUsesPlan(events)
              ? 'plan'
              : 'conversation',
          Date.now()
        )
      this.db
        .prepare('UPDATE conversations SET active_skills = ?, updated_at = ? WHERE id = ?')
        .run(
          JSON.stringify(active.prepared.toolSession.persistentSkillIds()),
          Date.now(),
          active.input.conversationId
        )
      const compaction = active.prepared.latestCompaction()
      if (compaction && active.prepared.latestUserMessage) {
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
    const parentEditingTarget =
      parentInput.catalog instanceof Function
        ? parentInput.catalog().editingTarget
        : parentInput.catalog.editingTarget
    const session = await this.tools.createSession({
      runId: id,
      surface: 'subagent',
      workspaceRoot: parentContext.workspaceRoot,
      webSearchEnabled: true,
      editingTarget: parentEditingTarget ?? {
        providerKind: target.providerKind,
        model: target.model,
        dialect: target.editingDialect,
        upstreamModel: target.upstreamModel,
        calibration: target.editingCalibration
      },
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
      editingRecovery: parentContext.workspaceRoot
        ? {
            currentDialect: session.editingDialect,
            recover: async (signal) => {
              const result = await editingCompatibilityService.recover(
                target,
                session.editingDialect(),
                signal
              )
              if (result.switched && result.to) session.setEditingDialect(result.to)
              return result
            }
          }
        : undefined,
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
    return {
      run: this.store.get(runId),
      events: this.store.listEvents(runId, afterSequence, 10_000),
      pendingInteractions: this.store.listPendingInteractions(runId)
    }
  }

  latest(threadId: string): AgentRunEventsResult {
    const run = this.store.latest(threadId)
    return {
      run,
      events: run ? this.store.listEvents(run.id, 0, 10_000) : [],
      pendingInteractions: run ? this.store.listPendingInteractions(run.id) : []
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
