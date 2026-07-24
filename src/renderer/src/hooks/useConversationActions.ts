import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { messageTextForClipboard } from '../utils/messageClipboard'
import { authorizeCheckpointMutation } from '../utils/checkpointAuthorization'
import type { Message, MessageEditGeometry } from '../types/chat.types'
import type { ConversationRunMode } from '../../../shared/agentRunApi'

interface ConversationActionsOptions {
  messages: Message[]
  setMessages: Dispatch<SetStateAction<Message[]>>
  conversationId: string | null
  selectedModel: string
  workspaceFolder: string | null
  onCheckpointCreated?: (restoredHash?: string) => void
  rerunStream: (
    messages: Message[],
    conversationId: string,
    mode: ConversationRunMode
  ) => Promise<void>
}

export function useConversationActions(options: ConversationActionsOptions): {
  editingMessageId: string | null
  editingDraft: string
  editingGeometry: MessageEditGeometry | null
  copiedMessageId: string | null
  pendingCheckpointRestore: string | null
  setEditingDraft: Dispatch<SetStateAction<string>>
  startEditMessage: (message: Message, event: React.MouseEvent<HTMLButtonElement>) => void
  cancelEditMessage: () => void
  confirmEditMessage: (message: Message) => void
  copyMessage: (message: Message) => Promise<void>
  requestCheckpointRestore: (hash: string) => void
  cancelCheckpointRestore: () => void
  confirmCheckpointRestore: () => Promise<void>
  retryMessage: (message: Message) => void
} {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState('')
  const [editingGeometry, setEditingGeometry] = useState<MessageEditGeometry | null>(null)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [pendingCheckpointRestore, setPendingCheckpointRestore] = useState<string | null>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    },
    []
  )

  const rewindConversation = async (message: Message, updatedContent?: string): Promise<void> => {
    if (!options.conversationId || !options.selectedModel) return
    const targetIndex = options.messages.findIndex((candidate) => candidate.id === message.id)
    if (targetIndex < 0) return

    if (options.workspaceFolder) {
      const priorHash = options.messages
        .slice(0, targetIndex)
        .reverse()
        .find(
          (candidate) =>
            candidate.checkpointHash &&
            candidate.checkpointWorkspaceRoot === options.workspaceFolder
        )?.checkpointHash
      if (priorHash) {
        try {
          const authorization = await authorizeCheckpointMutation('hard-reset', priorHash)
          if (authorization) {
            const result = await window.api.workspace.hardResetCheckpoint(
              options.workspaceFolder,
              priorHash,
              authorization
            )
            if (result.ok) options.onCheckpointCreated?.(priorHash)
            else console.warn('[Rewind] Checkpoint hard-reset failed:', result.error)
          }
        } catch (error) {
          console.warn('[Rewind] Checkpoint hard-reset failed:', error)
        }
      } else {
        const ownHash = options.messages
          .slice(targetIndex + 1)
          .find(
            (candidate) =>
              candidate.checkpointHash &&
              candidate.checkpointWorkspaceRoot === options.workspaceFolder
          )?.checkpointHash
        if (ownHash) {
          try {
            const authorization = await authorizeCheckpointMutation('rewind', ownHash)
            if (!authorization) throw new Error('Checkpoint rewind denied')
            const result = await window.api.workspace.rewindToBeforeCheckpoint(
              options.workspaceFolder,
              ownHash,
              authorization
            )
            if (result.ok) options.onCheckpointCreated?.(result.parentHash ?? undefined)
            else console.warn('[Rewind] rewindToBeforeCheckpoint failed:', result.error)
          } catch (error) {
            console.warn('[Rewind] rewindToBeforeCheckpoint threw:', error)
          }
        }
      }
    }

    const trimmedContent = updatedContent?.trim()
    if (updatedContent !== undefined && !trimmedContent) return
    const updatedMessage =
      updatedContent === undefined
        ? message
        : { ...message, content: trimmedContent || message.content }
    const truncatedMessages = options.messages
      .slice(0, targetIndex + 1)
      .map((candidate) => (candidate.id === message.id ? updatedMessage : candidate))
    setEditingMessageId(null)
    setEditingDraft('')
    setEditingGeometry(null)

    if (updatedContent !== undefined) {
      try {
        await window.api.conversations.updateMessage({
          id: message.id,
          conversation_id: options.conversationId,
          content: updatedMessage.content,
          thinking: message.thinking,
          segments: message.segments,
          timestamp: message.timestamp
        })
      } catch (error) {
        console.error('Error updating message:', error)
      }
    }
    try {
      await window.api.conversations.deleteMessagesAfter(options.conversationId, message.timestamp)
    } catch (error) {
      console.error('Error truncating messages:', error)
    }
    await options.rerunStream(
      truncatedMessages,
      options.conversationId,
      updatedMessage.runMode ?? 'conversation'
    )
  }

  const startEditMessage = (message: Message, event: React.MouseEvent<HTMLButtonElement>): void => {
    const bubble = event.currentTarget
      .closest('.message')
      ?.querySelector<HTMLElement>('.message-bubble')
    const messageElement = event.currentTarget.closest<HTMLElement>('.message')
    if (bubble && messageElement) {
      const bubbleRect = bubble.getBoundingClientRect()
      setEditingGeometry({
        width: bubbleRect.width,
        height: bubbleRect.height,
        viewportTop: messageElement.getBoundingClientRect().top
      })
    }
    setEditingMessageId(message.id)
    setEditingDraft(message.content)
  }

  const cancelEditMessage = (): void => {
    setEditingMessageId(null)
    setEditingDraft('')
    setEditingGeometry(null)
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
    if (!pendingCheckpointRestore || !options.workspaceFolder) return
    const hash = pendingCheckpointRestore
    setPendingCheckpointRestore(null)
    try {
      const authorization = await authorizeCheckpointMutation('restore', hash)
      if (!authorization) return
      const result = await window.api.workspace.restoreCheckpoint(
        options.workspaceFolder,
        hash,
        authorization
      )
      if (result.ok) {
        options.setMessages((previous) =>
          previous.map((message) =>
            message.checkpointHash === hash ? { ...message, restoredFrom: hash } : message
          )
        )
      } else console.error('[Checkpoint] Restore failed:', result.error)
    } catch (error) {
      console.error('[Checkpoint] Restore error:', error)
    }
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
    editingDraft,
    editingGeometry,
    copiedMessageId,
    pendingCheckpointRestore,
    setEditingDraft,
    startEditMessage,
    cancelEditMessage,
    confirmEditMessage: (message) => {
      void rewindConversation(message, editingDraft)
    },
    copyMessage,
    requestCheckpointRestore: setPendingCheckpointRestore,
    cancelCheckpointRestore: () => setPendingCheckpointRestore(null),
    confirmCheckpointRestore,
    retryMessage
  }
}
