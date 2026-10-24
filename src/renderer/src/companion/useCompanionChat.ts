import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { projectAgentRunEvents } from '../../../shared/agentEventProjection'
import type { ConversationRunMode, PromptAdmissionsResult } from '../../../shared/agentRunApi'
import type { AgentRunEvent, AgentRunSnapshot } from '../../../shared/agentRuntime'
import type {
  CompanionCalls,
  CompanionChatDetail,
  CompanionEvent,
  CompanionImage
} from '../../../shared/companion'
import type { Message } from '../types/chat.types'
import {
  firstGapAfter,
  isActivePhase,
  mergeRunEvents,
  runEventAction,
  sendBaseline,
  unconfirmedSends,
  type CompanionConnection,
  type PendingSend
} from './chatState'
import { liveRunMessage, pendingSendMessage, toDesktopMessage } from './messageAdapter'

interface LiveRun {
  snapshot: AgentRunSnapshot
  events: AgentRunEvent[]
}

export type Subscribe = (listener: (event: CompanionEvent) => void) => () => void

export type ModelList = CompanionCalls['models.list']['output']

/** What one message carries: its text and the uploads already on the computer. */
export interface OutgoingMessage {
  text: string
  mode: ConversationRunMode
  modelId?: string
  images: Array<{ uploadId: string; preview: CompanionImage }>
  files: Array<{ uploadId: string; name: string }>
  /** For a new chat: the project it starts in, and whether in its own worktree of it. */
  projectId?: string
  workIn?: 'folder' | 'worktree'
}

const NO_QUEUE: PromptAdmissionsResult = { queued: [], pivot: null }

let nextSendId = 1

/**
 * One chat as the phone follows it: the saved messages from `chat.open`, the active run rebuilt
 * from its events as they arrive, and the messages queued behind it.
 */
export function useCompanionChat({
  connection,
  initialConversationId,
  subscribe,
  reconnects,
  onCreated,
  onFailure
}: {
  connection: CompanionConnection
  initialConversationId: string | null
  subscribe: Subscribe
  /** Counts stream reconnections; events sent while it was down are lost, so the chat reloads. */
  reconnects: number
  onCreated: (conversationId: string) => void
  /** Returns the message to show, or null when the failure was handled elsewhere. */
  onFailure: (error: unknown) => string | null
}) {
  const [conversationId, setConversationId] = useState(initialConversationId)
  const [detail, setDetail] = useState<CompanionChatDetail | null>(null)
  const [run, setRun] = useState<LiveRun | null>(null)
  const [loading, setLoading] = useState(Boolean(initialConversationId))
  const [pending, setPending] = useState<PendingSend[]>([])
  const [queue, setQueue] = useState<PromptAdmissionsResult>(NO_QUEUE)
  const [models, setModels] = useState<ModelList | null>(null)
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  // The mode of runs this phone started; a run's events do not say it.
  const [runModes, setRunModes] = useState<ReadonlyMap<string, ConversationRunMode>>(new Map())
  // Event handlers need the latest values without resubscribing on every change.
  const idRef = useRef(conversationId)
  const runRef = useRef(run)
  const loadToken = useRef(0)
  const queueToken = useRef(0)
  const catchingUp = useRef(false)

  const updateRun = useCallback((next: LiveRun | null) => {
    runRef.current = next
    setRun(next)
  }, [])

  const fail = useCallback(
    (failure: unknown) => {
      const message = onFailure(failure)
      if (message) setError(message)
    },
    [onFailure]
  )

  const load = useCallback(async () => {
    const id = idRef.current
    if (!id) return
    const token = ++loadToken.current
    try {
      const next = await connection.call('chat.open', { conversationId: id })
      if (token !== loadToken.current || idRef.current !== id) return
      setDetail(next)
      const current = runRef.current
      updateRun(
        next.run
          ? {
              snapshot: next.run.run,
              events:
                current?.snapshot.id === next.run.run.id
                  ? mergeRunEvents(current.events, next.run.events)
                  : mergeRunEvents([], next.run.events)
            }
          : null
      )
    } catch (failure) {
      if (token === loadToken.current) fail(failure)
    } finally {
      if (token === loadToken.current) setLoading(false)
    }
  }, [connection, fail, updateRun])

  const loadQueue = useCallback(async () => {
    const id = idRef.current
    if (!id) return
    const token = ++queueToken.current
    try {
      const next = await connection.call('queue.list', { conversationId: id })
      if (token === queueToken.current && idRef.current === id) setQueue(next)
    } catch {
      /* The queue shows again with the next change. */
    }
  }, [connection])

  const loadModels = useCallback(async () => {
    try {
      const id = idRef.current
      setModels(await connection.call('models.list', id ? { conversationId: id } : {}))
    } catch {
      /* Without the list, messages go to the chat's own model. */
    }
  }, [connection])

  // Fills holes left by events the stream dropped.
  const catchUp = useCallback(async () => {
    if (catchingUp.current) return
    catchingUp.current = true
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = runRef.current
        const after = current ? firstGapAfter(current.events) : null
        if (!current || after === null) return
        const page = await connection.call('run.events', {
          runId: current.snapshot.id,
          afterSequence: after
        })
        const latest = runRef.current
        if (!latest || latest.snapshot.id !== current.snapshot.id) return
        updateRun({ snapshot: page.run, events: mergeRunEvents(latest.events, page.events) })
      }
    } catch (failure) {
      fail(failure)
    } finally {
      catchingUp.current = false
    }
  }, [connection, fail, updateRun])

  useEffect(() => {
    void load()
    void loadQueue()
  }, [load, loadQueue, reconnects])

  useEffect(() => {
    void loadModels()
  }, [loadModels, reconnects])

  useEffect(
    () =>
      subscribe((event) => {
        const id = idRef.current
        if (!id) return
        if (event.type === 'messages.changed') {
          if (event.conversationId === id) void load()
          return
        }
        if (event.type === 'queue.changed') {
          if (event.conversationId === id) void loadQueue()
          return
        }
        if (event.type !== 'run.event') return
        const current = runRef.current
        const action = runEventAction(event.event, id, current?.snapshot.id ?? null)
        if (action === 'reload') void load()
        if (action !== 'append' || !current) return
        updateRun({ ...current, events: mergeRunEvents(current.events, [event.event]) })
        // The finished reply becomes a saved message.
        if (event.event.type === 'run.finalized') void load()
        else void catchUp()
      }),
    [subscribe, load, loadQueue, catchUp, updateRun]
  )

  const projected = useMemo(() => (run ? projectAgentRunEvents(run.events) : null), [run])
  const liveSegments = useMemo(() => projected?.segments ?? [], [projected])
  const unconfirmed = useMemo(
    () => unconfirmedSends(pending, detail?.messages ?? [], liveSegments),
    [pending, detail, liveSegments]
  )
  const phase = projected?.phase ?? run?.snapshot.phase ?? null
  const runActive = Boolean(run) && isActivePhase(phase)

  /** The chat as the desktop's message view shows it: saved, then sent, then being written. */
  const messages = useMemo((): Message[] => {
    const saved = detail?.messages ?? []
    // The run's own output message may already exist; the live projection draws it instead.
    const shown = (run ? saved.filter((message) => message.runId !== run.snapshot.id) : saved).map(
      toDesktopMessage
    )
    shown.push(...unconfirmed.map(pendingSendMessage))
    if (run && projected)
      shown.push(liveRunMessage(run.snapshot, projected, runModes.get(run.snapshot.id)))
    return shown
  }, [detail, run, projected, unconfirmed, runModes])

  const send = useCallback(
    async (message: OutgoingMessage): Promise<boolean> => {
      const queuing = runActive
      const pendingSend: PendingSend | null = queuing
        ? null
        : {
            id: `send-${nextSendId++}`,
            text: message.text,
            sentAt: Date.now(),
            baseline: sendBaseline(message.text, detail?.messages ?? [], liveSegments, pending),
            images: message.images.map((image) => image.preview),
            files: message.files.map((file) => file.name)
          }
      if (pendingSend) setPending((current) => [...current, pendingSend])
      setSending(true)
      setError('')
      try {
        const id = idRef.current
        const result = await connection.call('chat.send', {
          ...(id
            ? { conversationId: id }
            : message.projectId
              ? { projectId: message.projectId, workIn: message.workIn ?? 'folder' }
              : {}),
          text: message.text,
          mode: message.mode,
          ...(message.modelId ? { modelId: message.modelId } : {}),
          ...(message.images.length
            ? { images: message.images.map(({ uploadId }) => ({ uploadId })) }
            : {}),
          ...(message.files.length
            ? { files: message.files.map(({ uploadId }) => ({ uploadId })) }
            : {})
        })
        if (!id) {
          idRef.current = result.conversationId
          setConversationId(result.conversationId)
          onCreated(result.conversationId)
        }
        // A queued message shows in the queue, not as a sent one.
        if (result.queued && pendingSend)
          setPending((current) => current.filter((item) => item.id !== pendingSend.id))
        if (result.runId && !result.queued && !result.steered) {
          const runId = result.runId
          setRunModes((current) => new Map(current).set(runId, message.mode))
        }
        await Promise.all([load(), loadQueue()])
        return true
      } catch (failure) {
        if (pendingSend)
          setPending((current) => current.filter((item) => item.id !== pendingSend.id))
        fail(failure)
        return false
      } finally {
        setSending(false)
      }
    },
    [connection, detail, liveSegments, pending, runActive, load, loadQueue, onCreated, fail]
  )

  /**
   * Answers a sent message again, with new text for an edit, as the desktop's Retry and Edit do.
   * The replies after it leave as the computer deletes them.
   */
  const retry = useCallback(
    async (messageId: string, text?: string): Promise<boolean> => {
      const id = idRef.current
      if (!id) return false
      setSending(true)
      setError('')
      try {
        await connection.call('chat.retry', {
          conversationId: id,
          messageId,
          ...(text !== undefined ? { text } : {})
        })
        await load()
        return true
      } catch (failure) {
        fail(failure)
        return false
      } finally {
        setSending(false)
      }
    },
    [connection, fail, load]
  )

  const stop = useCallback(async () => {
    const current = runRef.current
    if (!current) return
    setStopping(true)
    setError('')
    try {
      await connection.call('run.stop', { runId: current.snapshot.id })
    } catch (failure) {
      fail(failure)
    } finally {
      setStopping(false)
    }
  }, [connection, fail])

  /**
   * Answers a card. The desktop's cards await this to settle, and some do not catch, so the
   * promise is marked handled here and the failure is shown above the message box.
   */
  const resolve = useCallback(
    (interactionId: string, response: Record<string, unknown>, cancelled?: boolean) => {
      setError('')
      const result = connection
        .call('interaction.resolve', {
          interactionId,
          response,
          ...(cancelled ? { cancelled: true } : {})
        })
        .then(() => undefined)
      result.catch(fail)
      return result
    },
    [connection, fail]
  )

  /** Replaces the queue: reordered, edited, or without the ids left out. */
  const updateQueue = useCallback(
    async (queued: Array<{ id: string; content: string }>) => {
      const id = idRef.current
      if (!id) return
      // Shown at once; the computer's answer replaces it.
      setQueue((current) => {
        const byId = new Map(current.queued.map((item) => [item.id, item]))
        return {
          ...current,
          queued: queued.flatMap(({ id: itemId, content }) => {
            const item = byId.get(itemId)
            return item ? [{ ...item, content }] : []
          })
        }
      })
      try {
        setQueue(await connection.call('queue.update', { conversationId: id, queued }))
      } catch (failure) {
        fail(failure)
        void loadQueue()
      }
    },
    [connection, fail, loadQueue]
  )

  const steerQueued = useCallback(
    async (admissionId: string) => {
      const id = idRef.current
      if (!id) return
      setError('')
      try {
        await connection.call('queue.steer', { conversationId: id, admissionId })
      } catch (failure) {
        fail(failure)
      } finally {
        void loadQueue()
      }
    },
    [connection, fail, loadQueue]
  )

  return {
    conversationId,
    chat: detail?.chat ?? null,
    messages,
    runActive,
    phase,
    queue,
    models,
    loading,
    sending,
    stopping,
    error,
    setError,
    send,
    retry,
    reload: load,
    stop,
    resolve,
    updateQueue,
    steerQueued
  }
}
