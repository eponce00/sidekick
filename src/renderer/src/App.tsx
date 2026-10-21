import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Copy, Minus, Moon, Settings, Square, Sun, X } from 'lucide-react'
import Sidebar from './components/Sidebar'
import ChatPanel from './components/ChatPanel'
import ActivityPanel from './components/ActivityPanel'
import SettingsModal from './components/SettingsModal'
import { applyAccentPalette } from './components/SettingsModal'
import appIconUrl from '../../../build/icon.svg?url'
import smallIconUrl from '../../../build/icon-small.svg?url'
import type { SettingsSection } from './components/SettingsModal'
import ContextIndicator from './components/ContextIndicator'
import SchedulesDialog from './components/SchedulesDialog'
import { useSchedules } from './hooks/useSchedules'
import { AppUpdateToast } from './components/AppUpdateControls'
import { ForkConversationDialog } from './components/ForkConversationDialog'
import { WorktreesDialog } from './components/WorktreesDialog'
import { AppMenuHost } from './components/AppMenuHost'
import { useManagedWorktrees } from './hooks/useManagedWorktrees'
import CommandPalette from './components/CommandPalette'
import type { TodoItem } from '../../shared/types'
import type { MoveConversationInput } from '../../shared/projects'
import type { ManagedWorktreeSummary } from '../../shared/worktrees'
import { normalizePermissionMode } from '../../shared/permissions'
import { resolveStoredToolCallLimit } from '../../shared/agentLimits'
import {
  conversationTitleVersionForSource,
  type ConversationTitleSource
} from '../../shared/conversationTitles'
import {
  migrateLegacyProviderInstances,
  pinnedModelsFromProviderInstances,
  providerInstanceForModel,
  syncLegacyProviderSettings
} from '../../shared/providerInstances'
import type { PinnedModel } from './types/models.types'
import {
  DEFAULT_TOOL_CALL_LIMIT,
  TOOL_CALL_LIMIT_POLICY_VERSION,
  type ProviderSettings,
  type Conversation,
  type Project
} from './types/app.types'
import { resolveFastModel } from './utils/fastModel'
import { isPlaceholderConversationTitle } from './utils/chatPanelHelpers'
import { switchThemeFrom } from './utils/themeTransition'
import { WrittenTitle } from './components/WrittenTitle'
import { createWelcomeSuggestions } from './utils/welcomeSuggestions'
import type { AppCommand } from '../../shared/appCommands'
import { useConversationTitleBackfill } from './hooks/useConversationTitleBackfill'
import { changedSettings } from './utils/settingsChanges'
import { useConversationPanelRegistry } from './hooks/useConversationPanelRegistry'
import { useUntouchedChatCleanup } from './hooks/useUntouchedChatCleanup'
import {
  deleteComposerDraft,
  saveComposerDraft,
  type ComposerDraft
} from './services/composerDrafts'
import { useSessionStatuses } from './hooks/useSessionStatuses'
import { attentionNotificationBody, shouldNotifyAttention } from './utils/conversationAttention'
import type { ConversationAttentionAlert } from '../../shared/conversationAttention'
import { conversationJumpIndex, matchesShortcut } from '../../shared/keyboardShortcuts'
import { buildCommandPaletteItems, latestProjectConversationId } from './utils/commandPaletteItems'
import { adjacentConversationId } from './utils/sidebarConversationOrder'
import { useVoiceState } from './hooks/useVoice'
import { toggleVoiceLoop, useVoiceLoop } from './services/voice/voiceLoop'
import {
  LAYOUT_MOTION_MS,
  PANEL_GLIDE_MS,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_WIDTH,
  activityPanelSnapWidths,
  storedActivityPanelSize,
  storedActivityPanelWidth,
  workspaceLayout,
  type ActivityPanelSize
} from './utils/activityPanelLayout'
import './styles/App.css'

const DEFAULT_SETTINGS: ProviderSettings = {
  openRouterApiKey: '',
  ollamaEndpoint: 'http://localhost:11434',
  ollamaCloudApiKey: '',
  ollamaCloudBaseUrl: 'https://ollama.com',
  lmStudioEndpoint: 'http://localhost:1234/v1',
  lmStudioApiKey: '',
  llamaCppEndpoint: 'http://localhost:8080/v1',
  focusChainEnabled: true,
  autoCompactEnabled: true,
  autoCompactThreshold: 0.8,
  notificationsEnabled: true,
  notificationSoundEnabled: false,
  ollamaThinkingEnabled: true,
  openRouterThinkingEnabled: false,
  commandPermissionMode: 'full-access',
  contentFontSize: 13,
  toolCallLimit: DEFAULT_TOOL_CALL_LIMIT
}

function getPreviewSettingsSection(): SettingsSection | null {
  const params = new URLSearchParams(window.location.search)
  if (!params.has('ui-preview')) return null

  const section = params.get('settings')
  const validSections: SettingsSection[] = [
    'providers',
    'general',
    'agent',
    'appearance',
    'integrations',
    'credentials'
  ]
  return validSections.find((item) => item === section) ?? null
}

const previewSettingsSection = getPreviewSettingsSection()

function getPreviewTheme(): 'dark' | 'light' | null {
  const params = new URLSearchParams(window.location.search)
  if (!params.has('ui-preview')) return null
  return params.get('theme') === 'light' ? 'light' : params.get('theme') === 'dark' ? 'dark' : null
}

const previewTheme = getPreviewTheme()

function normalizeSettings(settings: ProviderSettings): ProviderSettings {
  return {
    ...settings,
    contentFontSize: Math.max(12, Math.min(17, Math.round(settings.contentFontSize ?? 13))),
    commandPermissionMode: normalizePermissionMode(settings.commandPermissionMode),
    toolCallLimit: resolveStoredToolCallLimit(
      settings.toolCallLimit,
      settings.toolCallLimitVersion
    ),
    toolCallLimitVersion: TOOL_CALL_LIMIT_POLICY_VERSION
  }
}

function App(): React.JSX.Element {
  const platform = window.api.app.platform
  const isMac = platform === 'macos'
  const [isSettingsOpen, setIsSettingsOpen] = useState(previewSettingsSection !== null)
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>(
    previewSettingsSection ?? 'general'
  )

  const appCommandHandlerRef = useRef<(command: AppCommand) => void>(() => undefined)
  useEffect(() => window.api.app.onCommand((command) => appCommandHandlerRef.current(command)), [])
  const openConversationHandlerRef = useRef<(id: string) => void>(() => undefined)
  // Bumped when a notification is clicked, so the panel scrolls the reply the
  // user was told about into view instead of leaving them wherever they were.
  const [focusReplyRequest, setFocusReplyRequest] = useState<{
    conversationId: string
    at: number
  } | null>(null)
  useEffect(
    () => window.api.app.onOpenConversation((id) => openConversationHandlerRef.current(id)),
    []
  )
  // SideKick's agent asks the user to type a provider key into Settings, never into the chat.
  const [providerKeyRequest, setProviderKeyRequest] = useState<{ id: string; at: number } | null>(
    null
  )
  useEffect(
    () =>
      window.api.app.onOpenProviderKey((id) => {
        setProviderKeyRequest({ id, at: Date.now() })
        setSettingsInitialSection('providers')
        setIsSettingsOpen(true)
      }),
    []
  )
  // Likewise a credential: the user types its value into Settings.
  const [credentialRequest, setCredentialRequest] = useState<{
    value: import('../../shared/credentials').CredentialRequest
    at: number
  } | null>(null)
  useEffect(
    () =>
      window.api.app.onOpenCredential((value) => {
        setCredentialRequest({ value, at: Date.now() })
        setSettingsInitialSection('credentials')
        setIsSettingsOpen(true)
      }),
    []
  )
  const [pinnedModels, setPinnedModels] = useState<PinnedModel[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)
  const [pendingFork, setPendingFork] = useState<{
    conversationId: string
    messageId?: string
  } | null>(null)
  const [forkBusy, setForkBusy] = useState(false)
  const [forkError, setForkError] = useState<string | null>(null)
  const { worktrees, refreshWorktrees } = useManagedWorktrees()
  const [worktreesDialog, setWorktreesDialog] = useState<{ focusWorktreeId: string | null } | null>(
    null
  )
  const currentConversation = conversations.find(
    (conversation) => conversation.id === currentConversationId
  )
  const [isSchedulesOpen, setIsSchedulesOpen] = useState(false)
  const [focusChainTodosByConversation, setFocusChainTodosByConversation] = useState<
    Record<string, TodoItem[]>
  >({})
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [isActivityPanelPinned, setIsActivityPanelPinned] = useState<boolean>(() => {
    const stored = window.localStorage.getItem('activityPanelPinned')
    return stored === null ? window.innerWidth >= 1100 : stored === 'true'
  })
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    return window.localStorage.getItem('sidebarCollapsed') === 'true'
  })
  const [isCompactLayout, setIsCompactLayout] = useState(
    () => window.matchMedia('(max-width: 760px)').matches
  )
  const [isCompactActivityOpen, setIsCompactActivityOpen] = useState(false)
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  // Kept by the sidebar and the activity panel for keyboard navigation; reading
  // them never needs a render.
  const sidebarOrderRef = useRef<string[]>([])
  const activityTabRef = useRef<string | null>(null)
  const [activityTabRequest, setActivityTabRequest] = useState<{
    tab: 'browser'
    at: number
  } | null>(null)
  const voiceState = useVoiceState()
  const voiceLoop = useVoiceLoop()
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const update = (): void => setIsCompactLayout(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const effectiveActivityPanelPinned = isCompactLayout
    ? isCompactActivityOpen
    : isActivityPanelPinned
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const update = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const [activityPanelWidth, setActivityPanelWidth] = useState(() =>
    storedActivityPanelWidth(
      window.localStorage.getItem('activityPanelWidth'),
      window.innerWidth,
      window.localStorage.getItem('activityPanelSize')
    )
  )
  const [activityPanelSize, setActivityPanelSize] = useState<ActivityPanelSize>(() =>
    storedActivityPanelSize(window.localStorage.getItem('activityPanelSize'))
  )
  useEffect(() => {
    window.localStorage.setItem('activityPanelSize', activityPanelSize)
  }, [activityPanelSize])
  useEffect(() => {
    window.localStorage.setItem('activityPanelWidth', String(activityPanelWidth))
  }, [activityPanelWidth])
  // Each time the inspector's edge glides to a width, the chat is held still while it moves.
  const [panelGlide, setPanelGlide] = useState(0)
  // Where the panel floats over the chat, sizes do not apply.
  const panelSize: ActivityPanelSize = isCompactLayout ? 'wide' : activityPanelSize
  const panelIsFull = effectiveActivityPanelPinned && panelSize === 'full'
  // Opening the sidebar while it is folded for room keeps it open; the inspector narrows instead.
  const [isSidebarHeldOpen, setIsSidebarHeldOpen] = useState(false)
  const layout = workspaceLayout({
    viewportWidth,
    sidebarCollapsed: isSidebarCollapsed,
    sidebarHeldOpen: isSidebarHeldOpen,
    panelOpen: effectiveActivityPanelPinned,
    panelWidth: activityPanelWidth,
    panelSize
  })
  // A sidebar kept open for one squeeze folds again in the next, once there has been room.
  const sidebarNeedsRoom = workspaceLayout({
    viewportWidth,
    sidebarCollapsed: false,
    sidebarHeldOpen: false,
    panelOpen: effectiveActivityPanelPinned,
    panelWidth: activityPanelWidth,
    panelSize: panelSize === 'full' ? 'wide' : panelSize
  }).sidebarAutoCollapsed
  useEffect(() => {
    if (!sidebarNeedsRoom) setIsSidebarHeldOpen(false)
  }, [sidebarNeedsRoom])
  const effectiveSidebarCollapsed =
    isSidebarCollapsed || layout.sidebarAutoCollapsed || (isCompactLayout && isCompactActivityOpen)
  // When the sidebar or the inspector opens, closes or changes size, the chat's content is held at
  // its final width for the animation, centred and clipped, instead of re-wrapping every frame.
  // Dragging the inspector's edge and resizing the window still re-lay it out live.
  const collapsedPanelWidth = 48
  const sidebarTargetWidth = effectiveSidebarCollapsed ? SIDEBAR_RAIL_WIDTH : SIDEBAR_WIDTH
  const panelTargetWidth = !effectiveActivityPanelPinned
    ? collapsedPanelWidth
    : panelSize === 'full'
      ? layout.panelMaxWidth
      : Math.min(activityPanelWidth, layout.panelMaxWidth)
  // The widest the inspector fits beside the chat, with the sidebar folded for it: dragged well
  // past this, it takes the whole window.
  const panelSideBySideMax = workspaceLayout({
    viewportWidth,
    sidebarCollapsed: isSidebarCollapsed,
    sidebarHeldOpen: isSidebarHeldOpen,
    panelOpen: true,
    panelWidth: Number.MAX_SAFE_INTEGER,
    panelSize: 'wide'
  }).panelMaxWidth
  const panelSnapWidths = activityPanelSnapWidths({
    viewportWidth,
    sidebarWidth: SIDEBAR_RAIL_WIDTH,
    sideBySideMax: panelSideBySideMax
  })
  const chatTargetWidth = panelIsFull
    ? 0
    : Math.max(0, viewportWidth - sidebarTargetWidth - panelTargetWidth)
  const layoutShape = `${panelSize}|${effectiveActivityPanelPinned}|${effectiveSidebarCollapsed}|${panelGlide}`
  const [settledLayout, setSettledLayout] = useState({
    shape: layoutShape,
    chatWidth: chatTargetWidth,
    panelGlide
  })
  const [layoutMotion, setLayoutMotion] = useState<{
    chatWidth: number
    duration: number
    at: number
  } | null>(null)
  if (settledLayout.shape !== layoutShape) {
    setSettledLayout({ shape: layoutShape, chatWidth: chatTargetWidth, panelGlide })
    if (!isCompactLayout)
      setLayoutMotion({
        // A chat stepping aside for the full panel keeps the width it had while it fades.
        chatWidth: chatTargetWidth > 0 ? chatTargetWidth : settledLayout.chatWidth,
        // The inspector let go of glides a little longer than other layout changes.
        duration: settledLayout.panelGlide !== panelGlide ? PANEL_GLIDE_MS : LAYOUT_MOTION_MS,
        at: Date.now()
      })
  } else if (settledLayout.chatWidth !== chatTargetWidth) {
    setSettledLayout({ shape: layoutShape, chatWidth: chatTargetWidth, panelGlide })
  }
  useEffect(() => {
    if (!layoutMotion) return
    const timer = window.setTimeout(() => setLayoutMotion(null), layoutMotion.duration + 40)
    return () => window.clearTimeout(timer)
  }, [layoutMotion])
  const toggleSidebar = (): void => {
    if (isCompactLayout && effectiveSidebarCollapsed) {
      setIsCompactActivityOpen(false)
      setIsSidebarCollapsed(false)
      return
    }
    // Opening it is a choice to keep it open; only closing hands it back to the layout. The full
    // panel has no room for it, so opening the sidebar steps the panel back to wide.
    const opening = effectiveSidebarCollapsed
    if (opening && panelIsFull) setActivityPanelSize('wide')
    setIsSidebarHeldOpen(opening)
    setIsSidebarCollapsed(!opening)
  }
  const toggleActivityPanel = (): void => {
    if (isCompactLayout) {
      setIsCompactActivityOpen((prev) => {
        const next = !prev
        if (next) setIsSidebarCollapsed(true)
        return next
      })
      return
    }
    setIsActivityPanelPinned((prev) => !prev)
  }
  const toggleBrowserPanel = (): void => {
    if (effectiveActivityPanelPinned && activityTabRef.current === 'browser') {
      toggleActivityPanel()
      return
    }
    setActivityTabRequest({ tab: 'browser', at: Date.now() })
    if (!effectiveActivityPanelPinned) toggleActivityPanel()
  }
  const [isWindowMaximized, setIsWindowMaximized] = useState(false)
  const [isWindowFullScreen, setIsWindowFullScreen] = useState(false)
  useEffect(() => {
    if (platform === 'macos') return
    void window.api.window.isMaximized().then(setIsWindowMaximized)
    return window.api.window.onMaximizedChange(setIsWindowMaximized)
  }, [platform])
  useEffect(() => {
    if (platform !== 'macos') return
    const removeListener = window.api.window.onFullScreenChange(setIsWindowFullScreen)
    void window.api.window.isFullScreen().then(setIsWindowFullScreen)
    return removeListener
  }, [platform])
  const [tokenCounts, setTokenCounts] = useState<{ current: number; max: number }>({
    current: 0,
    max: 4096
  })
  const [conversationCost, setConversationCost] = useState<number>(0)
  const [userLocation, setUserLocation] = useState<{
    city?: string
    country?: string
    timezone?: string
  }>()
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (previewTheme) return previewTheme
    const savedTheme = window.localStorage.getItem('theme')
    return savedTheme === 'light' ? 'light' : 'dark'
  })
  const [settings, setSettings] = useState<ProviderSettings>(DEFAULT_SETTINGS)
  const [checkpointVersion, setCheckpointVersion] = useState(0)
  const [restoredHash, setRestoredHash] = useState<string | undefined>(undefined)
  const [chatRollbackHash, setChatRollbackHash] = useState<string | null>(null)
  const [isReady, setIsReady] = useState(false)
  const {
    currentConversationIdRef,
    currentConversationBusy: isAgentBusy,
    mountedConversationIds,
    conversationPanelKeys,
    draftPanelKey,
    onBusyStateChange: handleConversationBusyStateChange,
    claimDraftPanel,
    forgetPanel,
    resetPanels
  } = useConversationPanelRegistry(conversations, currentConversationId)
  useUntouchedChatCleanup({
    ready: isReady,
    conversations,
    currentConversationId,
    onDiscarded: (id) => {
      deleteComposerDraft(id)
      forgetPanel(id)
      setConversations((current) => current.filter((conversation) => conversation.id !== id))
    }
  })
  // Load settings, pinned models, and conversations on startup
  useEffect(() => {
    const loadData = async (): Promise<void> => {
      try {
        const savedSettings = await window.api.settings.load()
        const savedModels = await window.api.pinnedModels.load()
        // The main process migrated and stored these as they loaded. Saving this copy back would
        // undo any save made since it was read, such as a provider added as the window opened.
        const mergedSettings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(savedSettings || {}) })
        const providerInstances = migrateLegacyProviderInstances(mergedSettings, savedModels || [])
        const migratedSettings = syncLegacyProviderSettings({
          ...mergedSettings,
          providerInstances
        })
        const configuredModels = pinnedModelsFromProviderInstances(providerInstances)
        const legacySelection = (savedModels || []).find(
          (model) => model.id === savedSettings?.selectedModel
        )
        const selected = configuredModels.some((model) => model.id === savedSettings?.selectedModel)
          ? savedSettings?.selectedModel || ''
          : configuredModels.find(
              (model) =>
                legacySelection &&
                model.provider === legacySelection.provider &&
                model.name === legacySelection.name
            )?.id ||
            configuredModels[0]?.id ||
            ''
        migratedSettings.selectedModel = selected
        setSettings(migratedSettings)
        setPinnedModels(configuredModels)
        setSelectedModel(selected)
        if (savedSettings) {
          // Apply saved accent palette
          if (migratedSettings.accentPalette) {
            const currentTheme = document.body.dataset.theme === 'light' ? 'light' : 'dark'
            applyAccentPalette(migratedSettings.accentPalette, currentTheme)
          }
        }

        const [conversationsList, projectsList] = await Promise.all([
          window.api.conversations.list(),
          window.api.projects.list(),
          window.api.workspace.setPath(null)
        ])
        setConversations(conversationsList)
        setProjects(projectsList)

        // Local data is ready — show the app immediately
        setIsReady(true)

        // Geolocation runs in background after the app is visible
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
        if (savedSettings?.manualLocation) {
          setUserLocation({ city: savedSettings.manualLocation, timezone })
        } else {
          setUserLocation({ timezone })
        }
      } catch (error) {
        console.error('Failed to load saved data:', error)
        setIsReady(true) // show app even if something fails
      }
    }

    loadData()
  }, [])

  useEffect(
    () =>
      window.api.providers.onHealthChanged(({ providerInstanceId, health }) => {
        setPinnedModels((models) =>
          models.map((model) =>
            model.providerInstanceId === providerInstanceId
              ? { ...model, providerHealth: health }
              : model
          )
        )
      }),
    []
  )

  useEffect(() => {
    document.body.dataset.theme = theme
    window.localStorage.setItem('theme', theme)
    // Re-apply accent palette when theme changes
    if (settings.accentPalette) {
      applyAccentPalette(settings.accentPalette, theme)
    }
  }, [theme, settings.accentPalette])

  useEffect(() => {
    const size = Math.max(12, Math.min(17, Math.round(settings.contentFontSize ?? 13)))
    document.documentElement.style.setProperty('--content-text', `${size}px`)
    document.documentElement.style.setProperty(
      '--content-text-secondary',
      `${Math.max(11, size - (size > 14 ? 2 : 1))}px`
    )
  }, [settings.contentFontSize])

  useEffect(() => {
    window.localStorage.setItem('sidebarCollapsed', String(isSidebarCollapsed))
  }, [isSidebarCollapsed])

  useEffect(() => {
    window.localStorage.setItem('activityPanelPinned', String(isActivityPanelPinned))
  }, [isActivityPanelPinned])

  const handleSaveSettings = async (
    newSettings: ProviderSettings,
    openedWith: ProviderSettings
  ): Promise<{ success: boolean; error?: string }> => {
    const normalizedSettings = normalizeSettings(syncLegacyProviderSettings(newSettings))
    const configuredModels = pinnedModelsFromProviderInstances(
      normalizedSettings.providerInstances || []
    )
    const nextSelectedModel = configuredModels.some((model) => model.id === selectedModel)
      ? selectedModel
      : configuredModels[0]?.id || ''
    normalizedSettings.selectedModel = nextSelectedModel
    // Only what changed since Settings opened, so a change made meanwhile, such as by the
    // `sidekick` CLI, survives. The chat's current model is always this window's to say.
    const result = await window.api.settings.save({
      ...changedSettings(
        normalizeSettings(syncLegacyProviderSettings(openedWith)),
        normalizedSettings
      ),
      selectedModel: nextSelectedModel
    })
    if (!result.success) return result
    setPinnedModels(configuredModels)
    setSelectedModel(nextSelectedModel)
    await window.api.pinnedModels.save(configuredModels)
    const publicSettings = await window.api.settings.load()
    setSettings(
      normalizeSettings(
        syncLegacyProviderSettings({ ...DEFAULT_SETTINGS, ...(publicSettings || {}) })
      )
    )

    // Update location if manual location changed
    if (normalizedSettings.manualLocation !== settings.manualLocation) {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (normalizedSettings.manualLocation) {
        setUserLocation({ city: normalizedSettings.manualLocation, timezone })
      }
    }
    return result
  }

  // The `sidekick` CLI can change settings while this window is open. Adopt them so a later
  // save from here does not write the old values back.
  useEffect(
    () =>
      window.api.settings.onChanged(() => {
        void window.api.settings.load().then((saved) => {
          if (!saved) return
          const next = normalizeSettings(
            syncLegacyProviderSettings({ ...DEFAULT_SETTINGS, ...saved })
          )
          setSettings(next)
          const configured = pinnedModelsFromProviderInstances(next.providerInstances || [])
          setPinnedModels(configured)
          if (configured.some((model) => model.id === next.selectedModel)) {
            setSelectedModel(next.selectedModel || '')
          }
        })
      }),
    []
  )

  const handleModelChange = (modelId: string): void => {
    setSelectedModel(modelId)
    setSettings({ ...settings, selectedModel: modelId })
    window.api.settings.save({ selectedModel: modelId })
  }

  // Throttle token count updates to avoid "Maximum update depth exceeded" during rapid streaming.
  // IPC chunks can arrive faster than React can reconcile, so we debounce to one update per 250ms.
  const pendingTokenUpdate = useRef<{ tokens: number; max: number } | null>(null)
  const tokenThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Each open chat's last reported context. A chat's panel stays mounted after
  // it is first opened and reports again only when its messages change, so
  // switching back to it must restore its figure rather than start from zero.
  const tokenCountsByConversation = useRef(new Map<string, { current: number; max: number }>())
  const restoreTokenCounts = useCallback((conversationId: string | null) => {
    pendingTokenUpdate.current = null
    setTokenCounts(
      (conversationId && tokenCountsByConversation.current.get(conversationId)) || {
        current: 0,
        max: 4096
      }
    )
  }, [])

  const handleTokenCountUpdate = useCallback((tokens: number, max: number) => {
    pendingTokenUpdate.current = { tokens, max }
    if (!tokenThrottleRef.current) {
      tokenThrottleRef.current = setTimeout(() => {
        if (pendingTokenUpdate.current) {
          setTokenCounts({
            current: pendingTokenUpdate.current.tokens,
            max: pendingTokenUpdate.current.max
          })
          pendingTokenUpdate.current = null
        }
        tokenThrottleRef.current = null
      }, 250)
    }
  }, [])

  const projectById = useCallback(
    (projectId: string | null | undefined) =>
      projectId ? projects.find((project) => project.id === projectId) || null : null,
    [projects]
  )

  const activateProjectWorkspace = useCallback(
    async (projectId: string | null | undefined): Promise<void> => {
      await window.api.workspace.setPath(projectById(projectId)?.folder_path ?? null)
    },
    [projectById]
  )

  const worktreeById = useMemo(
    () => new Map(worktrees.map((worktree) => [worktree.id, worktree])),
    [worktrees]
  )
  /** Where a chat works: its own worktree's folder, else its project's folder. */
  const conversationFolder = useCallback(
    (conversation: Conversation | null | undefined): string | null =>
      conversation?.worktree_folder ??
      (conversation?.worktree_id ? worktreeById.get(conversation.worktree_id)?.folderPath : null) ??
      projectById(conversation?.project_id)?.folder_path ??
      null,
    [projectById, worktreeById]
  )

  const refreshProjects = useCallback(async (): Promise<void> => {
    setProjects(await window.api.projects.list())
  }, [])

  // A chat outside any project can move into one of these.
  const projectChoices = useMemo(() => projects.map(({ id, name }) => ({ id, name })), [projects])

  const markConversationRead = useCallback((id: string): void => {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === id ? { ...conversation, unread_completion_at: null } : conversation
      )
    )
    void window.api.conversations.markRead(id)
  }, [])

  const handleNewConversation = async (projectId: string | null = null): Promise<void> => {
    await activateProjectWorkspace(projectId)
    const newConv = await window.api.conversations.create(
      'New Conversation',
      projectId,
      'placeholder'
    )
    setConversations((prev) => [newConv, ...prev])
    setCurrentConversationId(newConv.id)
    setTokenCounts({ current: 0, max: 4096 })
    setConversationCost(0)
    void refreshProjects()
  }

  const handleSelectConversation = async (id: string): Promise<void> => {
    const conversation = conversations.find((candidate) => candidate.id === id)
    markConversationRead(id)
    await window.api.workspace.setPath(conversationFolder(conversation))
    setCurrentConversationId(id)
    restoreTokenCounts(id)
    setConversationCost(0)
  }

  const handleDeleteConversation = async (id: string): Promise<void> => {
    if (runningConversationIds.has(id)) return
    await window.api.conversations.delete(id)
    deleteComposerDraft(id)
    setConversations((prev) => prev.filter((c) => c.id !== id))
    forgetPanel(id)
    if (currentConversationId === id) {
      setCurrentConversationId(null)
      await window.api.workspace.setPath(null)
    }
    void refreshProjects()
  }

  const handleDeleteAllConversations = async (): Promise<void> => {
    if (runningConversationIds.size > 0) return
    try {
      for (const conv of conversations) {
        await window.api.conversations.delete(conv.id)
        deleteComposerDraft(conv.id)
      }
      setConversations([])
      resetPanels()
      setCurrentConversationId(null)
      await window.api.workspace.setPath(null)
      setTokenCounts({ current: 0, max: 4096 })
      setConversationCost(0)
    } catch (error) {
      console.error('[App] Error deleting all conversations:', error)
    }
  }

  const handleUpdateConversationTitle = async (
    id: string,
    title: string,
    source: ConversationTitleSource = 'user'
  ): Promise<void> => {
    const result = await window.api.conversations.update(id, title, {
      source,
      preserveUpdatedAt: source !== 'user'
    })
    if (!result.success) return
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === id
          ? {
              ...conversation,
              title,
              title_source: source,
              title_version: conversationTitleVersionForSource(source),
              updated_at: result.updatedAt ?? conversation.updated_at
            }
          : conversation
      )
    )
  }

  const handleConversationTitleApplied = (id: string, title: string): void => {
    setConversations((previous) =>
      previous.map((conversation) =>
        conversation.id === id
          ? {
              ...conversation,
              title,
              title_source: 'generated',
              title_version: conversationTitleVersionForSource('generated')
            }
          : conversation
      )
    )
  }

  // Forking from a specific message only copies history already committed to the
  // database, so it stays available while the conversation is still running.
  // Forking from the tip would copy the in-flight message, so that still waits.
  const forkBlockedByRun = (conversationId: string, messageId?: string): boolean =>
    !messageId && runningConversationIds.has(conversationId)

  const handleForkConversation = (id: string, messageId?: string): void => {
    if (forkBlockedByRun(id, messageId)) return
    setForkError(null)
    setPendingFork({ conversationId: id, messageId })
  }

  const executeForkConversation = async (workspaceMode: 'current' | 'worktree'): Promise<void> => {
    if (!pendingFork || forkBusy) return
    if (forkBlockedByRun(pendingFork.conversationId, pendingFork.messageId)) return
    setForkBusy(true)
    setForkError(null)
    try {
      const forked = await window.api.conversations.fork({
        sourceId: pendingFork.conversationId,
        messageId: pendingFork.messageId,
        workspaceMode
      })
      await window.api.workspace.setPath(
        forked.worktree_folder ?? forked.home_workspace_root ?? null
      )
      setProjects(await window.api.projects.list())
      setConversations((prev) => [forked, ...prev])
      setCurrentConversationId(forked.id)
      setPendingFork(null)
      if (forked.worktree_id) void refreshWorktrees()
    } catch (error) {
      setForkError(error instanceof Error ? error.message : String(error))
    } finally {
      setForkBusy(false)
    }
  }

  const handleStartInWorktree = async (
    conversationId: string,
    options: { baseRef?: string }
  ): Promise<void> => {
    const result = await window.api.worktrees.createForConversation({ conversationId, ...options })
    if (currentConversationIdRef.current === conversationId) {
      await window.api.workspace.setPath(result.worktree.folderPath)
    }
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, ...result.conversation }
          : conversation
      )
    )
    await refreshWorktrees()
  }

  const handleForkIntoWorktree = async (
    conversationId: string,
    draft: ComposerDraft
  ): Promise<void> => {
    const forked = await window.api.conversations.fork({
      sourceId: conversationId,
      workspaceMode: 'worktree'
    })
    // The fork's composer opens with the message that could not be sent here.
    saveComposerDraft(forked.id, draft)
    await window.api.workspace.setPath(forked.worktree_folder ?? forked.home_workspace_root ?? null)
    setConversations((prev) => [forked, ...prev])
    setCurrentConversationId(forked.id)
    await refreshWorktrees()
  }

  const handleWorktreesRemoved = async (): Promise<void> => {
    const listedConversations = await window.api.conversations.list()
    setConversations(listedConversations)
    await refreshWorktrees()
    const current = listedConversations.find(({ id }) => id === currentConversationIdRef.current)
    if (current && !current.project_id && !current.worktree_id)
      await window.api.workspace.setPath(null)
  }

  /** Opens a worktree's chat, or a new chat in its project when none is left. */
  const openWorktreeChat = (worktree: ManagedWorktreeSummary): void => {
    setWorktreesDialog(null)
    const chat = worktree.owners[0]
    if (chat) void handleSelectConversation(chat.id)
    else void handleNewConversation(worktree.sourceProjectId)
  }

  const handleConversationCreated = async (id: string, title: string): Promise<void> => {
    const newConv: Conversation = {
      id,
      title,
      created_at: Date.now(),
      updated_at: Date.now(),
      project_id: null,
      is_pinned: 0,
      title_source: 'fallback',
      title_version: conversationTitleVersionForSource('fallback'),
      sidebar_order: -1,
      project_context_version: 0,
      home_workspace_root: null,
      home_project_name: null
    }
    claimDraftPanel(id)
    setConversations((prev) => [newConv, ...prev])
    setCurrentConversationId(id)
  }

  const handleOpenProject = async (attachCurrentConversation: boolean): Promise<void> => {
    if (attachCurrentConversation && isAgentBusy) return
    const selection = await window.api.workspace.selectFolder()
    if (selection.canceled || !selection.path) return

    const project = await window.api.projects.create(selection.path)
    setProjects((current) => {
      const withoutProject = current.filter((candidate) => candidate.id !== project.id)
      return [project, ...withoutProject]
    })
    if (attachCurrentConversation && currentConversationId) {
      await window.api.projects.moveConversation({
        conversationId: currentConversationId,
        projectId: project.id,
        placement: 'start',
        expectedProjectContextVersion: currentConversation?.project_context_version
      })
      await window.api.workspace.setPath(project.folder_path)
      setConversations(await window.api.conversations.list())
    } else {
      const conversation = await window.api.conversations.create(
        'New Conversation',
        project.id,
        'placeholder'
      )
      setConversations((current) => [conversation, ...current])
      setCurrentConversationId(conversation.id)
      setTokenCounts({ current: 0, max: 4096 })
      setConversationCost(0)
    }
    void refreshProjects()
  }

  useEffect(() => {
    openConversationHandlerRef.current = (id): void => {
      if (!conversations.some((conversation) => conversation.id === id)) return
      void handleSelectConversation(id)
      setFocusReplyRequest({ conversationId: id, at: Date.now() })
    }
  })

  useEffect(() => {
    appCommandHandlerRef.current = (command): void => {
      if (command === 'open-settings') {
        openSettings()
      } else if (command === 'new-chat') {
        void handleNewConversation(null)
      } else if (command === 'open-project') {
        void handleOpenProject(false)
      }
    }
  })

  const handleSidebarOrderChange = useCallback((conversationIds: string[]): void => {
    sidebarOrderRef.current = conversationIds
  }, [])
  const handleActivityTabChange = useCallback((tab: string): void => {
    activityTabRef.current = tab
  }, [])

  const openSettings = (): void => {
    setSettingsInitialSection('general')
    setIsSettingsOpen(true)
  }
  const showAdjacentConversation = (direction: 1 | -1): void => {
    const shown = currentConversationId
    const target = adjacentConversationId(sidebarOrderRef.current, shown, direction)
    if (target && target !== shown) void handleSelectConversation(target)
  }
  const voiceAvailable = Boolean(voiceState?.enabled && window.api.voice)

  const keyboardShortcutRef = useRef<(event: KeyboardEvent) => void>(() => undefined)
  useEffect(() => {
    keyboardShortcutRef.current = (event): void => {
      if (event.defaultPrevented) return
      const dialogOpen = document.querySelector('[aria-modal="true"]') !== null
      if (matchesShortcut(event, 'command-palette', platform)) {
        // Another dialog owns the keyboard (and Esc) while it is open.
        if (!isCommandPaletteOpen && dialogOpen) return
        event.preventDefault()
        setIsCommandPaletteOpen((open) => !open)
        return
      }
      if (dialogOpen) return
      const jump = conversationJumpIndex(event, platform)
      if (jump !== null) {
        const target = sidebarOrderRef.current[jump - 1]
        if (!target) return
        event.preventDefault()
        void handleSelectConversation(target)
        return
      }
      if (matchesShortcut(event, 'previous-conversation', platform)) {
        event.preventDefault()
        showAdjacentConversation(-1)
      } else if (matchesShortcut(event, 'next-conversation', platform)) {
        event.preventDefault()
        showAdjacentConversation(1)
      }
    }
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => keyboardShortcutRef.current(event)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const commandPaletteItems = isCommandPaletteOpen
    ? buildCommandPaletteItems({
        platform,
        conversations,
        projects,
        sidebarOrder: sidebarOrderRef.current,
        currentConversationId,
        sidebarCollapsed: effectiveSidebarCollapsed,
        browserPanelOpen: effectiveActivityPanelPinned && activityTabRef.current === 'browser',
        voiceOn: voiceAvailable ? voiceLoop !== 'off' : null,
        theme,
        actions: {
          newChat: () => void handleNewConversation(null),
          openSchedules: () => setIsSchedulesOpen(true),
          openProject: () => void handleOpenProject(false),
          openSettings,
          toggleSidebar,
          toggleBrowserPanel,
          toggleVoice: toggleVoiceLoop,
          toggleTheme: () =>
            switchThemeFrom(document.querySelector('.theme-toggle-button'), () =>
              setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
            ),
          checkForUpdates: () => void window.api.appUpdates.check(),
          previousConversation: () => showAdjacentConversation(-1),
          nextConversation: () => showAdjacentConversation(1),
          openConversation: (id) => void handleSelectConversation(id),
          openProjectConversations: (projectId) => {
            const latest = latestProjectConversationId(conversations, projectId)
            if (latest) void handleSelectConversation(latest)
            else void handleNewConversation(projectId)
          },
          manageWorktrees: () =>
            setWorktreesDialog({ focusWorktreeId: currentConversation?.worktree_id ?? null })
        }
      })
    : []

  const handleMoveConversation = async (input: MoveConversationInput): Promise<void> => {
    if (runningConversationIds.has(input.conversationId)) return
    await window.api.projects.moveConversation(input)
    if (input.conversationId === currentConversationId) {
      await activateProjectWorkspace(input.projectId)
    }
    setConversations(await window.api.conversations.list())
    void refreshProjects()
  }

  const handleRenameProject = async (id: string, name: string): Promise<void> => {
    const updated = await window.api.projects.update(id, { name })
    setProjects((current) =>
      current.map((project) => (project.id === id ? { ...project, ...updated } : project))
    )
    setConversations((current) =>
      current.map((conversation) =>
        conversation.home_workspace_root === updated.folder_path
          ? { ...conversation, home_project_name: updated.name }
          : conversation
      )
    )
  }

  const handleToggleProjectPin = async (id: string, pinned: boolean): Promise<void> => {
    await window.api.projects.update(id, { isPinned: pinned })
    await refreshProjects()
  }

  const handleToggleConversationPin = async (id: string, pinned: boolean): Promise<void> => {
    const result = await window.api.conversations.setPinned(id, pinned)
    if (result.success) setConversations(await window.api.conversations.list())
  }

  const handleRemoveProject = async (id: string): Promise<void> => {
    if (
      conversations.some(
        (conversation) =>
          conversation.project_id === id && runningConversationIds.has(conversation.id)
      )
    )
      return
    const affectedCurrent = conversations.find(
      (conversation) => conversation.id === currentConversationId && conversation.project_id === id
    )
    await window.api.projects.remove(id)
    setProjects(await window.api.projects.list())
    setConversations(await window.api.conversations.list())
    if (affectedCurrent) await window.api.workspace.setPath(null)
  }

  const handleFocusChainUpdate = useCallback((conversationId: string, todos: TodoItem[]): void => {
    setFocusChainTodosByConversation((prev) => ({
      ...prev,
      [conversationId]: todos
    }))
  }, [])

  const handleResponseComplete = useCallback(
    (message: string, conversationId: string | null): void => {
      const notificationsEnabled = settings.notificationsEnabled ?? true

      // Only notify when user is away from the app
      if (!notificationsEnabled || document.hasFocus()) return

      void window.api.notification.show({
        body: message,
        silent: !(settings.notificationSoundEnabled ?? false),
        ...(conversationId ? { conversationId } : {})
      })
    },
    [settings.notificationSoundEnabled, settings.notificationsEnabled]
  )

  // A background run paused on an approval or question, or one that failed,
  // is announced unless the user is already looking at it.
  const handleAttentionAlert = useCallback(
    (alert: ConversationAttentionAlert): void => {
      const notify = shouldNotifyAttention({
        notificationsEnabled: settings.notificationsEnabled ?? true,
        appFocused: document.hasFocus(),
        shownConversationId: currentConversationIdRef.current,
        conversationId: alert.conversationId
      })
      if (!notify) return
      const title = conversations.find(({ id }) => id === alert.conversationId)?.title
      void window.api.notification.show({
        body: attentionNotificationBody(alert.reason, title),
        silent: !(settings.notificationSoundEnabled ?? false),
        conversationId: alert.conversationId
      })
    },
    [
      conversations,
      currentConversationIdRef,
      settings.notificationSoundEnabled,
      settings.notificationsEnabled
    ]
  )
  // Main owns every chat's state, including runs no panel here started.
  const sessionStatuses = useSessionStatuses(handleAttentionAlert)
  const runningConversationIds = sessionStatuses.active
  const waitingConversationIds = sessionStatuses.waiting
  const refreshConversationsForSchedules = useCallback(() => {
    void window.api.conversations
      .list()
      .then((list) => {
        setConversations(list)
        // A run that finished in the chat on screen has been read, whichever event came first.
        const shown = list.find(({ id }) => id === currentConversationIdRef.current)
        if (shown?.unread_completion_at) markConversationRead(shown.id)
      })
      .catch((error) => console.error('[Schedules] Could not refresh chats', error))
  }, [currentConversationIdRef, markConversationRead])
  const { schedules } = useSchedules(refreshConversationsForSchedules)
  // Chats another chat starts are created in the main process, often in a new worktree project,
  // so the lists here learn about them from the family change rather than from a user action.
  useEffect(
    () =>
      window.api.sessions.onChanged((change) => {
        if (change.kind !== 'family') return
        refreshConversationsForSchedules()
        void refreshProjects()
      }),
    [refreshConversationsForSchedules, refreshProjects]
  )
  const scheduleNames = useMemo(
    () => new Map(schedules.map(({ id, name }) => [id, name])),
    [schedules]
  )

  const handleConversationResponseComplete = useCallback(
    (conversationId: string | null, message: string): void => {
      handleResponseComplete(message, conversationId)
      if (!conversationId) return
      if (currentConversationIdRef.current === conversationId) {
        markConversationRead(conversationId)
        return
      }
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, unread_completion_at: Date.now() }
            : conversation
        )
      )
    },
    [currentConversationIdRef, handleResponseComplete, markConversationRead]
  )

  const selectedPinnedModel = pinnedModels.find((model) => model.id === selectedModel)
  const activeProviderInstance = providerInstanceForModel(settings, selectedPinnedModel)
  const currentProvider = selectedPinnedModel?.provider || 'ollama'
  const currentModelName =
    selectedPinnedModel?.providerModelId || selectedPinnedModel?.name || selectedModel
  const legacyFastModel = resolveFastModel(currentProvider, currentModelName, settings).modelName
  const fastModelName = activeProviderInstance?.fastModelId || legacyFastModel
  useConversationTitleBackfill({
    enabled: isReady,
    model: selectedPinnedModel,
    fastModelName: fastModelName !== currentModelName ? fastModelName : undefined,
    isAgentBusy: runningConversationIds.size > 0,
    onTitleApplied: (conversationId, title, source = 'generated') => {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                title,
                title_source: source,
                title_version: conversationTitleVersionForSource(source)
              }
            : conversation
        )
      )
    }
  })
  const unreadConversationIds = useMemo(
    () =>
      new Set(
        conversations
          .filter((conversation) => Boolean(conversation.unread_completion_at))
          .map((conversation) => conversation.id)
      ),
    [conversations]
  )
  const activeProject = projectById(currentConversation?.project_id)
  const titleBarContext = currentConversationId
    ? currentConversation?.title || 'Conversation'
    : null
  const historyWorkspaceFolder =
    conversationFolder(currentConversation) ?? currentConversation?.home_workspace_root ?? null
  const historyReadOnly =
    !conversationFolder(currentConversation) && Boolean(currentConversation?.home_workspace_root)
  const welcomeSuggestions = useMemo(() => {
    const currentProjectId = currentConversation?.project_id ?? null
    const recentConversationTitles = conversations
      .filter(
        (conversation) =>
          conversation.id !== currentConversationId &&
          !isPlaceholderConversationTitle(conversation.title)
      )
      .sort((left, right) => {
        const leftMatchesProject = left.project_id === currentProjectId ? 1 : 0
        const rightMatchesProject = right.project_id === currentProjectId ? 1 : 0
        return rightMatchesProject - leftMatchesProject || right.updated_at - left.updated_at
      })
      .map((conversation) => conversation.title)

    return createWelcomeSuggestions({
      recentConversationTitles,
      projectName: activeProject?.name
    })
  }, [activeProject?.name, conversations, currentConversation?.project_id, currentConversationId])

  const renderConversationPanel = (
    conversation: Conversation | null,
    panelKey: string,
    visible: boolean
  ): React.JSX.Element => {
    const panelConversationId = conversation?.id ?? null
    const panelProject = projectById(conversation?.project_id)
    return (
      <div
        className="conversation-panel-slot"
        key={panelKey}
        hidden={!visible}
        aria-hidden={!visible}
      >
        <ChatPanel
          pinnedModels={pinnedModels}
          onOpenModelSearch={() => {
            setSettingsInitialSection('providers')
            setIsSettingsOpen(true)
          }}
          conversationId={panelConversationId}
          conversationTitle={conversation?.title ?? null}
          welcomeSuggestions={visible ? welcomeSuggestions : []}
          workspaceFolder={conversationFolder(conversation)}
          projectName={panelProject?.name ?? null}
          projectId={panelProject?.id ?? null}
          worktree={
            conversation?.worktree_id ? (worktreeById.get(conversation.worktree_id) ?? null) : null
          }
          onStartInWorktree={handleStartInWorktree}
          onForkIntoWorktree={handleForkIntoWorktree}
          onManageWorktrees={() =>
            setWorktreesDialog({ focusWorktreeId: conversation?.worktree_id ?? null })
          }
          projectChoices={projectChoices}
          onChooseProject={(projectId) =>
            panelConversationId
              ? handleMoveConversation({ conversationId: panelConversationId, projectId })
              : handleNewConversation(projectId)
          }
          onOpenConversation={(id) => void handleSelectConversation(id)}
          onOpenProject={() => handleOpenProject(true)}
          onUpdateConversationTitle={handleUpdateConversationTitle}
          onConversationTitleApplied={handleConversationTitleApplied}
          onConversationCreated={handleConversationCreated}
          onForkConversation={(messageId) => {
            if (panelConversationId) handleForkConversation(panelConversationId, messageId)
          }}
          selectedModel={selectedModel}
          planningModelId={settings.planningModelId}
          onModelChange={handleModelChange}
          onTokenCountUpdate={(current, max) => {
            if (panelConversationId) {
              tokenCountsByConversation.current.set(panelConversationId, { current, max })
            }
            if (
              currentConversationIdRef.current === panelConversationId ||
              (visible && panelConversationId === null)
            ) {
              handleTokenCountUpdate(current, max)
            }
          }}
          onConversationCostUpdate={(cost) => {
            if (currentConversationIdRef.current === panelConversationId) {
              setConversationCost(cost)
            }
          }}
          onFocusChainUpdate={handleFocusChainUpdate}
          autoCompactEnabled={settings.autoCompactEnabled ?? true}
          autoCompactThreshold={settings.autoCompactThreshold ?? 0.8}
          focusChainEnabled={settings.focusChainEnabled ?? true}
          toolCallLimit={settings.toolCallLimit ?? DEFAULT_TOOL_CALL_LIMIT}
          commandPermissionMode={settings.commandPermissionMode ?? 'full-access'}
          userLocation={userLocation}
          onResponseComplete={(message) =>
            handleConversationResponseComplete(panelConversationId, message)
          }
          focusReplyAt={
            focusReplyRequest && focusReplyRequest.conversationId === panelConversationId
              ? focusReplyRequest.at
              : undefined
          }
          onBusyStateChange={handleConversationBusyStateChange}
          fastModelName={fastModelName !== currentModelName ? fastModelName : undefined}
          reasoningSettings={settings}
          onReasoningLevelChange={(modelId, level) => {
            const reasoningLevels = { ...settings.reasoningLevels, [modelId]: level }
            setSettings({ ...settings, reasoningLevels })
            window.api.settings.save({ reasoningLevels })
          }}
          onCheckpointCreated={(_restoredHash) => {
            if (currentConversationIdRef.current !== panelConversationId) return
            setCheckpointVersion((version) => version + 1)
            setRestoredHash(_restoredHash)
          }}
          chatRollbackHash={visible ? chatRollbackHash : null}
          onChatRollbackConsumed={() => {
            if (currentConversationIdRef.current === panelConversationId) {
              setChatRollbackHash(null)
            }
          }}
        />
      </div>
    )
  }

  if (!isReady) {
    return (
      <div className="app-loading" data-theme={theme}>
        <div className="app-loading-content">
          <img src={appIconUrl} alt="" className="app-loading-icon" />
          <span className="app-loading-name">SideKick</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`app platform-${platform}${isWindowFullScreen ? ' window-fullscreen' : ''}${isSettingsOpen ? ' settings-open' : ''}`}
    >
      <div className="title-bar">
        <div className="title-bar-left">
          {/* At 20 px the title bar takes the icon's small cut, drawn to read at that size. */}
          <img src={smallIconUrl} alt="SideKick" className="title-bar-icon" />
          {titleBarContext && (
            <>
              <span className="title-bar-divider">/</span>
              <WrittenTitle
                className="title-bar-context"
                text={titleBarContext}
                identity={currentConversationId}
              />
            </>
          )}
        </div>
        <div className="title-bar-right">
          <div className="title-bar-actions">
            <ContextIndicator
              currentTokens={tokenCounts.current}
              maxTokens={tokenCounts.max}
              selectedModel={selectedModel}
              model={selectedPinnedModel}
              autoCompactEnabled={settings.autoCompactEnabled ?? true}
              autoCompactThreshold={settings.autoCompactThreshold ?? 0.8}
              conversationCost={conversationCost}
            />
            <button
              className="theme-toggle-button"
              onClick={(event) => {
                const origin = event.currentTarget
                switchThemeFrom(origin, () =>
                  setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
                )
              }}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="settings-button"
              onClick={() => {
                setSettingsInitialSection('general')
                setIsSettingsOpen(true)
              }}
              title="Settings"
              aria-label="Settings"
            >
              <Settings size={18} />
            </button>
          </div>
          {!isMac && (
            <div className="window-controls">
              <button
                className="window-control minimize"
                onClick={() => window.api.window.minimize()}
                title="Minimize"
                aria-label="Minimize"
              >
                <Minus size={13} />
              </button>
              <button
                className="window-control maximize"
                onClick={() => window.api.window.maximize()}
                title={isWindowMaximized ? 'Restore down' : 'Maximize'}
                aria-label={isWindowMaximized ? 'Restore down' : 'Maximize'}
              >
                {isWindowMaximized ? <Copy size={11} /> : <Square size={11} />}
              </button>
              <button
                className="window-control close"
                onClick={() => window.api.window.close()}
                title="Close"
                aria-label="Close"
              >
                <X size={13} />
              </button>
            </div>
          )}
        </div>
      </div>

      <main className="app-main">
        <Sidebar
          sessionStatuses={sessionStatuses.byId}
          conversations={conversations}
          projects={projects}
          currentConversationId={currentConversationId}
          isCollapsed={effectiveSidebarCollapsed}
          platform={platform}
          busyConversationIds={runningConversationIds}
          unreadConversationIds={unreadConversationIds}
          waitingConversationIds={waitingConversationIds}
          onSelectConversation={handleSelectConversation}
          onToggleCollapsed={toggleSidebar}
          onNewConversation={(projectId) => void handleNewConversation(projectId)}
          onOpenProject={() => void handleOpenProject(false)}
          onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
          onDeleteConversation={handleDeleteConversation}
          onDeleteAllConversations={handleDeleteAllConversations}
          onForkConversation={handleForkConversation}
          onRenameConversation={handleUpdateConversationTitle}
          onMoveConversation={(input) => void handleMoveConversation(input)}
          onRenameProject={(id, name) => void handleRenameProject(id, name)}
          onToggleConversationPin={(id, pinned) => void handleToggleConversationPin(id, pinned)}
          onToggleProjectPin={(id, pinned) => void handleToggleProjectPin(id, pinned)}
          onRemoveProject={(id) => void handleRemoveProject(id)}
          onVisibleConversationOrderChange={handleSidebarOrderChange}
          scheduleNames={scheduleNames}
          onOpenSchedules={() => setIsSchedulesOpen(true)}
        />
        <div
          className={`conversation-panel-stack${panelIsFull ? ' is-behind-panel' : ''}${layoutMotion ? ' is-in-motion' : ''}`}
          aria-hidden={panelIsFull || undefined}
          style={
            layoutMotion
              ? ({ '--frozen-chat-width': `${layoutMotion.chatWidth}px` } as React.CSSProperties)
              : undefined
          }
        >
          {!currentConversationId && renderConversationPanel(null, draftPanelKey, true)}
          {mountedConversationIds.map((id) => {
            const conversation = conversations.find((candidate) => candidate.id === id)
            if (!conversation) return null
            return renderConversationPanel(
              conversation,
              conversationPanelKeys[id] ?? `conversation:${id}`,
              currentConversationId === id
            )
          })}
        </div>
        <ActivityPanel
          isPinned={effectiveActivityPanelPinned}
          conversationId={currentConversationId}
          onTogglePin={toggleActivityPanel}
          tabRequest={activityTabRequest}
          onActiveTabChange={handleActivityTabChange}
          maxWidth={layout.panelMaxWidth}
          width={activityPanelWidth}
          onWidthChange={setActivityPanelWidth}
          size={panelSize}
          onSizeChange={isCompactLayout ? undefined : setActivityPanelSize}
          sideBySideMaxWidth={panelSideBySideMax}
          snapWidths={panelSnapWidths}
          onSettle={() => setPanelGlide((count) => count + 1)}
          onOpenConversation={(id) => void handleSelectConversation(id)}
          focusChainTodos={
            currentConversationId ? focusChainTodosByConversation[currentConversationId] || [] : []
          }
          workspaceFolder={conversationFolder(currentConversation)}
          historyWorkspaceFolder={historyWorkspaceFolder}
          historyReadOnly={historyReadOnly}
          checkpointVersion={checkpointVersion}
          restoredHash={restoredHash}
          onGoToCheckpoint={(hash) => {
            setCheckpointVersion((v) => v + 1)
            setRestoredHash(hash)
            setChatRollbackHash(hash)
          }}
          titleModel={selectedPinnedModel}
          fastModelName={fastModelName !== currentModelName ? fastModelName : undefined}
          isAgentBusy={isAgentBusy}
        />
      </main>

      {isSchedulesOpen && (
        <SchedulesDialog
          isOpen
          schedules={schedules}
          projects={projects}
          models={pinnedModels}
          defaultModelId={selectedModel}
          defaultProjectId={currentConversation?.project_id ?? null}
          permissionMode={normalizePermissionMode(settings.commandPermissionMode)}
          onClose={() => setIsSchedulesOpen(false)}
          onOpenConversation={(id) => {
            setIsSchedulesOpen(false)
            void handleSelectConversation(id)
          }}
        />
      )}

      <WorktreesDialog
        isOpen={worktreesDialog !== null}
        worktrees={worktrees}
        focusWorktreeId={worktreesDialog?.focusWorktreeId}
        onClose={() => setWorktreesDialog(null)}
        onRefresh={refreshWorktrees}
        onOpenChat={openWorktreeChat}
        onRemoved={handleWorktreesRemoved}
      />
      <ForkConversationDialog
        isOpen={pendingFork !== null}
        canUseWorktree={Boolean(
          pendingFork &&
          conversations.find((conversation) => conversation.id === pendingFork.conversationId)
            ?.project_id
        )}
        busy={forkBusy}
        error={forkError}
        onChoose={(mode) => void executeForkConversation(mode)}
        onCancel={() => {
          if (forkBusy) return
          setPendingFork(null)
          setForkError(null)
        }}
      />

      <AppUpdateToast />

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        items={commandPaletteItems}
        onClose={() => setIsCommandPaletteOpen(false)}
      />

      {isSettingsOpen && (
        <SettingsModal
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setIsSettingsOpen(false)}
          initialSection={settingsInitialSection}
          providerKeyRequest={providerKeyRequest}
          credentialRequest={credentialRequest}
        />
      )}
      <AppMenuHost />
    </div>
  )
}

export default App
