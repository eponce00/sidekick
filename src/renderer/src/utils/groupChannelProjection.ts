import {
  isCollaborationTransportEvent,
  normalizeCollaborationHumanAddress,
  type CollaborationEvent,
  type CollaborationParticipant
} from '../../../shared/collaboration'
import type { ContentSegment, Message } from '../types/chat.types'
import { messageTokenUsageFromMetadata } from './messageTokenUsage'

export function visibleGroupChannelEvents(events: CollaborationEvent[]): CollaborationEvent[] {
  return events.filter((event) => {
    const metadata = event.payload.metadata
    if (isCollaborationTransportEvent(event)) return false
    return (
      ['user_message', 'agent_message', 'peer_message'].includes(event.kind) ||
      (event.kind === 'system' && Boolean(metadata?.agentInteraction))
    )
  })
}

function interactionSegment(value: unknown): ContentSegment | null {
  if (!value || typeof value !== 'object') return null
  const interaction = value as Record<string, unknown>
  const id = String(interaction.id || '')
  const kind = String(interaction.kind || 'question')
  const status = String(interaction.status || 'pending')
  if (!id) return null
  if (kind === 'tool_limit') {
    const request = (interaction.request as Record<string, unknown>) ?? {}
    const response = interaction.response as Record<string, unknown> | undefined
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
      request: (interaction.request as Record<string, unknown>) ?? {},
      ...(interaction.response ? { response: interaction.response as Record<string, unknown> } : {})
    }
  }
}

function audienceLabel(
  event: CollaborationEvent,
  participants: CollaborationParticipant[]
): string {
  if (event.kind === 'user_message') {
    const targetIds = event.payload.targetParticipantIds || []
    if (!targetIds.length || targetIds.length >= participants.length) return 'to everyone'
    const targets = targetIds
      .map((id) => participants.find((participant) => participant.id === id)?.label)
      .filter((label): label is string => Boolean(label))
    return targets.length ? `to ${targets.join(' + ')}` : 'to project agent'
  }

  const audience = event.payload.metadata?.audience
  const messageType = event.payload.metadata?.messageType
  const humanAttention =
    event.payload.metadata?.humanAttention === true ||
    normalizeCollaborationHumanAddress(event.payload.text || '').mentionedHuman
  if (audience === 'human') {
    return messageType === 'request' ? 'to you · response requested' : 'to you'
  }
  if (audience === 'everyone') {
    if (humanAttention) {
      return messageType === 'request'
        ? 'to everyone · needs your input'
        : 'to everyone · mentions you'
    }
    return 'to everyone'
  }
  if (audience === 'other_agent') return 'to the other agent'
  if (humanAttention) return 'mentions you'
  return 'update'
}

/** Projects the public collaboration log into the same message model used by normal chats. */
export function projectGroupChannelMessages(
  events: CollaborationEvent[],
  participants: CollaborationParticipant[]
): Message[] {
  const participantById = new Map(participants.map((participant) => [participant.id, participant]))
  const visible = visibleGroupChannelEvents(events)
  const latestInteractionEvent = new Map<string, CollaborationEvent>()
  for (const event of visible) {
    const raw = event.payload.metadata?.agentInteraction
    if (raw && typeof raw === 'object') {
      const id = String((raw as Record<string, unknown>).id || '')
      if (id) latestInteractionEvent.set(id, event)
    }
  }
  return visible.flatMap<Message>((event) => {
    const interaction = interactionSegment(event.payload.metadata?.agentInteraction)
    if (interaction) {
      const id = interaction.decision?.id || interaction.interaction?.id || ''
      if (latestInteractionEvent.get(id)?.id !== event.id) return []
      const earlier = visible
        .filter((candidate) => candidate.id !== event.id)
        .map((candidate) => candidate.payload.metadata?.agentInteraction)
        .find(
          (candidate) =>
            candidate &&
            typeof candidate === 'object' &&
            String((candidate as Record<string, unknown>).id || '') === id
        ) as Record<string, unknown> | undefined
      if (
        interaction.interaction &&
        !Object.keys(interaction.interaction.request).length &&
        earlier
      ) {
        interaction.interaction.request =
          (earlier.request as Record<string, unknown> | undefined) ?? {}
      }
      if (interaction.decision && earlier) {
        const request = (earlier.request as Record<string, unknown> | undefined) ?? {}
        interaction.decision.currentLimit = Number(request.roundsUsed || 0)
        interaction.decision.roundsUsed = Number(request.roundsUsed || 0)
        interaction.decision.requestedAdditionalRounds = Number(
          request.requestedAdditionalRounds || 25
        )
      }
      const participant = event.actorParticipantId
        ? participantById.get(event.actorParticipantId)
        : undefined
      return [
        {
          id: event.id,
          role: 'agent' as const,
          senderLabel: participant?.label || 'Project agent',
          senderContext: participant?.projectName || '',
          content: '',
          segments: [interaction],
          timestamp: event.createdAt
        }
      ]
    }
    const content = normalizeCollaborationHumanAddress(event.payload.text || '').text.trim()
    if (!content) return []
    const participant = event.actorParticipantId
      ? participantById.get(event.actorParticipantId)
      : undefined
    const actorLabel =
      participant?.label ||
      (typeof event.payload.metadata?.actorLabel === 'string'
        ? event.payload.metadata.actorLabel
        : 'Project agent')
    const projectName =
      participant?.projectName ||
      (typeof event.payload.metadata?.projectName === 'string'
        ? event.payload.metadata.projectName
        : '')
    const context = [projectName, audienceLabel(event, participants)].filter(Boolean).join(' · ')

    return [
      {
        id: event.id,
        role: event.actorType === 'user' ? 'user' : 'agent',
        senderLabel: event.actorType === 'user' ? 'You' : actorLabel,
        senderContext: context,
        content,
        tokenUsage: messageTokenUsageFromMetadata(event.payload.metadata),
        timestamp: event.createdAt
      }
    ]
  })
}
