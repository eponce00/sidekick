import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { TerminalSessionSummary } from '../../../shared/terminalSessions'

/**
 * The window's view of agent commands. One subscription to the main process feeds every command
 * row in the chat and the Terminal panel, so a running command is drawn from one record.
 */

type OutputListener = (data: string, offset: number) => void

let sessions: readonly TerminalSessionSummary[] = []
const changeListeners = new Set<() => void>()
const outputListeners = new Map<string, Set<OutputListener>>()
const loadedConversations = new Set<string>()
let unsubscribeEvents: (() => void) | null = null

function setSessions(next: readonly TerminalSessionSummary[]): void {
  sessions = next
  for (const listener of changeListeners) listener()
}

function upsert(session: TerminalSessionSummary): void {
  const index = sessions.findIndex((candidate) => candidate.id === session.id)
  if (index < 0) setSessions([...sessions, session])
  else setSessions(sessions.map((candidate, at) => (at === index ? session : candidate)))
}

function ensureSubscribed(): void {
  if (unsubscribeEvents || typeof window === 'undefined' || !window.api?.terminal) return
  unsubscribeEvents = window.api.terminal.onEvent((event) => {
    if (event.type === 'session') upsert(event.session)
    else
      for (const listener of outputListeners.get(event.id) ?? []) listener(event.data, event.offset)
  })
}

/** Loads a conversation's commands from this app session once; events keep them current. */
export function loadTerminalSessions(conversationId: string): void {
  ensureSubscribed()
  if (loadedConversations.has(conversationId) || !window.api?.terminal) return
  loadedConversations.add(conversationId)
  void window.api.terminal
    .list(conversationId)
    .then((listed) => {
      // An event may already have brought a newer copy of a session.
      const known = new Set(sessions.map((session) => session.id))
      const added = listed.filter((session) => !known.has(session.id))
      if (added.length) setSessions([...sessions, ...added])
    })
    .catch(() => loadedConversations.delete(conversationId))
}

function subscribe(listener: () => void): () => void {
  ensureSubscribed()
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function snapshot(): readonly TerminalSessionSummary[] {
  return sessions
}

export function useTerminalSessions(
  conversationId: string | null | undefined
): readonly TerminalSessionSummary[] {
  const all = useSyncExternalStore(subscribe, snapshot)
  useEffect(() => {
    if (conversationId) loadTerminalSessions(conversationId)
  }, [conversationId])
  return useMemo(
    () =>
      conversationId
        ? all
            .filter((session) => session.conversationId === conversationId)
            .sort((left, right) => left.startedAt - right.startedAt)
        : [],
    [all, conversationId]
  )
}

/** The terminal of the command a tool call ran, once one exists, or of a command by its ID. */
export function useTerminalSessionForTool(
  toolCallId: string | undefined,
  sessionId?: string
): TerminalSessionSummary | undefined {
  const all = useSyncExternalStore(subscribe, snapshot)
  return useMemo(
    () =>
      sessionId
        ? all.find((session) => session.id === sessionId)
        : toolCallId
          ? all.find((session) => session.toolCallId === toolCallId)
          : undefined,
    [all, sessionId, toolCallId]
  )
}

/** Raw output as it arrives, for a terminal view that already replayed what came before. */
export function subscribeTerminalOutput(id: string, listener: OutputListener): () => void {
  ensureSubscribed()
  const listeners = outputListeners.get(id) ?? new Set<OutputListener>()
  listeners.add(listener)
  outputListeners.set(id, listeners)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) outputListeners.delete(id)
  }
}

type ViewListener = (sessionId: string) => void
const viewListeners = new Set<ViewListener>()

/** Asks the side panel to show a command's terminal. */
export function requestTerminalView(sessionId: string): boolean {
  if (!viewListeners.size) return false
  for (const listener of viewListeners) listener(sessionId)
  return true
}

export function subscribeTerminalView(listener: ViewListener): () => void {
  viewListeners.add(listener)
  return () => viewListeners.delete(listener)
}
