import type { ProviderTarget } from './providerRuntime'
import type { ProviderToolCall } from './providerRuntime'

export type CollaborationGroupStatus = 'active' | 'archived'
export type CollaborationMissionStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'failed'

export type CollaborationParticipantStatus = 'active' | 'removed'

export type CollaborationParticipantRunStatus =
  | 'queued'
  | 'working'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'failed'

export type CollaborationEventKind =
  | 'user_message'
  | 'agent_message'
  | 'peer_message'
  | 'agent_activity'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'mission_status'

export interface CollaborationGroup {
  id: string
  title: string
  description: string | null
  status: CollaborationGroupStatus
  createdAt: number
  updatedAt: number
  activeMissionId: string | null
  activeMissionStatus: CollaborationMissionStatus | null
  participantCount: number
  unreadCompletionAt: number | null
  agentSessions: CollaborationAgentSession[]
}

export interface CollaborationParticipant {
  id: string
  groupId: string
  projectId: string
  projectName: string
  projectFolder: string
  label: string
  providerTarget: ProviderTarget
  status: CollaborationParticipantStatus
  joinedAt: number
  removedAt: number | null
  lastReadSeq: number
}

export interface CollaborationMission {
  id: string
  groupId: string
  objectiveEventId: string
  status: CollaborationMissionStatus
  requestedParticipantIds: string[]
  /** Aggregate provider iterations across independent participant runs. */
  iterationCount: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
  error: string | null
}

/**
 * Durable, per-agent execution state. A mission can have multiple participant
 * runs active at the same time; the shared event sequence is their mailbox.
 */
export interface CollaborationParticipantRun {
  missionId: string
  participantId: string
  status: CollaborationParticipantRunStatus
  iterationCount: number
  maxIterations: number
  lastIngestedSeq: number
  currentActivity: string | null
  startedAt: number | null
  updatedAt: number
  completedAt: number | null
  error: string | null
}

export interface CollaborationAgentSession {
  id: string
  groupId: string
  participantId: string
  projectId: string
  title: string
  /** Status for this participant in the group's current mission, if any. */
  activeRunStatus: CollaborationParticipantRunStatus | null
  lastEventSeq: number
  unreadCompletionAt: number | null
  createdAt: number
  updatedAt: number
}

export type CollaborationSessionMessageKind =
  | 'shared_event'
  | 'assistant'
  | 'tool_result'
  | 'system'

/**
 * Controls how a durable agent-session record is presented to the human.
 * Internal prompt envelopes remain in provider history without leaking into
 * the chat UI; history records are represented by the History surface.
 */
export type CollaborationSessionMessagePresentation =
  | 'conversation'
  | 'internal'
  | 'notice'
  | 'history'

export interface CollaborationAgentSessionMessage {
  id: string
  sessionId: string
  missionId: string | null
  role: 'user' | 'assistant' | 'tool' | 'system'
  kind: CollaborationSessionMessageKind
  presentation: CollaborationSessionMessagePresentation
  content: string
  toolCalls: ProviderToolCall[]
  toolCallId: string | null
  metadata: Record<string, unknown>
  createdAt: number
}

export interface CollaborationArtifact {
  id: string
  groupId: string
  missionId: string | null
  senderParticipantId: string
  name: string
  sourcePath: string
  byteSize: number
  sha256: string
  createdAt: number
}

export interface CollaborationEventPayload {
  text?: string
  title?: string
  toolName?: string
  toolCallId?: string
  args?: Record<string, unknown>
  result?: unknown
  success?: boolean
  status?: CollaborationMissionStatus
  targetParticipantIds?: string[]
  metadata?: Record<string, unknown>
}

const HUMAN_ADDRESS_PATTERN = /@(?:user|human)\b/iu
const HUMAN_ADDRESS_REPLACEMENT_PATTERN = /@(?:user|human)\b/giu

/**
 * Models sometimes borrow Slack syntax and write `@User` even though the
 * human is not an agent participant. Human attention is routing metadata in
 * SideKick; this keeps the public transcript conversational and readable.
 */
export function normalizeCollaborationHumanAddress(value: string): {
  text: string
  mentionedHuman: boolean
} {
  const mentionedHuman = HUMAN_ADDRESS_PATTERN.test(value)
  if (!mentionedHuman) return { text: value, mentionedHuman: false }
  return {
    text: value.replace(HUMAN_ADDRESS_REPLACEMENT_PATTERN, (_match, offset: number) => {
      const prefix = value.slice(0, offset)
      const beginsSentence = !prefix.trim() || /(?:[.!?]\s+|\n\s*)$/u.test(prefix)
      return beginsSentence ? 'You' : 'you'
    }),
    mentionedHuman: true
  }
}

export interface CollaborationEvent {
  id: string
  groupId: string
  missionId: string | null
  seq: number
  actorType: 'user' | 'agent' | 'system'
  actorParticipantId: string | null
  kind: CollaborationEventKind
  payload: CollaborationEventPayload
  replyToEventId: string | null
  createdAt: number
}

/**
 * Artifact handoffs are durable agent mail, not authored chat messages. Keep
 * them available to participant runtimes without leaking transport IDs into
 * the human conversation. The text check preserves that behavior for events
 * created before the structured marker was introduced.
 */
export function isCollaborationTransportEvent(event: CollaborationEvent): boolean {
  const metadata = event.payload.metadata
  return (
    metadata?.transportOnly === true ||
    (typeof metadata?.artifactId === 'string' &&
      /^Shared .+ \(artifact [^)]+\)$/.test(event.payload.text || ''))
  )
}

export interface CollaborationGroupDetail {
  group: CollaborationGroup
  participants: CollaborationParticipant[]
  agentSessions: CollaborationAgentSession[]
  activeMission: CollaborationMission | null
  participantRuns: CollaborationParticipantRun[]
  events: CollaborationEvent[]
}

export interface CreateCollaborationGroupInput {
  title: string
  description?: string
  participants: Array<{
    projectId: string
    label?: string
    providerTarget: ProviderTarget
  }>
}

export interface SendCollaborationMessageInput {
  groupId: string
  text: string
  targetParticipantIds?: string[]
}

export interface RewriteCollaborationMessageInput {
  groupId: string
  eventId: string
  text: string
}

export interface CollaborationTimelineRewind {
  participantId: string
  projectName: string
  workspaceRoot: string
  checkpointHash: string
  parentHash: string | null
  changedFiles: number
}

export interface RewriteCollaborationMessageResult {
  event: CollaborationEvent
  mission: CollaborationMission
  rewound: CollaborationTimelineRewind[]
}

export interface UpdateCollaborationAgentSessionInput {
  title: string
}

export interface AddCollaborationParticipantInput {
  groupId: string
  projectId: string
  label?: string
  providerTarget: ProviderTarget
}

export interface UpdateCollaborationParticipantInput {
  providerTarget: ProviderTarget
}

export interface UpdateCollaborationParticipantsInput {
  groupId: string
  participantIds: string[]
  providerTarget: ProviderTarget
}

export interface UpdateCollaborationGroupInput {
  title?: string
  description?: string
  status?: CollaborationGroupStatus
}

export interface CollaborationChangedEvent {
  groupId: string
  reason: 'group' | 'event' | 'mission' | 'participant'
}
