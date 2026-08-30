import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type {
  AgentRunEventsResult,
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
import type { MessageImageAttachment } from '../../../shared/messageImages'
import type { MessageContextAttachment } from '../../../shared/messageContextAttachments'
import { AgentRunClientModel } from '../models/AgentRunClientModel'

export type PendingRunMessage = {
  content: string
  images?: MessageImageAttachment[]
  attachments?: MessageContextAttachment[]
  kind: 'pivot' | 'queued'
  mode: ConversationRunMode
}

export type PendingRunMessageItem = {
  id: string
  content: string
  images?: MessageImageAttachment[]
  attachments?: MessageContextAttachment[]
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
  images?: MessageImageAttachment[]
  attachments?: MessageContextAttachment[]
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
  model: AgentRunClientModel
  resolve: () => void
  attached?: boolean
  projectionTimer?: ReturnType<typeof setTimeout>
  repairPromise?: Promise<void>
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
  finishRun: () => Promise<PendingRunMessage | null>
  requestStop: () => Promise<void>
  submitDuringRun: (
    content: string,
    mode?: ConversationRunMode,
    behaviorOverride?: 'pivot' | 'queue',
    images?: MessageImageAttachment[],
    attachments?: MessageContextAttachment[]
  ) => Promise<boolean>
  updatePendingMessage: (id: string, content: string) => boolean
  removePendingMessage: (id: string) => void
  moveQueuedMessage: (id: string, toIndex: number) => void
  steerQueuedMessage: (id: string) => Promise<boolean>
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

async function completeJournalWindow(initial: AgentRunEventsResult): Promise<AgentRunEventsResult> {
  if (!initial.run || !initial.journal?.hasMore) return initial
  const events = [...initial.events]
  let page = initial
  while (page.journal?.hasMore) {
    const cursor = page.journal.nextSequence
    const next = await window.api.agentRuns.events(initial.run.id, cursor)
    if (!next.events.length || next.journal?.nextSequence === cursor) break
    events.push(...next.events)
    page = next
  }
  return { ...page, run: page.run ?? initial.run, events }
}

function createPendingRunMessage(
  content: string,
  mode: ConversationRunMode,
  images: MessageImageAttachment[] = [],
  attachments: MessageContextAttachment[] = []
): PendingRunMessageItem {
  return {
    id: crypto.randomUUID(),
    content,
    ...(images.length ? { images } : {}),
    ...(attachments.length ? { attachments } : {}),
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
  // Events can arrive while `latest()` is still resolving and before we know
  // which durable run to attach. Buffer that narrow handoff window by run id.
  const unattachedEventsRef = useRef(new Map<string, AgentRunEvent[]>())
  const queuedRef = useRef<PendingRunMessageItem[]>([])
  const pivotRef = useRef<PendingRunMessageItem | null>(null)
  const admissionWriteRef = useRef<Promise<unknown>>(Promise.resolve())

  const project = useCallback(
    (active: ActiveRun): void => {
      const snapshot = active.model.getSnapshot()
      const events = snapshot.events
      const projection = snapshot.projection
      const finalized = events.some((event) => event.type === 'run.finalized')
      const projectedPhase = projection.phase ?? 'streaming'
      setPhase(!finalized && TERMINAL_PHASES.has(projectedPhase) ? 'streaming' : projectedPhase)
      setMessages((previous) =>
        previous.map((message) =>
          message.id === active.assistantMessageId
            ? {
                ...message,
                runId: active.runId,
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

  const scheduleProject = useCallback(
    (active: ActiveRun, immediate = false): void => {
      if (active.projectionTimer) {
        if (!immediate) return
        clearTimeout(active.projectionTimer)
        active.projectionTimer = undefined
      }
      if (immediate) {
        project(active)
        return
      }
      // Provider token streams can emit hundreds of durable deltas per second.
      // Coalesce them into one projection/frame while preserving their sequence in the event log.
      active.projectionTimer = setTimeout(() => {
        active.projectionTimer = undefined
        if (activeRef.current?.runId === active.runId) project(active)
      }, 50)
    },
    [project]
  )

  useEffect(() => {
    return window.api.agentRuns.onEvent(({ event }) => {
      const active = activeRef.current
      if (!active) {
        const buffered = unattachedEventsRef.current.get(event.runId) ?? []
        buffered.push(event)
        if (buffered.length > 1_000) buffered.splice(0, buffered.length - 1_000)
        unattachedEventsRef.current.set(event.runId, buffered)
        if (unattachedEventsRef.current.size > 8) {
          const oldest = unattachedEventsRef.current.keys().next().value
          if (oldest) unattachedEventsRef.current.delete(oldest)
        }
        return
      }
      if (event.runId !== active.runId) return
      const accepted = active.model.ingest(event)
      if (accepted.gapAfter !== undefined && !active.repairPromise) {
        active.repairPromise = window.api.agentRuns
          .events(active.runId, accepted.gapAfter)
          .then(completeJournalWindow)
          .then((result) => {
            if (activeRef.current?.runId !== active.runId) return
            active.model.merge(result.run, result.events)
            scheduleProject(active, true)
          })
          .catch((error) => console.error('[AgentRun] Could not repair event gap', error))
          .finally(() => {
            active.repairPromise = undefined
          })
      }
      if (event.type === 'plan.mode_changed' && event.payload.to === 'plan') {
        active.mode = 'plan'
        setActiveMode('plan')
      }
      scheduleProject(active, event.type !== 'assistant.delta')
      if (event.type === 'run.finalized' && active.attached) {
        activeRef.current = null
        setRunConversationId(null)
        setActiveMode(null)
      }
    })
  }, [scheduleProject])

  useEffect(() => {
    if (!conversationId || activeRef.current) return
    let cancelled = false
    void window.api.agentRuns
      .latest(conversationId)
      .then(completeJournalWindow)
      .then((result) => {
        if (cancelled || !result.run || !result.events.length) return
        const run = result.run
        if (TERMINAL_PHASES.has(run.phase)) return
        const started = result.events.find((event) => event.type === 'run.started')
        const assistantMessageId = String(started?.payload.outputMessageId || '')
        if (!assistantMessageId) return
        const runStartedAt = run.startedAt
        const active: ActiveRun = {
          runId: run.id,
          conversationId,
          assistantMessageId,
          mode:
            run.surface === 'research'
              ? 'research'
              : agentRunUsesPlan(result.events)
                ? 'plan'
                : 'conversation',
          model: new AgentRunClientModel(),
          resolve: () => undefined,
          attached: true
        }
        activeRef.current = active
        active.model.replace(run, result.events)
        active.model.merge(run, unattachedEventsRef.current.get(run.id) ?? [])
        unattachedEventsRef.current.delete(run.id)
        setRunConversationId(conversationId)
        setActiveMode(active.mode)
        setMessages((previous) =>
          previous.some((message) => message.id === assistantMessageId)
            ? previous
            : [
                ...previous,
                {
                  id: assistantMessageId,
                  runId: run.id,
                  role: 'agent',
                  content: '',
                  thinking: '',
                  timestamp: runStartedAt,
                  runMode: active.mode
                }
              ]
        )
        scheduleProject(active, true)
      })
    return () => {
      cancelled = true
    }
  }, [conversationId, scheduleProject, setMessages])

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
        model: new AgentRunClientModel(),
        resolve: resolveCompletion
      }
      activeRef.current = active
      try {
        const started = await window.api.agentRuns.startConversation(input)
        setPhase(started.run.phase)
        const snapshot = await completeJournalWindow(await window.api.agentRuns.events(input.id))
        const current = activeRef.current
        if (current?.runId === input.id) {
          // Preserve live events ingested while the durable snapshot was in flight.
          current.model.merge(snapshot.run, snapshot.events)
          scheduleProject(current, true)
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
    [scheduleProject]
  )

  const replaceQueue = useCallback((next: PendingRunMessageItem[]) => {
    queuedRef.current = next
    setQueuedMessages(next)
  }, [])

  const replacePivot = useCallback((next: PendingRunMessageItem | null) => {
    pivotRef.current = next
    setPivotMessage(next)
  }, [])

  const persistAdmissions = useCallback(
    async (
      targetConversationId: string,
      queued: PendingRunMessageItem[],
      pivot: PendingRunMessageItem | null
    ): Promise<unknown> => {
      const write = admissionWriteRef.current.then(() =>
        window.api.agentRuns.admissionsReplace({
          conversationId: targetConversationId,
          queued,
          pivot
        })
      )
      admissionWriteRef.current = write.catch(() => undefined)
      return write
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    if (!conversationId) {
      void Promise.resolve().then(() => {
        if (cancelled) return
        replaceQueue([])
        replacePivot(null)
      })
      return () => {
        cancelled = true
      }
    }
    void admissionWriteRef.current
      .then(() => window.api.agentRuns.admissionsList(conversationId))
      .then((result) => {
        if (cancelled) return
        replaceQueue(result.queued)
        replacePivot(result.pivot)
      })
      .catch((error) => console.error('[PromptAdmissions] Failed to load queue', error))
    return () => {
      cancelled = true
    }
  }, [conversationId, replacePivot, replaceQueue])

  const finishRun = useCallback(async (): Promise<PendingRunMessage | null> => {
    const targetConversationId = activeRef.current?.conversationId ?? conversationId
    if (activeRef.current?.projectionTimer) clearTimeout(activeRef.current.projectionTimer)
    activeRef.current = null
    setRunConversationId(null)
    setActiveMode(null)
    setPhase('idle')
    if (!targetConversationId) return null
    await admissionWriteRef.current
    const pending = await window.api.agentRuns.admissionsTakeNext(targetConversationId)
    if (!pending) return null
    if (pending.behavior === 'pivot') replacePivot(null)
    else replaceQueue(queuedRef.current.filter((item) => item.id !== pending.id))
    return {
      content: pending.content,
      images: pending.images,
      attachments: pending.attachments,
      mode: pending.mode,
      kind: pending.behavior === 'pivot' ? 'pivot' : 'queued'
    }
  }, [conversationId, replacePivot, replaceQueue])

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
        const nextPivot = { ...pivotRef.current, content: normalized }
        replacePivot(nextPivot)
        const targetConversationId = activeRef.current?.conversationId ?? conversationId
        if (targetConversationId)
          void persistAdmissions(targetConversationId, queuedRef.current, nextPivot)
        return true
      }
      const index = queuedRef.current.findIndex((message) => message.id === id)
      if (index < 0) return false
      const next = [...queuedRef.current]
      next[index] = { ...next[index], content: normalized }
      replaceQueue(next)
      const targetConversationId = activeRef.current?.conversationId ?? conversationId
      if (targetConversationId) void persistAdmissions(targetConversationId, next, pivotRef.current)
      return true
    },
    [conversationId, persistAdmissions, replacePivot, replaceQueue]
  )

  const removePendingMessage = useCallback(
    (id: string): void => {
      if (pivotRef.current?.id === id) {
        replacePivot(null)
        const targetConversationId = activeRef.current?.conversationId ?? conversationId
        if (targetConversationId)
          void persistAdmissions(targetConversationId, queuedRef.current, null)
        return
      }
      const next = queuedRef.current.filter((message) => message.id !== id)
      replaceQueue(next)
      const targetConversationId = activeRef.current?.conversationId ?? conversationId
      if (targetConversationId) void persistAdmissions(targetConversationId, next, pivotRef.current)
    },
    [conversationId, persistAdmissions, replacePivot, replaceQueue]
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
      const targetConversationId = activeRef.current?.conversationId ?? conversationId
      if (targetConversationId) void persistAdmissions(targetConversationId, next, pivotRef.current)
    },
    [conversationId, persistAdmissions, replaceQueue]
  )

  const steerQueuedMessage = useCallback(
    async (id: string): Promise<boolean> => {
      const index = queuedRef.current.findIndex((message) => message.id === id)
      if (index < 0) return false
      const nextQueue = [...queuedRef.current]
      const [message] = nextQueue.splice(index, 1)
      if (pivotRef.current) nextQueue.unshift(pivotRef.current)
      replaceQueue(nextQueue)
      replacePivot(message)
      const targetConversationId = activeRef.current?.conversationId ?? conversationId
      if (targetConversationId) await persistAdmissions(targetConversationId, nextQueue, message)
      await requestStop()
      return true
    },
    [conversationId, persistAdmissions, replacePivot, replaceQueue, requestStop]
  )

  const submitDuringRun = useCallback(
    async (
      content: string,
      mode: ConversationRunMode = 'conversation',
      behaviorOverride?: 'pivot' | 'queue',
      images: MessageImageAttachment[] = [],
      attachments: MessageContextAttachment[] = []
    ): Promise<boolean> => {
      if (!content.trim() && !images.length && !attachments.length) return false
      const pending = createPendingRunMessage(content.trim(), mode, images, attachments)
      if (behaviorOverride === 'pivot') {
        const nextQueue = pivotRef.current
          ? [pivotRef.current, ...queuedRef.current]
          : queuedRef.current
        if (pivotRef.current) replaceQueue(nextQueue)
        replacePivot(pending)
        const targetConversationId = activeRef.current?.conversationId ?? conversationId
        if (targetConversationId) await persistAdmissions(targetConversationId, nextQueue, pending)
        await requestStop()
      } else {
        const nextQueue = [...queuedRef.current, pending]
        replaceQueue(nextQueue)
        const targetConversationId = activeRef.current?.conversationId ?? conversationId
        if (targetConversationId)
          await persistAdmissions(targetConversationId, nextQueue, pivotRef.current)
      }
      return true
    },
    [conversationId, persistAdmissions, replacePivot, replaceQueue, requestStop]
  )

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
      const images = options?.images ?? []
      const attachments = options?.attachments ?? []
      if (!content.trim() && !images.length && !attachments.length) return
      if (isLoading) throw new Error('Already loading')
      let activeConversationId = options?.conversationId || conversationId
      const isNewConversation = !activeConversationId || messagesRef.current.length === 0
      if (!activeConversationId) {
        const title = createFallbackConversationTitle(
          content || images[0]?.name || attachments[0]?.name || 'Attachment'
        )
        const created = await window.api.conversations.create(title, null, 'fallback')
        activeConversationId = created.id
        skipNextLoadRef.current = true
        onConversationCreated(created.id, title)
      }
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        ...(images.length ? { images } : {}),
        ...(attachments.length ? { attachments } : {}),
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
          images: userMessage.images,
          attachments: userMessage.attachments,
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
    resolveInteraction,
    sendMessage
  }
}
