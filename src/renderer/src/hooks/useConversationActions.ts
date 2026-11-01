import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { messageTextForClipboard } from '../utils/messageClipboard'
import { authorizeCheckpointMutation } from '../utils/checkpointAuthorization'
import type { Message } from '../types/chat.types'
import type { MessageImageAttachment } from '../../../shared/messageImages'
import type { MessageContextAttachment } from '../../../shared/messageContextAttachments'
import type { ConversationRunMode } from '../../../shared/agentRunApi'
import { historyRestoreTargets, type HistoryRestoreTarget } from '../../../shared/workspaceHistory'

interface ConversationActionsOptions {
  messages: Message[]
  setMessages: Dispatch<SetStateAction<Message[]>>
  conversationId: string | null
  /** The model the chat runs with; empty when it has none it can use. */
  selectedModel: string
  /** Asked to answer again while the chat has no model it can use. */
  onModelUnavailable?: () => void
  workspaceFolder: string | null
  /** The project's other folders, whose History points go back together with the workspace's. */
  otherFolders?: readonly string[]
  /** Whether a reply is running or starting, read at call time. */
  isRunActive?: () => boolean
  rerunStream: (
    messages: Message[],
    conversationId: string,
    mode: ConversationRunMode,
    goal: RewoundGoal
  ) => Promise<void>
  /**
   * After a rewind to a message, that message goes back into the message box. Clears a goal
   * the rewind discarded the start of.
   */
  restoreDraft?: (message: Message, discardsGoalStart: boolean) => Promise<void> | void
  /**
   * Editing a message loads it into the message box, setting aside what was there. `source` is
   * the message on screen, for the move into the box.
   */
  beginEdit?: (message: Message, source: HTMLElement | null) => void
  /** The edit was cancelled: put back what the message box held before. */
  cancelEdit?: () => void
  /**
   * Called just before a rewind takes messages out of the chat: after `message` for an edit or a
   * retry, from `message` on for a rewind to it. The chat waits for what this returns, so the
   * messages can be seen to leave.
   */
  beforeMessagesLeave?: (message: Message, kind: MessagesLeaveKind) => Promise<void> | void
}

export type MessagesLeaveKind = 'edit' | 'retry' | 'rewind'

/** What the message box holds when an edited message is sent again. */
export interface MessageEdit {
  content: string
  images: MessageImageAttachment[]
  attachments: MessageContextAttachment[]
  runMode: ConversationRunMode
  startsGoal: boolean
}

/**
 * What a rewind does to a persistent goal. A goal is conversation state rather
 * than a property of the run, so replaying its first message would otherwise
 * send it as an ordinary message, and discarding that message would leave the
 * goal running without it.
 */
export interface RewoundGoal {
  /** The replayed message began a goal; start it again with this objective. */
  restartObjective?: string
  /** The message a goal began from is among the discarded ones. */
  discardsGoalStart: boolean
}

export function useConversationActions(options: ConversationActionsOptions): {
  editingMessageId: string | null
  /** The message being edited or replaced: it and everything after it step back. */
  steppedBackFromId: string | null
  copiedMessageId: string | null
  pendingCheckpointRestore: string | null
  startEditMessage: (message: Message, event: React.MouseEvent<HTMLButtonElement>) => void
  cancelEditMessage: () => void
  /** Replaces the message being edited with this and answers again from there. */
  submitEdit: (edit: MessageEdit) => void
  copyMessage: (message: Message) => Promise<void>
  /** Asks to undo a reply's file changes, by the reply's message ID. */
  requestCheckpointRestore: (messageId: string) => void
  cancelCheckpointRestore: () => void
  confirmCheckpointRestore: () => Promise<void>
  retryMessage: (message: Message) => void
  rewindToMessage: (message: Message, restoreFiles: boolean) => Promise<void>
} {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  // A sent edit keeps what it replaces stepped back until those messages leave.
  const [replacingMessageId, setReplacingMessageId] = useState<string | null>(null)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [pendingCheckpointRestore, setPendingCheckpointRestore] = useState<string | null>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Messages skip re-rendering when only their handlers change, so an Edit button can hold an
  // older startEditMessage; it reaches the current callbacks, and the box's current draft, here.
  const latestOptionsRef = useRef(options)
  useLayoutEffect(() => {
    latestOptionsRef.current = options
  })

  useEffect(
    () => () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    },
    []
  )

  const folderRoots = (): string[] =>
    options.workspaceFolder ? [options.workspaceFolder, ...(options.otherFolders ?? [])] : []

  /** Puts these folders back together; resolves to why they could not, or null. */
  const restoreHistory = async (targets: HistoryRestoreTarget[]): Promise<string | null> => {
    if (!targets.length) return null
    try {
      const authorization = await authorizeCheckpointMutation(targets)
      if (!authorization) return 'Restoring the files was not approved.'
      const result = await window.api.workspace.restoreHistory(targets, authorization)
      return result.ok ? null : result.error || 'The files could not be restored.'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Returns the project's files to how they were before the message at this index: each folder
   * back to its last earlier History point, or, with none, to before the first one after it.
   * Resolves to why the files could not be restored, or null when they were or there was nothing
   * to restore.
   */
  const restoreFilesBefore = (targetIndex: number): Promise<string | null> =>
    restoreHistory(historyRestoreTargets(options.messages, targetIndex, folderRoots()))

  /**
   * A rewind that cannot finish leaves the chat as it was and says why in it. Deleting the
   * messages anyway, or answering again, would leave the chat, the stored history and the
   * project's files disagreeing.
   */
  const reportRewindFailure = (summary: string, error: unknown): void => {
    console.error('[Rewind]', summary, error)
    setReplacingMessageId(null)
    options.setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: 'agent',
        noticeTone: 'error',
        content: `${summary} ${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now()
      }
    ])
  }

  const rewindingRef = useRef(false)

  /**
   * A rewind deletes the replies after the message and starts a new one. Under a running reply,
   * or twice from a double click, the second start was refused and took the first one down with
   * it, leaving a reply running that the window no longer followed.
   */
  const rewindConversation = async (message: Message, edit?: MessageEdit): Promise<void> => {
    if (rewindingRef.current || options.isRunActive?.()) return
    rewindingRef.current = true
    try {
      await rewindConversationOnce(message, edit)
    } finally {
      rewindingRef.current = false
      setReplacingMessageId(null)
    }
  }

  const rewindConversationOnce = async (message: Message, edit?: MessageEdit): Promise<void> => {
    if (!options.conversationId) return
    if (!options.selectedModel) {
      options.onModelUnavailable?.()
      return
    }
    const targetIndex = options.messages.findIndex((candidate) => candidate.id === message.id)
    if (targetIndex < 0) return

    const trimmedContent = edit?.content.trim() ?? ''
    if (edit && !trimmedContent && !edit.images.length && !edit.attachments.length) return
    const updatedMessage: Message = edit
      ? {
          ...message,
          content: trimmedContent,
          images: edit.images,
          attachments: edit.attachments,
          runMode: edit.runMode,
          startsGoal: edit.startsGoal
        }
      : message
    const truncatedMessages = options.messages
      .slice(0, targetIndex + 1)
      .map((candidate) => (candidate.id === message.id ? updatedMessage : candidate))
    setEditingMessageId(null)

    // A failed rewind must not start a new run. The stored history still holds
    // the messages this rewind meant to replace, so answering on top of them
    // interleaves the stale and new turns the next time the chat is loaded; with
    // the files left as they were, it would work on changes the chat no longer
    // shows. Leave the visible transcript in place and report the failure.
    const restoreError = await restoreFilesBefore(targetIndex)
    if (restoreError) {
      reportRewindFailure(
        'Your files could not be restored, so the messages were kept and no new reply was started:',
        restoreError
      )
      return
    }

    if (edit) {
      try {
        await window.api.conversations.updateMessage({
          id: message.id,
          conversation_id: options.conversationId,
          content: updatedMessage.content,
          images: updatedMessage.images,
          attachments: updatedMessage.attachments,
          runMode: updatedMessage.runMode,
          startsGoal: updatedMessage.startsGoal,
          thinking: message.thinking,
          segments: message.segments,
          timestamp: message.timestamp
        })
      } catch (error) {
        reportRewindFailure('Your edit could not be saved, so no new reply was started:', error)
        return
      }
    }
    try {
      await window.api.conversations.deleteMessagesAfter(options.conversationId, message.timestamp)
    } catch (error) {
      reportRewindFailure(
        'The replaced messages could not be cleared, so no new reply was started:',
        error
      )
      return
    }
    await latestOptionsRef.current.beforeMessagesLeave?.(message, edit ? 'edit' : 'retry')
    setReplacingMessageId(null)
    await options.rerunStream(
      truncatedMessages,
      options.conversationId,
      updatedMessage.runMode ?? 'conversation',
      {
        ...(updatedMessage.startsGoal ? { restartObjective: updatedMessage.content } : {}),
        discardsGoalStart: options.messages
          .slice(targetIndex + 1)
          .some((candidate) => candidate.startsGoal === true)
      }
    )
  }

  /**
   * Goes back to before a message without answering again: the message and everything after it
   * leave the conversation, SideKick's file changes since then are undone when asked, and the
   * message returns to the message box to change or send.
   */
  const rewindToMessage = async (message: Message, restoreFiles: boolean): Promise<void> => {
    if (!options.conversationId || options.isRunActive?.()) return
    const targetIndex = options.messages.findIndex((candidate) => candidate.id === message.id)
    if (targetIndex < 0) return
    const restoreError = restoreFiles ? await restoreFilesBefore(targetIndex) : null
    if (restoreError) {
      reportRewindFailure('Your files could not be restored, so nothing was rewound:', restoreError)
      return
    }
    const previous = options.messages[targetIndex - 1]
    try {
      await window.api.conversations.deleteMessagesAfter(
        options.conversationId,
        previous ? previous.timestamp : message.timestamp - 1
      )
    } catch (error) {
      reportRewindFailure('The rewound messages could not be cleared:', error)
      return
    }
    // The message heads back into the box while it and what follows leave the chat.
    const leaving = latestOptionsRef.current.beforeMessagesLeave?.(message, 'rewind')
    await options.restoreDraft?.(
      message,
      options.messages.slice(targetIndex).some((candidate) => candidate.startsGoal === true)
    )
    await leaving
    options.setMessages(options.messages.slice(0, targetIndex))
  }

  /** Brings a message into the message box; sending it then replaces it and what follows. */
  const startEditMessage = (message: Message, event: React.MouseEvent<HTMLButtonElement>): void => {
    if (options.isRunActive?.()) return
    const source = event.currentTarget
      .closest('.message')
      ?.querySelector<HTMLElement>('.message-bubble')
    setEditingMessageId(message.id)
    latestOptionsRef.current.beginEdit?.(message, source ?? null)
  }

  const cancelEditMessage = (): void => {
    if (!editingMessageId) return
    setEditingMessageId(null)
    options.cancelEdit?.()
  }

  const copyMessage = async (message: Message): Promise<void> => {
    try {
      const result = await window.api.clipboard.writeText(messageTextForClipboard(message))
      if (!result.success) throw new Error(result.error || 'Could not copy message')
      setCopiedMessageId(message.id)
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => {
        setCopiedMessageId(null)
        copyTimeoutRef.current = null
      }, 2000)
    } catch (error) {
      console.error('[ChatPanel] Failed to copy message:', error)
    }
  }

  const confirmCheckpointRestore = async (): Promise<void> => {
    const messageId = pendingCheckpointRestore
    setPendingCheckpointRestore(null)
    const message = options.messages.find((candidate) => candidate.id === messageId)
    const roots = folderRoots()
    // Every folder the reply changed goes back to before it, or none does.
    const targets: HistoryRestoreTarget[] = (message?.checkpoints ?? [])
      .filter(({ workspaceRoot }) => roots.includes(workspaceRoot))
      .map(({ workspaceRoot, hash }) => ({ workspaceRoot, hashes: [hash] }))
    if (!messageId || !targets.length) return
    const error = await restoreHistory(targets)
    if (error) {
      console.error('[Checkpoint] Undo failed:', error)
      return
    }
    options.setMessages((previous) =>
      previous.map((candidate) =>
        candidate.id === messageId ? { ...candidate, restored: true } : candidate
      )
    )
  }

  const retryMessage = (message: Message): void => {
    if (message.role === 'user') {
      void rewindConversation(message)
      return
    }
    const targetUserMessage = options.messages
      .slice(
        0,
        options.messages.findIndex((candidate) => candidate.id === message.id)
      )
      .reverse()
      .find((candidate) => candidate.role === 'user')
    if (targetUserMessage) void rewindConversation(targetUserMessage)
    else console.warn('[ChatPanel] No preceding user message found for retry')
  }

  return {
    editingMessageId,
    steppedBackFromId: editingMessageId ?? replacingMessageId,
    copiedMessageId,
    pendingCheckpointRestore,
    startEditMessage,
    cancelEditMessage,
    submitEdit: (edit) => {
      const message = options.messages.find((candidate) => candidate.id === editingMessageId)
      if (!message) return
      setEditingMessageId(null)
      setReplacingMessageId(message.id)
      void rewindConversation(message, edit)
    },
    copyMessage,
    rewindToMessage,
    requestCheckpointRestore: setPendingCheckpointRestore,
    cancelCheckpointRestore: () => setPendingCheckpointRestore(null),
    confirmCheckpointRestore,
    retryMessage
  }
}
