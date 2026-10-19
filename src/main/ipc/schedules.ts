import { BrowserWindow, ipcMain, Notification, powerMonitor } from 'electron'
import icon from '../../../resources/icon.png?asset'
import { normalizeDesktopNotificationBody } from '../../shared/desktopNotifications'
import { normalizePermissionMode } from '../../shared/permissions'
import { validateScheduleInput } from '../../shared/schedules'
import { ScheduleService, type ScheduledRunFinishedNotice } from '../services/scheduleService'
import { ScheduleStore } from '../services/scheduleStore'
import { createScheduledConversationLauncher } from '../services/scheduledConversationLauncher'
import type { ProviderSettings } from '../../shared/settings'
import { createDesktopEventPublisher } from './desktopEventPublisher'
import {
  getAgentRuntimeCoordinator,
  observeAgentRunEvents,
  startConversationInBackground
} from './agentRuns'
import { loadStoredSettings } from './settings'
import { getDb } from './state'
import { getManagedWorktrees } from './worktrees'

let service: ScheduleService | null = null
/** Shows the main window, opening it again if it was closed, on the given chat. */
let openConversation: ((conversationId: string) => void) | null = null
const publishDesktopEvent = createDesktopEventPublisher(() => BrowserWindow.getAllWindows())

/**
 * A scheduled chat that finished has no manager chat to report to, so it reports to the user,
 * unless they are looking at SideKick already; the chat's unread dot says it either way.
 */
function announceFinished(notice: ScheduledRunFinishedNotice): void {
  const settings = loadStoredSettings() as unknown as ProviderSettings
  if (settings.notificationsEnabled === false || !Notification.isSupported()) return
  if (BrowserWindow.getFocusedWindow()) return
  const notification = new Notification({
    title: notice.title,
    body: normalizeDesktopNotificationBody(notice.reply),
    silent: settings.notificationSoundEnabled !== true,
    icon: process.platform === 'darwin' ? undefined : icon
  })
  notification.on('click', () => openConversation?.(notice.conversationId))
  notification.on('failed', (_event, error) => {
    console.warn('[Schedules] Native notification failed:', error)
  })
  notification.show()
}

function validId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200) {
    throw new Error('Invalid schedule')
  }
  return value
}

export function registerScheduleHandlers(): void {
  const db = getDb()
  service = new ScheduleService({
    store: new ScheduleStore(db),
    launcher: createScheduledConversationLauncher({
      db,
      settings: () => loadStoredSettings() as unknown as ProviderSettings,
      startConversationRun: startConversationInBackground,
      folderOccupants: (folder) => getAgentRuntimeCoordinator().folderOccupants(folder),
      isRunQueued: (agentRunId) =>
        getAgentRuntimeCoordinator()
          .queuedRuns()
          .some(({ runId }) => runId === agentRunId),
      worktrees: {
        isGitProject: async (projectId) =>
          (await getManagedWorktrees().branchOptions(projectId)).isGitRepository,
        create: async (projectId, title) => {
          const worktrees = getManagedWorktrees()
          const worktree = await worktrees.create(projectId, title)
          return {
            worktreeId: worktree.id,
            location: worktrees.location(worktree.id) ?? 'from the project'
          }
        },
        discard: (worktreeId) => getManagedWorktrees().discardFresh(worktreeId)
      }
    }),
    onChange: (change) => publishDesktopEvent('schedules:changed', change),
    permissionMode: () =>
      normalizePermissionMode(
        (loadStoredSettings() as unknown as ProviderSettings).commandPermissionMode
      ),
    onFinished: announceFinished
  })
  const schedules = service
  observeAgentRunEvents((event) => {
    if (event.type === 'run.phase' || event.type === 'run.completed') {
      schedules.agentRunChanged(event.runId, event.type === 'run.completed')
    }
    if (event.type === 'run.finalized') schedules.agentRunFinalized(event.runId)
  })

  ipcMain.handle('schedules:list', () => schedules.list())
  ipcMain.handle('schedules:create', (_event, input: unknown) =>
    schedules.create(validateScheduleInput(input))
  )
  ipcMain.handle('schedules:update', (_event, input: unknown) => {
    const id = validId((input as { id?: unknown } | null)?.id)
    return schedules.update(id, validateScheduleInput(input))
  })
  ipcMain.handle('schedules:pause', (_event, id: unknown) => schedules.pause(validId(id)))
  ipcMain.handle('schedules:resume', (_event, id: unknown) => schedules.resume(validId(id)))
  ipcMain.handle('schedules:delete', (_event, id: unknown) => ({
    success: schedules.delete(validId(id))
  }))
  ipcMain.handle('schedules:runNow', (_event, id: unknown) => schedules.runNow(validId(id)))
  ipcMain.handle('schedules:runs', (_event, id: unknown) => schedules.runs(validId(id)))
}

/** Starts the timer once the runtime has recovered runs interrupted by the last exit. */
export function startScheduler(options: { openConversation?: (id: string) => void } = {}): void {
  openConversation = options.openConversation ?? null
  if (!service) return
  // Recovery marks runs left over from a crash as interrupted, so they do not look active.
  getAgentRuntimeCoordinator()
  powerMonitor.on('resume', () => service?.wake())
  powerMonitor.on('unlock-screen', () => service?.wake())
  service.start()
}

export function stopScheduler(): void {
  service?.stop()
}
