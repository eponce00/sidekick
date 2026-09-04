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
  save: (settings: ProviderSettings) => Promise<{ success: boolean; error?: string }>
  load: () => Promise<PublicProviderSettings | null>
}

interface ProvidersAPI {
  complete: (request: ProviderChatRequest) => Promise<ProviderCompletionResult>
  discoverModels: (request: ProviderDiscoveryRequest) => Promise<ProviderDiscoveryResult>
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
  search: (query: string) => Promise<import('../shared/projects').ProjectConversation[]>
  create: (
    title: string,
    projectId?: string | null,
    titleSource?: import('../shared/conversationTitles').ConversationTitleSource
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
  delete: (id: string) => Promise<{ success: boolean }>
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
  startConversation: (
    input: import('../shared/agentRunApi').StartConversationAgentRunInput
  ) => Promise<import('../shared/agentRunApi').StartConversationAgentRunResult>
  stop: (runId: string) => Promise<{ stopped: boolean }>
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

interface AppAPI {
  platform: import('../shared/platform').DesktopPlatform
  getIconPath: () => Promise<string>
  onCommand: (callback: (command: import('../shared/appCommands').AppCommand) => void) => () => void
}

interface ClipboardAPI {
  writeText: (text: string) => Promise<{ success: boolean; error?: string }>
}

interface WorkspaceAPI {
  selectFolder: () => Promise<{ canceled: boolean; path: string | null }>
  selectContextAttachments: (workspaceRoot: string) => Promise<{
    ok: boolean
    canceled: boolean
    attachments: import('../shared/messageContextAttachments').MessageContextAttachment[]
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
  readFile: (
    workspaceRoot: string,
    filePath: string,
    startLine?: number,
    endLine?: number
  ) => Promise<{ ok: boolean; content: string | null; totalLines?: number; error?: string }>
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
  onFilesChanged: (callback: () => void) => () => void
}

interface CollaborationAPI {
  listGroups: () => Promise<import('../shared/collaboration').CollaborationGroup[]>
  getGroup: (
    id: string
  ) => Promise<import('../shared/collaboration').CollaborationGroupDetail | null>
  getAgentSession: (
    id: string
  ) => Promise<import('../shared/collaboration').CollaborationAgentSession | null>
  updateAgentSession: (
    id: string,
    input: import('../shared/collaboration').UpdateCollaborationAgentSessionInput
  ) => Promise<import('../shared/collaboration').CollaborationAgentSession>
  markGroupRead: (id: string) => Promise<{ success: boolean }>
  markAgentSessionRead: (id: string) => Promise<{ success: boolean }>
  listAgentSessionMessages: (
    sessionId: string,
    afterCreatedAt?: number
  ) => Promise<import('../shared/collaboration').CollaborationAgentSessionMessage[]>
  listEvents: (
    groupId: string,
    afterSeq?: number
  ) => Promise<import('../shared/collaboration').CollaborationEvent[]>
  createGroup: (
    input: import('../shared/collaboration').CreateCollaborationGroupInput
  ) => Promise<import('../shared/collaboration').CollaborationGroupDetail>
  updateGroup: (
    id: string,
    input: import('../shared/collaboration').UpdateCollaborationGroupInput
  ) => Promise<import('../shared/collaboration').CollaborationGroup>
  deleteGroup: (id: string) => Promise<void>
  addParticipant: (
    input: import('../shared/collaboration').AddCollaborationParticipantInput
  ) => Promise<import('../shared/collaboration').CollaborationParticipant>
  removeParticipant: (groupId: string, participantId: string) => Promise<void>
  updateParticipant: (
    participantId: string,
    input: import('../shared/collaboration').UpdateCollaborationParticipantInput
  ) => Promise<import('../shared/collaboration').CollaborationParticipant>
  updateParticipants: (
    input: import('../shared/collaboration').UpdateCollaborationParticipantsInput
  ) => Promise<import('../shared/collaboration').CollaborationParticipant[]>
  sendMessage: (input: import('../shared/collaboration').SendCollaborationMessageInput) => Promise<{
    event: import('../shared/collaboration').CollaborationEvent
    mission: import('../shared/collaboration').CollaborationMission
  }>
  rewriteMessage: (
    input: import('../shared/collaboration').RewriteCollaborationMessageInput
  ) => Promise<import('../shared/collaboration').RewriteCollaborationMessageResult>
  pauseMission: (
    missionId: string
  ) => Promise<import('../shared/collaboration').CollaborationMission>
  resumeMission: (
    missionId: string
  ) => Promise<import('../shared/collaboration').CollaborationMission>
  stopMission: (
    missionId: string
  ) => Promise<import('../shared/collaboration').CollaborationMission>
  stopParticipant: (
    missionId: string,
    participantId: string
  ) => Promise<import('../shared/collaboration').CollaborationParticipantRun>
  onChanged: (
    callback: (change: import('../shared/collaboration').CollaborationChangedEvent) => void
  ) => () => void
}

export interface DesktopApi {
  providers: ProvidersAPI
  settings: SettingsAPI
  memory: MemoryAPI
  pinnedModels: PinnedModelsAPI
  conversations: ConversationsAPI
  projects: ProjectsAPI
  agentRuns: AgentRunsAPI
  conversationGoals: import('../shared/conversationGoals').ConversationGoalsAPI
  collaboration: CollaborationAPI
  mcp: McpAPI
  permissions: PermissionsAPI
  window: WindowAPI
  notification: NotificationAPI
  app: AppAPI
  appUpdates: import('../shared/appUpdates').AppUpdatesAPI
  support: import('../shared/supportDiagnostics').SupportDiagnosticsAPI
  clipboard: ClipboardAPI
  workspace: WorkspaceAPI
}

declare global {
  interface Window {
    api: DesktopApi
  }
}
