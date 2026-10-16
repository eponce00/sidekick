import { BrowserWindow, ipcMain } from 'electron'
import type { PinnedModel } from '../../shared/models'
import { pinnedModelsFromProviderInstances } from '../../shared/providerInstances'
import type { ProviderSettings } from '../../shared/settings'
import {
  SESSION_LIMITS,
  type StartSessionSpec,
  type StartSessionsInput
} from '../../shared/sessions'
import { SessionService } from '../services/sessionService'
import { createDesktopEventPublisher } from './desktopEventPublisher'
import {
  getAgentRuntimeCoordinator,
  observeAgentRunEvents,
  startConversationRun
} from './agentRuns'
import { loadStoredSettings } from './settings'
import { getDb } from './state'
import { getManagedWorktrees } from './worktrees'

let service: SessionService | null = null
const publishDesktopEvent = createDesktopEventPublisher(() => BrowserWindow.getAllWindows())

export function getSessionService(): SessionService {
  if (!service) throw new Error('Sessions are not ready')
  return service
}

function validId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200) throw new Error('Invalid chat')
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`)
  return value
}

function validSpec(value: unknown): StartSessionSpec {
  if (!value || typeof value !== 'object') throw new Error('Invalid chat to start')
  const spec = value as Record<string, unknown>
  const projectId = spec.projectId
  if (projectId !== undefined && projectId !== null && typeof projectId !== 'string')
    throw new Error('Invalid project')
  const context = spec.context
  if (context !== undefined && context !== 'fresh' && context !== 'fork')
    throw new Error('Invalid context')
  return {
    title: optionalString(spec.title, 'title') ?? '',
    brief: optionalString(spec.brief, 'brief') ?? '',
    ...(spec.handle !== undefined ? { handle: optionalString(spec.handle, 'name') } : {}),
    ...(projectId !== undefined ? { projectId: projectId as string | null } : {}),
    ...(spec.workIn !== undefined
      ? { workIn: optionalString(spec.workIn, 'workspace') as StartSessionSpec['workIn'] }
      : {}),
    ...(spec.baseRef !== undefined ? { baseRef: optionalString(spec.baseRef, 'base') } : {}),
    ...(spec.modelId !== undefined ? { modelId: optionalString(spec.modelId, 'model') } : {}),
    ...(context ? { context } : {})
  }
}

/** Changes to a suggestion before starting it; omitted fields keep the suggestion's. */
function validOverrides(value: unknown): Partial<StartSessionSpec> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object') throw new Error('Invalid changes')
  const { title, brief, ...rest } = validSpec({ title: '', brief: '', ...value })
  return { ...rest, ...(title ? { title } : {}), ...(brief ? { brief } : {}) }
}

function validStartInput(value: unknown): StartSessionsInput {
  const input = value as Record<string, unknown> | null
  if (!input || typeof input !== 'object') throw new Error('Invalid chats to start')
  const sessions = input.sessions
  if (!Array.isArray(sessions) || sessions.length > SESSION_LIMITS.liveWorkersPerFamily)
    throw new Error('Invalid chats to start')
  if (input.mode !== undefined && input.mode !== 'start' && input.mode !== 'propose')
    throw new Error('Invalid mode')
  return {
    managerConversationId: validId(input.managerConversationId),
    sessions: sessions.map(validSpec),
    ...(input.mode ? { mode: input.mode as 'start' | 'propose' } : {})
  }
}

/** The model asked for, else the one the chat's latest run used, else the selected model. */
function resolveModel(conversationId: string, modelId?: string): PinnedModel | null {
  const settings = loadStoredSettings() as unknown as ProviderSettings
  const models = pinnedModelsFromProviderInstances(settings.providerInstances ?? [])
  if (modelId) return models.find(({ id }) => id === modelId) ?? null
  const latest = getAgentRuntimeCoordinator().store.latest(conversationId)
  const used = latest
    ? models.find(
        (model) =>
          (model.providerModelId || model.name) === latest.model &&
          (model.providerKind ?? model.provider) === latest.provider
      )
    : undefined
  return used ?? models.find(({ id }) => id === settings.selectedModel) ?? models[0] ?? null
}

export function registerSessionHandlers(): void {
  const coordinator = getAgentRuntimeCoordinator()
  const worktrees = getManagedWorktrees()
  const sessions = new SessionService({
    db: getDb(),
    runtime: {
      startRun: startConversationRun,
      stopRun: (runId) => coordinator.stop(runId),
      steer: (conversationId, steer) => coordinator.steerConversation(conversationId, steer),
      latestRun: (conversationId) => coordinator.store.latest(conversationId),
      run: (runId) => coordinator.store.get(runId)
    },
    worktrees: {
      isGitProject: async (projectId) => (await worktrees.branchOptions(projectId)).isGitRepository,
      createForConversation: (input) => worktrees.createForConversation(input),
      removeIfUnused: (projectId) => worktrees.removeIfUnused(projectId)
    },
    resolveModel,
    onChange: (change) => publishDesktopEvent('sessions:changed', change)
  })
  service = sessions
  coordinator.setConversationInbox((conversationId, runId) =>
    sessions.pendingSteers(conversationId, runId)
  )
  observeAgentRunEvents((event) => sessions.observe(event))

  // `sessions:statuses` belongs to the status service.
  ipcMain.handle('sessions:family', (_event, id: unknown) => sessions.family(validId(id)))
  ipcMain.handle('sessions:messages', (_event, id: unknown, options: unknown) => {
    const value = (options ?? {}) as { limit?: unknown; beforeCreatedAt?: unknown }
    return sessions.messages(validId(id), {
      ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
      ...(typeof value.beforeCreatedAt === 'number'
        ? { beforeCreatedAt: value.beforeCreatedAt }
        : {})
    })
  })
  ipcMain.handle('sessions:markMessagesRead', (_event, id: unknown) =>
    sessions.markMessagesRead(validId(id))
  )
  ipcMain.handle('sessions:attachment', (_event, id: unknown) =>
    sessions.store.attachment(validId(id))
  )
  ipcMain.handle('sessions:start', (_event, input: unknown) =>
    sessions.start(validStartInput(input), 'user')
  )
  ipcMain.handle('sessions:proposals', (_event, id: unknown) => sessions.proposals(validId(id)))
  ipcMain.handle('sessions:startProposal', (_event, id: unknown, overrides: unknown) =>
    sessions.startProposal(validId(id), validOverrides(overrides))
  )
  ipcMain.handle('sessions:dismissProposal', (_event, id: unknown) =>
    sessions.dismissProposal(validId(id))
  )
  ipcMain.handle('sessions:stop', (_event, id: unknown) => sessions.stop(validId(id)))
  ipcMain.handle('sessions:archive', (_event, id: unknown, options: unknown) =>
    sessions.archive(validId(id), {
      family: (options as { family?: unknown } | undefined)?.family === true
    })
  )
  ipcMain.handle('sessions:unarchive', (_event, id: unknown) => sessions.unarchive(validId(id)))
  ipcMain.handle('sessions:detach', (_event, id: unknown) => sessions.detach(validId(id)))
  ipcMain.handle('sessions:grants', (_event, id: unknown) => sessions.store.grants(validId(id)))
  ipcMain.handle('sessions:grantProject', (_event, id: unknown, projectId: unknown) =>
    sessions.grantProject(validId(id), validId(projectId))
  )
  ipcMain.handle('sessions:revokeProject', (_event, id: unknown, projectId: unknown) =>
    sessions.revokeProject(validId(id), validId(projectId))
  )
}
