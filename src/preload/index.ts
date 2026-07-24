import { contextBridge, ipcRenderer } from 'electron'
import { desktopPlatform } from '../shared/platform'
import { isAppCommand } from '../shared/appCommands'
import type { DesktopApi } from './api'

// Custom APIs for renderer
const api = {
  providers: {
    complete: (request: import('../shared/providerRuntime').ProviderChatRequest) =>
      ipcRenderer.invoke('providers:complete', request),
    discoverModels: (request: import('../shared/providerRuntime').ProviderDiscoveryRequest) =>
      ipcRenderer.invoke('providers:discoverModels', request),
    resolveContext: (target: import('../shared/providerRuntime').ProviderTarget) =>
      ipcRenderer.invoke('providers:resolveContext', target),
    calibrateEditing: (
      request: import('../shared/providerRuntime').ProviderEditingCalibrationRequest
    ) => ipcRenderer.invoke('providers:calibrateEditing', request),
    getGenerationStats: (
      target: import('../shared/providerRuntime').ProviderTarget,
      generationId: string
    ) => ipcRenderer.invoke('providers:getGenerationStats', target, generationId),
    onHealthChanged: (
      callback: (change: import('../shared/providerRuntime').ProviderHealthChangedEvent) => void
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        change: import('../shared/providerRuntime').ProviderHealthChangedEvent
      ): void => callback(change)
      ipcRenderer.on('providers:healthChanged', listener)
      return () => ipcRenderer.removeListener('providers:healthChanged', listener)
    }
  },
  settings: {
    save: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
    load: () => ipcRenderer.invoke('settings:load')
  },
  memory: {
    get: (workspaceRoot?: string) => ipcRenderer.invoke('memory:get', workspaceRoot),
    save: (workspaceRoot: string, content: string) =>
      ipcRenderer.invoke('memory:save', workspaceRoot, content)
  },
  pinnedModels: {
    save: (models: unknown) => ipcRenderer.invoke('pinnedModels:save', models),
    load: () => ipcRenderer.invoke('pinnedModels:load')
  },
  conversations: {
    list: () => ipcRenderer.invoke('conversations:list'),
    search: (query: string) => ipcRenderer.invoke('conversations:search', query),
    create: (
      title: string,
      projectId?: string | null,
      titleSource?: import('../shared/conversationTitles').ConversationTitleSource
    ) => ipcRenderer.invoke('conversations:create', title, projectId, titleSource),
    fork: (id: string, timestamp?: number) =>
      ipcRenderer.invoke('conversations:fork', id, timestamp),
    update: (
      id: string,
      title: string,
      options?: import('../shared/conversationTitles').ConversationTitleUpdateOptions
    ) => ipcRenderer.invoke('conversations:update', id, title, options),
    listTitleBackfillCandidates: (limit?: number) =>
      ipcRenderer.invoke('conversations:listTitleBackfillCandidates', limit),
    claimTitleBackfill: (
      input: import('../shared/conversationTitles').ConversationTitleBackfillIdentity
    ) => ipcRenderer.invoke('conversations:claimTitleBackfill', input),
    completeTitleBackfill: (
      input: import('../shared/conversationTitles').CompleteConversationTitleBackfillInput
    ) => ipcRenderer.invoke('conversations:completeTitleBackfill', input),
    failTitleBackfill: (
      input: import('../shared/conversationTitles').FailConversationTitleBackfillInput
    ) => ipcRenderer.invoke('conversations:failTitleBackfill', input),
    preserveTitle: (
      input: import('../shared/conversationTitles').ConversationTitleBackfillIdentity
    ) => ipcRenderer.invoke('conversations:preserveTitle', input),
    markRead: (id: string) => ipcRenderer.invoke('conversations:markRead', id),
    delete: (id: string) => ipcRenderer.invoke('conversations:delete', id),
    deleteAll: () => ipcRenderer.invoke('conversations:deleteAll'),
    getMessages: (conversationId: string) =>
      ipcRenderer.invoke('conversations:getMessages', conversationId),
    getLatestCompaction: (conversationId: string) =>
      ipcRenderer.invoke('conversations:getLatestCompaction', conversationId),
    saveCompaction: (
      input: import('../shared/conversationCompactions').SaveConversationCompactionInput
    ) => ipcRenderer.invoke('conversations:saveCompaction', input),
    saveMessage: (message: Record<string, unknown>) =>
      ipcRenderer.invoke('conversations:saveMessage', message),
    updateMessage: (message: Record<string, unknown>) =>
      ipcRenderer.invoke('conversations:updateMessage', message),
    deleteMessagesAfter: (conversationId: string, timestamp: number) =>
      ipcRenderer.invoke('conversations:deleteMessagesAfter', conversationId, timestamp),
    saveSkills: (conversationId: string, skillIds: string[]) =>
      ipcRenderer.invoke('conversations:saveSkills', conversationId, skillIds),
    loadSkills: (conversationId: string) =>
      ipcRenderer.invoke('conversations:loadSkills', conversationId)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (folderPath: string, name?: string) =>
      ipcRenderer.invoke('projects:create', folderPath, name),
    update: (id: string, input: { name?: string; isPinned?: boolean }) =>
      ipcRenderer.invoke('projects:update', id, input),
    remove: (id: string) => ipcRenderer.invoke('projects:remove', id),
    getConversationContext: (conversationId: string) =>
      ipcRenderer.invoke('projects:getConversationContext', conversationId),
    moveConversation: (input: import('../shared/projects').MoveConversationInput) =>
      ipcRenderer.invoke('projects:moveConversation', input)
  },
  agentRuns: {
    startConversation: (input: import('../shared/agentRunApi').StartConversationAgentRunInput) =>
      ipcRenderer.invoke('agentRuns:startConversation', input),
    stop: (runId: string) => ipcRenderer.invoke('agentRuns:stop', runId),
    events: (runId: string, afterSequence?: number) =>
      ipcRenderer.invoke('agentRuns:events', runId, afterSequence),
    latest: (threadId: string) => ipcRenderer.invoke('agentRuns:latest', threadId),
    resolveInteraction: (input: import('../shared/agentRunApi').ResolveAgentInteractionInput) =>
      ipcRenderer.invoke('agentRuns:resolveInteraction', input),
    onEvent: (callback: (change: import('../shared/agentRunApi').AgentRunChangedEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        change: import('../shared/agentRunApi').AgentRunChangedEvent
      ): void => callback(change)
      ipcRenderer.on('agentRuns:event', listener)
      return () => ipcRenderer.removeListener('agentRuns:event', listener)
    }
  },
  conversationGoals: {
    current: (conversationId: string) =>
      ipcRenderer.invoke('conversationGoals:current', conversationId),
    create: (input: import('../shared/conversationGoals').CreateConversationGoalInput) =>
      ipcRenderer.invoke('conversationGoals:create', input),
    edit: (input: import('../shared/conversationGoals').UpdateConversationGoalInput) =>
      ipcRenderer.invoke('conversationGoals:edit', input),
    pause: (goalId: string) => ipcRenderer.invoke('conversationGoals:pause', goalId),
    resume: (goalId: string) => ipcRenderer.invoke('conversationGoals:resume', goalId),
    clear: (goalId: string) => ipcRenderer.invoke('conversationGoals:clear', goalId),
    onChanged: (
      callback: (change: import('../shared/conversationGoals').ConversationGoalChangedEvent) => void
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        change: import('../shared/conversationGoals').ConversationGoalChangedEvent
      ): void => callback(change)
      ipcRenderer.on('conversationGoals:changed', listener)
      return () => ipcRenderer.removeListener('conversationGoals:changed', listener)
    }
  },
  collaboration: {
    listGroups: () => ipcRenderer.invoke('collaboration:listGroups'),
    getGroup: (id: string) => ipcRenderer.invoke('collaboration:getGroup', id),
    getAgentSession: (id: string) => ipcRenderer.invoke('collaboration:getAgentSession', id),
    updateAgentSession: (
      id: string,
      input: import('../shared/collaboration').UpdateCollaborationAgentSessionInput
    ) => ipcRenderer.invoke('collaboration:updateAgentSession', id, input),
    markGroupRead: (id: string) => ipcRenderer.invoke('collaboration:markGroupRead', id),
    markAgentSessionRead: (id: string) =>
      ipcRenderer.invoke('collaboration:markAgentSessionRead', id),
    listAgentSessionMessages: (sessionId: string, afterCreatedAt?: number) =>
      ipcRenderer.invoke('collaboration:listAgentSessionMessages', sessionId, afterCreatedAt),
    listEvents: (groupId: string, afterSeq?: number) =>
      ipcRenderer.invoke('collaboration:listEvents', groupId, afterSeq),
    createGroup: (input: import('../shared/collaboration').CreateCollaborationGroupInput) =>
      ipcRenderer.invoke('collaboration:createGroup', input),
    updateGroup: (
      id: string,
      input: import('../shared/collaboration').UpdateCollaborationGroupInput
    ) => ipcRenderer.invoke('collaboration:updateGroup', id, input),
    deleteGroup: (id: string) => ipcRenderer.invoke('collaboration:deleteGroup', id),
    addParticipant: (input: import('../shared/collaboration').AddCollaborationParticipantInput) =>
      ipcRenderer.invoke('collaboration:addParticipant', input),
    removeParticipant: (groupId: string, participantId: string) =>
      ipcRenderer.invoke('collaboration:removeParticipant', groupId, participantId),
    updateParticipant: (
      participantId: string,
      input: import('../shared/collaboration').UpdateCollaborationParticipantInput
    ) => ipcRenderer.invoke('collaboration:updateParticipant', participantId, input),
    updateParticipants: (
      input: import('../shared/collaboration').UpdateCollaborationParticipantsInput
    ) => ipcRenderer.invoke('collaboration:updateParticipants', input),
    sendMessage: (input: import('../shared/collaboration').SendCollaborationMessageInput) =>
      ipcRenderer.invoke('collaboration:sendMessage', input),
    rewriteMessage: (input: import('../shared/collaboration').RewriteCollaborationMessageInput) =>
      ipcRenderer.invoke('collaboration:rewriteMessage', input),
    pauseMission: (missionId: string) =>
      ipcRenderer.invoke('collaboration:pauseMission', missionId),
    resumeMission: (missionId: string) =>
      ipcRenderer.invoke('collaboration:resumeMission', missionId),
    stopMission: (missionId: string) => ipcRenderer.invoke('collaboration:stopMission', missionId),
    stopParticipant: (missionId: string, participantId: string) =>
      ipcRenderer.invoke('collaboration:stopParticipant', missionId, participantId),
    onChanged: (
      callback: (change: import('../shared/collaboration').CollaborationChangedEvent) => void
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        change: import('../shared/collaboration').CollaborationChangedEvent
      ): void => callback(change)
      ipcRenderer.on('collaboration:changed', listener)
      return () => ipcRenderer.removeListener('collaboration:changed', listener)
    }
  },
  mcp: {
    listTools: () => ipcRenderer.invoke('mcp:listTools'),
    authenticate: (serverId: string) => ipcRenderer.invoke('mcp:authenticate', serverId),
    disconnect: (serverId: string) => ipcRenderer.invoke('mcp:disconnect', serverId)
  },
  permissions: {
    authorize: (operation: import('../shared/permissions').PermissionOperation) =>
      ipcRenderer.invoke('permissions:authorize', operation),
    listAudit: () => ipcRenderer.invoke('permissions:listAudit')
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    isFullScreen: () => ipcRenderer.invoke('window:isFullScreen'),
    onMaximizedChange: (callback: (maximized: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, maximized: unknown): void => {
        if (typeof maximized === 'boolean') callback(maximized)
      }
      ipcRenderer.on('window:maximized-changed', listener)
      return () => ipcRenderer.removeListener('window:maximized-changed', listener)
    },
    onFullScreenChange: (callback: (fullScreen: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, fullScreen: unknown): void => {
        if (typeof fullScreen === 'boolean') callback(fullScreen)
      }
      ipcRenderer.on('window:fullscreen-changed', listener)
      return () => ipcRenderer.removeListener('window:fullscreen-changed', listener)
    }
  },
  notification: {
    show: (request: import('../shared/desktopNotifications').DesktopNotificationRequest) =>
      ipcRenderer.invoke('notification:show', request)
  },
  app: {
    platform: desktopPlatform(process.platform),
    getIconPath: (theme?: 'dark' | 'light') => ipcRenderer.invoke('app:getIconPath', theme),
    onCommand: (callback: (command: import('../shared/appCommands').AppCommand) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: unknown): void => {
        if (isAppCommand(command)) callback(command)
      }
      ipcRenderer.on('app:command', listener)
      return () => ipcRenderer.removeListener('app:command', listener)
    }
  },
  appUpdates: {
    getState: () => ipcRenderer.invoke('appUpdates:getState'),
    check: () => ipcRenderer.invoke('appUpdates:check'),
    openRelease: () => ipcRenderer.invoke('appUpdates:openRelease'),
    onState: (callback: (state: import('../shared/appUpdates').AppUpdateState) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        state: import('../shared/appUpdates').AppUpdateState
      ): void => callback(state)
      ipcRenderer.on('appUpdates:state', listener)
      return () => ipcRenderer.removeListener('appUpdates:state', listener)
    }
  },
  support: {
    export: () => ipcRenderer.invoke('support:exportDiagnostics')
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text)
  },
  workspace: {
    selectFolder: () => ipcRenderer.invoke('workspace:selectFolder'),
    getPath: () => ipcRenderer.invoke('workspace:getPath'),
    getRules: (workspaceRoot?: string, scopeId?: string) =>
      ipcRenderer.invoke('workspace:getRules', workspaceRoot, scopeId),
    resolveRulesForPath: (
      workspaceRoot: string,
      targetPath: string,
      scopeId: string,
      isDirectory?: boolean,
      mutation?: boolean
    ) =>
      ipcRenderer.invoke(
        'workspace:resolveRulesForPath',
        workspaceRoot,
        targetPath,
        scopeId,
        isDirectory,
        mutation
      ),
    resetRuleScope: (scopeId: string) => ipcRenderer.invoke('workspace:resetRuleScope', scopeId),
    clearRuleScope: (scopeId: string) => ipcRenderer.invoke('workspace:clearRuleScope', scopeId),
    setPath: (folderPath: string | null) => ipcRenderer.invoke('workspace:setPath', folderPath),
    listFiles: (workspaceRoot: string, subPath?: string, glob?: string) =>
      ipcRenderer.invoke('workspace:listFiles', workspaceRoot, subPath, glob),
    readFile: (workspaceRoot: string, filePath: string, startLine?: number, endLine?: number) =>
      ipcRenderer.invoke('workspace:readFile', workspaceRoot, filePath, startLine, endLine),
    searchFiles: (
      workspaceRoot: string,
      searchPath: string,
      regexPattern: string,
      filePattern?: string,
      contextLines?: number
    ) =>
      ipcRenderer.invoke(
        'workspace:searchFiles',
        workspaceRoot,
        searchPath,
        regexPattern,
        filePattern,
        contextLines
      ),
    trashFile: (
      workspaceRoot: string,
      filePath: string,
      authorization: import('../shared/types').WorkspaceMutationAuthorization
    ) => ipcRenderer.invoke('workspace:trashFile', workspaceRoot, filePath, authorization),
    gitAvailable: () => ipcRenderer.invoke('workspace:gitAvailable'),
    beginHistoryCapture: (workspaceRoot: string, conversationId: string, agentMessageId: string) =>
      ipcRenderer.invoke(
        'workspace:beginHistoryCapture',
        workspaceRoot,
        conversationId,
        agentMessageId
      ),
    discardHistoryCapture: (captureId: string) =>
      ipcRenderer.invoke('workspace:discardHistoryCapture', captureId),
    createCheckpoint: (workspaceRoot: string, message: string, captureId?: string) =>
      ipcRenderer.invoke('workspace:createCheckpoint', workspaceRoot, message, captureId),
    restoreCheckpoint: (
      workspaceRoot: string,
      hash: string,
      authorization: import('../shared/types').CheckpointMutationAuthorization
    ) => ipcRenderer.invoke('workspace:restoreCheckpoint', workspaceRoot, hash, authorization),
    hardResetCheckpoint: (
      workspaceRoot: string,
      hash: string,
      authorization: import('../shared/types').CheckpointMutationAuthorization
    ) => ipcRenderer.invoke('workspace:hardResetCheckpoint', workspaceRoot, hash, authorization),
    rewindToBeforeCheckpoint: (
      workspaceRoot: string,
      hash: string,
      authorization: import('../shared/types').CheckpointMutationAuthorization
    ) =>
      ipcRenderer.invoke('workspace:rewindToBeforeCheckpoint', workspaceRoot, hash, authorization),
    listCheckpoints: (workspaceRoot: string) =>
      ipcRenderer.invoke('workspace:listCheckpoints', workspaceRoot),
    getCheckpointDiff: (workspaceRoot: string, hash: string) =>
      ipcRenderer.invoke('workspace:getCheckpointDiff', workspaceRoot, hash),
    renameCheckpoint: (
      workspaceRoot: string,
      hash: string,
      newMessage: string,
      source?: import('../shared/checkpointTitles').CheckpointTitleSource
    ) => ipcRenderer.invoke('workspace:renameCheckpoint', workspaceRoot, hash, newMessage, source),
    claimCheckpointTitleBackfill: (
      input: import('../shared/checkpointTitles').CheckpointTitleIdentity
    ) => ipcRenderer.invoke('workspace:claimCheckpointTitleBackfill', input),
    completeCheckpointTitleBackfill: (
      input: import('../shared/checkpointTitles').CompleteCheckpointTitleBackfillInput
    ) => ipcRenderer.invoke('workspace:completeCheckpointTitleBackfill', input),
    failCheckpointTitleBackfill: (
      input: import('../shared/checkpointTitles').FailCheckpointTitleBackfillInput
    ) => ipcRenderer.invoke('workspace:failCheckpointTitleBackfill', input),
    getCheckpointTitleContext: (workspaceRoot: string, hash: string, timestamp: number) =>
      ipcRenderer.invoke('workspace:getCheckpointTitleContext', workspaceRoot, hash, timestamp),
    openFolder: (folderPath: string, workspaceRoot?: string) =>
      ipcRenderer.invoke('workspace:openFolder', folderPath, workspaceRoot),
    openFile: (filePath: string, workspaceRoot?: string) =>
      ipcRenderer.invoke('workspace:openFile', filePath, workspaceRoot),
    revealFile: (filePath: string, workspaceRoot?: string) =>
      ipcRenderer.invoke('workspace:revealFile', filePath, workspaceRoot),
    onFilesChanged: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('workspace:filesChanged', listener)
      return () => ipcRenderer.removeListener('workspace:filesChanged', listener)
    }
  }
} satisfies DesktopApi

contextBridge.exposeInMainWorld('api', api)
