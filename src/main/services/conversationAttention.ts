import type { AgentRunEvent, AgentRunSurface } from '../../shared/agentRuntime'
import type {
  ConversationAttentionAlert,
  ConversationAttentionState
} from '../../shared/conversationAttention'

export interface AttentionRunIdentity {
  threadId: string
  surface: AgentRunSurface
}

/**
 * Follows the run event stream to know which conversations are paused on the
 * user. A sub-agent's request counts for the conversation it works for; group
 * sessions have their own surface and are left out.
 */
export class ConversationAttentionTracker {
  private readonly pending = new Map<string, { runId: string; conversationId: string }>()

  constructor(
    private readonly runIdentity: (runId: string) => AttentionRunIdentity | null,
    private readonly onChange: (state: ConversationAttentionState) => void
  ) {}

  state(): ConversationAttentionState {
    const ids = new Set<string>()
    for (const { conversationId } of this.pending.values()) ids.add(conversationId)
    return { waitingConversationIds: [...ids] }
  }

  observe(event: AgentRunEvent): void {
    const interactionId = event.payload.interactionId
    if (event.type === 'permission.requested' || event.type === 'question.requested') {
      if (typeof interactionId !== 'string' || this.pending.has(interactionId)) return
      const run = this.runIdentity(event.runId)
      if (!run || run.surface === 'collaboration') return
      const alreadyWaiting = this.isWaiting(run.threadId)
      this.pending.set(interactionId, { runId: event.runId, conversationId: run.threadId })
      this.emit(
        alreadyWaiting
          ? undefined
          : {
              conversationId: run.threadId,
              reason: event.payload.kind === 'question' ? 'question' : 'approval'
            }
      )
      return
    }
    if (event.type === 'permission.resolved' || event.type === 'question.resolved') {
      if (typeof interactionId === 'string' && this.pending.delete(interactionId)) this.emit()
      return
    }
    if (event.type !== 'run.completed') return
    let changed = false
    for (const [id, entry] of this.pending) {
      if (entry.runId !== event.runId) continue
      this.pending.delete(id)
      changed = true
    }
    // A failed sub-agent is reported to its parent, which carries on.
    const run = event.payload.phase === 'failed' ? this.runIdentity(event.runId) : null
    const failed =
      run && (run.surface === 'conversation' || run.surface === 'research')
        ? { conversationId: run.threadId, reason: 'failed' as const }
        : undefined
    if (changed || failed) this.emit(failed)
  }

  private isWaiting(conversationId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.conversationId === conversationId) return true
    }
    return false
  }

  private emit(alert?: ConversationAttentionAlert): void {
    this.onChange(alert ? { ...this.state(), alert } : this.state())
  }
}
