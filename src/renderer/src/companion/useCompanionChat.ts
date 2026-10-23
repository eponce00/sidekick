import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { projectAgentRunEvents } from '../../../shared/agentEventProjection'
import type { AgentRunEvent, AgentRunSnapshot } from '../../../shared/agentRuntime'
import type { CompanionChatDetail, CompanionEvent } from '../../../shared/companion'
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

interface LiveRun {
  snapshot: AgentRunSnapshot
  events: AgentRunEvent[]
}

export type Subscribe = (listener: (event: CompanionEvent) => void) => () => void

let nextSendId = 1

/**
 * One chat as the phone follows it: the saved messages from `chat.open`, plus the active run
 * rebuilt from its events as they arrive.
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
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  // Event handlers need the latest values without resubscribing on every change.
  const idRef = useRef(conversationId)
  const runRef = useRef(run)
  const loadToken = useRef(0)
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
  }, [load, reconnects])

  useEffect(
    () =>
      subscribe((event) => {
        const id = idRef.current
        if (!id) return
        if (event.type === 'messages.changed') {
          if (event.conversationId === id) void load()
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
    [subscribe, load, catchUp, updateRun]
  )

  const projected = useMemo(() => (run ? projectAgentRunEvents(run.events) : null), [run])
  const liveSegments = useMemo(() => projected?.segments ?? [], [projected])
  const messages = useMemo(() => {
    const saved = detail?.messages ?? []
    // The run's own output message may already exist; the live projection draws it instead.
    return run ? saved.filter((message) => message.runId !== run.snapshot.id) : saved
  }, [detail, run])
  const unconfirmed = useMemo(
    () => unconfirmedSends(pending, detail?.messages ?? [], liveSegments),
    [pending, detail, liveSegments]
  )
  const phase = projected?.phase ?? run?.snapshot.phase ?? null
  const runActive = Boolean(run) && isActivePhase(phase)

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const pendingSend: PendingSend = {
        id: `send-${nextSendId++}`,
        text,
        baseline: sendBaseline(text, detail?.messages ?? [], liveSegments, pending)
      }
      setPending((current) => [...current, pendingSend])
      setSending(true)
      setError('')
      try {
        const id = idRef.current
        const result = await connection.call('chat.send', {
          ...(id ? { conversationId: id } : {}),
          text
        })
        if (!id) {
          idRef.current = result.conversationId
          setConversationId(result.conversationId)
          onCreated(result.conversationId)
        }
        await load()
        return true
      } catch (failure) {
        setPending((current) => current.filter((item) => item.id !== pendingSend.id))
        fail(failure)
        return false
      } finally {
        setSending(false)
      }
    },
    [connection, detail, liveSegments, pending, load, onCreated, fail]
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

  const resolve = useCallback(
    async (interactionId: string, response: Record<string, unknown>, cancelled?: boolean) => {
      setAnswered((current) => new Set(current).add(interactionId))
      setError('')
      try {
        await connection.call('interaction.resolve', {
          interactionId,
          response,
          ...(cancelled ? { cancelled: true } : {})
        })
      } catch (failure) {
        setAnswered((current) => {
          const next = new Set(current)
          next.delete(interactionId)
          return next
        })
        fail(failure)
      }
    },
    [connection, fail]
  )

  return {
    conversationId,
    chat: detail?.chat ?? null,
    messages,
    liveSegments,
    runActive,
    phase,
    unconfirmed,
    loading,
    sending,
    stopping,
    error,
    answered,
    send,
    stop,
    resolve
  }
}
