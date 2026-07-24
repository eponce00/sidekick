import {
  isCollaborationTransportEvent,
  normalizeCollaborationHumanAddress,
  type CollaborationAgentSessionMessage,
  type CollaborationEvent,
  type CollaborationParticipant
} from '../../../shared/collaboration'
import type { ActivityItem } from '../types/activity.types'
import type { ContentSegment, Message, ToolExecution } from '../types/chat.types'
import { isWorkspaceMutationTool } from '../../../shared/workspaceMutations'
import { mergeMessageTokenUsage, messageTokenUsageFromMetadata } from './messageTokenUsage'

export interface GroupAgentConversationProjection {
  messages: Message[]
  activities: ActivityItem[]
}

interface ProjectedMessage {
  order: number
  message: Message
  /** Provider iterations from one uninterrupted mission turn form one visual agent loop. */
  agentLoopMissionId?: string
}

function toolArgs(message: CollaborationAgentSessionMessage): Record<string, unknown> {
  const args = message.metadata.args
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
}

function toolName(message: CollaborationAgentSessionMessage): string {
  return typeof message.metadata.toolName === 'string' ? message.metadata.toolName : 'tool'
}

function toolTitle(message: CollaborationAgentSessionMessage): string {
  if (typeof message.metadata.title === 'string' && message.metadata.title.trim()) {
    return message.metadata.title
  }
  return toolName(message).replaceAll('_', ' ')
}

function executionFor(
  call: CollaborationAgentSessionMessage['toolCalls'][number],
  result: CollaborationAgentSessionMessage | undefined
): ToolExecution {
  const name = call.function.name
  const rawArgs = call.function.arguments
  let input: Record<string, unknown> = {}
  if (rawArgs && typeof rawArgs === 'object') input = rawArgs
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs)
      if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>
    } catch {
      input = {}
    }
  }
  const success = result?.metadata.success !== false
  return {
    id: call.id || `${name}-${call.index ?? 0}`,
    callId: call.id,
    title: result ? toolTitle(result) : name.replaceAll('_', ' '),
    name,
    command: name === 'execute_command' && typeof input.command === 'string' ? input.command : name,
    input,
    status: result ? (success ? 'success' : 'error') : 'running',
    output: result && success ? result.content : undefined,
    error: result && !success ? result.content : undefined
  }
}

function sessionInteractionSegment(
  current: Record<string, unknown>,
  prior?: Record<string, unknown>
): ContentSegment | null {
  const id = String(current.id || '')
  if (!id) return null
  const kind = String(current.kind || 'question')
  const status = String(current.status || 'pending')
  const request =
    (current.request as Record<string, unknown> | undefined) ??
    (prior?.request as Record<string, unknown> | undefined) ??
    {}
  const response = current.response as Record<string, unknown> | undefined
  if (kind === 'tool_limit') {
    return {
      type: 'decision',
      decision: {
        id,
        prompt: 'The agent reached its tool-round safety limit. Continue?',
        status:
          status === 'pending' ? 'pending' : response?.approved === true ? 'approved' : 'denied',
        currentLimit: Number(request.roundsUsed || 0),
        roundsUsed: Number(request.roundsUsed || 0),
        requestedAdditionalRounds: Number(request.requestedAdditionalRounds || 25)
      }
    }
  }
  return {
    type: 'interaction',
    interaction: {
      id,
      kind:
        kind === 'permission'
          ? 'permission'
          : kind === 'plan_approval'
            ? 'plan_approval'
            : 'question',
      status: status === 'cancelled' ? 'cancelled' : status === 'resolved' ? 'resolved' : 'pending',
      request,
      ...(response ? { response } : {})
    }
  }
}

export function projectGroupAgentConversation(input: {
  participant: CollaborationParticipant
  participants: CollaborationParticipant[]
  events: CollaborationEvent[]
  sessionMessages: CollaborationAgentSessionMessage[]
}): GroupAgentConversationProjection {
  const participantById = new Map(
    input.participants.map((participant) => [participant.id, participant])
  )
  const resultsByCallId = new Map(
    input.sessionMessages
      .filter((message) => message.kind === 'tool_result' && message.toolCallId)
      .map((message) => [message.toolCallId as string, message])
  )
  const interactionsById = new Map<
    string,
    {
      record: CollaborationAgentSessionMessage
      value: Record<string, unknown>
      prior?: Record<string, unknown>
    }
  >()
  for (const record of input.sessionMessages) {
    const value = record.metadata.agentInteraction
    if (!value || typeof value !== 'object') continue
    const interaction = value as Record<string, unknown>
    const id = String(interaction.id || '')
    if (!id) continue
    const existing = interactionsById.get(id)
    interactionsById.set(id, {
      record,
      value: interaction,
      prior: existing?.prior ?? existing?.value
    })
  }
  const projected: ProjectedMessage[] = []

  for (const event of input.events) {
    if (isCollaborationTransportEvent(event)) continue
    const targetParticipantIds = event.payload.targetParticipantIds || []
    const deliveredToParticipant =
      !targetParticipantIds.length || targetParticipantIds.includes(input.participant.id)
    if (event.kind === 'user_message' && deliveredToParticipant && event.payload.text?.trim()) {
      projected.push({
        order: event.seq,
        message: {
          id: event.id,
          role: 'user',
          content: event.payload.text,
          timestamp: event.createdAt
        }
      })
      continue
    }
    if (
      event.actorType === 'agent' &&
      event.actorParticipantId === input.participant.id &&
      event.kind === 'peer_message' &&
      event.payload.text?.trim()
    ) {
      projected.push({
        order: event.seq,
        message: {
          id: event.id,
          role: 'agent',
          content: normalizeCollaborationHumanAddress(event.payload.text).text,
          tokenUsage: messageTokenUsageFromMetadata(event.payload.metadata),
          timestamp: event.createdAt
        }
      })
      continue
    }
    if (
      event.actorType === 'agent' &&
      event.actorParticipantId !== input.participant.id &&
      event.kind === 'peer_message' &&
      deliveredToParticipant &&
      event.payload.metadata?.audience !== 'human' &&
      event.payload.text?.trim()
    ) {
      const sender = event.actorParticipantId
        ? participantById.get(event.actorParticipantId)
        : undefined
      projected.push({
        order: event.seq,
        message: {
          id: event.id,
          role: 'agent',
          peerLabel: sender?.label || 'Project agent',
          content: normalizeCollaborationHumanAddress(event.payload.text).text,
          tokenUsage: messageTokenUsageFromMetadata(event.payload.metadata),
          timestamp: event.createdAt
        }
      })
    }
  }

  for (const [index, record] of input.sessionMessages.entries()) {
    const rawInteraction = record.metadata.agentInteraction
    if (rawInteraction && typeof rawInteraction === 'object') {
      const id = String((rawInteraction as Record<string, unknown>).id || '')
      const latest = interactionsById.get(id)
      if (latest?.record.id !== record.id) continue
      const segment = sessionInteractionSegment(latest.value, latest.prior)
      if (segment) {
        projected.push({
          order: 10_000 + index,
          agentLoopMissionId: record.missionId || undefined,
          message: {
            id: record.id,
            role: 'agent',
            content: '',
            segments: [segment],
            timestamp: record.createdAt
          }
        })
      }
      continue
    }
    if (
      record.presentation === 'internal' ||
      record.presentation === 'history' ||
      record.kind === 'shared_event' ||
      record.kind === 'tool_result'
    ) {
      continue
    }
    if (record.kind === 'assistant') {
      const segments: ContentSegment[] = []
      if (record.content.trim()) segments.push({ type: 'text', content: record.content })
      for (const call of record.toolCalls) {
        if (call.function.name === 'collaboration_send') continue
        segments.push({
          type: 'tool',
          tool: executionFor(call, call.id ? resultsByCallId.get(call.id) : undefined)
        })
      }
      if (!segments.length) continue
      projected.push({
        order: 10_000 + index,
        agentLoopMissionId: record.missionId || undefined,
        message: {
          id: record.id,
          role: 'agent',
          content: record.content,
          segments,
          tokenUsage: messageTokenUsageFromMetadata(record.metadata),
          timestamp: record.createdAt,
          completedAt: record.createdAt
        }
      })
      continue
    }
    if (
      record.kind === 'system' &&
      record.presentation === 'notice' &&
      record.content.trim() &&
      typeof record.metadata.checkpointHash !== 'string'
    ) {
      projected.push({
        order: 10_000 + index,
        message: {
          id: record.id,
          role: 'system',
          content: record.content,
          timestamp: record.createdAt,
          noticeTone: record.metadata.error === true ? 'error' : 'info',
          checkpointHash: undefined,
          checkpointWorkspaceRoot: undefined
        }
      })
    }
  }

  projected.sort(
    (left, right) => left.message.timestamp - right.message.timestamp || left.order - right.order
  )

  const merged: ProjectedMessage[] = []
  for (const current of projected) {
    const previous = merged.at(-1)
    const continuesAgentLoop = Boolean(
      current.agentLoopMissionId &&
      previous?.agentLoopMissionId === current.agentLoopMissionId &&
      previous.message.role === 'agent' &&
      current.message.role === 'agent' &&
      !previous.message.peerLabel &&
      !current.message.peerLabel
    )
    if (!continuesAgentLoop || !previous) {
      merged.push(current)
      continue
    }

    previous.message = {
      ...previous.message,
      content: [previous.message.content, current.message.content].filter(Boolean).join('\n\n'),
      segments: [...(previous.message.segments || []), ...(current.message.segments || [])],
      tokenUsage: mergeMessageTokenUsage(previous.message.tokenUsage, current.message.tokenUsage),
      completedAt: current.message.completedAt ?? current.message.timestamp
    }
  }

  const activities: ActivityItem[] = input.sessionMessages
    .filter(
      (message) =>
        message.kind === 'tool_result' && message.metadata.toolName !== 'collaboration_send'
    )
    .map((result) => {
      const name = toolName(result)
      const success = result.metadata.success !== false
      const args = toolArgs(result)
      return {
        id: result.toolCallId || result.id,
        type:
          name === 'execute_command'
            ? 'command'
            : name.includes('workspace_file') || isWorkspaceMutationTool(name)
              ? 'file'
              : 'tool',
        status: success ? 'success' : 'error',
        title: toolTitle(result),
        command:
          name === 'execute_command' && typeof args.command === 'string' ? args.command : undefined,
        output: success ? result.content : undefined,
        error: success ? undefined : result.content,
        startTime: result.createdAt,
        endTime: result.createdAt
      }
    })

  return { messages: merged.map(({ message }) => message), activities }
}
