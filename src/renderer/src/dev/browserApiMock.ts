import type {
  CollaborationAgentSessionMessage,
  CollaborationGroup,
  CollaborationGroupDetail
} from '../../../shared/collaboration'
import type { ProjectConversation } from '../../../shared/projects'

const previewSettings = {
  openRouterApiKeyConfigured: false,
  ollamaCloudApiKeyConfigured: false,
  lmStudioApiKeyConfigured: false,
  ollamaEndpoint: 'http://localhost:11434',
  lmStudioEndpoint: 'http://localhost:1234',
  llamaCppEndpoint: 'http://localhost:8080',
  selectedModel: 'ollama:qwen3:8b',
  commandPermissionMode: 'full-access' as const,
  notificationsEnabled: true,
  notificationSoundEnabled: false,
  focusChainEnabled: true,
  autoCompactEnabled: true,
  autoCompactThreshold: 0.8,
  toolCallLimit: 1000,
  toolCallLimitVersion: 3,
  mcpServers: [
    {
      id: 'filesystem',
      name: 'Workspace tools',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Projects\\sidekick-demo'],
      cwd: 'C:\\Projects\\sidekick-demo',
      approvalMode: 'prompt' as const,
      enabled: true
    }
  ]
}

const previewPermissionAudit = [
  {
    id: 'preview-audit-1',
    timestamp: Date.now() - 120_000,
    event: 'authorization' as const,
    operationKind: 'workspace' as const,
    title: 'Edit renderer settings layout and responsive styles',
    requestedAccess: 'auto' as const,
    effectiveAccess: 'auto' as const,
    mode: 'sensitive-only' as const,
    fingerprint: 'a16e436d5507c0209be6',
    outcome: 'auto-approved' as const,
    reason: 'The requested edit stays inside the active project workspace.'
  },
  {
    id: 'preview-audit-2',
    timestamp: Date.now() - 3_600_000,
    event: 'authorization' as const,
    operationKind: 'command' as const,
    title: 'Install a system-level package with a deliberately long descriptive title',
    requestedAccess: 'confirm' as const,
    effectiveAccess: 'confirm' as const,
    mode: 'always-ask' as const,
    fingerprint: 'c7ff19767ad9bec4f14c',
    outcome: 'denied' as const,
    reason: 'The user declined this operation.'
  }
]

const previewModels = [
  {
    id: 'ollama:qwen3:8b',
    name: 'Qwen 3 8B',
    provider: 'ollama' as const,
    providerKind: 'ollama' as const,
    providerModelId: 'qwen3:8b',
    contextLength: 32_768
  },
  {
    id: 'openrouter:anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    provider: 'openrouter' as const,
    contextLength: 200_000
  }
]

const previewConversations: ProjectConversation[] = [
  {
    id: 'preview-1',
    title: 'Refine the desktop experience',
    created_at: Date.now() - 3_600_000,
    updated_at: Date.now() - 120_000,
    project_id: 'preview-project-1',
    sidebar_order: 0,
    project_context_version: 0,
    home_workspace_root: 'C:\\Projects\\sidekick-demo',
    home_project_name: 'sidekick-demo'
  },
  {
    id: 'preview-2',
    title: 'Research local model options',
    created_at: Date.now() - 86_400_000,
    updated_at: Date.now() - 43_200_000,
    project_id: null,
    sidebar_order: 0,
    project_context_version: 0,
    home_workspace_root: null,
    home_project_name: null
  },
  {
    id: 'preview-3',
    title: 'Build release checklist',
    created_at: Date.now() - 172_800_000,
    updated_at: Date.now() - 86_400_000,
    project_id: 'preview-project-1',
    sidebar_order: 1,
    project_context_version: 0,
    home_workspace_root: 'C:\\Projects\\sidekick-demo',
    home_project_name: 'sidekick-demo'
  }
]

const previewCreatedConversations: ProjectConversation[] = []

const previewProjects = [
  {
    id: 'preview-project-1',
    name: 'sidekick-demo',
    folder_path: 'C:\\Projects\\sidekick-demo',
    is_pinned: 0,
    created_at: Date.now() - 172_800_000,
    updated_at: Date.now() - 120_000,
    conversation_count: 2,
    last_activity_at: Date.now() - 120_000
  },
  {
    id: 'preview-project-2',
    name: 'sidekick-api',
    folder_path: 'C:\\Projects\\sidekick-api',
    is_pinned: 0,
    created_at: Date.now() - 120_000_000,
    updated_at: Date.now() - 90_000,
    conversation_count: 0,
    last_activity_at: Date.now() - 90_000
  }
]

const previewAgentSessions = [
  {
    id: 'preview-session-1',
    groupId: 'preview-group-1',
    participantId: 'preview-participant-1',
    projectId: 'preview-project-1',
    title: 'Desktop + API launch · sidekick-demo agent',
    activeRunStatus: 'working' as const,
    lastEventSeq: 7,
    unreadCompletionAt: null,
    createdAt: Date.now() - 600_000,
    updatedAt: Date.now() - 6_000
  },
  {
    id: 'preview-session-2',
    groupId: 'preview-group-1',
    participantId: 'preview-participant-2',
    projectId: 'preview-project-2',
    title: 'Desktop + API launch · sidekick-api agent',
    activeRunStatus: 'waiting' as const,
    lastEventSeq: 7,
    unreadCompletionAt: null,
    createdAt: Date.now() - 600_000,
    updatedAt: Date.now() - 20_000
  }
]

const previewAgentSessionMessages: Record<string, CollaborationAgentSessionMessage[]> = {
  'preview-session-1': [
    {
      id: 'preview-session-message-1',
      sessionId: 'preview-session-1',
      missionId: 'preview-mission-1',
      role: 'user',
      kind: 'shared_event',
      presentation: 'internal',
      content: 'You asked both agents to coordinate the desktop and API changes.',
      toolCalls: [],
      toolCallId: null,
      metadata: { firstSeq: 2, lastSeq: 3 },
      createdAt: Date.now() - 210_000
    },
    {
      id: 'preview-session-message-2',
      sessionId: 'preview-session-1',
      missionId: 'preview-mission-1',
      role: 'assistant',
      kind: 'assistant',
      presentation: 'conversation',
      content: 'I am wiring the shared contract into the desktop client.',
      toolCalls: [
        {
          id: 'preview-session-tool-1',
          type: 'function',
          function: { name: 'apply_patch', arguments: '{}' }
        }
      ],
      toolCallId: null,
      metadata: { promptTokens: 2_140, completionTokens: 38 },
      createdAt: Date.now() - 12_000
    }
  ],
  'preview-session-2': [
    {
      id: 'preview-session-message-3',
      sessionId: 'preview-session-2',
      missionId: 'preview-mission-1',
      role: 'user',
      kind: 'shared_event',
      presentation: 'internal',
      content: 'Frontend asked for the exact response shape for /v1/projects.',
      toolCalls: [],
      toolCallId: null,
      metadata: { firstSeq: 2, lastSeq: 3 },
      createdAt: Date.now() - 140_000
    },
    {
      id: 'preview-session-message-4',
      sessionId: 'preview-session-2',
      missionId: 'preview-mission-1',
      role: 'tool',
      kind: 'tool_result',
      presentation: 'conversation',
      content: '{"ok":true}',
      toolCalls: [],
      toolCallId: 'preview-read-projects',
      metadata: {
        toolName: 'read',
        title: 'Read src/routes/projects.ts',
        success: true
      },
      createdAt: Date.now() - 75_000
    },
    {
      id: 'preview-session-message-5',
      sessionId: 'preview-session-2',
      missionId: 'preview-mission-1',
      role: 'assistant',
      kind: 'assistant',
      presentation: 'conversation',
      content: 'The API contract test passes and the response shape is ready.',
      toolCalls: [],
      toolCallId: null,
      metadata: {},
      createdAt: Date.now() - 20_000
    }
  ]
}

const previewGroup: CollaborationGroup = {
  id: 'preview-group-1',
  title: 'Desktop + API launch',
  description: null,
  status: 'active',
  createdAt: Date.now() - 600_000,
  updatedAt: Date.now() - 20_000,
  activeMissionId: 'preview-mission-1',
  activeMissionStatus: 'running',
  participantCount: 2,
  unreadCompletionAt: null,
  agentSessions: previewAgentSessions
}

const previewGroupDetail: CollaborationGroupDetail = {
  group: previewGroup,
  participants: [
    {
      id: 'preview-participant-1',
      groupId: previewGroup.id,
      projectId: 'preview-project-1',
      projectName: 'sidekick-demo',
      projectFolder: 'C:\\Projects\\sidekick-demo',
      label: 'sidekick-demo agent',
      providerTarget: { providerKind: 'ollama', model: 'qwen3:8b' },
      status: 'active',
      joinedAt: previewGroup.createdAt,
      removedAt: null,
      lastReadSeq: 7
    },
    {
      id: 'preview-participant-2',
      groupId: previewGroup.id,
      projectId: 'preview-project-2',
      projectName: 'sidekick-api',
      projectFolder: 'C:\\Projects\\sidekick-api',
      label: 'sidekick-api agent',
      providerTarget: { providerKind: 'openrouter', model: 'anthropic/claude-sonnet-4' },
      status: 'active',
      joinedAt: previewGroup.createdAt,
      removedAt: null,
      lastReadSeq: 7
    }
  ],
  agentSessions: previewAgentSessions,
  activeMission: {
    id: 'preview-mission-1',
    groupId: previewGroup.id,
    objectiveEventId: 'preview-group-event-2',
    status: 'running',
    requestedParticipantIds: ['preview-participant-1', 'preview-participant-2'],
    iterationCount: 6,
    createdAt: Date.now() - 240_000,
    updatedAt: Date.now() - 15_000,
    completedAt: null,
    error: null
  },
  participantRuns: [
    {
      missionId: 'preview-mission-1',
      participantId: 'preview-participant-1',
      status: 'working',
      iterationCount: 4,
      maxIterations: 1000,
      lastIngestedSeq: 7,
      currentActivity: 'Updating desktop client',
      startedAt: Date.now() - 210_000,
      updatedAt: Date.now() - 6_000,
      completedAt: null,
      error: null
    },
    {
      missionId: 'preview-mission-1',
      participantId: 'preview-participant-2',
      status: 'waiting',
      iterationCount: 2,
      maxIterations: 1000,
      lastIngestedSeq: 7,
      currentActivity: null,
      startedAt: Date.now() - 200_000,
      updatedAt: Date.now() - 20_000,
      completedAt: null,
      error: null
    }
  ],
  events: [
    {
      id: 'preview-group-event-1',
      groupId: previewGroup.id,
      missionId: null,
      seq: 1,
      actorType: 'system',
      actorParticipantId: null,
      kind: 'system',
      payload: { text: 'Group created. Start a mission by sending a message.' },
      replyToEventId: null,
      createdAt: Date.now() - 600_000
    },
    {
      id: 'preview-group-event-2',
      groupId: previewGroup.id,
      missionId: 'preview-mission-1',
      seq: 2,
      actorType: 'user',
      actorParticipantId: null,
      kind: 'user_message',
      payload: {
        text: 'Coordinate the desktop and API changes, agree on the contract, and verify both projects together.'
      },
      replyToEventId: null,
      createdAt: Date.now() - 240_000
    },
    {
      id: 'preview-group-event-3',
      groupId: previewGroup.id,
      missionId: 'preview-mission-1',
      seq: 3,
      actorType: 'agent',
      actorParticipantId: 'preview-participant-1',
      kind: 'peer_message',
      payload: {
        text: 'I will update the desktop client. Can you confirm the response shape for `/v1/projects`?'
      },
      replyToEventId: null,
      createdAt: Date.now() - 150_000
    },
    {
      id: 'preview-group-event-4',
      groupId: previewGroup.id,
      missionId: 'preview-mission-1',
      seq: 4,
      actorType: 'agent',
      actorParticipantId: 'preview-participant-2',
      kind: 'tool_call',
      payload: {
        toolName: 'read',
        toolCallId: 'preview-read-projects',
        title: 'src/routes/projects.ts'
      },
      replyToEventId: null,
      createdAt: Date.now() - 80_000
    },
    {
      id: 'preview-group-event-5',
      groupId: previewGroup.id,
      missionId: 'preview-mission-1',
      seq: 5,
      actorType: 'agent',
      actorParticipantId: 'preview-participant-2',
      kind: 'tool_result',
      payload: {
        toolName: 'read',
        toolCallId: 'preview-read-projects',
        success: true,
        result: 'Read src/routes/projects.ts'
      },
      replyToEventId: null,
      createdAt: Date.now() - 75_000
    },
    {
      id: 'preview-group-event-6',
      groupId: previewGroup.id,
      missionId: 'preview-mission-1',
      seq: 6,
      actorType: 'agent',
      actorParticipantId: 'preview-participant-2',
      kind: 'agent_message',
      payload: {
        text: 'The endpoint returns `{ projects, nextCursor }`. I added a contract test and shared the exact field names.'
      },
      replyToEventId: null,
      createdAt: Date.now() - 20_000
    },
    {
      id: 'preview-group-event-7',
      groupId: previewGroup.id,
      missionId: 'preview-mission-1',
      seq: 7,
      actorType: 'agent',
      actorParticipantId: 'preview-participant-1',
      kind: 'agent_activity',
      payload: { text: 'sidekick-demo agent is working' },
      replyToEventId: null,
      createdAt: Date.now() - 5_000
    }
  ]
}

const previewMessages = [
  {
    id: 'preview-message-1',
    conversation_id: 'preview-1',
    role: 'user',
    content:
      'Review the desktop experience and make the interface feel calmer, clearer, and more deliberate.',
    timestamp: Date.now() - 180_000
  },
  {
    id: 'preview-message-2',
    runId: 'preview-run-1',
    conversation_id: 'preview-1',
    role: 'agent',
    content:
      'I reviewed the main shell and found three high-impact areas:\n\n- **Preserve the workspace:** collapse secondary panels before they squeeze the conversation.\n- **Clarify hierarchy:** strengthen the composer, active navigation, and dialog section boundaries.\n- **Improve first use:** offer useful starting points instead of leaving an empty canvas.\n\nThe result should feel focused without becoming visually busy.',
    segments: [
      {
        type: 'thinking' as const,
        content:
          'I should inspect the current information hierarchy before changing visual density.'
      },
      {
        type: 'tool' as const,
        tool: {
          id: 'preview-tool-search',
          name: 'web_search',
          title: 'Searching: "población Cuba 2024 2025 2026 and recent official statistics"',
          command: 'web_search("población Cuba 2024 2025 2026 and recent official statistics")',
          status: 'success' as const,
          accessLevel: 'auto' as const,
          approvalStatus: 'auto' as const,
          presentation: {
            kind: 'search' as const,
            title: 'Search population sources',
            subject: 'población Cuba 2024 2025 2026',
            detail: '8 sources matched'
          },
          output:
            '1. Cuba Population (2026) — World Population Review\n2. Population and Demography — ONEI\n3. World Population Prospects — United Nations'
        }
      },
      {
        type: 'thinking' as const,
        content:
          'The sources disagree slightly, so I will inspect the source page and preserve that distinction in the answer.'
      },
      {
        type: 'tool' as const,
        tool: {
          id: 'preview-tool-read',
          name: 'web_fetch',
          title: 'Fetching: https://worldpopulationreview.com/countries/cuba',
          command: 'web_fetch("https://worldpopulationreview.com/countries/cuba")',
          hint: 'Cuba population figures for each year from 2016 to 2026 and an explanation of differences between sources',
          status: 'success' as const,
          accessLevel: 'auto' as const,
          approvalStatus: 'auto' as const,
          presentation: {
            kind: 'web' as const,
            title: 'Fetch population source',
            subject: 'worldpopulationreview.com/countries/cuba',
            detail: 'Cuba population figures and source methodology'
          },
          output:
            'Retrieved the population table, source notes, and methodology section successfully.'
        }
      },
      {
        type: 'tool' as const,
        tool: {
          id: 'preview-tool-command',
          name: 'shell',
          title: 'Checking the renderer',
          command: 'npm run typecheck:web',
          status: 'success' as const,
          accessLevel: 'auto' as const,
          approvalStatus: 'auto' as const,
          presentation: {
            kind: 'terminal' as const,
            title: 'Check the renderer',
            subject: 'npm run typecheck:web',
            detail: 'Completed in 4.2s'
          },
          output:
            '> sidekick@0.6.0 typecheck:web\n> tsc --noEmit -p tsconfig.web.json --composite false\n\nType check passed.',
          startedAt: Date.now() - 130_000,
          completedAt: Date.now() - 126_000
        }
      },
      {
        type: 'thinking' as const,
        content:
          'The data path is sound. I can now simplify the work disclosure and make file changes explicit.'
      },
      {
        type: 'tool' as const,
        tool: {
          id: 'preview-tool-diff',
          name: 'apply_patch',
          title: 'Update conversation hierarchy',
          command: 'apply_patch',
          status: 'success' as const,
          accessLevel: 'auto' as const,
          approvalStatus: 'auto' as const,
          presentation: {
            kind: 'diff' as const,
            title: 'Update conversation hierarchy',
            subject: 'src/renderer/src/components/ChatPanel.tsx',
            detail: '1 file changed'
          },
          data: {
            diff: 'diff --git a/src/renderer/src/components/ChatPanel.tsx b/src/renderer/src/components/ChatPanel.tsx\n--- a/src/renderer/src/components/ChatPanel.tsx\n+++ b/src/renderer/src/components/ChatPanel.tsx\n@@ -704,6 +704,10 @@\n return (\n   <div className="chat-panel">\n+    <ConversationViewTabs\n+      value={conversationView}\n+      onChange={setConversationView}\n+    />\n     <div className="messages-container">'
          },
          changes: [
            {
              path: 'src/renderer/src/components/ChatPanel.tsx',
              kind: 'update' as const
            }
          ]
        }
      },
      {
        type: 'text' as const,
        content:
          'I reviewed the main shell and found three high-impact areas:\n\n- **Preserve the workspace:** collapse secondary panels before they squeeze the conversation.\n- **Clarify hierarchy:** strengthen the composer, active navigation, and dialog section boundaries.\n- **Improve first use:** offer useful starting points instead of leaving an empty canvas.\n\nThe result should feel focused without becoming visually busy.'
      }
    ],
    tokenUsage: {
      promptTokens: 286,
      completionTokens: 86,
      tokensPerSecond: 32.4,
      runStartedAt: Date.now() - 180_000,
      runCompletedAt: Date.now() - 120_000
    },
    timestamp: Date.now() - 120_000
  }
]

export function installBrowserApiMock(): void {
  if (window.api || !import.meta.env.DEV) return

  window.api = {
    providers: {
      complete: async () => ({ ok: false, error: 'UI preview' }),
      discoverModels: async () => ({ ok: true, models: [] }),
      resolveContext: async () => ({
        ok: true,
        contextLength: 32_768,
        reliable: false,
        source: 'fallback'
      }),
      getGenerationStats: async () => ({ ok: false, error: 'UI preview' }),
      onHealthChanged: () => () => undefined
    },
    settings: {
      save: async () => ({ success: true }),
      load: async () => previewSettings
    },
    memory: {
      get: async () => ({ ok: true, content: '', updatedAt: null }),
      save: async (_workspaceRoot, content) => ({ ok: true, content, updatedAt: Date.now() })
    },
    pinnedModels: {
      save: async () => ({ success: true }),
      load: async () => previewModels
    },
    conversations: {
      list: async () => [...previewCreatedConversations, ...previewConversations],
      search: async (query) =>
        [...previewCreatedConversations, ...previewConversations].filter((item) =>
          item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        ),
      create: async (title, projectId, titleSource = 'placeholder') => {
        const project = previewProjects.find(({ id }) => id === projectId)
        const created = {
          id: `preview-${Date.now()}`,
          title,
          created_at: Date.now(),
          updated_at: Date.now(),
          project_id: projectId ?? null,
          is_pinned: 0,
          title_source: titleSource,
          title_version: 0,
          sidebar_order: -1,
          project_context_version: 0,
          home_workspace_root: project?.folder_path ?? null,
          home_project_name: project?.name ?? null
        }
        previewCreatedConversations.unshift(created)
        return created
      },
      fork: async () => ({
        id: `preview-${Date.now()}`,
        title: 'Forked conversation',
        created_at: Date.now(),
        updated_at: Date.now(),
        project_id: null,
        is_pinned: 0,
        sidebar_order: -1,
        project_context_version: 0,
        home_workspace_root: null,
        home_project_name: null
      }),
      update: async () => ({ success: true }),
      setPinned: async (id, pinned) => {
        const conversation = [...previewCreatedConversations, ...previewConversations].find(
          (candidate) => candidate.id === id
        )
        if (conversation) conversation.is_pinned = pinned ? 1 : 0
        return { success: Boolean(conversation) }
      },
      listTitleBackfillCandidates: async () => [],
      claimTitleBackfill: async () => ({ claimed: false }),
      completeTitleBackfill: async () => ({ applied: false }),
      failTitleBackfill: async () => ({ recorded: false }),
      preserveTitle: async () => ({ preserved: false }),
      markRead: async (id) => {
        const conversation = [...previewCreatedConversations, ...previewConversations].find(
          (candidate) => candidate.id === id
        )
        if (conversation) conversation.unread_completion_at = null
        return { success: Boolean(conversation) }
      },
      delete: async () => ({ success: true }),
      deleteAll: async () => ({ success: true }),
      getMessages: async (conversationId) =>
        conversationId === 'preview-1' ? previewMessages : [],
      getLatestCompaction: async () => null,
      saveCompaction: async (input) => ({
        id: `preview-compaction-${Date.now()}`,
        conversationId: input.conversationId,
        summary: input.summary,
        compactedThroughMessageId: input.compactedThroughMessageId ?? null,
        compactedThroughTimestamp: input.compactedThroughTimestamp ?? null,
        previousCompactionId: input.previousCompactionId ?? null,
        originalTokens: input.originalTokens,
        summaryTokens: input.summaryTokens,
        messagesCompacted: input.messagesCompacted,
        strategy: input.strategy,
        promptVersion: input.promptVersion,
        provider: input.provider,
        model: input.model,
        createdAt: Date.now()
      }),
      saveMessage: async () => ({ success: true }),
      updateMessage: async () => ({ success: true }),
      deleteMessagesAfter: async () => ({ success: true }),
      saveSkills: async () => ({ success: true }),
      loadSkills: async () => null
    },
    projects: {
      list: async () => previewProjects,
      create: async (folderPath, name) => ({
        id: `preview-project-${Date.now()}`,
        name: name || folderPath.split(/[\\/]/).filter(Boolean).at(-1) || folderPath,
        folder_path: folderPath,
        is_pinned: 0,
        created_at: Date.now(),
        updated_at: Date.now()
      }),
      update: async (id, input) => ({
        ...(previewProjects.find((project) => project.id === id) || previewProjects[0]),
        id,
        name: input.name || previewProjects[0].name,
        is_pinned: input.isPinned ? 1 : 0,
        updated_at: Date.now()
      }),
      remove: async () => ({ success: true }),
      getConversationContext: async (conversationId) => {
        const conversation = [...previewCreatedConversations, ...previewConversations].find(
          ({ id }) => id === conversationId
        )
        const project = previewProjects.find(({ id }) => id === conversation?.project_id)
        return {
          conversationId,
          projectId: conversation?.project_id ?? null,
          projectName: project?.name ?? null,
          workspaceRoot: project?.folder_path ?? null,
          homeWorkspaceRoot: conversation?.home_workspace_root ?? null,
          homeProjectName: conversation?.home_project_name ?? null,
          isDetached: !conversation?.project_id && Boolean(conversation?.home_workspace_root),
          contextVersion: conversation?.project_context_version ?? 0,
          latestTransition: null
        }
      },
      moveConversation: async (input) => ({
        conversation: {
          id: input.conversationId,
          title: 'Preview conversation',
          created_at: Date.now(),
          updated_at: Date.now(),
          project_id: input.projectId,
          sidebar_order: 0,
          project_context_version: 0,
          home_workspace_root: null,
          home_project_name: null
        },
        transition: null
      })
    },
    agentRuns: {
      startConversation: async (input) => ({
        run: {
          id: input.id,
          threadId: input.conversationId,
          surface: 'conversation',
          executionMode: 'act',
          phase: 'streaming',
          provider: input.model.provider,
          model: input.model.providerModelId || input.model.name,
          lastSequence: 1,
          startedAt: Date.now(),
          updatedAt: Date.now()
        }
      }),
      stop: async () => ({ stopped: true }),
      events: async (runId, afterSequence = 0) => {
        if (runId !== 'preview-run-1') {
          return { run: null, events: [], pendingInteractions: [] }
        }
        const now = Date.now() - 120_000
        const events = [
          {
            id: 'preview-event-1',
            runId,
            sequence: 1,
            type: 'run.started' as const,
            timestamp: now - 7_000,
            payload: { executionMode: 'act' }
          },
          {
            id: 'preview-event-2',
            runId,
            sequence: 2,
            type: 'assistant.delta' as const,
            timestamp: now - 6_500,
            payload: { thinking: 'First I will inspect the current information hierarchy.' }
          },
          {
            id: 'preview-event-3',
            runId,
            sequence: 3,
            type: 'assistant.completed' as const,
            timestamp: now - 6_000,
            payload: { thinking: 'First I will inspect the current information hierarchy.' }
          },
          {
            id: 'preview-event-4',
            runId,
            sequence: 4,
            type: 'tool.pending' as const,
            timestamp: now - 5_500,
            payload: { toolCallId: 'preview-tool-search', name: 'web_search', arguments: {} }
          },
          {
            id: 'preview-event-5',
            runId,
            sequence: 5,
            type: 'tool.running' as const,
            timestamp: now - 5_000,
            payload: { toolCallId: 'preview-tool-search', title: 'Search population sources' }
          },
          {
            id: 'preview-event-6',
            runId,
            sequence: 6,
            type: 'tool.completed' as const,
            timestamp: now - 4_000,
            payload: {
              toolCallId: 'preview-tool-search',
              result: {
                callId: 'preview-tool-search',
                name: 'web_search',
                title: 'Search population sources',
                status: 'success' as const,
                modelContent: 'Found representative sources.',
                timing: { startedAt: now - 5_000, completedAt: now - 4_000 }
              }
            }
          },
          {
            id: 'preview-event-7',
            runId,
            sequence: 7,
            type: 'run.completed' as const,
            timestamp: now,
            payload: { phase: 'completed' }
          }
        ]
        const page = events.filter((event) => event.sequence > afterSequence)
        return {
          run: null,
          events: page,
          pendingInteractions: [],
          journal: {
            version: 1 as const,
            afterSequence,
            firstSequence: page[0]?.sequence ?? null,
            lastSequence: page.at(-1)?.sequence ?? null,
            nextSequence: page.at(-1)?.sequence ?? afterSequence,
            hasMore: false,
            gapDetected: false
          }
        }
      },
      latest: async () => ({ run: null, events: [], pendingInteractions: [] }),
      beginBrowserHumanTakeover: async (conversationId) => ({
        active: true,
        conversationId,
        sessionId: 'preview-browser-session',
        pageTitle: 'Preview browser',
        url: 'https://example.com/',
        humanVerificationRequired: true
      }),
      completeBrowserHumanTakeover: async (conversationId) => ({
        active: false,
        conversationId,
        sessionId: 'preview-browser-session',
        pageTitle: 'Preview browser',
        url: 'https://example.com/',
        humanVerificationRequired: false
      }),
      resolveInteraction: async () => ({ success: true }),
      admissionsList: async () => ({ queued: [], pivot: null }),
      admissionsReplace: async () => ({ queued: [], pivot: null }),
      admissionsTakeNext: async () => null,
      onEvent: () => () => undefined
    },
    conversationGoals: {
      current: async () => null,
      create: async (input) => ({
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        objective: input.objective,
        status: 'active',
        revision: 1,
        continuationCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        blockedStreak: 0,
        plan: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }),
      edit: async (input) => ({
        id: input.goalId,
        conversationId: 'preview-conversation',
        objective: input.objective,
        status: 'paused',
        revision: 2,
        continuationCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        blockedStreak: 0,
        plan: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }),
      pause: async () => {
        throw new Error('No preview goal')
      },
      resume: async () => {
        throw new Error('No preview goal')
      },
      clear: async () => {
        throw new Error('No preview goal')
      },
      onChanged: () => () => undefined
    },
    collaboration: {
      listGroups: async () => [previewGroup],
      getGroup: async (id) => (id === previewGroup.id ? previewGroupDetail : null),
      getAgentSession: async (id) =>
        previewAgentSessions.find((session) => session.id === id) || null,
      updateAgentSession: async (id, input) => {
        const session = previewAgentSessions.find((candidate) => candidate.id === id)
        if (!session) throw new Error('Agent conversation not found')
        session.title = input.title
        return session
      },
      markGroupRead: async (id) => {
        if (previewGroup.id !== id) return { success: false }
        previewGroup.unreadCompletionAt = null
        for (const session of previewAgentSessions) session.unreadCompletionAt = null
        return { success: true }
      },
      markAgentSessionRead: async (id) => {
        const session = previewAgentSessions.find((candidate) => candidate.id === id)
        if (session) session.unreadCompletionAt = null
        return { success: Boolean(session) }
      },
      listAgentSessionMessages: async (sessionId) => previewAgentSessionMessages[sessionId] || [],
      listEvents: async () => previewGroupDetail.events,
      createGroup: async () => previewGroupDetail,
      updateGroup: async (_id, input) => {
        if (input.title) previewGroup.title = input.title
        if (input.description !== undefined) previewGroup.description = input.description
        if (input.status) previewGroup.status = input.status
        return previewGroup
      },
      deleteGroup: async () => undefined,
      addParticipant: async () => {
        throw new Error('Participant updates are unavailable in UI preview')
      },
      removeParticipant: async () => undefined,
      updateParticipant: async (participantId, input) => {
        const participant = previewGroupDetail.participants.find(({ id }) => id === participantId)
        if (!participant) throw new Error('Participant not found')
        participant.providerTarget = input.providerTarget
        return participant
      },
      updateParticipants: async (input) =>
        input.participantIds.map((participantId) => {
          const participant = previewGroupDetail.participants.find(({ id }) => id === participantId)
          if (!participant) throw new Error('Participant not found')
          participant.providerTarget = input.providerTarget
          return participant
        }),
      sendMessage: async () => {
        throw new Error('Group messages are unavailable in UI preview')
      },
      rewriteMessage: async () => {
        throw new Error('Group timeline rewrites are unavailable in UI preview')
      },
      pauseMission: async () => {
        throw new Error('Missions are unavailable in UI preview')
      },
      resumeMission: async () => {
        throw new Error('Missions are unavailable in UI preview')
      },
      stopMission: async () => {
        throw new Error('Missions are unavailable in UI preview')
      },
      stopParticipant: async (_missionId, participantId) => {
        const run = previewGroupDetail.participantRuns.find(
          (candidate) => candidate.participantId === participantId
        )
        if (!run) throw new Error('Participant run not found')
        run.status = 'stopped'
        run.currentActivity = null
        return run
      },
      onChanged: () => () => undefined
    },
    mcp: {
      listTools: async () => ({ ok: true, tools: [], statuses: [] }),
      authenticate: async () => ({ ok: true, tools: [], statuses: [] }),
      disconnect: async () => ({ ok: true, tools: [], statuses: [] })
    },
    permissions: {
      authorize: async (operation) => ({
        approved: true,
        token: 'ui-preview',
        effectiveAccess: operation.requestedAccess
      }),
      listAudit: async () => previewPermissionAudit
    },
    window: {
      minimize: () => {},
      maximize: () => {},
      close: () => {},
      isMaximized: async () => false,
      isFullScreen: async () => false,
      onMaximizedChange: () => () => undefined,
      onFullScreenChange: () => () => undefined
    },
    notification: { show: async () => ({ ok: true }) },
    app: {
      platform: 'windows',
      getIconPath: async () => '',
      onCommand: () => () => undefined
    },
    appUpdates: {
      getState: async () => ({
        status: 'disabled' as const,
        currentVersion: '0.6.0',
        reason: 'development' as const
      }),
      check: async () => ({
        status: 'disabled' as const,
        currentVersion: '0.6.0',
        reason: 'development' as const
      }),
      openRelease: async () => ({ opened: false }),
      onState: () => () => undefined
    },
    support: { export: async () => ({ success: true }) },
    clipboard: { writeText: async () => ({ success: true }) },
    workspace: {
      selectFolder: async () => ({ canceled: false, path: 'C:\\Projects\\sidekick-demo' }),
      selectContextAttachments: async () => ({ ok: true, canceled: true, attachments: [] }),
      getPath: async () => 'C:\\Projects\\sidekick-demo',
      getRules: async () => ({
        ok: true,
        content: '',
        sources: [],
        sourceDetails: [],
        truncated: false
      }),
      resolveRulesForPath: async () => ({
        ok: true,
        content: '',
        sources: [],
        sourceDetails: [],
        truncated: false,
        retryRequired: false
      }),
      resetRuleScope: async () => ({ ok: true }),
      clearRuleScope: async () => ({ ok: true }),
      setPath: async () => ({ success: true }),
      listFiles: async () => ({
        ok: true,
        files: ['README.md', 'package.json', 'src/', 'src/main/', 'src/renderer/']
      }),
      readFile: async () => ({ ok: true, content: '# Preview file', totalLines: 1 }),
      searchFiles: async () => ({ ok: true, output: '', matchCount: 0, matchedFiles: [] }),
      trashFile: async () => ({ ok: true }),
      gitAvailable: async () => true,
      beginHistoryCapture: async () => ({ ok: true, captureId: crypto.randomUUID() }),
      discardHistoryCapture: async () => ({ ok: true }),
      createCheckpoint: async () => ({ ok: true, hash: 'abcdef123456' }),
      restoreCheckpoint: async () => ({ ok: true }),
      hardResetCheckpoint: async () => ({ ok: true }),
      rewindToBeforeCheckpoint: async () => ({ ok: true, parentHash: null }),
      listCheckpoints: async () => ({
        ok: true,
        checkpoints: [],
        status: { storage: 'private-app-data', realRepository: false, appliedHash: null }
      }),
      getCheckpointDiff: async () => ({ ok: true, diff: '' }),
      renameCheckpoint: async () => ({ ok: true }),
      claimCheckpointTitleBackfill: async () => ({ claimed: false }),
      completeCheckpointTitleBackfill: async () => ({ applied: false }),
      failCheckpointTitleBackfill: async () => ({ recorded: false }),
      getCheckpointTitleContext: async () => null,
      openFolder: async () => {},
      openFile: async () => {},
      openFileReference: async (fileReference) => ({
        ok: true,
        status: 'opened' as const,
        path: fileReference
      }),
      revealFile: async () => {},
      showPathMenu: async () => {},
      onFilesChanged: () => () => {}
    }
  }
}
