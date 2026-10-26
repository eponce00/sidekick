import type { ProjectedAgentRunMessage } from '../../../shared/agentEventProjection'
import type { ConversationRunMode } from '../../../shared/agentRunApi'
import type { AgentRunSnapshot } from '../../../shared/agentRuntime'
import type { CompanionMessage } from '../../../shared/companion'
import {
  parseMessageContextAttachments,
  type MessageContextAttachment
} from '../../../shared/messageContextAttachments'
import type { ContentSegment, Message } from '../types/chat.types'
import type { PendingSend } from './chatState'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Saved segments come from storage, shortened for the phone; only ones with a kind are kept. */
function segmentsFrom(value: unknown[] | undefined): ContentSegment[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter(
    (segment): segment is ContentSegment => isRecord(segment) && typeof segment.type === 'string'
  )
}

/**
 * Attachments arrive by name and kind only, and show as the desktop shows a project file; the
 * file itself stays on the computer. Marks on browser pages arrive with their notes.
 */
function attachmentsFrom(
  value: CompanionMessage['attachments']
): MessageContextAttachment[] | undefined {
  if (!value?.length) return undefined
  return value.flatMap((attachment): MessageContextAttachment[] => {
    // A mark on a browser page shows as on the desktop, with its note.
    if (attachment.kind === 'browser')
      return parseMessageContextAttachments(JSON.stringify([attachment]))
    const { id, kind, name } = attachment
    return [{ id, kind: kind === 'folder' ? 'folder' : 'file', name, relativePath: name }]
  })
}

/** A saved message as the desktop's message view takes it. */
export function toDesktopMessage(message: CompanionMessage): Message {
  const role = message.role === 'assistant' ? 'agent' : message.role === 'user' ? 'user' : 'system'
  return {
    id: message.id,
    role,
    content: message.content,
    timestamp: message.timestamp,
    ...(message.runId ? { runId: message.runId } : {}),
    ...(message.runMode ? { runMode: message.runMode } : {}),
    ...(message.segments ? { segments: segmentsFrom(message.segments) } : {}),
    ...(message.images?.length ? { images: message.images } : {}),
    ...(message.attachments?.length ? { attachments: attachmentsFrom(message.attachments) } : {})
  }
}

/** The reply a run is writing, rebuilt from its events as the desktop rebuilds it. */
export function liveRunMessage(
  run: AgentRunSnapshot,
  projected: ProjectedAgentRunMessage,
  mode?: ConversationRunMode
): Message {
  return {
    id: `run:${run.id}`,
    runId: run.id,
    role: 'agent',
    content: projected.content,
    thinking: projected.thinking,
    segments: projected.segments as ContentSegment[],
    tokenUsage: {
      ...projected.tokenUsage,
      runStartedAt: projected.tokenUsage.runStartedAt ?? run.startedAt
    },
    timestamp: run.startedAt,
    ...(mode ? { runMode: mode } : {})
  }
}

/** A message sent from this phone that the computer has not shown back yet. */
export function pendingSendMessage(send: PendingSend): Message {
  return {
    id: `pending:${send.id}`,
    role: 'user',
    content: send.text,
    timestamp: send.sentAt,
    ...(send.images?.length ? { images: send.images } : {}),
    ...(send.files?.length
      ? {
          attachments: send.files.map((name, index) => ({
            id: `${send.id}:${index}`,
            kind: 'file' as const,
            name,
            relativePath: name
          }))
        }
      : {})
  }
}
