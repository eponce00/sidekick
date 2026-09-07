import { app, BrowserWindow, ipcMain } from 'electron'
import type {
  BrowserHumanTakeoverSnapshot,
  ResolveAgentInteractionInput,
  ReplacePromptAdmissionsInput,
  StartConversationAgentRunInput
} from '../../shared/agentRunApi'
import type { BrowserHumanTakeoverResult } from '../services/nativeBrowserSessionService'
import { AgentRuntimeCoordinator } from '../services/agentRuntimeCoordinator'
import { AgentEngineClient, LocalAgentEngineTransport } from '../services/agentEngineTransport'
import { PromptAdmissionStore } from '../services/promptAdmissionStore'
import { getDb } from './state'
import { mountBrowserView, unmountBrowserHost } from '../services/browserViewHost'
import type { BrowserWorkspaceRequest } from '../../shared/browserWorkspace'
import { clipBrowserPanelBounds } from '../../shared/browserPanelBounds'
import { ProjectStore } from '../services/projectStore'
import { createDesktopEventPublisher } from './desktopEventPublisher'
import {
  CONVERSATION_GOAL_MAX_LENGTH,
  type CreateConversationGoalInput,
  type UpdateConversationGoalInput
} from '../../shared/conversationGoals'

let coordinator: AgentRuntimeCoordinator | null = null
let engineClient: AgentEngineClient | null = null
const publishDesktopEvent = createDesktopEventPublisher(() => BrowserWindow.getAllWindows())

function publish(event: import('../../shared/agentRuntime').AgentRunEvent): void {
  publishDesktopEvent('agentRuns:event', { event })
}

function publishGoal(goal: import('../../shared/conversationGoals').ConversationGoal): void {
  publishDesktopEvent('conversationGoals:changed', { goal })
}

export function getAgentRuntimeCoordinator(): AgentRuntimeCoordinator {
  if (!coordinator) {
    coordinator = new AgentRuntimeCoordinator(
      getDb(),
      app.getPath('userData'),
      publish,
      publishGoal,
      { pdfOutputRoot: app.getPath('downloads') }
    )
  }
  return coordinator
}

function getAgentEngineClient(): AgentEngineClient {
  if (!engineClient) {
    engineClient = new AgentEngineClient(
      new LocalAgentEngineTransport(getAgentRuntimeCoordinator())
    )
  }
  return engineClient
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

function publicBrowserTakeover(
  conversationId: string,
  result: BrowserHumanTakeoverResult
): BrowserHumanTakeoverSnapshot {
  const observation = result.observation
  return {
    active: result.active,
    conversationId,
    sessionId: observation.sessionId,
    pageTitle: observation.tab.title,
    url: observation.tab.url,
    humanVerificationRequired: observation.humanVerification?.required === true,
    ...(observation.humanVerification?.message
      ? { message: observation.humanVerification.message }
      : {}),
    ...(observation.screenshot
      ? {
          screenshot: {
            id: observation.screenshot.id,
            url: observation.screenshot.url,
            kind: observation.screenshot.kind,
            width: observation.screenshot.width,
            height: observation.screenshot.height
          }
        }
      : {})
  }
}

function browserTakeoverScope(interactionId: unknown): {
  runtime: AgentRuntimeCoordinator
  conversationId: string
  browserSessionId: string
} {
  if (!validId(interactionId)) throw new Error('Invalid browser takeover interaction')
  const runtime = getAgentRuntimeCoordinator()
  const interaction = runtime.store.getInteraction(interactionId)
  if (
    !interaction ||
    interaction.status !== 'pending' ||
    interaction.kind !== 'question' ||
    interaction.request.intent !== 'browser_takeover'
  ) {
    throw new Error('Browser takeover interaction is not pending')
  }
  const run = runtime.store.get(interaction.runId)
  if (!run) throw new Error('Browser takeover run is unavailable')
  const browserSessionId = interaction.request.browserSessionId
  if (!validId(browserSessionId)) throw new Error('Browser takeover session is unavailable')
  return { runtime, conversationId: run.threadId, browserSessionId }
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

function validateAdmissions(value: unknown): ReplacePromptAdmissionsInput {
  const input = value as ReplacePromptAdmissionsInput
  if (!input || !validId(input.conversationId) || !Array.isArray(input.queued)) {
    throw new Error('Invalid prompt admissions')
  }
  const items = [...input.queued, ...(input.pivot ? [input.pivot] : [])]
  if (
    items.length > 100 ||
    items.some(
      (item) =>
        !item ||
        !validId(item.id) ||
        typeof item.content !== 'string' ||
        item.content.length > 1_000_000 ||
        !['conversation', 'research', 'plan'].includes(item.mode) ||
        (item.images !== undefined && !Array.isArray(item.images))
    )
  ) {
    throw new Error('Invalid prompt admissions')
  }
  return input
}

export function registerAgentRunHandlers(): void {
  ipcMain.handle('agentRuns:browserWorkspace', async (event, input: BrowserWorkspaceRequest) => {
    const host = BrowserWindow.fromWebContents(event.sender)
    if (
      !host ||
      host.webContents !== event.sender ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error('Browser controls are only available from the app window')
    }
    if (
      !input ||
      !validId(input.conversationId) ||
      ![
        'state',
        'mount',
        'unmount',
        'control',
        'resume',
        'url',
        'back',
        'forward',
        'reload',
        'new',
        'select',
        'close'
      ].includes(input.action)
    ) {
      throw new Error('Invalid browser workspace request')
    }
    const manager = getAgentRuntimeCoordinator().tools.browser
    if (input.action === 'unmount') {
      unmountBrowserHost(host)
      return null
    }
    if (!manager) return null
    if (input.action === 'state' || input.action === 'mount') {
      const state = manager.workspaceState(input.conversationId)
      if (input.action === 'mount') {
        const zoom = event.sender.getZoomFactor()
        const b = input.bounds && {
          x: input.bounds.x * zoom,
          y: input.bounds.y * zoom,
          width: input.bounds.width * zoom,
          height: input.bounds.height * zoom
        }
        const [width, height] = host.getContentSize()
        if (
          !b ||
          !Object.values(b).every(Number.isFinite) ||
          b.x < 0 ||
          b.y < 0 ||
          b.width <= 0 ||
          b.height <= 0
        )
          throw new Error('Invalid browser panel bounds')
        const tab = state?.tabs.find((item) => item.active)
        // A renderer snapshot can arrive after a host resize/zoom. Keep native
        // content inside the current host instead of rejecting valid stale layout.
        const clipped = clipBrowserPanelBounds(b, width, height)
        if (tab && clipped)
          mountBrowserView(tab.webContentsId, host, clipped, () =>
            manager.claimUserControl(input.conversationId)
          )
        else unmountBrowserHost(host)
      }
      return (
        state && {
          ...state,
          tabs: state.tabs.map(({ id, title, url, active, loading }) => ({
            id,
            title,
            url,
            active,
            loading
          }))
        }
      )
    }
    if (
      !manager.workspaceState(input.conversationId) &&
      (input.action === 'url' || input.action === 'new')
    ) {
      const context = new ProjectStore(getDb()).getConversationContext(input.conversationId)
      const { lease } = await manager.open(
        input.conversationId,
        `browser-${input.conversationId}`,
        input.url || 'about:blank',
        undefined,
        context.workspaceRoot ? [context.workspaceRoot] : [],
        new AbortController().signal
      )
      await lease.release()
      manager.claimUserControl(input.conversationId)
      const state = manager.workspaceState(input.conversationId)
      return (
        state && {
          ...state,
          tabs: state.tabs.map(({ id, title, url, active, loading }) => ({
            id,
            title,
            url,
            active,
            loading
          }))
        }
      )
    }
    const result = await manager.workspaceAction(input.conversationId, input)
    return (
      result && {
        ...result,
        tabs: result.tabs.map(({ id, title, url, active, loading }) => ({
          id,
          title,
          url,
          active,
          loading
        }))
      }
    )
  })
  const engine = getAgentEngineClient()
  const admissions = new PromptAdmissionStore(getDb())
  ipcMain.handle('agentRuns:startConversation', async (_event, raw: unknown) => ({
    run: await engine.request<import('../../shared/agentRuntime').AgentRunSnapshot>({
      type: 'run.startConversation',
      input: validateStart(raw)
    })
  }))
  ipcMain.handle('agentRuns:stop', async (_event, runId: string) => ({
    stopped:
      typeof runId === 'string' && (await engine.request<boolean>({ type: 'run.stop', runId }))
  }))
  ipcMain.handle('agentRuns:events', (_event, runId: string, afterSequence?: number) =>
    engine.request<import('../../shared/agentRunApi').AgentRunEventsResult>({
      type: 'run.events',
      runId,
      afterSequence
    })
  )
  ipcMain.handle('agentRuns:latest', (_event, threadId: string) =>
    engine.request<import('../../shared/agentRunApi').AgentRunEventsResult>({
      type: 'run.latest',
      threadId
    })
  )
  ipcMain.handle('agentRuns:browserTakeoverBegin', async (_event, interactionId: string) => {
    const { runtime, conversationId, browserSessionId } = browserTakeoverScope(interactionId)
    return publicBrowserTakeover(
      conversationId,
      await runtime.tools.beginBrowserHumanTakeover(conversationId, browserSessionId)
    )
  })
  ipcMain.handle('agentRuns:browserTakeoverComplete', async (_event, interactionId: string) => {
    const { runtime, conversationId, browserSessionId } = browserTakeoverScope(interactionId)
    return publicBrowserTakeover(
      conversationId,
      await runtime.tools.completeBrowserHumanTakeover(conversationId, browserSessionId)
    )
  })
  ipcMain.handle(
    'agentRuns:resolveInteraction',
    async (_event, input: ResolveAgentInteractionInput) => {
      if (!input || typeof input.interactionId !== 'string' || !input.interactionId) {
        throw new Error('Invalid interaction response')
      }
      return engine.request<{ success: true }>({ type: 'run.resolveInteraction', input })
    }
  )
  ipcMain.handle('agentRuns:admissionsList', (_event, conversationId: string) => {
    if (!validId(conversationId)) throw new Error('Invalid conversation')
    return admissions.list(conversationId)
  })
  ipcMain.handle('agentRuns:admissionsReplace', (_event, input: ReplacePromptAdmissionsInput) => {
    return admissions.replace(validateAdmissions(input))
  })
  ipcMain.handle('agentRuns:admissionsTakeNext', (_event, conversationId: string) => {
    if (!validId(conversationId)) throw new Error('Invalid conversation')
    return admissions.takeNext(conversationId)
  })
  ipcMain.handle('conversationGoals:current', (_event, conversationId: string) =>
    validId(conversationId)
      ? engine.request<import('../../shared/conversationGoals').ConversationGoal | null>({
          type: 'goal.current',
          conversationId
        })
      : null
  )
  ipcMain.handle('conversationGoals:create', (_event, input: unknown) =>
    engine.request<import('../../shared/conversationGoals').ConversationGoal>({
      type: 'goal.create',
      input: validateGoalCreate(input)
    })
  )
  ipcMain.handle('conversationGoals:edit', (_event, input: unknown) =>
    engine.request<import('../../shared/conversationGoals').ConversationGoal>({
      type: 'goal.edit',
      input: validateGoalEdit(input)
    })
  )
  ipcMain.handle('conversationGoals:pause', (_event, goalId: string) => {
    if (!validId(goalId)) throw new Error('Invalid goal')
    return engine.request({ type: 'goal.pause', goalId })
  })
  ipcMain.handle('conversationGoals:resume', (_event, goalId: string) => {
    if (!validId(goalId)) throw new Error('Invalid goal')
    return engine.request({ type: 'goal.resume', goalId })
  })
  ipcMain.handle('conversationGoals:clear', (_event, goalId: string) => {
    if (!validId(goalId)) throw new Error('Invalid goal')
    return engine.request({ type: 'goal.clear', goalId })
  })
}

export async function shutdownAgentRuntime(): Promise<void> {
  const current = coordinator
  const client = engineClient
  coordinator = null
  engineClient = null
  if (client) await client.request({ type: 'engine.close' })
  else await current?.close()
}

export function hasActiveAgentWork(): boolean {
  return coordinator?.hasActiveRuns() ?? false
}
