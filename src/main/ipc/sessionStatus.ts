import { BrowserWindow, ipcMain } from 'electron'
import type { SessionsChangedEvent } from '../../shared/sessions'
import { applyAttentionBadge } from '../services/attentionBadge'
import { databaseSessionSources, SessionStatusService } from '../services/sessionStatus'
import {
  existingAgentRuntimeCoordinator,
  observeAgentRunEvents,
  observeAgentRunPreparations
} from './agentRuns'
import { createDesktopEventPublisher } from './desktopEventPublisher'
import { getDb } from './state'

const publishDesktopEvent = createDesktopEventPublisher(() => BrowserWindow.getAllWindows())
let service: SessionStatusService | null = null

/** The status service, once the status handlers are registered. */
export function sessionStatusService(): SessionStatusService | null {
  return service
}

/** Re-reads chats whose stored state changed outside a run, such as being read or deleted. */
export function refreshSessionStatuses(conversationIds: readonly string[]): void {
  try {
    service?.refresh(conversationIds)
  } catch (error) {
    console.warn('[Sessions] Could not refresh chat status:', error)
  }
}

export function registerSessionStatusHandlers(): void {
  if (service) return
  const db = getDb()
  const current = new SessionStatusService({
    ...databaseSessionSources(db),
    runIdentity: (runId) => existingAgentRuntimeCoordinator()?.store.get(runId) ?? null,
    activeConversationIds: () => existingAgentRuntimeCoordinator()?.activeConversationIds() ?? []
  })
  service = current
  current.onChange((change: SessionsChangedEvent) => {
    applyAttentionBadge(current.waitingConversationIds().length)
    publishDesktopEvent('sessions:changed', change)
  })
  // Status is a convenience; it must never interrupt the durable event stream.
  observeAgentRunEvents((event) => {
    try {
      current.observe(event)
    } catch (error) {
      console.warn('[Sessions] Could not follow a run event:', error)
    }
  })
  observeAgentRunPreparations((threadId) => refreshSessionStatuses([threadId]))
  current.start()
  applyAttentionBadge(current.waitingConversationIds().length)
  ipcMain.handle('sessions:statuses', () => current.statuses())
}
