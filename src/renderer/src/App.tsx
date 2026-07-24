import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Copy, Minus, Moon, Settings, Square, Sun, X } from 'lucide-react'
import Sidebar from './components/Sidebar'
import ChatPanel from './components/ChatPanel'
import ActivityPanel from './components/ActivityPanel'
import SettingsModal from './components/SettingsModal'
import { applyAccentPalette } from './components/SettingsModal'
import type { SettingsSection } from './components/SettingsModal'
import ContextIndicator from './components/ContextIndicator'
import GroupChatPanel from './components/GroupChatPanel'
import GroupSetupDialog from './components/GroupSetupDialog'
import { AppUpdateToast } from './components/AppUpdateControls'
import type { TodoItem } from '../../shared/types'
import type { MoveConversationInput } from '../../shared/projects'
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
import type { CollaborationGroup, CreateCollaborationGroupInput } from '../../shared/collaboration'
import {
  DEFAULT_TOOL_CALL_LIMIT,
  TOOL_CALL_LIMIT_POLICY_VERSION,
  type ProviderSettings,
  type Conversation,
  type Project
} from './types/app.types'
import { resolveFastModel } from './utils/fastModel'
import { isPlaceholderConversationTitle } from './utils/chatPanelHelpers'
import { createWelcomeSuggestions } from './utils/welcomeSuggestions'
import type { GroupAgentContextSnapshot } from './utils/groupAgentContext'
import type { AppCommand } from '../../shared/appCommands'
import { useConversationTitleBackfill } from './hooks/useConversationTitleBackfill'
import { useConversationPanelRegistry } from './hooks/useConversationPanelRegistry'
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
  focusChainReminderInterval: 15,
  autoCompactEnabled: true,
  autoCompactThreshold: 0.8,
  notificationsEnabled: true,
  notificationSoundEnabled: false,
  ollamaThinkingEnabled: true,
  openRouterThinkingEnabled: false,
  commandPermissionMode: 'agent-decides',
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
    'integrations'
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

function getPreviewGroupId(): string | null {
  const params = new URLSearchParams(window.location.search)
  return params.has('ui-preview') && params.get('view') === 'group' ? 'preview-group-1' : null
}

const previewGroupId = getPreviewGroupId()

function getPreviewGroupSessionId(): string | null {
  const params = new URLSearchParams(window.location.search)
  return params.has('ui-preview') && params.get('view') === 'group' ? params.get('session') : null
}

const previewGroupSessionId = getPreviewGroupSessionId()

function normalizeSettings(settings: ProviderSettings): ProviderSettings {
  return {
    ...settings,
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
  const [pinnedModels, setPinnedModels] = useState<PinnedModel[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [groups, setGroups] = useState<CollaborationGroup[]>([])
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(previewGroupId)
  const [currentGroupSessionId, setCurrentGroupSessionId] = useState<string | null>(
    previewGroupSessionId
  )
  const currentGroupIdRef = useRef(currentGroupId)
  const currentGroupSessionIdRef = useRef(currentGroupSessionId)
  useEffect(() => {
    currentGroupIdRef.current = currentGroupId
    currentGroupSessionIdRef.current = currentGroupSessionId
  }, [currentGroupId, currentGroupSessionId])
  const currentConversation = conversations.find(
    (conversation) => conversation.id === currentConversationId
  )
  const [groupAgentContext, setGroupAgentContext] = useState<GroupAgentContextSnapshot | null>(null)
  const [isGroupSetupOpen, setIsGroupSetupOpen] = useState(false)
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
  const [appIconPath, setAppIconPath] = useState<string>('')
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
    busyConversationIds,
    currentConversationIdRef,
    currentConversationBusy: isAgentBusy,
    hasActiveConversationRuns,
    mountedConversationIds,
    conversationPanelKeys,
    draftPanelKey,
    onBusyStateChange: handleConversationBusyStateChange,
    claimDraftPanel,
    forgetPanel,
    resetPanels
  } = useConversationPanelRegistry(conversations, currentConversationId)
  // Load settings, pinned models, and conversations on startup
  useEffect(() => {
    const loadData = async (): Promise<void> => {
      try {
        setAppIconPath(await window.api.app.getIconPath())

        const savedSettings = await window.api.settings.load()
        const savedModels = await window.api.pinnedModels.load()
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
        if (
          !savedSettings?.providerInstances ||
          savedSettings.toolCallLimitVersion !== TOOL_CALL_LIMIT_POLICY_VERSION
        ) {
          void window.api.settings.save(migratedSettings)
        }
        if (!savedSettings?.providerInstances) {
          void window.api.pinnedModels.save(configuredModels)
        }
        if (savedSettings) {
          // Apply saved accent palette
          if (migratedSettings.accentPalette) {
            const currentTheme = document.body.dataset.theme === 'light' ? 'light' : 'dark'
            applyAccentPalette(migratedSettings.accentPalette, currentTheme)
          }
        }

        const [conversationsList, projectsList, groupsList] = await Promise.all([
          window.api.conversations.list(),
          window.api.projects.list(),
          window.api.collaboration.listGroups(),
          window.api.workspace.setPath(null)
        ])
        setConversations(conversationsList)
        setProjects(projectsList)
        setGroups(groupsList)

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
      window.api.collaboration.onChanged(() => {
        void window.api.collaboration.listGroups().then((nextGroups) => {
          const openGroupId = currentGroupIdRef.current
          const openSessionId = currentGroupSessionIdRef.current
          if (!openGroupId) {
            setGroups(nextGroups)
            return
          }
          setGroups(
            nextGroups.map((group) => {
              if (group.id !== openGroupId) return group
              if (openSessionId) {
                const openSession = group.agentSessions.find(
                  (session) => session.id === openSessionId
                )
                if (!openSession?.unreadCompletionAt) return group
                void window.api.collaboration.markAgentSessionRead(openSessionId)
                return {
                  ...group,
                  agentSessions: group.agentSessions.map((session) =>
                    session.id === openSessionId
                      ? { ...session, unreadCompletionAt: null }
                      : session
                  )
                }
              }
              if (
                !group.unreadCompletionAt &&
                !group.agentSessions.some((session) => session.unreadCompletionAt)
              ) {
                return group
              }
              void window.api.collaboration.markGroupRead(openGroupId)
              return {
                ...group,
                unreadCompletionAt: null,
                agentSessions: group.agentSessions.map((session) => ({
                  ...session,
                  unreadCompletionAt: null
                }))
              }
            })
          )
        })
      }),
    []
  )

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
    window.localStorage.setItem('sidebarCollapsed', String(isSidebarCollapsed))
  }, [isSidebarCollapsed])

  useEffect(() => {
    window.localStorage.setItem('activityPanelPinned', String(isActivityPanelPinned))
  }, [isActivityPanelPinned])

  const handleSaveSettings = async (
    newSettings: ProviderSettings
  ): Promise<{ success: boolean; error?: string }> => {
    const normalizedSettings = normalizeSettings(syncLegacyProviderSettings(newSettings))
    const configuredModels = pinnedModelsFromProviderInstances(
      normalizedSettings.providerInstances || []
    )
    const nextSelectedModel = configuredModels.some((model) => model.id === selectedModel)
      ? selectedModel
      : configuredModels[0]?.id || ''
    normalizedSettings.selectedModel = nextSelectedModel
    const result = await window.api.settings.save(normalizedSettings)
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

  const handleModelChange = (modelId: string): void => {
    setSelectedModel(modelId)
    const updatedSettings = { ...settings, selectedModel: modelId }
    setSettings(updatedSettings)
    window.api.settings.save(updatedSettings)
  }

  // Throttle token count updates to avoid "Maximum update depth exceeded" during rapid streaming.
  // IPC chunks can arrive faster than React can reconcile, so we debounce to one update per 250ms.
  const pendingTokenUpdate = useRef<{ tokens: number; max: number } | null>(null)
  const tokenThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const refreshProjects = useCallback(async (): Promise<void> => {
    setProjects(await window.api.projects.list())
  }, [])

  const markConversationRead = useCallback((id: string): void => {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === id ? { ...conversation, unread_completion_at: null } : conversation
      )
    )
    void window.api.conversations.markRead(id)
  }, [])

  const markGroupRead = useCallback((id: string): void => {
    setGroups((current) =>
      current.map((group) =>
        group.id === id
          ? {
              ...group,
              unreadCompletionAt: null,
              agentSessions: group.agentSessions.map((session) => ({
                ...session,
                unreadCompletionAt: null
              }))
            }
          : group
      )
    )
    void window.api.collaboration.markGroupRead(id)
  }, [])

  const markGroupSessionRead = useCallback((groupId: string, sessionId: string): void => {
    setGroups((current) =>
      current.map((group) =>
        group.id === groupId
          ? {
              ...group,
              agentSessions: group.agentSessions.map((session) =>
                session.id === sessionId ? { ...session, unreadCompletionAt: null } : session
              )
            }
          : group
      )
    )
    void window.api.collaboration.markAgentSessionRead(sessionId)
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
    setCurrentGroupId(null)
    setCurrentGroupSessionId(null)
    setGroupAgentContext(null)
    setTokenCounts({ current: 0, max: 4096 })
    setConversationCost(0)
    void refreshProjects()
  }

  const handleSelectConversation = async (id: string): Promise<void> => {
    const conversation = conversations.find((candidate) => candidate.id === id)
    markConversationRead(id)
    await activateProjectWorkspace(conversation?.project_id)
    setCurrentConversationId(id)
    setCurrentGroupId(null)
    setCurrentGroupSessionId(null)
    setGroupAgentContext(null)
    setTokenCounts({ current: 0, max: 4096 })
    setConversationCost(0)
  }

  const handleSelectGroup = async (id: string): Promise<void> => {
    markGroupRead(id)
    setCurrentConversationId(null)
    setCurrentGroupId(id)
    setCurrentGroupSessionId(null)
    setGroupAgentContext(null)
    await window.api.workspace.setPath(null)
  }

  const handleSelectGroupSession = async (groupId: string, sessionId: string): Promise<void> => {
    const session = groups
      .find((group) => group.id === groupId)
      ?.agentSessions.find((candidate) => candidate.id === sessionId)
    markGroupSessionRead(groupId, sessionId)
    setCurrentConversationId(null)
    setCurrentGroupId(groupId)
    setCurrentGroupSessionId(sessionId)
    setGroupAgentContext(null)
    await activateProjectWorkspace(session?.projectId ?? null)
  }

  const handleRenameGroupSession = async (id: string, title: string): Promise<void> => {
    const updated = await window.api.collaboration.updateAgentSession(id, { title })
    setGroups((current) =>
      current.map((group) =>
        group.id === updated.groupId
          ? {
              ...group,
              agentSessions: group.agentSessions.map((session) =>
                session.id === updated.id ? updated : session
              )
            }
          : group
      )
    )
  }

  const handleRenameGroup = async (id: string, title: string): Promise<void> => {
    const updated = await window.api.collaboration.updateGroup(id, { title })
    setGroups((current) =>
      current.map((group) => (group.id === updated.id ? { ...group, ...updated } : group))
    )
  }

  const handleCreateGroup = async (input: CreateCollaborationGroupInput): Promise<void> => {
    const detail = await window.api.collaboration.createGroup(input)
    setGroups(await window.api.collaboration.listGroups())
    setCurrentConversationId(null)
    setCurrentGroupId(detail.group.id)
    setCurrentGroupSessionId(null)
    setGroupAgentContext(null)
    setIsGroupSetupOpen(false)
    await window.api.workspace.setPath(null)
  }

  const handleDeleteGroup = async (id: string): Promise<void> => {
    await window.api.collaboration.deleteGroup(id)
    setGroups((current) => current.filter((group) => group.id !== id))
    if (currentGroupId === id) {
      setCurrentGroupId(null)
      setCurrentGroupSessionId(null)
      setGroupAgentContext(null)
    }
  }

  const handleDeleteConversation = async (id: string): Promise<void> => {
    if (busyConversationIds.has(id)) return
    await window.api.conversations.delete(id)
    setConversations((prev) => prev.filter((c) => c.id !== id))
    forgetPanel(id)
    if (currentConversationId === id) {
      setCurrentConversationId(null)
      await window.api.workspace.setPath(null)
    }
    void refreshProjects()
  }

  const handleDeleteAllConversations = async (): Promise<void> => {
    if (hasActiveConversationRuns) return
    try {
      for (const conv of conversations) {
        await window.api.conversations.delete(conv.id)
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

  const handleForkConversation = async (id: string): Promise<void> => {
    if (busyConversationIds.has(id)) return
    const forked = await window.api.conversations.fork(id)
    await activateProjectWorkspace(forked.project_id)
    setConversations((prev) => [forked, ...prev])
    setCurrentConversationId(forked.id)
    void refreshProjects()
  }

  const handleConversationCreated = async (id: string, title: string): Promise<void> => {
    const newConv: Conversation = {
      id,
      title,
      created_at: Date.now(),
      updated_at: Date.now(),
      project_id: null,
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
    appCommandHandlerRef.current = (command): void => {
      if (command === 'open-settings') {
        setSettingsInitialSection('general')
        setIsSettingsOpen(true)
      } else if (command === 'new-chat') {
        void handleNewConversation(null)
      } else if (command === 'open-project') {
        void handleOpenProject(false)
      }
    }
  })

  const handleMoveConversation = async (input: MoveConversationInput): Promise<void> => {
    if (busyConversationIds.has(input.conversationId)) return
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

  const handleRemoveProject = async (id: string): Promise<void> => {
    if (
      conversations.some(
        (conversation) => conversation.project_id === id && busyConversationIds.has(conversation.id)
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
    (message: string): void => {
      const notificationsEnabled = settings.notificationsEnabled ?? true

      // Only notify when user is away from the app
      if (!notificationsEnabled || document.hasFocus()) return

      void window.api.notification.show({
        body: message,
        silent: !(settings.notificationSoundEnabled ?? false)
      })
    },
    [settings.notificationSoundEnabled, settings.notificationsEnabled]
  )

  const handleConversationResponseComplete = useCallback(
    (conversationId: string | null, message: string): void => {
      handleResponseComplete(message)
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
    isAgentBusy: hasActiveConversationRuns,
    onTitleApplied: (conversationId, title) => {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
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
  })
  const currentGroup = groups.find((group) => group.id === currentGroupId)
  const currentGroupSession = currentGroup?.agentSessions.find(
    (session) => session.id === currentGroupSessionId
  )
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
  const titleBarContext = currentGroupId
    ? currentGroupSession?.title || currentGroup?.title || 'Group chat'
    : currentConversationId
      ? currentConversation?.title || 'Conversation'
      : null
  const historyWorkspaceFolder =
    activeProject?.folder_path ?? currentConversation?.home_workspace_root ?? null
  const historyReadOnly = !activeProject && Boolean(currentConversation?.home_workspace_root)
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
          workspaceFolder={panelProject?.folder_path ?? null}
          projectName={panelProject?.name ?? null}
          onOpenProject={() => handleOpenProject(true)}
          onUpdateConversationTitle={handleUpdateConversationTitle}
          onConversationCreated={handleConversationCreated}
          selectedModel={selectedModel}
          planningModelId={settings.planningModelId}
          onModelChange={handleModelChange}
          onTokenCountUpdate={(current, max) => {
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
          commandPermissionMode={settings.commandPermissionMode ?? 'agent-decides'}
          userLocation={userLocation}
          onResponseComplete={(message) =>
            handleConversationResponseComplete(panelConversationId, message)
          }
          onBusyStateChange={handleConversationBusyStateChange}
          fastModelName={fastModelName !== currentModelName ? fastModelName : undefined}
          ollamaThinkingEnabled={settings.ollamaThinkingEnabled ?? true}
          openRouterThinkingEnabled={settings.openRouterThinkingEnabled ?? false}
          onToggleOllamaThinking={() => {
            const updatedSettings = {
              ...settings,
              ollamaThinkingEnabled: !(settings.ollamaThinkingEnabled ?? true)
            }
            setSettings(updatedSettings)
            window.api.settings.save(updatedSettings)
          }}
          onToggleOpenRouterThinking={() => {
            const updatedSettings = {
              ...settings,
              openRouterThinkingEnabled: !(settings.openRouterThinkingEnabled ?? false)
            }
            setSettings(updatedSettings)
            window.api.settings.save(updatedSettings)
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
          {appIconPath && <img src={appIconPath} alt="" className="app-loading-icon" />}
          <span className="app-loading-name">SideKick</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`app platform-${platform}${isWindowFullScreen ? ' window-fullscreen' : ''}`}>
      <div className="title-bar">
        <div className="title-bar-left">
          {appIconPath && <img src={appIconPath} alt="SideKick" className="title-bar-icon" />}
          {titleBarContext && (
            <>
              <span className="title-bar-divider">/</span>
              <span className="title-bar-context">{titleBarContext}</span>
            </>
          )}
        </div>
        <div className="title-bar-right">
          <div className="title-bar-actions">
            {!currentGroupId && (
              <ContextIndicator
                currentTokens={tokenCounts.current}
                maxTokens={tokenCounts.max}
                selectedModel={selectedModel}
                model={selectedPinnedModel}
                autoCompactEnabled={settings.autoCompactEnabled ?? true}
                autoCompactThreshold={settings.autoCompactThreshold ?? 0.8}
                conversationCost={conversationCost}
              />
            )}
            {currentGroupSession && groupAgentContext?.sessionId === currentGroupSession.id && (
              <ContextIndicator
                currentTokens={groupAgentContext.currentTokens}
                maxTokens={groupAgentContext.maxTokens}
                selectedModel={groupAgentContext.selectedModel}
                model={groupAgentContext.model}
                autoCompactEnabled={settings.autoCompactEnabled ?? true}
                autoCompactThreshold={settings.autoCompactThreshold ?? 0.8}
              />
            )}
            <button
              className="theme-toggle-button"
              onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
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
          conversations={conversations}
          projects={projects}
          groups={groups}
          currentConversationId={currentConversationId}
          currentGroupId={currentGroupId}
          currentGroupSessionId={currentGroupSessionId}
          isCollapsed={isSidebarCollapsed}
          busyConversationIds={busyConversationIds}
          unreadConversationIds={unreadConversationIds}
          onSelectConversation={handleSelectConversation}
          onSelectGroup={(id) => void handleSelectGroup(id)}
          onSelectGroupSession={(groupId, sessionId) =>
            void handleSelectGroupSession(groupId, sessionId)
          }
          onToggleCollapsed={() => setIsSidebarCollapsed((prev) => !prev)}
          onNewConversation={(projectId) => void handleNewConversation(projectId)}
          onNewGroup={() => setIsGroupSetupOpen(true)}
          onOpenProject={() => void handleOpenProject(false)}
          onDeleteConversation={handleDeleteConversation}
          onDeleteGroup={(id) => void handleDeleteGroup(id)}
          onDeleteAllConversations={handleDeleteAllConversations}
          onForkConversation={handleForkConversation}
          onRenameConversation={handleUpdateConversationTitle}
          onRenameGroup={(id, title) => void handleRenameGroup(id, title)}
          onRenameGroupSession={(id, title) => void handleRenameGroupSession(id, title)}
          onMoveConversation={(input) => void handleMoveConversation(input)}
          onRenameProject={(id, name) => void handleRenameProject(id, name)}
          onToggleProjectPin={(id, pinned) => void handleToggleProjectPin(id, pinned)}
          onRemoveProject={(id) => void handleRemoveProject(id)}
        />
        <div className="conversation-panel-stack">
          {currentGroupId && (
            <GroupChatPanel
              groupId={currentGroupId}
              focusedSessionId={currentGroupSessionId}
              onFocusSession={(sessionId) => {
                setGroupAgentContext(null)
                setCurrentGroupSessionId(sessionId)
                if (sessionId) markGroupSessionRead(currentGroupId!, sessionId)
              }}
              pinnedModels={pinnedModels}
              autoCompactEnabled={settings.autoCompactEnabled ?? true}
              autoCompactThreshold={settings.autoCompactThreshold ?? 0.8}
              onFocusedSessionContextChange={setGroupAgentContext}
              onOpenModelSearch={() => {
                setSettingsInitialSection('providers')
                setIsSettingsOpen(true)
              }}
            />
          )}
          {!currentGroupId &&
            !currentConversationId &&
            renderConversationPanel(null, draftPanelKey, true)}
          {mountedConversationIds.map((id) => {
            const conversation = conversations.find((candidate) => candidate.id === id)
            if (!conversation) return null
            return renderConversationPanel(
              conversation,
              conversationPanelKeys[id] ?? `conversation:${id}`,
              !currentGroupId && currentConversationId === id
            )
          })}
        </div>
        {!currentGroupId && (
          <ActivityPanel
            isPinned={isActivityPanelPinned}
            onTogglePin={() => setIsActivityPanelPinned((prev) => !prev)}
            focusChainTodos={
              currentConversationId
                ? focusChainTodosByConversation[currentConversationId] || []
                : []
            }
            workspaceFolder={activeProject?.folder_path ?? null}
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
        )}
      </main>

      <GroupSetupDialog
        isOpen={isGroupSetupOpen}
        projects={projects}
        models={pinnedModels}
        selectedModelId={selectedModel}
        onCancel={() => setIsGroupSetupOpen(false)}
        onCreate={handleCreateGroup}
      />

      <AppUpdateToast />

      {isSettingsOpen && (
        <SettingsModal
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setIsSettingsOpen(false)}
          initialSection={settingsInitialSection}
        />
      )}
    </div>
  )
}

export default App
