import { useSyncExternalStore } from 'react'
import type { UserTerminalSummary } from '../../../shared/userTerminals'

/**
 * The window's view of the user's own terminals. They belong to the app, not to one chat, so
 * every Terminal panel lists the same ones; one subscription keeps them current.
 */

type OutputListener = (data: string, offset: number) => void

let terminals: readonly UserTerminalSummary[] = []
let loaded = false
const changeListeners = new Set<() => void>()
const outputListeners = new Map<string, Set<OutputListener>>()
let unsubscribeEvents: (() => void) | null = null

function setTerminals(next: readonly UserTerminalSummary[]): void {
  terminals = next
  for (const listener of changeListeners) listener()
}

function upsert(terminal: UserTerminalSummary): void {
  const index = terminals.findIndex((candidate) => candidate.id === terminal.id)
  if (index < 0) setTerminals([...terminals, terminal])
  else setTerminals(terminals.map((candidate, at) => (at === index ? terminal : candidate)))
}

function ensureLoaded(): void {
  if (typeof window === 'undefined' || !window.api?.userTerminal) return
  unsubscribeEvents ??= window.api.userTerminal.onEvent((event) => {
    if (event.type === 'terminal') upsert(event.terminal)
    else if (event.type === 'closed')
      setTerminals(terminals.filter((terminal) => terminal.id !== event.id))
    else
      for (const listener of outputListeners.get(event.id) ?? []) listener(event.data, event.offset)
  })
  if (loaded) return
  loaded = true
  void window.api.userTerminal
    .list()
    .then((listed) => {
      // An event may already have brought a newer copy of a terminal.
      const known = new Set(terminals.map((terminal) => terminal.id))
      const added = listed.filter((terminal) => !known.has(terminal.id))
      if (added.length)
        setTerminals([...terminals, ...added].sort((a, b) => a.startedAt - b.startedAt))
    })
    .catch(() => {
      loaded = false
    })
}

function subscribe(listener: () => void): () => void {
  ensureLoaded()
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

export function useUserTerminals(): readonly UserTerminalSummary[] {
  return useSyncExternalStore(subscribe, () => terminals)
}

/** Records a terminal the moment it is opened, before its event arrives, so it can be shown. */
export function addUserTerminal(terminal: UserTerminalSummary): void {
  if (!terminals.some((candidate) => candidate.id === terminal.id)) upsert(terminal)
}

/** Raw output as it arrives, for a terminal view that already replayed what came before. */
export function subscribeUserTerminalOutput(id: string, listener: OutputListener): () => void {
  ensureLoaded()
  const listeners = outputListeners.get(id) ?? new Set<OutputListener>()
  listeners.add(listener)
  outputListeners.set(id, listeners)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) outputListeners.delete(id)
  }
}
