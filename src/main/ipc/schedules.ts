import { BrowserWindow, ipcMain, powerMonitor } from 'electron'
import { validateScheduleInput } from '../../shared/schedules'
import { ScheduleService } from '../services/scheduleService'
import { ScheduleStore } from '../services/scheduleStore'
import { createScheduledConversationLauncher } from '../services/scheduledConversationLauncher'
import type { ProviderSettings } from '../../shared/settings'
import { createDesktopEventPublisher } from './desktopEventPublisher'
import {
  getAgentRuntimeCoordinator,
  observeAgentRunEvents,
  startConversationRun
} from './agentRuns'
import { loadStoredSettings } from './settings'
import { getDb } from './state'

let service: ScheduleService | null = null
const publishDesktopEvent = createDesktopEventPublisher(() => BrowserWindow.getAllWindows())

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
      startConversationRun
    }),
    onChange: (change) => publishDesktopEvent('schedules:changed', change)
  })
  const schedules = service
  observeAgentRunEvents((event) => {
    if (event.type === 'run.phase' || event.type === 'run.completed') {
      schedules.agentRunChanged(event.runId, event.type === 'run.completed')
    }
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
export function startScheduler(): void {
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
