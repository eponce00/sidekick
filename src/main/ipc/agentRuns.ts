import { app, BrowserWindow, ipcMain } from 'electron'
import type {
  ResolveAgentInteractionInput,
  StartConversationAgentRunInput
} from '../../shared/agentRunApi'
import { AgentRuntimeCoordinator } from '../services/agentRuntimeCoordinator'
import { getDb } from './state'
import {
  CONVERSATION_GOAL_MAX_LENGTH,
  type CreateConversationGoalInput,
  type UpdateConversationGoalInput
} from '../../shared/conversationGoals'

let coordinator: AgentRuntimeCoordinator | null = null

function publish(event: import('../../shared/agentRuntime').AgentRunEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('agentRuns:event', { event })
  }
}

function publishGoal(goal: import('../../shared/conversationGoals').ConversationGoal): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('conversationGoals:changed', { goal })
  }
}

export function getAgentRuntimeCoordinator(): AgentRuntimeCoordinator {
  if (!coordinator) {
    coordinator = new AgentRuntimeCoordinator(
      getDb(),
      app.getPath('userData'),
      publish,
      publishGoal
    )
  }
  return coordinator
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

function validateGoalCreate(value: unknown): CreateConversationGoalInput {
  const input = value as CreateConversationGoalInput
  if (
    !input ||
    !validId(input.conversationId) ||
    typeof input.objective !== 'string' ||
    !input.objective.trim() ||
    input.objective.length > CONVERSATION_GOAL_MAX_LENGTH
  ) {
    throw new Error('Invalid goal request')
  }
  return input
}

function validateGoalEdit(value: unknown): UpdateConversationGoalInput {
  const input = value as UpdateConversationGoalInput
  if (
    !input ||
    !validId(input.goalId) ||
    typeof input.objective !== 'string' ||
    !input.objective.trim() ||
    input.objective.length > CONVERSATION_GOAL_MAX_LENGTH
  ) {
    throw new Error('Invalid goal update')
  }
  return input
}

function validateStart(value: unknown): StartConversationAgentRunInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid agent run request')
  const input = value as StartConversationAgentRunInput
  if (
    typeof input.id !== 'string' ||
    !input.id ||
    input.id.length > 200 ||
    typeof input.conversationId !== 'string' ||
    !input.conversationId ||
    input.conversationId.length > 200 ||
    typeof input.assistantMessageId !== 'string' ||
    !input.assistantMessageId ||
    input.assistantMessageId.length > 200 ||
    !input.model ||
    typeof input.model !== 'object' ||
    typeof input.model.id !== 'string' ||
    typeof input.model.name !== 'string' ||
    typeof input.model.provider !== 'string' ||
    (input.mode !== undefined && !['conversation', 'research', 'plan'].includes(input.mode))
  ) {
    throw new Error('Invalid conversation agent run request')
  }
  if (
    input.plannerModel &&
    (typeof input.plannerModel !== 'object' ||
      typeof input.plannerModel.id !== 'string' ||
      typeof input.plannerModel.name !== 'string' ||
      typeof input.plannerModel.provider !== 'string')
  ) {
    throw new Error('Invalid planning model')
  }
  return input
}

export function registerAgentRunHandlers(): void {
  const host = getAgentRuntimeCoordinator()
  ipcMain.handle('agentRuns:startConversation', async (_event, raw: unknown) => ({
    run: await host.startConversation(validateStart(raw))
  }))
  ipcMain.handle('agentRuns:stop', (_event, runId: string) => ({
    stopped: typeof runId === 'string' && host.stop(runId)
  }))
  ipcMain.handle('agentRuns:events', (_event, runId: string, afterSequence?: number) =>
    host.events(runId, afterSequence)
  )
  ipcMain.handle('agentRuns:latest', (_event, threadId: string) => host.latest(threadId))
  ipcMain.handle('agentRuns:resolveInteraction', (_event, input: ResolveAgentInteractionInput) => {
    if (!input || typeof input.interactionId !== 'string' || !input.interactionId) {
      throw new Error('Invalid interaction response')
    }
    host.resolveInteraction(input)
    return { success: true }
  })
  ipcMain.handle('conversationGoals:current', (_event, conversationId: string) =>
    validId(conversationId) ? host.currentGoal(conversationId) : null
  )
  ipcMain.handle('conversationGoals:create', (_event, input: unknown) =>
    host.createGoal(validateGoalCreate(input))
  )
  ipcMain.handle('conversationGoals:edit', (_event, input: unknown) =>
    host.editGoal(validateGoalEdit(input))
  )
  ipcMain.handle('conversationGoals:pause', (_event, goalId: string) => {
    if (!validId(goalId)) throw new Error('Invalid goal')
    return host.pauseGoal(goalId)
  })
  ipcMain.handle('conversationGoals:resume', (_event, goalId: string) => {
    if (!validId(goalId)) throw new Error('Invalid goal')
    return host.resumeGoal(goalId)
  })
  ipcMain.handle('conversationGoals:clear', (_event, goalId: string) => {
    if (!validId(goalId)) throw new Error('Invalid goal')
    return host.clearGoal(goalId)
  })
}

export async function shutdownAgentRuntime(): Promise<void> {
  const current = coordinator
  coordinator = null
  await current?.close()
}

export function hasActiveAgentWork(): boolean {
  return coordinator?.hasActiveRuns() ?? false
}
