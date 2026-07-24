import { BrowserWindow, ipcMain } from 'electron'
import type {
  AddCollaborationParticipantInput,
  CollaborationChangedEvent,
  CreateCollaborationGroupInput,
  RewriteCollaborationMessageInput,
  SendCollaborationMessageInput,
  UpdateCollaborationAgentSessionInput,
  UpdateCollaborationGroupInput,
  UpdateCollaborationParticipantInput,
  UpdateCollaborationParticipantsInput
} from '../../shared/collaboration'
import { CollaborationStore } from '../services/collaborationStore'
import { CollaborationSupervisor } from '../services/collaborationSupervisor'
import { resolveStoredToolCallLimit } from '../../shared/agentLimits'
import { getDb, getStore } from './state'
import { getAgentRuntimeCoordinator } from './agentRuns'

let supervisor: CollaborationSupervisor | null = null

function notify(change: CollaborationChangedEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('collaboration:changed', change)
  }
}

export function registerCollaborationHandlers(): void {
  const store = new CollaborationStore(getDb())
  supervisor = new CollaborationSupervisor(
    store,
    getAgentRuntimeCoordinator(),
    (groupId, reason) => notify({ groupId, reason }),
    {
      toolCallLimit: () => {
        const settings = getStore().get('settings', {}) as {
          toolCallLimit?: unknown
          toolCallLimitVersion?: unknown
        }
        return resolveStoredToolCallLimit(settings.toolCallLimit, settings.toolCallLimitVersion)
      }
    }
  )
  const recovered = supervisor.recover()
  if (recovered) console.log(`[Collaboration] Paused ${recovered} interrupted mission(s)`)

  ipcMain.handle('collaboration:listGroups', () => store.listGroups())
  ipcMain.handle('collaboration:getGroup', (_event, id: string) => store.getDetail(id))
  ipcMain.handle('collaboration:getAgentSession', (_event, id: string) => store.getAgentSession(id))
  ipcMain.handle('collaboration:markGroupRead', (_event, id: string) => ({
    success: store.markGroupRead(id)
  }))
  ipcMain.handle('collaboration:markAgentSessionRead', (_event, id: string) => ({
    success: store.markAgentSessionRead(id)
  }))
  ipcMain.handle(
    'collaboration:updateAgentSession',
    (_event, id: string, input: UpdateCollaborationAgentSessionInput) => {
      const session = store.updateAgentSession(id, input.title)
      notify({ groupId: session.groupId, reason: 'group' })
      return session
    }
  )
  ipcMain.handle(
    'collaboration:listAgentSessionMessages',
    (_event, sessionId: string, afterCreatedAt?: number) =>
      afterCreatedAt === undefined
        ? store.listRecentAgentSessionMessages(sessionId, 1_000)
        : store.listAgentSessionMessages(sessionId, afterCreatedAt)
  )
  ipcMain.handle('collaboration:listEvents', (_event, groupId: string, afterSeq?: number) =>
    afterSeq === undefined ? store.listRecentEvents(groupId) : store.listEvents(groupId, afterSeq)
  )
  ipcMain.handle('collaboration:createGroup', (_event, input: CreateCollaborationGroupInput) => {
    const detail = store.createGroup(input)
    notify({ groupId: detail.group.id, reason: 'group' })
    return detail
  })
  ipcMain.handle(
    'collaboration:updateGroup',
    (_event, id: string, input: UpdateCollaborationGroupInput) => {
      const group = store.updateGroup(id, input)
      notify({ groupId: id, reason: 'group' })
      return group
    }
  )
  ipcMain.handle('collaboration:deleteGroup', (_event, id: string) => {
    const mission = store.getActiveMission(id)
    if (mission) supervisor?.stop(mission.id)
    store.deleteGroup(id)
    notify({ groupId: id, reason: 'group' })
  })
  ipcMain.handle(
    'collaboration:addParticipant',
    (_event, input: AddCollaborationParticipantInput) => {
      const participant = store.addParticipant(input)
      notify({ groupId: input.groupId, reason: 'participant' })
      return participant
    }
  )
  ipcMain.handle(
    'collaboration:removeParticipant',
    (_event, groupId: string, participantId: string) => {
      store.removeParticipant(groupId, participantId)
      notify({ groupId, reason: 'participant' })
    }
  )
  ipcMain.handle(
    'collaboration:updateParticipant',
    (_event, participantId: string, input: UpdateCollaborationParticipantInput) => {
      const participant = store.updateParticipant(participantId, input)
      notify({ groupId: participant.groupId, reason: 'participant' })
      return participant
    }
  )
  ipcMain.handle(
    'collaboration:updateParticipants',
    (_event, input: UpdateCollaborationParticipantsInput) => {
      const participants = store.updateParticipants(input)
      notify({ groupId: input.groupId, reason: 'participant' })
      return participants
    }
  )
  ipcMain.handle('collaboration:sendMessage', (event, input: SendCollaborationMessageInput) => {
    supervisor?.assertGroupWritable(input.groupId)
    const result = store.sendUserMessage(input)
    notify({ groupId: input.groupId, reason: 'event' })
    if (result.mission.status === 'paused') supervisor?.resume(result.mission.id, event.sender)
    else {
      supervisor?.start(result.mission.id, event.sender, result.event.payload.targetParticipantIds)
    }
    return result
  })
  ipcMain.handle('collaboration:rewriteMessage', (event, input: RewriteCollaborationMessageInput) =>
    supervisor?.rewriteMessage(input, event.sender)
  )
  ipcMain.handle('collaboration:pauseMission', (_event, missionId: string) =>
    supervisor?.pause(missionId)
  )
  ipcMain.handle('collaboration:resumeMission', (event, missionId: string) =>
    supervisor?.resume(missionId, event.sender)
  )
  ipcMain.handle('collaboration:stopMission', (_event, missionId: string) =>
    supervisor?.stop(missionId)
  )
  ipcMain.handle(
    'collaboration:stopParticipant',
    (_event, missionId: string, participantId: string) =>
      supervisor?.stopParticipant(missionId, participantId)
  )
}

export function shutdownCollaboration(): void {
  supervisor?.shutdown()
  supervisor = null
}

export function hasActiveCollaborationWork(): boolean {
  return supervisor?.hasActiveWork() ?? false
}
