import { previewTerminalApi, previewUserTerminalApi } from './terminalPreview'
import { previewPullRequestsApi } from './pullRequestPreview'
import { previewCredentialsApi } from './credentialsPreview'
import { previewBrowserLibraryApi } from './browserLibraryPreview'
import { previewCompanionApi } from './companionPreview'
import {
  previewSessionConversations,
  previewSessionsApi,
  previewSessionTranscripts,
  previewSessionWorktrees
} from './sessionsPreview'
import type { ProjectConversation } from '../../../shared/projects'
import type { ProviderInstance, ProviderInstanceModel } from '../../../shared/settings'
import type { CommandLineToolStatus } from '../../../shared/commandLineTool'
import type { ManagedWorktreeSummary, WorktreesAPI } from '../../../shared/worktrees'
import type {
  ConversationGoal,
  ConversationGoalChangedEvent
} from '../../../shared/conversationGoals'
import {
  nextScheduleOccurrence,
  type Schedule,
  type ScheduleRun,
  type SchedulesChangedEvent
} from '../../../shared/schedules'

const previewCommandLineStatus: CommandLineToolStatus = {
  mode: 'shell-script',
  installed: false,
  location: '~/.local/bin/sidekick',
  onPath: null,
  hint: 'If `sidekick` is not found, add ~/.local/bin to PATH in your shell profile.'
}

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

let previewBrowserNetwork = [
  { origin: 'http://10.50.160.123:8080', approvedAt: Date.now() - 86_400_000 },
  { origin: 'http://rno-l-024:8080', approvedAt: Date.now() - 3_600_000 }
]

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
    providerModelId: 'anthropic/claude-sonnet-4',
    contextLength: 200_000
  }
]

// What a few providers list, so the Providers page has a catalog to browse.
const catalogModel = (
  id: string,
  details: Partial<ProviderInstanceModel>
): ProviderInstanceModel => ({
  id,
  name: id,
  enabled: false,
  metadataSource: 'provider',
  ...details
})

const previewCatalogs: Partial<Record<ProviderInstance['type'], ProviderInstanceModel[]>> = {
  ollama: [
    catalogModel('gemma3:4b', {
      contextLength: 131_072,
      supportsTools: false,
      supportsVision: true,
      supportsReasoning: false
    }),
    catalogModel('gpt-oss:20b', {
      contextLength: 131_072,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: true
    }),
    catalogModel('qwen2.5-coder:7b', {
      contextLength: 32_768,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: false
    }),
    catalogModel('qwen3:8b', {
      contextLength: 40_960,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: true
    })
  ],
  openrouter: [
    catalogModel('anthropic/claude-sonnet-4', {
      name: 'Anthropic: Claude Sonnet 4',
      contextLength: 1_000_000,
      outputTokenLimit: 64_000,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsPdfInput: true,
      pricing: { prompt: 0.000003, completion: 0.000015 }
    }),
    catalogModel('deepseek/deepseek-chat-v3.1', {
      name: 'DeepSeek: DeepSeek V3.1',
      contextLength: 163_840,
      supportsTools: true,
      supportsReasoning: true,
      pricing: { prompt: 0.0000002, completion: 0.0000008 }
    }),
    catalogModel('google/gemini-2.5-flash', {
      name: 'Google: Gemini 2.5 Flash',
      contextLength: 1_048_576,
      outputTokenLimit: 65_536,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsPdfInput: true,
      supportsAudioInput: true,
      pricing: { prompt: 0.0000003, completion: 0.0000025 }
    }),
    catalogModel('meta-llama/llama-3.3-70b-instruct:free', {
      name: 'Meta: Llama 3.3 70B Instruct (free)',
      contextLength: 131_072,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: false,
      pricing: { prompt: 0, completion: 0 }
    }),
    catalogModel('openai/gpt-5-mini', {
      name: 'OpenAI: GPT-5 Mini',
      contextLength: 400_000,
      outputTokenLimit: 128_000,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsPdfInput: true,
      pricing: { prompt: 0.00000025, completion: 0.000002 }
    }),
    catalogModel('qwen/qwen3-coder', {
      name: 'Qwen: Qwen3 Coder 480B A35B',
      contextLength: 262_144,
      supportsTools: true,
      supportsReasoning: false,
      pricing: { prompt: 0.00000022, completion: 0.00000095 }
    })
  ]
}

function previewDiscoverModels(draft: ProviderInstance | undefined): ProviderInstanceModel[] {
  if (!draft) return []
  const catalog = previewCatalogs[draft.type]
  if (!catalog) return draft.models
  // As the main process does: the user's choice and any name they gave survive a load.
  return catalog.map((model) => {
    const configured = draft.models.find(({ id }) => id === model.id)
    return {
      ...model,
      name: configured?.name && configured.name !== model.id ? configured.name : model.name,
      enabled: configured?.enabled ?? false
    }
  })
}

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
    home_project_name: 'sidekick-demo',
    model_id: 'openrouter:openrouter/anthropic/claude-sonnet-4'
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
    home_project_name: null,
    model_id: 'ollama:ollama-local/qwen3:8b'
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
    home_project_name: 'sidekick-demo',
    // Its provider was removed since, so the chat asks for another model.
    model_id: 'lmstudio:lm-studio/qwen2.5-coder-14b'
  },
  ...[2, 1].map(
    (run): ProjectConversation => ({
      id: `preview-scheduled-${run}`,
      title: `Morning repository check · Run ${run}`,
      created_at: Date.now() - (3 - run) * 86_400_000,
      updated_at: Date.now() - (3 - run) * 86_400_000,
      project_id: 'preview-project-1',
      sidebar_order: 2,
      project_context_version: 0,
      home_workspace_root: 'C:\\Projects\\sidekick-demo',
      home_project_name: 'sidekick-demo',
      schedule_id: 'preview-schedule-1',
      schedule_run_number: run,
      started_by_kind: 'schedule'
    })
  ),
  ...previewSessionConversations
]

const previewSchedules: Schedule[] = [
  {
    id: 'preview-schedule-1',
    name: 'Morning repository check',
    prompt: 'Summarize what changed in this repository since yesterday and flag anything risky.',
    projectId: 'preview-project-1',
    modelId: 'ollama:ollama-local/qwen3:8b',
    cadence: 'weekdays',
    hour: 9,
    minute: 0,
    weekday: 1,
    catchUp: true,
    permissionCeiling: 'sensitive-only',
    enabled: true,
    nextRunAt: nextScheduleOccurrence(
      { cadence: 'weekdays', hour: 9, minute: 0, weekday: 1 },
      Date.now()
    ),
    lastRunAt: Date.now() - 86_400_000,
    runCount: 2,
    createdAt: Date.now() - 3 * 86_400_000,
    updatedAt: Date.now() - 86_400_000
  },
  {
    id: 'preview-schedule-2',
    name: 'Weekly dependency check',
    prompt:
      'Check this repository for outdated or vulnerable npm dependencies and list what to update. Do not change any files.',
    projectId: 'preview-project-1',
    modelId: 'ollama:ollama-local/qwen3:8b',
    cadence: 'weekly',
    hour: 10,
    minute: 30,
    weekday: 1,
    catchUp: true,
    chatMode: 'new',
    permissionCeiling: 'always-ask',
    enabled: true,
    nextRunAt: nextScheduleOccurrence(
      { cadence: 'weekly', hour: 10, minute: 30, weekday: 1 },
      Date.now()
    ),
    runCount: 0,
    createdBy: {
      kind: 'agent',
      conversationId: 'preview-3',
      conversationTitle: 'Build release checklist'
    },
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now() - 3_600_000
  }
]

const previewScheduleRuns: ScheduleRun[] = [
  {
    id: 'preview-schedule-run-2',
    scheduleId: 'preview-schedule-1',
    runNumber: 2,
    scheduledFor: Date.now() - 86_400_000,
    startedAt: Date.now() - 86_400_000,
    outcome: 'started',
    trigger: 'schedule',
    late: false,
    conversationId: 'preview-scheduled-2',
    agentPhase: 'completed',
    workers: [
      {
        conversationId: 'preview-scheduled-2',
        handle: 'dependency-audit',
        title: 'Audit the new dependencies',
        agentPhase: 'completed'
      }
    ]
  },
  {
    id: 'preview-schedule-run-1',
    scheduleId: 'preview-schedule-1',
    runNumber: 1,
    scheduledFor: Date.now() - 2 * 86_400_000 - 3_600_000,
    startedAt: Date.now() - 2 * 86_400_000,
    outcome: 'started',
    trigger: 'schedule',
    late: true,
    reason: 'Started late: SideKick was closed or the computer was asleep.',
    conversationId: 'preview-scheduled-1',
    agentPhase: 'completed'
  }
]

const previewScheduleListeners = new Set<(change: SchedulesChangedEvent) => void>()

function previewSchedule(id: string): Schedule {
  const schedule = previewSchedules.find((candidate) => candidate.id === id)
  if (!schedule) throw new Error('Schedule not found')
  return schedule
}

function publishPreviewSchedules(): void {
  for (const listener of previewScheduleListeners) listener({ schedules: [...previewSchedules] })
}

function changePreviewSchedule(id: string, change: Partial<Schedule>): Schedule {
  const index = previewSchedules.findIndex((candidate) => candidate.id === id)
  if (index < 0) throw new Error('Schedule not found')
  previewSchedules[index] = { ...previewSchedules[index], ...change, updatedAt: Date.now() }
  publishPreviewSchedules()
  return previewSchedules[index]
}

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

const CARD_POLISH_FOLDER =
  'C:\\Users\\you\\AppData\\Roaming\\sidekick\\worktrees\\preview-project-1\\card-polish-1a2b3c4d'

previewConversations.push({
  id: 'preview-4',
  title: 'Polish the conversation cards',
  created_at: Date.now() - 7_200_000,
  updated_at: Date.now() - 600_000,
  project_id: 'preview-project-1',
  sidebar_order: 0,
  project_context_version: 0,
  home_workspace_root: previewProjects[0].folder_path,
  home_project_name: previewProjects[0].name,
  worktree_id: 'preview-worktree-1',
  worktree_folder: CARD_POLISH_FOLDER
})

const previewWorktrees: ManagedWorktreeSummary[] = [
  {
    id: 'preview-worktree-1',
    folderPath: CARD_POLISH_FOLDER,
    worktreeRoot: CARD_POLISH_FOLDER,
    sourceProjectId: 'preview-project-1',
    sourceProjectName: 'sidekick-demo',
    branch: 'sidekick/card-polish',
    baseRef: 'main',
    createdAt: Date.now() - 7_200_000,
    lastUsedAt: Date.now() - 600_000,
    owners: [
      { kind: 'chat', id: 'preview-4', title: 'Polish the conversation cards', running: false }
    ],
    setAsideAt: null,
    status: { currentBranch: 'sidekick/card-polish', ahead: 3, changedFiles: 4 }
  },
  {
    id: 'preview-worktree-2',
    folderPath:
      'C:\\Users\\you\\AppData\\Roaming\\sidekick\\worktrees\\preview-project-1\\release-notes-9f8e7d6c',
    worktreeRoot:
      'C:\\Users\\you\\AppData\\Roaming\\sidekick\\worktrees\\preview-project-1\\release-notes-9f8e7d6c',
    sourceProjectId: 'preview-project-1',
    sourceProjectName: 'sidekick-demo',
    branch: 'sidekick/release-notes',
    baseRef: 'main',
    createdAt: Date.now() - 90_000_000,
    lastUsedAt: Date.now() - 80_000_000,
    owners: [
      {
        kind: 'chat',
        id: 'preview-release-notes',
        title: 'Draft the release notes',
        running: false
      }
    ],
    setAsideAt: Date.now() - 70_000_000,
    status: null
  },
  ...previewSessionWorktrees
]

const previewWorktreesApi: WorktreesAPI = {
  list: async () => structuredClone(previewWorktrees),
  branchOptions: async (projectId) => ({
    branches: ['main', 'release/0.13', 'eponce/tray-menu'],
    currentBranch: 'main',
    isGitRepository: projectId !== 'preview-project-2'
  }),
  createForConversation: async ({ conversationId, baseRef }) => {
    const conversation = previewCreatedConversations.find(({ id }) => id === conversationId)
    if (!conversation) throw new Error('Only a chat without messages can move to a new worktree')
    const base = baseRef || 'main'
    const folder = `C:\\Users\\you\\AppData\\Roaming\\sidekick\\worktrees\\preview-project-1\\new-chat`
    const id = `preview-worktree-${Date.now()}`
    Object.assign(conversation, {
      worktree_id: id,
      worktree_folder: folder,
      project_context_version: conversation.project_context_version + 1
    })
    const worktree: ManagedWorktreeSummary = {
      id,
      folderPath: folder,
      worktreeRoot: folder,
      sourceProjectId: 'preview-project-1',
      sourceProjectName: 'sidekick-demo',
      branch: 'sidekick/new-chat-5e1d0a',
      baseRef: base,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      owners: [{ kind: 'chat', id: conversation.id, title: conversation.title, running: false }],
      setAsideAt: null,
      status: { currentBranch: 'sidekick/new-chat-5e1d0a', ahead: 0, changedFiles: 0 }
    }
    previewWorktrees.unshift(worktree)
    return { conversation, worktree }
  },
  remove: async (id) => {
    const index = previewWorktrees.findIndex((worktree) => worktree.id === id)
    if (index < 0) throw new Error('This worktree is no longer managed by SideKick')
    if (previewWorktrees[index].owners.some(({ running }) => running))
      return { removed: false, reason: 'An agent is working in it. Stop it first.' }
    previewWorktrees.splice(index, 1)
    return { removed: true }
  },
  reveal: async () => undefined
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
      'I reviewed the main shell and found three high-impact areas:\n\n- **Preserve the workspace:** collapse secondary panels before they squeeze the conversation.\n- **Clarify hierarchy:** strengthen the composer, active navigation, and dialog section boundaries.\n- **Improve first use:** offer useful starting points instead of leaving an empty canvas.\n\nThe result should feel focused without becoming visually busy. I started in `src/renderer/src/components/ChatPanel.tsx` and the guidelines in docs/development/UI.md.\n\nBackground reading: [Inclusive Components](https://inclusive-components.design/) and the [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).',
    segments: [
      {
        type: 'thinking' as const,
        content:
          'I should inspect the current information hierarchy before changing visual density.'
      },
      {
        type: 'steer' as const,
        steer: {
          id: 'preview-steer-1',
          content: 'Keep the sidebar as it is; focus on the chat and the composer.',
          timestamp: Date.now() - 150_000
        }
      },
      {
        type: 'interaction' as const,
        interaction: {
          id: 'preview-question-answered',
          kind: 'question' as const,
          status: 'resolved' as const,
          request: {
            questions: [
              {
                id: 'scope',
                header: 'Redesign scope',
                question: 'Which parts of the interface should this pass change?',
                options: [{ label: 'Everything, all of it' }, { label: 'Only the conversation' }]
              }
            ]
          },
          response: { scope: 'Everything, all of it' }
        }
      },
      {
        type: 'interaction' as const,
        interaction: {
          id: 'preview-question-1',
          kind: 'question' as const,
          status: 'pending' as const,
          request: {
            questions: [
              {
                id: 'density',
                header: 'Density',
                question: 'How compact should the conversation feel on a large display?',
                multiSelect: false,
                options: [
                  {
                    label: 'Comfortable',
                    description:
                      'Roomier line height and spacing, easier for long reading sessions',
                    recommended: true
                  },
                  {
                    label: 'Compact',
                    description: 'Fits more of the conversation on screen at once'
                  }
                ]
              },
              {
                id: 'surfaces',
                header: 'Surfaces',
                question: 'Which secondary panels should stay visible while the agent works?',
                multiSelect: true,
                options: [
                  { label: 'Files', description: 'The project tree and the file viewer' },
                  { label: 'Browser', description: 'The live page the agent is driving' },
                  { label: 'Recovery', description: 'Checkpoints and workspace history' }
                ]
              }
            ]
          }
        }
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
            'Exit code: 0\n<stdout>\n> sidekick@0.6.0 typecheck:web\n> tsc --noEmit -p tsconfig.web.json --composite false\n\nType check passed.\n</stdout>\n',
          data: {
            success: true,
            exitCode: 0,
            stdout:
              '> sidekick@0.6.0 typecheck:web\n> tsc --noEmit -p tsconfig.web.json --composite false\n\nType check passed.\n',
            stderr: ''
          },
          startedAt: Date.now() - 130_000,
          completedAt: Date.now() - 126_000
        }
      },
      {
        type: 'tool' as const,
        tool: {
          id: 'preview-tool-download',
          name: 'shell',
          title: 'Download the job files',
          command: 'python fetch_jobs.py --host 192.168.0.20 --dir /md/',
          status: 'success' as const,
          accessLevel: 'auto' as const,
          approvalStatus: 'auto' as const,
          presentation: {
            kind: 'terminal' as const,
            title: 'Download the job files',
            subject: 'python fetch_jobs.py --host 192.168.0.20 --dir /md/',
            detail: 'Completed in 12.8s'
          },
          output: 'Exit code: 0\n<stdout>\n…\n</stdout>\n',
          data: {
            success: true,
            exitCode: 0,
            stdout: Array.from(
              { length: 1_200 },
              (_, line) =>
                `RETR /md/JOB${String(line).padStart(4, '0')}.LS  ${(2_048 + line * 3).toLocaleString('en-US')} bytes  OK`
            )
              .concat('Downloaded 1,200 files, 2,412,160 bytes in total.')
              .join('\n'),
            stderr: 'warning: passive mode refused, using active mode\n'
          },
          outputReference: {
            truncated: true,
            originalBytes: 58_903,
            returnedBytes: 31_224,
            fullOutputHandle: '00000000-0000-4000-8000-000000000000',
            continuation: { offset: 15_812 }
          },
          startedAt: Date.now() - 125_000,
          completedAt: Date.now() - 112_000
        }
      },
      {
        type: 'tool' as const,
        tool: {
          id: 'preview-tool-failed-command',
          name: 'shell',
          title: 'Upload the program',
          command: 'python put_program.py MAIN.TP',
          status: 'error' as const,
          accessLevel: 'auto' as const,
          approvalStatus: 'auto' as const,
          presentation: {
            kind: 'terminal' as const,
            title: 'Upload the program',
            subject: 'python put_program.py MAIN.TP',
            detail: 'Failed in 1.1s'
          },
          error: 'Command exited with code 2: 550 MAIN.TP: write protected',
          output: 'Exit code: 2\n<stdout>\nConnected to 192.168.0.20\n</stdout>\n',
          data: {
            success: false,
            exitCode: 2,
            stdout: 'Connected to 192.168.0.20\nSTOR MAIN.TP\n',
            stderr: '550 MAIN.TP: write protected\n'
          },
          startedAt: Date.now() - 110_000,
          completedAt: Date.now() - 109_000
        }
      },
      {
        type: 'tool' as const,
        tool: {
          id: 'preview-tool-dev-server',
          name: 'shell',
          title: 'Start the dev server',
          command: 'npm run dev',
          status: 'success' as const,
          accessLevel: 'auto' as const,
          approvalStatus: 'auto' as const,
          presentation: {
            kind: 'terminal' as const,
            title: 'Start the dev server',
            subject: 'npm run dev',
            detail: 'Running in the background'
          },
          output: 'Running in the background.',
          startedAt: Date.now() - 90_000,
          completedAt: Date.now() - 89_000
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
          'I reviewed the main shell and found three high-impact areas:\n\n- **Preserve the workspace:** collapse secondary panels before they squeeze the conversation.\n- **Clarify hierarchy:** strengthen the composer, active navigation, and dialog section boundaries.\n- **Improve first use:** offer useful starting points instead of leaving an empty canvas.\n\nThe result should feel focused without becoming visually busy. I started in `src/renderer/src/components/ChatPanel.tsx` and the guidelines in docs/development/UI.md.\n\nBackground reading: [Inclusive Components](https://inclusive-components.design/) and the [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).'
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

// The preview keeps one goal and its listeners so the composer banner and the
// completion notice can be exercised without a model. Nothing here is shipped.
let previewGoal: ConversationGoal | null = null
const previewGoalListeners = new Set<(change: ConversationGoalChangedEvent) => void>()

function changePreviewGoal(update: Partial<ConversationGoal>): ConversationGoal {
  if (!previewGoal) throw new Error('No preview goal')
  previewGoal = {
    ...previewGoal,
    ...update,
    revision: previewGoal.revision + 1,
    updatedAt: Date.now()
  }
  const snapshot = previewGoal
  for (const listener of previewGoalListeners) listener({ goal: snapshot })
  if (snapshot.status === 'cleared') previewGoal = null
  return snapshot
}

declare global {
  interface Window {
    /** Preview-only controls for states a model would normally drive. */
    __sidekickPreview?: {
      completeGoal: (summary?: string, verification?: string) => ConversationGoal
    }
  }
}

export function installBrowserApiMock(): void {
  if (window.api || !import.meta.env.DEV) return

  window.__sidekickPreview = {
    completeGoal: (
      summary = 'Added the toggle and wired it to the theme store.',
      verification = 'Settings tests pass: 14 of 14.'
    ) =>
      changePreviewGoal({
        status: 'completed',
        completionSummary: summary,
        completionVerification: verification,
        completedAt: Date.now()
      })
  }

  window.api = {
    providers: {
      probe: async (target) => ({ model: target.model, checks: [] }),
      cancelProbe: async () => undefined,
      complete: async () => ({ ok: false, error: 'UI preview' }),
      discoverModels: async (request) => {
        // Long enough to see the loading state.
        await new Promise((resolve) => setTimeout(resolve, 400))
        return { ok: true, models: previewDiscoverModels(request.draft) }
      },
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
      selectOfficeInterpreter: async () => ({ canceled: true }),
      save: async () => ({ success: true }),
      load: async () => previewSettings,
      onChanged: () => () => undefined
    },
    commandLine: {
      status: async () => previewCommandLineStatus,
      install: async () => ({ ok: true, status: previewCommandLineStatus })
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
      // No phone adds messages in the preview.
      onMessagesChanged: () => () => undefined,
      onListChanged: () => () => undefined,
      search: async (query) =>
        [...previewCreatedConversations, ...previewConversations].filter((item) =>
          item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        ),
      create: async (title, projectId, titleSource = 'placeholder', modelId) => {
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
          home_project_name: project?.name ?? null,
          model_id: modelId ?? null
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
      setModel: async (id, modelId) => {
        const conversation = [...previewCreatedConversations, ...previewConversations].find(
          (candidate) => candidate.id === id
        )
        if (conversation) conversation.model_id = modelId
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
      discardIfUntouched: async (id) => {
        const index = previewCreatedConversations.findIndex((candidate) => candidate.id === id)
        if (index >= 0) previewCreatedConversations.splice(index, 1)
        return { discarded: index >= 0 }
      },
      deleteAll: async () => ({ success: true }),
      getMessages: async (conversationId) =>
        conversationId === 'preview-1'
          ? previewMessages
          : ((previewSessionTranscripts[conversationId] ?? []) as typeof previewMessages),
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
        replyMessageId: input.replyMessageId ?? null,
        replyMessagesCovered: input.replyMessagesCovered ?? 0,
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
          workspaceRoot: conversation?.worktree_folder ?? project?.folder_path ?? null,
          worktreeId: conversation?.worktree_id ?? null,
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
    worktrees: previewWorktreesApi,
    menus: {
      onShow: () => () => undefined,
      choose: async () => undefined,
      dismiss: async () => undefined
    },
    agentRuns: {
      // "Refine the desktop experience" is treated as writing in sidekick-demo, so a new chat
      // there shows the busy-folder prompt.
      workspaceOccupants: async (conversationId) => {
        const conversation = [...previewCreatedConversations, ...previewConversations].find(
          ({ id }) => id === conversationId
        )
        return conversation?.project_id === 'preview-project-1' && conversationId !== 'preview-1'
          ? [
              {
                runId: 'preview-run-1',
                conversationId: 'preview-1',
                title: 'Refine the desktop experience',
                workspaceRoot: 'C:\\Projects\\sidekick-demo'
              }
            ]
          : []
      },
      browserWorkspace: async () => null,
      browserAnnotations: async () => [],
      onBrowserAnnotationsChanged: () => () => undefined,
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
      steer: async () => ({ accepted: false }),
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
      resolveInteraction: async () => ({ success: true }),
      admissionsList: async () => ({ queued: [], pivot: null }),
      admissionsReplace: async () => ({ queued: [], pivot: null }),
      admissionsTakeNext: async () => null,
      onAdmissionsChanged: () => () => undefined,
      onEvent: () => () => undefined,
      onArtifactDraft: () => () => undefined
    },
    terminal: previewTerminalApi(),
    userTerminal: previewUserTerminalApi(),
    sessions: previewSessionsApi(),
    schedules: {
      list: async () => [...previewSchedules],
      create: async (input) => {
        const schedule: Schedule = {
          ...input,
          id: crypto.randomUUID(),
          enabled: true,
          nextRunAt: nextScheduleOccurrence(input, Date.now()),
          runCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        previewSchedules.push(schedule)
        publishPreviewSchedules()
        return schedule
      },
      update: async ({ id, ...input }) =>
        changePreviewSchedule(id, {
          ...input,
          nextRunAt: previewSchedule(id).enabled ? nextScheduleOccurrence(input, Date.now()) : null
        }),
      pause: async (id) => changePreviewSchedule(id, { enabled: false, nextRunAt: null }),
      resume: async (id) =>
        changePreviewSchedule(id, {
          enabled: true,
          pausedReason: undefined,
          nextRunAt: nextScheduleOccurrence(previewSchedule(id), Date.now())
        }),
      delete: async (id) => {
        const index = previewSchedules.findIndex((candidate) => candidate.id === id)
        if (index >= 0) previewSchedules.splice(index, 1)
        publishPreviewSchedules()
        return { success: index >= 0 }
      },
      runNow: async (id) => {
        const run: ScheduleRun = {
          id: crypto.randomUUID(),
          scheduleId: id,
          scheduledFor: Date.now(),
          outcome: 'skipped',
          trigger: 'manual',
          late: false,
          reason: 'The preview does not start agent runs.'
        }
        previewScheduleRuns.unshift(run)
        return run
      },
      runs: async (id) => previewScheduleRuns.filter((run) => run.scheduleId === id),
      onChanged: (callback) => {
        previewScheduleListeners.add(callback)
        return () => previewScheduleListeners.delete(callback)
      }
    },
    conversationGoals: {
      current: async (conversationId) =>
        previewGoal?.conversationId === conversationId ? previewGoal : null,
      create: async (input) => {
        previewGoal = {
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
        }
        return previewGoal
      },
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
      pause: async () => changePreviewGoal({ status: 'paused' }),
      resume: async () => changePreviewGoal({ status: 'active' }),
      clear: async () => changePreviewGoal({ status: 'cleared' }),
      onChanged: (callback) => {
        previewGoalListeners.add(callback)
        return () => previewGoalListeners.delete(callback)
      }
    },
    mcp: {
      listTools: async () => ({ ok: true, tools: [], statuses: [] }),
      authenticate: async () => ({ ok: true, tools: [], statuses: [] }),
      approve: async () => ({ ok: true, tools: [], statuses: [] }),
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
    browserNetwork: {
      list: async () => [...previewBrowserNetwork],
      revoke: async (origin) => {
        previewBrowserNetwork = previewBrowserNetwork.filter((entry) => entry.origin !== origin)
        return [...previewBrowserNetwork]
      }
    },
    credentials: previewCredentialsApi(),
    browserLibrary: previewBrowserLibraryApi(),
    companion: previewCompanionApi(),
    pullRequests: previewPullRequestsApi(),
    window: {
      minimize: () => {},
      maximize: () => {},
      close: () => {},
      isMaximized: async () => false,
      isFullScreen: async () => false,
      onMaximizedChange: () => () => undefined,
      onFullScreenChange: () => () => undefined
    },
    panelWindows: {
      open: async () => false,
      list: async () => [],
      focus: async () => false,
      dock: () => {},
      onChanged: () => () => undefined,
      onDocked: () => () => undefined
    },
    notification: { show: async () => ({ ok: true }) },
    siteIcons: { get: async () => ({ dataUrl: null }) },
    app: {
      platform: 'windows',
      onCommand: () => () => undefined,
      onOpenConversation: () => () => undefined,
      onOpenProviderKey: () => () => undefined,
      onOpenCredential: () => () => undefined
    },
    appUpdates: {
      install: async () => ({
        status: 'disabled' as const,
        currentVersion: '0.7.0',
        reason: 'development' as const
      }),
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
    voice: {
      getState: async () => ({
        enabled: true,
        models: {
          dictation: { status: 'downloading' as const, receivedBytes: 280e6, totalBytes: 671e6 },
          speech: { status: 'ready' as const, receivedBytes: 361e6, totalBytes: 361e6 }
        }
      }),
      onState: () => () => undefined,
      prioritize: async () => undefined,
      startDictation: async () => ({
        ok: false as const,
        reason: 'downloading' as const,
        message: 'Dictation is still being set up (41%).'
      }),
      pushDictationAudio: () => undefined,
      stopDictation: async () => undefined,
      cancelDictation: async () => undefined,
      onDictationText: () => () => undefined,
      speak: async () => ({
        ok: false as const,
        reason: 'unavailable' as const,
        message: 'Read aloud needs the desktop app.'
      }),
      stopSpeech: async () => undefined,
      onSpeechAudio: () => () => undefined,
      onSpeechEnd: () => () => undefined
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
      listPrompts: async () => ({
        ok: true,
        prompts: [
          {
            name: 'review',
            description: 'Review the current changes',
            body: 'Review the changes in $ARGUMENTS for bugs and missing tests.',
            source: 'project' as const,
            location: '.sidekick/prompts/review.md'
          }
        ]
      }),
      readFile: async (_root: string, filePath: string) =>
        filePath.endsWith('.md')
          ? {
              ok: true,
              content: [
                '# Anascan improvement plan (v0.2 → v1.0)',
                '',
                'Author: product + architecture lead. Audience: the coding agent that implements it.',
                '',
                'The goal: a scanner people *prefer* over CamScanner, which means, in this order:',
                '',
                '1. It **works every time** (capture → clean page → PDF, no dead ends).',
                '2. It is fast and obvious (three taps to a shared PDF).',
                '3. It looks and feels premium.',
                '',
                '---',
                '',
                '## 0. How to use this document',
                '',
                '- Go milestone by milestone, in order (`M0` → `M9`).',
                '- One task = one small, verifiable change:',
                '  - build: `gradle :app:assembleDebug`;',
                '  - test: `gradle :core:test`.',
                '- Never add network calls or Google Play Services.',
                '',
                '> **Definition of Done:** it works on the emulator end to end and has tests.',
                '',
                '### 2.1 Broken or dead-end',
                '',
                '| # | Problem | Where |',
                '|---|---|---|',
                '| B1 | Camera never shows a preview or captures. | `ui/CameraScreen.kt:68-87` |',
                '| B2 | Import from Home does nothing visible. | `MainActivity.kt:119-130` |',
                '| B3 | Reorder shows the wrong order after "Listo". | `ui/PhotoEditorScreen.kt:111` |',
                '',
                '```kotlin',
                '@Serializable data class Page(',
                '  val id: String,',
                '  val corners: Corners?,',
                '  val filter: FilterType,',
                ')',
                '```',
                '',
                '- [x] `git init` and the first commit',
                '- [ ] Add the Gradle wrapper',
                '',
                'See [the testing notes](REAL-DOCUMENTS-TESTING.md) for details.'
              ].join(String.fromCharCode(10)),
              totalLines: 42
            }
          : {
              ok: true,
              content: [
                "import { useState } from 'react'",
                '',
                'export function Counter(): JSX.Element {',
                '  const [count, setCount] = useState(0)',
                '  return <button onClick={() => setCount(count + 1)}>{count}</button>',
                '}'
              ].join(String.fromCharCode(10)),
              totalLines: 6
            },
      readImage: async () => ({ ok: false, dataUrl: null, error: 'Not available in preview' }),
      resolveFileReference: async (reference: string) => ({
        ok: true,
        matches: [reference.replace(/^\.\//, '')]
      }),
      searchFiles: async () => ({ ok: true, output: '', matchCount: 0, matchedFiles: [] }),
      trashFile: async () => ({ ok: true }),
      gitAvailable: async () => true,
      beginHistoryCapture: async () => ({ ok: true, captureId: crypto.randomUUID() }),
      discardHistoryCapture: async () => ({ ok: true }),
      createCheckpoint: async () => ({ ok: true, hash: 'abcdef123456' }),
      hardResetCheckpoint: async () => ({ ok: true }),
      rewindToBeforeCheckpoint: async () => ({ ok: true, parentHash: null }),
      openFolder: async () => {},
      openFile: async () => {},
      openFileReference: async (fileReference) => ({
        ok: true,
        status: 'opened' as const,
        path: fileReference
      }),
      revealFile: async () => {},
      showPathMenu: async () => undefined,
      countPathItems: async () => ({ count: 12, more: false }),
      watchFiles: () => () => {}
    }
  }
}
