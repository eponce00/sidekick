import type { AgentRunEvent } from '../../shared/agentRuntime'
import type { ConversationGoal } from '../../shared/conversationGoals'

interface DesktopEventPayloads {
  'agentRuns:event': { event: AgentRunEvent }
  'conversationGoals:changed': { goal: ConversationGoal }
}

export interface DesktopEventWindow {
  isDestroyed(): boolean
  readonly webContents: {
    isDestroyed(): boolean
    send(channel: string, payload: unknown): void
  }
}

/** Renderer delivery is best effort, not part of the durable engine transaction.
 * Catch only individual window delivery failures; callers retain ownership of
 * database writes and internal observers. Windows are reconsidered every event. */
export function createDesktopEventPublisher(
  windows: () => readonly DesktopEventWindow[],
  warn: (message: string) => void = (message) => console.warn(message)
) {
  let warned = false
  return <Channel extends keyof DesktopEventPayloads>(
    channel: Channel,
    payload: DesktopEventPayloads[Channel]
  ): void => {
    for (const window of windows()) {
      try {
        if (window.isDestroyed()) continue
        const contents = window.webContents
        if (contents.isDestroyed()) continue
        contents.send(channel, payload)
      } catch {
        // One fixed warning per publisher lifetime bounds shutdown/error storms.
        // Never include exception text, window IDs, channel data or event payloads.
        if (!warned) {
          warned = true
          try {
            warn(
              '[DesktopEvents] A renderer event could not be delivered; later deliveries remain enabled.'
            )
          } catch {
            /* A logging failure must not interrupt delivery either. */
          }
        }
      }
    }
  }
}
