import { app, BrowserWindow, ipcMain, webContents, type IpcMainInvokeEvent } from 'electron'
import { createAppControlHandlers, openProviderKeyPrompt } from '../control/controlService'
import type {
  ResolveAgentInteractionInput,
  ReplacePromptAdmissionsInput,
  StartConversationAgentRunInput,
  SteerConversationRunInput,
  SteerConversationRunResult
} from '../../shared/agentRunApi'
import { AgentRuntimeCoordinator } from '../services/agentRuntimeCoordinator'
import { AgentEngineClient, LocalAgentEngineTransport } from '../services/agentEngineTransport'
import { PromptAdmissionStore } from '../services/promptAdmissionStore'
import { getDb } from './state'
import { conversationCredentialContext, openCredentialEditor } from './credentials'
import { getCredentialVault } from '../services/credentialVaultInstance'
import { CredentialUses } from '../services/credentialUses'
import { getManagedWorktrees } from './worktrees'
import {
  browserAgentInput,
  browserViewPlacement,
  browserViewZoom,
  stepBrowserViewZoom,
  isBrowserParkingWindow,
  mountBrowserView,
  unmountBrowserHost
} from '../services/browserViewHost'
import {
  MAX_BROWSER_FIND_CHARACTERS,
  type BrowserAnnotationsChange,
  type BrowserWorkspaceRequest,
  type BrowserWorkspaceState
} from '../../shared/browserWorkspace'
import { BrowserAnnotationController } from '../services/browserAnnotations'
import { createBrowserAnnotationOverlay } from '../services/browserAnnotationOverlay'
import { findInBrowserPage } from '../services/browserPageFind'
import { MAX_BROWSER_ANNOTATION_NOTE_CHARACTERS } from '../../shared/messageContextAttachments'
import { clipBrowserPanelBounds } from '../../shared/browserPanelBounds'
import { ProjectStore } from '../services/projectStore'
import { createDesktopEventPublisher } from './desktopEventPublisher'
import { MAX_TERMINAL_INPUT_LENGTH } from '../../shared/terminalSessions'
import { validateMessageImages } from '../../shared/messageImages'
import {
  CONVERSATION_GOAL_MAX_LENGTH,
  type CreateConversationGoalInput,
  type UpdateConversationGoalInput
} from '../../shared/conversationGoals'
import { isBrowserZoomStep } from '../../shared/browserZoom'
import { ensureChatFolder } from '../services/chatFolders'

let coordinator: AgentRuntimeCoordinator | null = null
let engineClient: AgentEngineClient | null = null
const publishDesktopEvent = createDesktopEventPublisher(() => BrowserWindow.getAllWindows())
const preparationObservers = new Set<(threadId: string) => void>()

const runEventObservers = new Set<
  (event: import('../../shared/agentRuntime').AgentRunEvent) => void
>()

/** Lets another main-process service follow run events, such as the scheduler. */
export function observeAgentRunEvents(
  observer: (event: import('../../shared/agentRuntime').AgentRunEvent) => void
): () => void {
  runEventObservers.add(observer)
  return () => runEventObservers.delete(observer)
}

const admissionObservers = new Set<(conversationId: string) => void>()

/** Lets another service hear when the window changes a chat's queued messages. */
export function observeAdmissionChanges(observer: (conversationId: string) => void): () => void {
  admissionObservers.add(observer)
  return () => admissionObservers.delete(observer)
}

function admissionsChanged(conversationId: string): void {
  for (const observer of admissionObservers) {
    try {
      observer(conversationId)
    } catch (error) {
      console.warn('[AgentRuntime] An admission observer failed:', error)
    }
  }
}

/** Lets a service hear when a run starts or stops preparing, which publishes no run event. */
export function observeAgentRunPreparations(observer: (threadId: string) => void): () => void {
  preparationObservers.add(observer)
  return () => preparationObservers.delete(observer)
}

function publishPreparation(threadId: string): void {
  for (const observer of preparationObservers) {
    try {
      observer(threadId)
    } catch (error) {
      console.warn('[AgentRuntime] A preparation observer failed:', error)
    }
  }
}

function publish(event: import('../../shared/agentRuntime').AgentRunEvent): void {
  for (const observer of runEventObservers) {
    try {
      observer(event)
    } catch (error) {
      console.warn('[AgentRuntime] A run event observer failed:', error)
    }
  }
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
      {
        pdfOutputRoot: app.getPath('downloads'),
        publishTerminal: (event) => publishDesktopEvent('terminal:event', event),
        publishArtifactDraft: (draft) => publishDesktopEvent('agentRuns:artifactDraft', draft),
        onPreparationChange: publishPreparation,
        prepareWorkspace: (conversationId) =>
          getManagedWorktrees().prepareConversation(conversationId)
      }
    )
    coordinator.tools.setAppSettings({
      control: createAppControlHandlers("SideKick's agent"),
      openProviderKeyPrompt
    })
    const useContext = (conversationId: string | undefined) =>
      conversationCredentialContext(getDb(), conversationId)
    coordinator.tools.setCredentials({
      list: () => getCredentialVault().list(),
      useContext,
      openEditor: openCredentialEditor,
      uses: new CredentialUses(getCredentialVault(), useContext)
    })
  }
  return coordinator
}

/** The runtime if it has started; reading status must not start it. */
export function existingAgentRuntimeCoordinator(): AgentRuntimeCoordinator | null {
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

/** Starts a conversation run on the same engine path the renderer's chat uses. */
export function startConversationRun(
  input: StartConversationAgentRunInput
): Promise<import('../../shared/agentRuntime').AgentRunSnapshot> {
  return getAgentEngineClient().request<import('../../shared/agentRuntime').AgentRunSnapshot>({
    type: 'run.startConversation',
    input
  })
}

/**
 * Starts a run from the main process and returns once it is admitted, working or waiting for a
 * run slot. A later failure to start is recorded on the run.
 */
export function startConversationInBackground(
  input: StartConversationAgentRunInput
): Promise<{ queued: boolean }> {
  return getAgentEngineClient().request<{ queued: boolean }>({
    type: 'run.startConversationInBackground',
    input
  })
}

/** The panel's view of a conversation's browser: no WebContents ids, and the active tab's zoom. */
function publicWorkspaceState<
  T extends {
    tabs: Array<{
      id: string
      title: string
      url: string
      active: boolean
      loading: boolean
      webContentsId: number
    }>
  }
>(state: T): Omit<T, 'tabs'> & { tabs: BrowserWorkspaceState['tabs']; zoom: number } {
  const active = state.tabs.find((tab) => tab.active)
  return {
    ...state,
    tabs: state.tabs.map(({ id, title, url, active, loading }) => ({
      id,
      title,
      url,
      active,
      loading
    })),
    zoom: active ? browserViewZoom(active.webContentsId) : 100
  }
}

let annotations: BrowserAnnotationController | undefined

/** The marks users make on browser pages, until each is sent with a message. */
function browserAnnotations(): BrowserAnnotationController {
  annotations ??= new BrowserAnnotationController({
    page: (conversationId) => {
      const manager = getAgentRuntimeCoordinator().tools.browser
      const sessionId = manager?.sessionFor(conversationId)
      if (!manager || !sessionId) return undefined
      try {
        return manager.service.annotationPage(sessionId)
      } catch {
        return undefined
      }
    },
    placement: browserViewPlacement,
    overlay: createBrowserAnnotationOverlay,
    scroll: (conversationId, webContentsId, input) => {
      // The wheel is the user's own input on the page, so it waits for an agent action like a click.
      const manager = getAgentRuntimeCoordinator().tools.browser
      if (!manager?.claimUserControl(conversationId)) return
      const sessionId = manager.sessionFor(conversationId)
      const placement = browserViewPlacement(webContentsId)
      if (!sessionId || !placement || !(placement.scale > 0)) return
      let page: ReturnType<typeof manager.service.annotationPage>
      try {
        page = manager.service.annotationPage(sessionId)
      } catch {
        return
      }
      if (!page || page.webContentsId !== webContentsId) return
      const send = page.send
      // A wheel at that point through the page's debugger, so Chromium scrolls whatever is under
      // it, an inner list included, as the user's own wheel would. The overlay reports it in the
      // page's own sign, in window pixels; the page takes CSS pixels.
      void browserAgentInput(webContentsId, () =>
        send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: input.x / placement.scale,
          y: input.y / placement.scale,
          deltaX: input.deltaX / placement.scale,
          deltaY: input.deltaY / placement.scale
        })
      ).catch(() => undefined)
    },
    notify: (change: BrowserAnnotationsChange) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !isBrowserParkingWindow(window))
          window.webContents.send('agentRuns:browserAnnotationsChanged', change)
      }
    }
  })
  return annotations
}

/** Browser controls answer only the app window's own document. */
function browserControlHost(event: IpcMainInvokeEvent): BrowserWindow {
  const host = BrowserWindow.fromWebContents(event.sender)
  if (!host || host.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Browser controls are only available from the app window')
  }
  return host
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
    (input.mode !== undefined && !['conversation', 'research', 'plan'].includes(input.mode)) ||
    (input.continuesRunId !== undefined && !validId(input.continuesRunId)) ||
    (input.workspaceSharing !== undefined && input.workspaceSharing !== 'allow')
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
  // A steered message's images go into the run's journal and to the model as they are stored.
  const withImages = <T extends ReplacePromptAdmissionsInput['queued'][number]>(item: T): T => {
    const images = validateMessageImages(item.images)
    return { ...item, images: images.length ? images : undefined }
  }
  return {
    ...input,
    queued: input.queued.map(withImages),
    pivot: input.pivot ? withImages(input.pivot) : input.pivot
  }
}

export function registerAgentRunHandlers(): void {
  ipcMain.handle(
    'agentRuns:browserWorkspace',
    async (event, input: BrowserWorkspaceRequest): Promise<BrowserWorkspaceState | null> => {
      const state = await browserWorkspace(event, input)
      return state && { ...state, ...browserAnnotations().panelState(input.conversationId) }
    }
  )
  ipcMain.handle(
    'agentRuns:browserAnnotations',
    (event, input: { conversationId?: unknown; action?: unknown; ids?: unknown }) => {
      browserControlHost(event)
      if (!input || !validId(input.conversationId)) throw new Error('Invalid annotation request')
      if (input.action === 'list') return browserAnnotations().list(input.conversationId)
      if (
        input.action !== 'take' ||
        !Array.isArray(input.ids) ||
        input.ids.length > 32 ||
        !input.ids.every(validId)
      )
        throw new Error('Invalid annotation request')
      return browserAnnotations().take(input.conversationId, input.ids)
    }
  )
  const browserWorkspace = async (event: IpcMainInvokeEvent, input: BrowserWorkspaceRequest) => {
    const host = browserControlHost(event)
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
        'close',
        'device',
        'snapshot',
        'annotate',
        'annotationNote',
        'annotationRemove',
        'annotationDictation',
        'zoom',
        'print',
        'find',
        'screenshot'
      ].includes(input.action) ||
      (input.zoomStep !== undefined && !isBrowserZoomStep(input.zoomStep)) ||
      (input.annotate !== undefined && typeof input.annotate !== 'boolean') ||
      (input.theme !== undefined && input.theme !== 'dark' && input.theme !== 'light') ||
      (input.canDictate !== undefined && typeof input.canDictate !== 'boolean') ||
      (input.dictation !== undefined &&
        (typeof input.dictation?.listening !== 'boolean' ||
          (input.dictation.text !== undefined &&
            (typeof input.dictation.text !== 'string' ||
              input.dictation.text.length > MAX_BROWSER_ANNOTATION_NOTE_CHARACTERS)) ||
          (input.dictation.final !== undefined && typeof input.dictation.final !== 'boolean'))) ||
      [input.accent, input.accentText].some(
        (color) => color !== undefined && (typeof color !== 'string' || color.length > 64)
      ) ||
      (input.annotationId !== undefined && !validId(input.annotationId)) ||
      (input.note !== undefined &&
        (typeof input.note !== 'string' ||
          input.note.length > MAX_BROWSER_ANNOTATION_NOTE_CHARACTERS)) ||
      (input.find !== undefined &&
        (typeof input.find?.text !== 'string' ||
          input.find.text.length > MAX_BROWSER_FIND_CHARACTERS ||
          (input.find.forward !== undefined && typeof input.find.forward !== 'boolean') ||
          (input.find.next !== undefined && typeof input.find.next !== 'boolean'))) ||
      (input.device !== undefined && typeof input.device !== 'string')
    ) {
      throw new Error('Invalid browser workspace request')
    }
    const manager = getAgentRuntimeCoordinator().tools.browser
    if (input.action === 'unmount') {
      unmountBrowserHost(host)
      void browserAnnotations().hideHost(host)
      return null
    }
    if (!manager) return null
    if (
      input.action === 'annotate' ||
      input.action === 'annotationNote' ||
      input.action === 'annotationRemove' ||
      input.action === 'annotationDictation'
    ) {
      const marks = browserAnnotations()
      if (input.action === 'annotationDictation') {
        if (input.dictation) marks.dictated(input.conversationId, input.dictation)
      } else if (input.action === 'annotate')
        marks.setAnnotating(input.conversationId, input.annotate === true, {
          accent: input.accent,
          accentText: input.accentText,
          theme: input.theme,
          canDictate: input.canDictate
        })
      else if (!input.annotationId) throw new Error('Invalid browser workspace request')
      else if (input.action === 'annotationNote')
        marks.setNote(input.conversationId, input.annotationId, input.note ?? '')
      else marks.remove(input.conversationId, input.annotationId)
      const state = manager.workspaceState(input.conversationId)
      return state && publicWorkspaceState(state)
    }
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
        if (tab && clipped) {
          mountBrowserView(
            tab.webContentsId,
            host,
            clipped,
            () => manager.claimUserControl(input.conversationId),
            // The page renders at 100%, like a browser window, not at the app interface zoom.
            1
          )
          void browserAnnotations().sync(host, input.conversationId, tab.webContentsId)
        } else {
          unmountBrowserHost(host)
          void browserAnnotations().hideHost(host)
        }
      }
      return state && publicWorkspaceState(state)
    }
    if (
      !manager.workspaceState(input.conversationId) &&
      (input.action === 'url' || input.action === 'new')
    ) {
      const context = new ProjectStore(getDb()).getConversationContext(input.conversationId)
      if (context.chatFolder && context.workspaceRoot) ensureChatFolder(context.workspaceRoot)
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
      return state && publicWorkspaceState(state)
    }
    if (input.action === 'zoom') {
      const state = manager.workspaceState(input.conversationId)
      const tab = state?.tabs.find((item) => item.active)
      if (!state || !tab || !input.zoomStep) return state && publicWorkspaceState(state)
      stepBrowserViewZoom(tab.webContentsId, input.zoomStep)
      return publicWorkspaceState(state)
    }
    if (
      input.action === 'snapshot' ||
      input.action === 'print' ||
      input.action === 'find' ||
      input.action === 'screenshot'
    ) {
      const state = manager.workspaceState(input.conversationId)
      const activeTab = state?.tabs.find((tab) => tab.active)
      const page = activeTab ? webContents.fromId(activeTab.webContentsId) : undefined
      if (!state || !activeTab || !page || page.isDestroyed())
        return state && publicWorkspaceState(state)
      const result = publicWorkspaceState(state)
      if (input.action === 'print') {
        page.print()
        return result
      }
      if (input.action === 'find') {
        const sessionId = manager.sessionFor(input.conversationId)
        let cdp: ReturnType<typeof manager.service.annotationPage> | undefined
        try {
          cdp = sessionId ? manager.service.annotationPage(sessionId) : undefined
        } catch {
          return result
        }
        if (cdp?.webContentsId !== activeTab.webContentsId) return result
        const found = await findInBrowserPage(cdp, input.find)
        return { ...result, ...(found ? { found } : {}) }
      }
      if (input.action === 'screenshot') {
        const marks = browserAnnotations()
        marks.setAnnotating(input.conversationId, true, {
          accent: input.accent,
          accentText: input.accentText,
          theme: input.theme,
          canDictate: input.canDictate
        })
        await marks.sync(host, input.conversationId, activeTab.webContentsId)
        await marks.screenshot(input.conversationId)
        const next = manager.workspaceState(input.conversationId)
        return next && publicWorkspaceState(next)
      }
      // The page is drawn above the app, so SideKick's menu or popover would open under it. The
      // panel shows a picture of the page instead while either is open, and the page hides.
      const snapshot = await page
        .capturePage()
        .then((image) => (image.isEmpty() ? undefined : image.toDataURL()))
        .catch(() => undefined)
      return { ...result, ...(snapshot ? { snapshot } : {}) }
    }
    const result = await manager.workspaceAction(input.conversationId, input)
    return result && publicWorkspaceState(result)
  }
  const engine = getAgentEngineClient()
  const admissions = new PromptAdmissionStore(getDb())
  ipcMain.handle('agentRuns:startConversation', async (_event, raw: unknown) => ({
    run: await engine.request<import('../../shared/agentRuntime').AgentRunSnapshot>({
      type: 'run.startConversation',
      input: validateStart(raw)
    })
  }))
  ipcMain.handle('agentRuns:workspaceOccupants', (_event, conversationId: unknown) => {
    if (!validId(conversationId)) throw new Error('Invalid conversation ID')
    return engine.request<import('../../shared/worktrees').WorkspaceOccupant[]>({
      type: 'workspace.occupants',
      conversationId
    })
  })
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
  ipcMain.handle(
    'agentRuns:resolveInteraction',
    async (_event, input: ResolveAgentInteractionInput) => {
      if (!input || typeof input.interactionId !== 'string' || !input.interactionId) {
        throw new Error('Invalid interaction response')
      }
      return engine.request<{ success: true }>({ type: 'run.resolveInteraction', input })
    }
  )
  ipcMain.handle('agentRuns:steer', (_event, input: SteerConversationRunInput) => {
    if (!input || !validId(input.runId) || !validId(input.admissionId)) {
      throw new Error('Invalid steer request')
    }
    return engine.request<SteerConversationRunResult>({
      type: 'run.steer',
      input: { runId: input.runId, admissionId: input.admissionId }
    })
  })
  ipcMain.handle('agentRuns:admissionsList', (_event, conversationId: string) => {
    if (!validId(conversationId)) throw new Error('Invalid conversation')
    return admissions.list(conversationId)
  })
  ipcMain.handle('agentRuns:admissionsReplace', (_event, input: ReplacePromptAdmissionsInput) => {
    const result = admissions.replace(validateAdmissions(input))
    admissionsChanged(input.conversationId)
    return result
  })
  ipcMain.handle('agentRuns:admissionsTakeNext', (_event, conversationId: string) => {
    if (!validId(conversationId)) throw new Error('Invalid conversation')
    const next = admissions.takeNext(conversationId)
    if (next) admissionsChanged(conversationId)
    return next
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

  // The user's own controls over agent commands: watch, stop, background, type.
  const commands = (): import('../services/commandService').CommandService =>
    getAgentRuntimeCoordinator().commands
  ipcMain.handle('terminal:list', (_event, conversationId: unknown) =>
    validId(conversationId) ? commands().terminals.list(conversationId) : []
  )
  ipcMain.handle('terminal:read', (_event, id: unknown, offset: unknown) => {
    if (!validId(id)) return null
    const start = typeof offset === 'number' && Number.isFinite(offset) ? Math.max(0, offset) : 0
    return commands().terminals.read(id, start) ?? null
  })
  ipcMain.handle('terminal:stop', (_event, id: unknown) => ({
    stopped: validId(id) && commands().stopByUser(id)
  }))
  ipcMain.handle('terminal:moveToBackground', (_event, id: unknown) => ({
    moved: validId(id) && commands().moveToBackground(id)
  }))
  ipcMain.handle('terminal:write', (_event, id: unknown, data: unknown) => ({
    written:
      validId(id) &&
      typeof data === 'string' &&
      data.length > 0 &&
      data.length <= MAX_TERMINAL_INPUT_LENGTH &&
      commands().write(id, data)
  }))
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

export function activeAgentConversationCount(): number {
  return coordinator?.activeThreadIds().length ?? 0
}
