import type { PinnedModel } from '../shared/models'
import type { ProviderSettings, PublicProviderSettings } from '../shared/settings'
import type {
  ProviderChatRequest,
  ProviderCompletionResult,
  ProviderContextResult,
  ProviderDiscoveryRequest,
  ProviderDiscoveryResult,
  ProviderGenerationStatsResult,
  ProviderHealthChangedEvent,
  ProviderTarget
} from '../shared/providerRuntime'

interface SettingsAPI {
  selectOfficeInterpreter: () => Promise<{ canceled: boolean; path?: string; error?: string }>
  /** Replaces the settings it names; every other setting keeps what is stored. */
  save: (changes: Partial<ProviderSettings>) => Promise<{ success: boolean; error?: string }>
  load: () => Promise<PublicProviderSettings | null>
  /** Settings were changed outside this window, such as by the `sidekick` CLI. */
  onChanged: (callback: () => void) => () => void
}

interface CommandLineAPI {
  status: () => Promise<import('../shared/commandLineTool').CommandLineToolStatus>
  install: () => Promise<import('../shared/commandLineTool').CommandLineToolInstallResult>
}

interface ProvidersAPI {
  complete: (request: ProviderChatRequest) => Promise<ProviderCompletionResult>
  discoverModels: (request: ProviderDiscoveryRequest) => Promise<ProviderDiscoveryResult>
  probe: (
    target: import('../shared/providerRuntime').ProviderTarget,
    includeVision?: boolean
  ) => Promise<import('../shared/providerRuntime').ProviderProbeResult>
  cancelProbe: () => Promise<void>
  resolveContext: (target: ProviderTarget) => Promise<ProviderContextResult>
  getGenerationStats: (
    target: ProviderTarget,
    generationId: string
  ) => Promise<ProviderGenerationStatsResult>
  onHealthChanged: (callback: (change: ProviderHealthChangedEvent) => void) => () => void
}

interface PinnedModelsAPI {
  save: (models: PinnedModel[]) => Promise<{ success: boolean }>
  load: () => Promise<PinnedModel[]>
}

interface MemoryAPI {
  get: (
    workspaceRoot?: string
  ) => Promise<{ ok: boolean; content: string; updatedAt: number | null; error?: string }>
  save: (
    workspaceRoot: string,
    content: string
  ) => Promise<{ ok: boolean; content: string; updatedAt: number | null; error?: string }>
}

interface ConversationsAPI {
  list: () => Promise<import('../shared/projects').ProjectConversation[]>
  /** A chat's saved messages changed outside this window, such as from the user's phone. */
  onMessagesChanged: (callback: (conversationId: string) => void) => () => void
  search: (query: string) => Promise<import('../shared/projects').ProjectConversation[]>
  create: (
    title: string,
    projectId?: string | null,
    titleSource?: import('../shared/conversationTitles').ConversationTitleSource,
    /** The model the new chat starts on and keeps. */
    modelId?: string
  ) => Promise<
    import('../shared/projects').ProjectConversation & {
      title_source: import('../shared/conversationTitles').ConversationTitleSource
      title_version: number
    }
  >
  fork: (
    input: import('../shared/projects').ForkConversationInput
  ) => Promise<import('../shared/projects').ProjectConversation>
  update: (
    id: string,
    title: string,
    options?: import('../shared/conversationTitles').ConversationTitleUpdateOptions
  ) => Promise<{ success: boolean; updatedAt?: number }>
  setPinned: (id: string, pinned: boolean) => Promise<{ success: boolean }>
  /** Changes the model of this chat only. */
  setModel: (id: string, modelId: string) => Promise<{ success: boolean }>
  listTitleBackfillCandidates: (
    limit?: number
  ) => Promise<import('../shared/conversationTitles').ConversationTitleBackfillCandidate[]>
  claimTitleBackfill: (
    input: import('../shared/conversationTitles').ConversationTitleBackfillIdentity
  ) => Promise<{ claimed: boolean }>
  completeTitleBackfill: (
    input: import('../shared/conversationTitles').CompleteConversationTitleBackfillInput
  ) => Promise<{ applied: boolean }>
  failTitleBackfill: (
    input: import('../shared/conversationTitles').FailConversationTitleBackfillInput
  ) => Promise<{ recorded: boolean }>
  preserveTitle: (
    input: import('../shared/conversationTitles').ConversationTitleBackfillIdentity
  ) => Promise<{ preserved: boolean }>
  markRead: (id: string) => Promise<{ success: boolean }>
  delete: (id: string) => Promise<{
    success: boolean
    worktreeCleanup?: import('../shared/worktrees').RemoveManagedWorktreeResult
  }>
  /** Removes a chat left without anything said in it; one that was used stays. */
  discardIfUntouched: (id: string) => Promise<{ discarded: boolean }>
  deleteAll: () => Promise<{ success: boolean }>
  getMessages: (
    conversationId: string
  ) => Promise<
    Array<{ id: string; role: string; content: string; timestamp: number; [key: string]: unknown }>
  >
  getLatestCompaction: (
    conversationId: string
  ) => Promise<import('../shared/conversationCompactions').ConversationCompactionRecord | null>
  saveCompaction: (
    input: import('../shared/conversationCompactions').SaveConversationCompactionInput
  ) => Promise<import('../shared/conversationCompactions').ConversationCompactionRecord>
  saveMessage: (message: Record<string, unknown>) => Promise<{ success: boolean }>
  updateMessage: (message: Record<string, unknown>) => Promise<{ success: boolean }>
  deleteMessagesAfter: (conversationId: string, timestamp: number) => Promise<{ success: boolean }>
  saveSkills: (conversationId: string, skillIds: string[]) => Promise<{ success: boolean }>
  loadSkills: (conversationId: string) => Promise<string[] | null>
}

interface ProjectsAPI {
  list: () => Promise<import('../shared/projects').Project[]>
  create: (folderPath: string, name?: string) => Promise<import('../shared/projects').Project>
  update: (
    id: string,
    input: { name?: string; isPinned?: boolean }
  ) => Promise<import('../shared/projects').Project>
  remove: (id: string) => Promise<{ success: boolean }>
  getConversationContext: (
    conversationId: string
  ) => Promise<import('../shared/projects').ConversationProjectContext>
  moveConversation: (
    input: import('../shared/projects').MoveConversationInput
  ) => Promise<import('../shared/projects').MoveConversationResult>
}

interface AgentRunsAPI {
  browserWorkspace: (
    input: import('../shared/browserWorkspace').BrowserWorkspaceRequest
  ) => Promise<import('../shared/browserWorkspace').BrowserWorkspaceState | null>
  startConversation: (
    input: import('../shared/agentRunApi').StartConversationAgentRunInput
  ) => Promise<import('../shared/agentRunApi').StartConversationAgentRunResult>
  stop: (runId: string) => Promise<{ stopped: boolean }>
  /** Other agents writing in the folder this conversation works in. */
  workspaceOccupants: (
    conversationId: string
  ) => Promise<import('../shared/worktrees').WorkspaceOccupant[]>
  events: (
    runId: string,
    afterSequence?: number
  ) => Promise<import('../shared/agentRunApi').AgentRunEventsResult>
  latest: (threadId: string) => Promise<import('../shared/agentRunApi').AgentRunEventsResult>
  beginBrowserHumanTakeover: (
    interactionId: string
  ) => Promise<import('../shared/agentRunApi').BrowserHumanTakeoverSnapshot>
  completeBrowserHumanTakeover: (
    interactionId: string
  ) => Promise<import('../shared/agentRunApi').BrowserHumanTakeoverSnapshot>
  resolveInteraction: (
    input: import('../shared/agentRunApi').ResolveAgentInteractionInput
  ) => Promise<{ success: boolean }>
  steer: (
    input: import('../shared/agentRunApi').SteerConversationRunInput
  ) => Promise<import('../shared/agentRunApi').SteerConversationRunResult>
  admissionsList: (
    conversationId: string
  ) => Promise<import('../shared/agentRunApi').PromptAdmissionsResult>
  admissionsReplace: (
    input: import('../shared/agentRunApi').ReplacePromptAdmissionsInput
  ) => Promise<import('../shared/agentRunApi').PromptAdmissionsResult>
  admissionsTakeNext: (
    conversationId: string
  ) => Promise<import('../shared/agentRunApi').PromptAdmissionItem | null>
  onEvent: (
    callback: (change: import('../shared/agentRunApi').AgentRunChangedEvent) => void
  ) => () => void
}

interface McpAPI {
  listTools: () => Promise<import('../shared/types').McpListResult>
  authenticate: (serverId: string) => Promise<import('../shared/types').McpListResult>
  /** Shows the stored connector in a native dialog and records approval of exactly that content. */
  approve: (serverId: string) => Promise<import('../shared/types').McpListResult>
  disconnect: (serverId: string) => Promise<import('../shared/types').McpListResult>
}

interface PermissionsAPI {
  authorize: (
    operation: import('../shared/permissions').PermissionOperation
  ) => Promise<import('../shared/permissions').PermissionAuthorization>
  listAudit: () => Promise<import('../shared/permissions').PermissionAuditRecord[]>
}

interface WindowAPI {
  minimize: () => void
  maximize: () => void
  close: () => void
  isMaximized: () => Promise<boolean>
  isFullScreen: () => Promise<boolean>
  onMaximizedChange: (callback: (maximized: boolean) => void) => () => void
  onFullScreenChange: (callback: (fullScreen: boolean) => void) => () => void
}

interface NotificationAPI {
  show: (
    request: import('../shared/desktopNotifications').DesktopNotificationRequest
  ) => Promise<{ ok: boolean; error?: string }>
}

interface SiteIconsAPI {
  /** The linked site's own icon as a data URL, or null. Never a third-party service. */
  get: (url: string) => Promise<{ dataUrl: string | null }>
}

interface AppAPI {
  platform: import('../shared/platform').DesktopPlatform
  onCommand: (callback: (command: import('../shared/appCommands').AppCommand) => void) => () => void
  onOpenConversation: (callback: (conversationId: string) => void) => () => void
  /** SideKick's agent asked the user to enter a provider's key in Settings. */
  onOpenProviderKey: (callback: (providerInstanceId: string) => void) => () => void
  /** SideKick's agent asked the user to add or update a credential in Settings. */
  onOpenCredential: (
    callback: (request: import('../shared/credentials').CredentialRequest) => void
  ) => () => void
}

interface ClipboardAPI {
  writeText: (text: string) => Promise<{ success: boolean; error?: string }>
}

interface WorkspaceAPI {
  selectFolder: () => Promise<{ canceled: boolean; path: string | null }>
  selectContextAttachments: (workspaceRoot: string) => Promise<{
    ok: boolean
    canceled: boolean
    attachments: import('../shared/messageContextAttachments').ProjectContextAttachment[]
    error?: string
  }>
  getPath: () => Promise<string | null>
  getRules: (
    workspaceRoot?: string,
    scopeId?: string
  ) => Promise<{
    ok: boolean
    content: string
    sources: string[]
    sourceDetails: import('../shared/workspaceInstructions').WorkspaceInstructionSource[]
    truncated: boolean
    error?: string
  }>
  resolveRulesForPath: (
    workspaceRoot: string,
    targetPath: string,
    scopeId: string,
    isDirectory?: boolean,
    mutation?: boolean
  ) => Promise<
    import('../shared/workspaceInstructions').WorkspaceInstructionResolution & {
      ok: boolean
      error?: string
    }
  >
  resetRuleScope: (scopeId: string) => Promise<{ ok: boolean }>
  clearRuleScope: (scopeId: string) => Promise<{ ok: boolean }>
  setPath: (folderPath: string | null) => Promise<{ success: boolean }>
  listFiles: (
    workspaceRoot: string,
    subPath?: string,
    glob?: string
  ) => Promise<{ ok: boolean; files: string[]; error?: string }>
  /** Saved prompts from the project's and your own prompt folders, offered as `/` commands. */
  listPrompts: (workspaceRoot: string | null) => Promise<{
    ok: boolean
    prompts: import('../shared/savedPrompts').SavedPrompt[]
    error?: string
  }>
  readFile: (
    workspaceRoot: string,
    filePath: string,
    startLine?: number,
    endLine?: number
  ) => Promise<{ ok: boolean; content: string | null; totalLines?: number; error?: string }>
  readImage: (
    workspaceRoot: string,
    filePath: string
  ) => Promise<{ ok: boolean; dataUrl: string | null; error?: string }>
  resolveFileReference: (
    fileReference: string,
    workspaceRoot?: string
  ) => Promise<{ ok: boolean; matches: string[] }>
  searchFiles: (
    workspaceRoot: string,
    searchPath: string,
    regexPattern: string,
    filePattern?: string,
    contextLines?: number
  ) => Promise<{
    ok: boolean
    error?: string
    output: string
    matchCount: number
    matchedFiles: string[]
  }>
  trashFile: (
    workspaceRoot: string,
    filePath: string,
    authorization: import('../shared/types').WorkspaceMutationAuthorization
  ) => Promise<{ ok: boolean; error?: string }>
  gitAvailable: () => Promise<boolean>
  beginHistoryCapture: (
    workspaceRoot: string,
    conversationId: string,
    agentMessageId: string
  ) => Promise<import('../shared/checkpointTitles').HistoryCaptureResult>
  discardHistoryCapture: (captureId: string) => Promise<{ ok: boolean }>
  createCheckpoint: (
    workspaceRoot: string,
    message: string,
    captureId?: string
  ) => Promise<{
    ok: boolean
    hash: string | null
    changeCount?: number
    captureVersion?: number
    error?: string
  }>
  restoreCheckpoint: (
    workspaceRoot: string,
    hash: string,
    authorization: import('../shared/types').CheckpointMutationAuthorization
  ) => Promise<import('../shared/checkpointTitles').HistoryMutationResult>
  hardResetCheckpoint: (
    workspaceRoot: string,
    hash: string,
    authorization: import('../shared/types').CheckpointMutationAuthorization
  ) => Promise<import('../shared/checkpointTitles').HistoryMutationResult>
  rewindToBeforeCheckpoint: (
    workspaceRoot: string,
    hash: string,
    authorization: import('../shared/types').CheckpointMutationAuthorization
  ) => Promise<
    import('../shared/checkpointTitles').HistoryMutationResult & { parentHash: string | null }
  >
  listCheckpoints: (
    workspaceRoot: string
  ) => Promise<import('../shared/checkpointTitles').CheckpointListResult>
  getCheckpointDiff: (
    workspaceRoot: string,
    hash: string
  ) => Promise<{ ok: boolean; diff: string; error?: string }>
  renameCheckpoint: (
    workspaceRoot: string,
    hash: string,
    newMessage: string,
    source?: import('../shared/checkpointTitles').CheckpointTitleSource
  ) => Promise<{ ok: boolean; error?: string }>
  claimCheckpointTitleBackfill: (
    input: import('../shared/checkpointTitles').CheckpointTitleIdentity
  ) => Promise<{ claimed: boolean }>
  completeCheckpointTitleBackfill: (
    input: import('../shared/checkpointTitles').CompleteCheckpointTitleBackfillInput
  ) => Promise<{ applied: boolean }>
  failCheckpointTitleBackfill: (
    input: import('../shared/checkpointTitles').FailCheckpointTitleBackfillInput
  ) => Promise<{ recorded: boolean }>
  getCheckpointTitleContext: (
    workspaceRoot: string,
    hash: string,
    timestamp: number
  ) => Promise<import('../shared/checkpointTitles').CheckpointTitleContext | null>
  openFolder: (folderPath: string, workspaceRoot?: string) => Promise<void>
  openFile: (filePath: string, workspaceRoot?: string) => Promise<void>
  openFileReference: (
    fileReference: string,
    workspaceRoot?: string
  ) => Promise<{
    ok: boolean
    status: 'opened' | 'choose' | 'not_found'
    path?: string
    matches?: string[]
    error?: string
  }>
  revealFile: (filePath: string, workspaceRoot?: string) => Promise<void>
  showPathMenu: (filePath: string, workspaceRoot?: string, isDirectory?: boolean) => Promise<void>
  /** Calls back when files under the folder change; returns the function that stops watching. */
  watchFiles: (workspaceRoot: string, callback: () => void) => () => void
}

export interface DesktopApi {
  providers: ProvidersAPI
  settings: SettingsAPI
  commandLine: CommandLineAPI
  memory: MemoryAPI
  pinnedModels: PinnedModelsAPI
  conversations: ConversationsAPI
  projects: ProjectsAPI
  worktrees: import('../shared/worktrees').WorktreesAPI
  menus: import('../shared/appMenus').AppMenusAPI
  agentRuns: AgentRunsAPI
  conversationGoals: import('../shared/conversationGoals').ConversationGoalsAPI
  schedules: import('../shared/schedules').SchedulesAPI
  companion: import('../shared/companion').CompanionAPI
  sessions: import('../shared/sessions').SessionsAPI
  terminal: import('../shared/terminalSessions').TerminalAPI
  mcp: McpAPI
  permissions: PermissionsAPI
  browserNetwork: import('../shared/browserNetwork').BrowserNetworkAPI
  credentials: import('../shared/credentials').CredentialsAPI
  pullRequests: import('../shared/pullRequests').PullRequestsAPI
  window: WindowAPI
  notification: NotificationAPI
  siteIcons: SiteIconsAPI
  app: AppAPI
  appUpdates: import('../shared/appUpdates').AppUpdatesAPI
  voice: import('../shared/voice').VoiceAPI
  support: import('../shared/supportDiagnostics').SupportDiagnosticsAPI
  clipboard: ClipboardAPI
  workspace: WorkspaceAPI
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
