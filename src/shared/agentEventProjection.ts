import type { AgentRunEvent, AgentRunPhase, ToolExecutionResult } from './agentRuntime'
import type { WorkspaceVerificationSummary } from './verification'

export interface ProjectedToolExecution {
  id: string
  callId: string
  title: string
  command: string
  name: string
  input?: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error' | 'denied'
  accessLevel?: 'auto' | 'confirm'
  approvalStatus?: 'pending' | 'approved' | 'denied' | 'auto'
  output?: string
  error?: string
}

export type ProjectedContentSegment =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool'; tool: ProjectedToolExecution }
  | {
      type: 'artifact'
      artifact: { type: 'react' | 'html' | 'svg'; title: string; code: string; isStreaming: false }
    }
  | {
      type: 'summary'
      summary: { originalTokens: number; newTokens: number; messagesCompacted: number }
    }
  | {
      type: 'decision'
      decision: {
        id: string
        prompt: string
        status: 'pending' | 'approved' | 'denied'
        currentLimit: number
        roundsUsed: number
        requestedAdditionalRounds: number
      }
    }
  | {
      type: 'interaction'
      interaction: {
        id: string
        kind: 'permission' | 'question' | 'plan_approval'
        status: 'pending' | 'resolved' | 'cancelled'
        request: Record<string, unknown>
        response?: Record<string, unknown>
      }
    }
  | { type: 'verification'; verification: WorkspaceVerificationSummary }

export interface ProjectedAgentRunMessage {
  content: string
  thinking: string
  segments: ProjectedContentSegment[]
  /** Latest provider context sample plus generation speed blended across this run. */
  tokenUsage: {
    promptTokens: number
    completionTokens: number
    tokensPerSecond?: number
    runStartedAt?: number
    runCompletedAt?: number
  }
  phase: AgentRunPhase | null
}

function toolCallId(event: AgentRunEvent): string {
  return String(event.payload.toolCallId || event.id)
}

function resultFrom(event: AgentRunEvent): ToolExecutionResult | undefined {
  const value = event.payload.result
  return value && typeof value === 'object' ? (value as ToolExecutionResult) : undefined
}

const HIDDEN_CONTROL_TOOLS = new Set(['enter_plan_mode', 'present_plan', 'complete_plan'])

export function projectAgentRunEvents(events: readonly AgentRunEvent[]): ProjectedAgentRunMessage {
  const tools = new Map<string, ProjectedToolExecution>()
  const artifacts = new Map<string, ProjectedContentSegment>()
  const decisions = new Map<string, Extract<ProjectedContentSegment, { type: 'decision' }>>()
  const interactions = new Map<string, Extract<ProjectedContentSegment, { type: 'interaction' }>>()
  let promptTokens = 0
  let completionTokens = 0
  let measuredCompletionTokens = 0
  let measuredGenerationSeconds = 0
  let phase: AgentRunPhase | null = null
  let committedContent = ''
  let committedThinking = ''
  let pendingContent = ''
  let pendingThinking = ''
  let latestVerification: WorkspaceVerificationSummary | null = null
  let runStartedAt: number | undefined
  let runCompletedAt: number | undefined

  for (const event of events) {
    if (event.type === 'run.started') runStartedAt ??= event.timestamp
    if (event.type === 'run.phase' || event.type === 'run.completed') {
      if (typeof event.payload.phase === 'string') phase = event.payload.phase as AgentRunPhase
      if (event.type === 'run.completed') runCompletedAt = event.timestamp
    }
    if (event.type === 'assistant.delta') {
      pendingContent += typeof event.payload.content === 'string' ? event.payload.content : ''
      pendingThinking += typeof event.payload.thinking === 'string' ? event.payload.thinking : ''
    }
    if (event.type === 'assistant.completed') {
      if (event.payload.provisional !== true) {
        committedContent +=
          typeof event.payload.content === 'string' ? event.payload.content : pendingContent
        committedThinking +=
          typeof event.payload.thinking === 'string' ? event.payload.thinking : pendingThinking
      }
      pendingContent = ''
      pendingThinking = ''
    }
    if (event.type === 'usage.updated') {
      const turnCompletionTokens = Number(event.payload.completionTokens || 0)
      const turnTokensPerSecond = Number(event.payload.tokensPerSecond || 0)
      // Prompt sizes from sequential tool-loop turns overlap almost entirely.
      // Only the latest sample represents the live context window.
      promptTokens = Number(event.payload.promptTokens || 0)
      completionTokens = turnCompletionTokens
      if (turnCompletionTokens > 0 && turnTokensPerSecond > 0) {
        measuredCompletionTokens += turnCompletionTokens
        measuredGenerationSeconds += turnCompletionTokens / turnTokensPerSecond
      }
    }
    if (event.type === 'verification.updated') {
      const summary = event.payload.summary
      if (summary && typeof summary === 'object') {
        latestVerification = summary as unknown as WorkspaceVerificationSummary
      }
    }
    if (event.type === 'tool.pending') {
      const id = toolCallId(event)
      if (!tools.has(id)) {
        tools.set(id, {
          id,
          callId: id,
          title: String(event.payload.name || 'Tool'),
          command: String(event.payload.name || ''),
          name: String(event.payload.name || ''),
          input: event.payload.arguments as Record<string, unknown> | undefined,
          status: 'pending',
          approvalStatus: 'auto'
        })
      }
    }
    if (event.type === 'tool.running') {
      const tool = tools.get(toolCallId(event))
      if (tool) {
        tool.status = 'running'
        tool.title = String(event.payload.title || tool.title)
        tool.input = (event.payload.arguments as Record<string, unknown> | undefined) ?? tool.input
      }
    }
    if (event.type === 'permission.requested') {
      const request = event.payload.request as Record<string, unknown> | undefined
      const tool = tools.get(String(request?.toolCallId || ''))
      if (tool) {
        tool.accessLevel = 'confirm'
        tool.approvalStatus = 'pending'
      }
      const interactionId = String(event.payload.interactionId || '')
      if (interactionId) {
        interactions.set(interactionId, {
          type: 'interaction',
          interaction: {
            id: interactionId,
            kind: 'permission',
            status: 'pending',
            request: request ?? {}
          }
        })
      }
    }
    if (event.type === 'permission.resolved') {
      const request = event.payload.request as Record<string, unknown> | undefined
      const response = event.payload.response as Record<string, unknown> | undefined
      const tool = tools.get(String(event.payload.toolCallId || request?.toolCallId || ''))
      if (tool) {
        tool.approvalStatus =
          event.payload.approved === false || response?.approved === false ? 'denied' : 'approved'
      }
      const interaction = interactions.get(String(event.payload.interactionId || ''))
      if (interaction) {
        interaction.interaction.status =
          event.payload.status === 'cancelled' ? 'cancelled' : 'resolved'
        interaction.interaction.response = response
      }
    }
    if (event.type === 'tool.completed') {
      const id = toolCallId(event)
      const tool = tools.get(id)
      const result = resultFrom(event)
      if (tool && result) {
        tool.status =
          result.status === 'success' ? 'success' : result.status === 'denied' ? 'denied' : 'error'
        tool.title = result.title || tool.title
        tool.output = result.modelContent
        tool.error = result.error?.message
        const data = result.data as Record<string, unknown> | undefined
        const artifact = data?.artifact as Record<string, unknown> | undefined
        if (
          artifact &&
          (artifact.type === 'react' || artifact.type === 'html' || artifact.type === 'svg') &&
          typeof artifact.title === 'string' &&
          typeof artifact.code === 'string'
        ) {
          artifacts.set(id, {
            type: 'artifact',
            artifact: {
              type: artifact.type,
              title: artifact.title,
              code: artifact.code,
              isStreaming: false
            }
          })
        }
      }
    }
    if (event.type === 'question.requested' && event.payload.kind === 'tool_limit') {
      const request = event.payload.request as Record<string, unknown>
      const interactionId = String(event.payload.interactionId)
      decisions.set(interactionId, {
        type: 'decision',
        decision: {
          id: interactionId,
          prompt: 'The agent reached the configured tool-round limit. Continue this run?',
          status: 'pending',
          currentLimit: Number(request.roundsUsed || 0),
          roundsUsed: Number(request.roundsUsed || 0),
          requestedAdditionalRounds: Number(request.requestedAdditionalRounds || 25)
        }
      })
    }
    if (event.type === 'question.requested' && event.payload.kind !== 'tool_limit') {
      const interactionId = String(event.payload.interactionId || '')
      if (interactionId) {
        interactions.set(interactionId, {
          type: 'interaction',
          interaction: {
            id: interactionId,
            kind: event.payload.kind === 'plan_approval' ? 'plan_approval' : 'question',
            status: 'pending',
            request: (event.payload.request as Record<string, unknown>) ?? {}
          }
        })
      }
    }
    if (event.type === 'question.resolved' && event.payload.kind === 'tool_limit') {
      const decision = decisions.get(String(event.payload.interactionId))
      const response = event.payload.response as Record<string, unknown> | undefined
      if (decision) decision.decision.status = response?.approved === true ? 'approved' : 'denied'
    }
    if (event.type === 'question.resolved' && event.payload.kind !== 'tool_limit') {
      const interaction = interactions.get(String(event.payload.interactionId || ''))
      if (interaction) {
        interaction.interaction.status =
          event.payload.status === 'cancelled' ? 'cancelled' : 'resolved'
        interaction.interaction.response = event.payload.response as Record<string, unknown>
      }
    }
  }

  if (phase && ['failed', 'cancelled', 'interrupted'].includes(phase)) {
    for (const tool of tools.values()) {
      if (tool.status === 'pending' || tool.status === 'running') {
        tool.status = 'error'
        tool.error = phase === 'interrupted' ? 'Run interrupted' : `Run ${phase}`
      }
    }
  }

  const fullContent = committedContent + pendingContent
  const fullThinking = committedThinking + pendingThinking
  const segments: ProjectedContentSegment[] = []
  const emittedTools = new Set<string>()
  for (const event of events) {
    if (event.type === 'assistant.completed') {
      if (event.payload.provisional === true) continue
      const thinking = typeof event.payload.thinking === 'string' ? event.payload.thinking : ''
      const content = typeof event.payload.content === 'string' ? event.payload.content : ''
      if (thinking) segments.push({ type: 'thinking', content: thinking })
      if (content) segments.push({ type: 'text', content })
      const calls = Array.isArray(event.payload.toolCalls)
        ? (event.payload.toolCalls as Array<Record<string, unknown>>)
        : []
      for (const call of calls) {
        const id = String(call.id || '')
        const tool = tools.get(id)
        if (!tool || emittedTools.has(id)) continue
        if (HIDDEN_CONTROL_TOOLS.has(tool.name)) {
          emittedTools.add(id)
          continue
        }
        segments.push({ type: 'tool', tool })
        emittedTools.add(id)
        const artifact = artifacts.get(id)
        if (artifact) segments.push(artifact)
      }
    }
    if (event.type === 'compaction.completed') {
      segments.push({
        type: 'summary',
        summary: {
          originalTokens: Number(event.payload.originalTokens || 0),
          newTokens: Number(event.payload.summaryTokens || 0),
          messagesCompacted: Number(event.payload.messagesCompacted || 0)
        }
      })
    }
    if (event.type === 'question.requested' && event.payload.kind === 'tool_limit') {
      const decision = decisions.get(String(event.payload.interactionId))
      if (decision) segments.push(decision)
    }
    if (event.type === 'permission.requested') {
      const interaction = interactions.get(String(event.payload.interactionId || ''))
      if (interaction) segments.push(interaction)
    }
    if (event.type === 'question.requested' && event.payload.kind !== 'tool_limit') {
      const interaction = interactions.get(String(event.payload.interactionId || ''))
      if (interaction) segments.push(interaction)
    }
  }
  for (const [id, tool] of tools) {
    if (emittedTools.has(id)) continue
    if (HIDDEN_CONTROL_TOOLS.has(tool.name)) continue
    if (pendingThinking) segments.push({ type: 'thinking', content: pendingThinking })
    if (pendingContent) segments.push({ type: 'text', content: pendingContent })
    pendingThinking = ''
    pendingContent = ''
    segments.push({ type: 'tool', tool })
    const artifact = artifacts.get(id)
    if (artifact) segments.push(artifact)
  }
  if (pendingThinking) segments.push({ type: 'thinking', content: pendingThinking })
  if (pendingContent) segments.push({ type: 'text', content: pendingContent })
  if (latestVerification && latestVerification.status !== 'not_applicable') {
    segments.push({ type: 'verification', verification: latestVerification })
  }

  return {
    content: fullContent,
    thinking: fullThinking,
    segments,
    tokenUsage: {
      promptTokens,
      completionTokens,
      ...(measuredGenerationSeconds > 0
        ? { tokensPerSecond: measuredCompletionTokens / measuredGenerationSeconds }
        : {}),
      ...(runStartedAt === undefined ? {} : { runStartedAt }),
      ...(runCompletedAt === undefined ? {} : { runCompletedAt })
    },
    phase
  }
}
