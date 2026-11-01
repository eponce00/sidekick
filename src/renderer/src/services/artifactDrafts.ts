import { useSyncExternalStore } from 'react'
import type { AgentArtifactDraft } from '../../../shared/agentRunApi'

// Artifacts' code as the model writes it, by the call that is writing it. Drafts are live only:
// a chat opened after the call finished shows the finished artifact instead.

/** Calls written at once are few; older drafts are long finished. */
const KEPT_DRAFTS = 8

const drafts = new Map<string, string>()
const listeners = new Set<() => void>()
let stopListening: (() => void) | null = null

function receive(draft: AgentArtifactDraft): void {
  drafts.delete(draft.toolCallId)
  drafts.set(draft.toolCallId, draft.code)
  while (drafts.size > KEPT_DRAFTS) drafts.delete(drafts.keys().next().value!)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  // Pages without the app's API, such as the artifact inspection page, have no drafts.
  stopListening ??= window.api?.agentRuns?.onArtifactDraft?.(receive) ?? null
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      stopListening?.()
      stopListening = null
    }
  }
}

/** The code a call has written so far, or null when none has arrived. */
export function useArtifactDraft(toolCallId: string | undefined): string | null {
  return useSyncExternalStore(subscribe, () =>
    toolCallId ? (drafts.get(toolCallId) ?? null) : null
  )
}
