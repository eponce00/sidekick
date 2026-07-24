import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type {
  ConversationRunMode,
  StartConversationAgentRunInput
} from '../../../shared/agentRunApi'
import { projectAgentRunEvents } from '../../../shared/agentEventProjection'
import {
  agentRunUsesPlan,
  type AgentRunEvent,
  type AgentRunPhase
} from '../../../shared/agentRuntime'
import type { Message } from '../types/chat.types'
import { createFallbackConversationTitle } from '../utils/chatPanelHelpers'

export type PendingRunMessage = {
  content: string
  kind: 'pivot' | 'queued'
  mode: ConversationRunMode
}

export type PendingRunMessageItem = {
  id: string
  content: string
  mode: ConversationRunMode
}

interface UseConversationRunOptions {
  conversationId: string | null
  messagesRef: MutableRefObject<Message[]>
  skipNextLoadRef: MutableRefObject<boolean>
  setMessages: Dispatch<SetStateAction<Message[]>>
  setInputValue: Dispatch<SetStateAction<string>>
  onConversationCreated: (id: string, title: string) => void
  onProjection?: (projection: ReturnType<typeof projectAgentRunEvents>) => void
}

export interface SendConversationMessageOptions {
  clearInput?: boolean
  hideUserMessage?: boolean
  skipSave?: boolean
  conversationId?: string
  mode?: ConversationRunMode
}

export type StreamConversationResponse = (
  baseMessages: Message[],
  activeConversationId: string,
  isNewConversation: boolean,
  titleBaseMessage: Message | undefined,
  mode: ConversationRunMode
) => Promise<void>

interface ActiveRun {
  runId: string
  conversationId: string
  assistantMessageId: string
  mode: ConversationRunMode
  events: Map<number, AgentRunEvent>
  resolve: () => void
  attached?: boolean
}

export interface ConversationRunController {
  phase: AgentRunPhase | 'idle'
  activeMode: ConversationRunMode | null
  isLoading: boolean
  isStopping: boolean
  queuedMessages: PendingRunMessageItem[]
  pivotMessage: PendingRunMessageItem | null
  runConversationId: string | null
  startRun: (input: StartConversationAgentRunInput) => Promise<void>
  finishRun: () => PendingRunMessage | null
  requestStop: () => Promise<void>
  submitDuringRun: (
    content: string,
    mode?: ConversationRunMode,
    behaviorOverride?: 'pivot' | 'queue'
  ) => boolean
  updatePendingMessage: (id: string, content: string) => boolean
  removePendingMessage: (id: string) => void
  moveQueuedMessage: (id: string, toIndex: number) => void
  steerQueuedMessage: (id: string) => boolean
  resetPendingMessages: () => void
  resolveInteraction: (
    interactionId: string,
    response: Record<string, unknown>,
    cancelled?: boolean
  ) => Promise<void>
  sendMessage: (
    content: string,
    streamResponse: StreamConversationResponse,
    options?: SendConversationMessageOptions
  ) => Promise<void>
}

const TERMINAL_PHASES = new Set<AgentRunPhase>(['completed', 'failed', 'cancelled', 'interrupted'])

function createPendingRunMessage(
  content: string,
  mode: ConversationRunMode
): PendingRunMessageItem {
  return {
    id: crypto.randomUUID(),
    content,
    mode
  }
}

export function useConversationRun({
  conversationId,
  messagesRef,
  skipNextLoadRef,
  setMessages,
  setInputValue,
  onConversationCreated,
  onProjection
}: UseConversationRunOptions): ConversationRunController {
  const [phase, setPhase] = useState<AgentRunPhase | 'idle'>('idle')
  const [activeMode, setActiveMode] = useState<ConversationRunMode | null>(null)
  const [runConversationId, setRunConversationId] = useState<string | null>(null)
  const [queuedMessages, setQueuedMessages] = useState<PendingRunMessageItem[]>([])
  const [pivotMessage, setPivotMessage] = useState<PendingRunMessageItem | null>(null)
  const activeRef = useRef<ActiveRun | null>(null)
  const queuedRef = useRef<PendingRunMessageItem[]>([])
  const pivotRef = useRef<PendingRunMessageItem | null>(null)

  const project = useCallback(
    (active: ActiveRun): void => {
      const events = [...active.events.values()].sort(
        (left, right) => left.sequence - right.sequence
      )
      const projection = projectAgentRunEvents(events)
      const finalized = events.some((event) => event.type === 'run.finalized')
      const projectedPhase = projection.phase ?? 'streaming'
      setPhase(!finalized && TERMINAL_PHASES.has(projectedPhase) ? 'streaming' : projectedPhase)
      setMessages((previous) =>
        previous.map((message) =>
          message.id === active.assistantMessageId
            ? {
                ...message,
                content: projection.content,
                thinking: projection.thinking,
                segments: projection.segments as Message['segments'],
                tokenUsage: projection.tokenUsage,
                runMode: active.mode
              }
            : message
        )
      )
      onProjection?.(projection)
      if (finalized) active.resolve()
    },
    [onProjection, setMessages]
  )

  useEffect(() => {
    return window.api.agentRuns.onEvent(({ event }) => {
      const active = activeRef.current
      if (!active || event.runId !== active.runId) return
      if (!active.events.has(event.sequence)) active.events.set(event.sequence, event)
      if (event.type === 'plan.mode_changed' && event.payload.to === 'plan') {
        active.mode = 'plan'
        setActiveMode('plan')
      }
      project(active)
      if (event.type === 'run.finalized' && active.attached) {
        activeRef.current = null
        setRunConversationId(null)
        setActiveMode(null)
      }
    })
  }, [project])

  useEffect(() => {
    if (!conversationId || activeRef.current) return
    let cancelled = false
    void window.api.agentRuns.latest(conversationId).then((result) => {
      if (cancelled || !result.run || !result.events.length) return
      if (TERMINAL_PHASES.has(result.run.phase)) return
      const started = result.events.find((event) => event.type === 'run.started')
      const assistantMessageId = String(started?.payload.outputMessageId || '')
      if (!assistantMessageId) return
      const runStartedAt = result.run.startedAt
      const active: ActiveRun = {
        runId: result.run.id,
        conversationId,
        assistantMessageId,
        mode:
          result.run.surface === 'research'
            ? 'research'
            : agentRunUsesPlan(result.events)
              ? 'plan'
              : 'conversation',
        events: new Map(result.events.map((event) => [event.sequence, event])),
        resolve: () => undefined,
        attached: true
      }
      activeRef.current = active
      setRunConversationId(conversationId)
      setActiveMode(active.mode)
      setMessages((previous) =>
        previous.some((message) => message.id === assistantMessageId)
          ? previous
          : [
              ...previous,
              {
                id: assistantMessageId,
                role: 'agent',
                content: '',
                thinking: '',
                timestamp: runStartedAt,
                runMode: active.mode
              }
            ]
      )
      project(active)
    })
    return () => {
      cancelled = true
    }
  }, [conversationId, project, setMessages])

  const startRun = useCallback(
    async (input: StartConversationAgentRunInput): Promise<void> => {
      if (activeRef.current) throw new Error('A conversation run is already active')
      setPhase('queued')
      setRunConversationId(input.conversationId)
      const mode =
        input.mode === 'research' ? 'research' : input.mode === 'plan' ? 'plan' : 'conversation'
      setActiveMode(mode)
      let resolveCompletion!: () => void
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve
      })
      const active: ActiveRun = {
        runId: input.id,
        conversationId: input.conversationId,
        assistantMessageId: input.assistantMessageId,
        mode,
        events: new Map(),
        resolve: resolveCompletion
      }
      activeRef.current = active
      try {
        const started = await window.api.agentRuns.startConversation(input)
        setPhase(started.run.phase)
        const snapshot = await window.api.agentRuns.events(input.id)
        const current = activeRef.current
        if (current?.runId === input.id) {
          for (const event of snapshot.events) current.events.set(event.sequence, event)
          project(current)
        }
        await completion
      } catch (error) {
        if (activeRef.current?.runId === input.id) {
          activeRef.current = null
          setRunConversationId(null)
          setActiveMode(null)
          setPhase('failed')
        }
        throw error
      }
    },
    [project]
  )

  const replaceQueue = useCallback((next: PendingRunMessageItem[]) => {
    queuedRef.current = next
    setQueuedMessages(next)
  }, [])

  const replacePivot = useCallback((next: PendingRunMessageItem | null) => {
    pivotRef.current = next
    setPivotMessage(next)
  }, [])

  const finishRun = useCallback((): PendingRunMessage | null => {
    activeRef.current = null
    setRunConversationId(null)
    setActiveMode(null)
    setPhase('idle')
    if (pivotRef.current) {
      const pending = pivotRef.current
      replacePivot(null)
      return { content: pending.content, mode: pending.mode, kind: 'pivot' }
    }
    const [pending, ...remaining] = queuedRef.current
    if (pending) {
      replaceQueue(remaining)
      return { content: pending.content, mode: pending.mode, kind: 'queued' }
    }
    return null
  }, [replacePivot, replaceQueue])

  const requestStop = useCallback(async (): Promise<void> => {
    const active = activeRef.current
    if (!active || phase === 'stopping') return
    setPhase('stopping')
    await window.api.agentRuns.stop(active.runId)
  }, [phase])

  const updatePendingMessage = useCallback(
    (id: string, content: string): boolean => {
      const normalized = content.trim()
      if (!normalized) return false
      if (pivotRef.current?.id === id) {
        replacePivot({ ...pivotRef.current, content: normalized })
        return true
      }
      const index = queuedRef.current.findIndex((message) => message.id === id)
      if (index < 0) return false
      const next = [...queuedRef.current]
      next[index] = { ...next[index], content: normalized }
      replaceQueue(next)
      return true
    },
    [replacePivot, replaceQueue]
  )

  const removePendingMessage = useCallback(
    (id: string): void => {
      if (pivotRef.current?.id === id) {
        replacePivot(null)
        return
      }
      replaceQueue(queuedRef.current.filter((message) => message.id !== id))
    },
    [replacePivot, replaceQueue]
  )

  const moveQueuedMessage = useCallback(
    (id: string, toIndex: number): void => {
      const fromIndex = queuedRef.current.findIndex((message) => message.id === id)
      if (fromIndex < 0) return
      const next = [...queuedRef.current]
      const [message] = next.splice(fromIndex, 1)
      const destination = Math.max(0, Math.min(toIndex, next.length))
      next.splice(destination, 0, message)
      replaceQueue(next)
    },
    [replaceQueue]
  )

  const steerQueuedMessage = useCallback(
    (id: string): boolean => {
      const index = queuedRef.current.findIndex((message) => message.id === id)
      if (index < 0) return false
      const nextQueue = [...queuedRef.current]
      const [message] = nextQueue.splice(index, 1)
      if (pivotRef.current) nextQueue.unshift(pivotRef.current)
      replaceQueue(nextQueue)
      replacePivot(message)
      void requestStop()
      return true
    },
    [replacePivot, replaceQueue, requestStop]
  )

  const submitDuringRun = useCallback(
    (
      content: string,
      mode: ConversationRunMode = 'conversation',
      behaviorOverride?: 'pivot' | 'queue'
    ): boolean => {
      if (!content.trim()) return false
      const pending = createPendingRunMessage(content.trim(), mode)
      if (behaviorOverride === 'pivot') {
        if (pivotRef.current) replaceQueue([pivotRef.current, ...queuedRef.current])
        replacePivot(pending)
        void requestStop()
      } else {
        replaceQueue([...queuedRef.current, pending])
      }
      return true
    },
    [replacePivot, replaceQueue, requestStop]
  )

  const resetPendingMessages = useCallback(() => {
    replaceQueue([])
    replacePivot(null)
  }, [replacePivot, replaceQueue])

  const resolveInteraction = useCallback(
    async (
      interactionId: string,
      response: Record<string, unknown>,
      cancelled = false
    ): Promise<void> => {
      await window.api.agentRuns.resolveInteraction({ interactionId, response, cancelled })
    },
    []
  )

  const isLoading = !['idle', 'completed', 'failed', 'cancelled', 'interrupted'].includes(phase)

  const sendMessage = useCallback(
    async (
      content: string,
      streamResponse: StreamConversationResponse,
      options?: SendConversationMessageOptions
    ): Promise<void> => {
      if (!content.trim()) return
      if (isLoading) throw new Error('Already loading')
      let activeConversationId = options?.conversationId || conversationId
      const isNewConversation = !activeConversationId || messagesRef.current.length === 0
      if (!activeConversationId) {
        const title = createFallbackConversationTitle(content)
        const created = await window.api.conversations.create(title, null, 'fallback')
        activeConversationId = created.id
        skipNextLoadRef.current = true
        onConversationCreated(created.id, title)
      }
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: Date.now(),
        hidden: options?.hideUserMessage,
        runMode: options?.mode ?? 'conversation'
      }
      if (options?.clearInput ?? true) setInputValue('')
      if (!options?.skipSave) {
        await window.api.conversations.saveMessage({
          id: userMessage.id,
          conversation_id: activeConversationId,
          role: userMessage.role,
          content: userMessage.content,
          runMode: userMessage.runMode,
          timestamp: userMessage.timestamp
        })
      }
      const baseMessages = [...messagesRef.current, userMessage]
      if (!options?.hideUserMessage) setMessages((previous) => [...previous, userMessage])
      await streamResponse(
        baseMessages,
        activeConversationId,
        isNewConversation,
        userMessage,
        userMessage.runMode ?? 'conversation'
      )
    },
    [
      conversationId,
      isLoading,
      messagesRef,
      onConversationCreated,
      setInputValue,
      setMessages,
      skipNextLoadRef
    ]
  )

  return {
    phase,
    activeMode,
    isLoading,
    isStopping: phase === 'stopping',
    queuedMessages,
    pivotMessage,
    runConversationId,
    startRun,
    finishRun,
    requestStop,
    submitDuringRun,
    updatePendingMessage,
    removePendingMessage,
    moveQueuedMessage,
    steerQueuedMessage,
    resetPendingMessages,
    resolveInteraction,
    sendMessage
  }
}
