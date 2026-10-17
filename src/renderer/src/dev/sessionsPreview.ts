import type { ProjectConversation } from '../../../shared/projects'
import type { TodoItem } from '../../../shared/types'
import type { ManagedWorktreeSummary } from '../../../shared/worktrees'
import {
  SESSION_LIMITS,
  countSessionStates,
  mostUrgentSessionState,
  sessionLinkFromConversation,
  suggestSessionHandle,
  type SessionFamily,
  type SessionFamilyMember,
  type SessionMessage,
  type SessionProjectGrant,
  type SessionProposal,
  type SessionState,
  type SessionStatus,
  type SessionsAPI,
  type SessionsChangedEvent
} from '../../../shared/sessions'

const MANAGER_ID = 'preview-manager-1'
const DEMO_ROOT = 'C:\\Projects\\sidekick-demo'
const WORKTREES = 'C:\\Users\\you\\AppData\\Roaming\\sidekick\\worktrees\\preview-project-1'
const minutes = (count: number): number => Date.now() - count * 60_000

interface PreviewWorker {
  handle: string
  title: string
  state: SessionState
  reason?: string
  projectId?: string
  projectName?: string
  root?: string
}

const workers: PreviewWorker[] = [
  { handle: 'question-card', title: 'Polish the agent question card', state: 'done' },
  { handle: 'thinking-toggle', title: 'Brain-icon thinking toggle', state: 'working' },
  { handle: 'settings-polish', title: 'Polish the whole settings window', state: 'idle' },
  {
    handle: 'schedules',
    title: "Port Cline's schedules feature",
    state: 'waiting',
    reason: 'Approval: run npx vitest run src/main/services/scheduler'
  },
  {
    handle: 'release-notes',
    title: 'Draft the release notes',
    state: 'failed',
    reason: 'Interrupted when SideKick closed'
  },
  {
    handle: 'api-contract',
    title: 'Contract tests for /v1/projects',
    state: 'working',
    projectId: 'preview-project-2',
    projectName: 'sidekick-api',
    root: 'C:\\Projects\\sidekick-api'
  }
]

const workerId = (handle: string): string => `preview-worker-${handle}`
const workerWorktreeId = (handle: string): string => `preview-worker-worktree-${handle}`
const sourceName = (worker: PreviewWorker): string => worker.projectName ?? 'sidekick-demo'
const worktreeFolder = (worker: PreviewWorker): string =>
  worker.projectId
    ? `${WORKTREES.replace('preview-project-1', worker.projectId)}\\${worker.handle}`
    : `${WORKTREES}\\${worker.handle}`

/** A manager chat with five workers, one of them in another project. */
export const previewSessionConversations: ProjectConversation[] = [
  {
    id: MANAGER_ID,
    title: 'Cline desktop design review',
    created_at: minutes(90),
    updated_at: minutes(1),
    project_id: 'preview-project-1',
    sidebar_order: 3,
    project_context_version: 0,
    home_workspace_root: DEMO_ROOT,
    home_project_name: 'sidekick-demo',
    started_by_kind: 'user'
  },
  ...workers.map(
    (worker, index): ProjectConversation => ({
      id: workerId(worker.handle),
      title: worker.title,
      created_at: minutes(80 - index),
      updated_at: minutes(10 - index),
      // Each worker stays in its project and works in its own worktree of it.
      project_id: worker.projectId ?? 'preview-project-1',
      sidebar_order: 4 + index,
      project_context_version: 0,
      home_workspace_root: worker.root ?? DEMO_ROOT,
      home_project_name: sourceName(worker),
      worktree_id: workerWorktreeId(worker.handle),
      worktree_folder: worktreeFolder(worker),
      unread_completion_at: worker.state === 'done' ? minutes(4) : null,
      started_by_kind: 'session',
      started_by_conversation_id: MANAGER_ID,
      report_to_conversation_id: MANAGER_ID,
      session_handle: worker.handle,
      work_in: 'worktree'
    })
  )
]

const branchStatus: Record<string, { ahead: number; changedFiles: number }> = {
  'question-card': { ahead: 1, changedFiles: 0 },
  'thinking-toggle': { ahead: 2, changedFiles: 0 },
  'settings-polish': { ahead: 4, changedFiles: 0 },
  schedules: { ahead: 3, changedFiles: 4 },
  'release-notes': { ahead: 0, changedFiles: 1 },
  'api-contract': { ahead: 1, changedFiles: 2 }
}

// This module loads with the app, so a worker missing above must not stop SideKick from starting.
const statusOf = (handle: string): { ahead: number; changedFiles: number } =>
  branchStatus[handle] ?? { ahead: 0, changedFiles: 0 }

export const previewSessionWorktrees: ManagedWorktreeSummary[] = workers.map((worker, index) => ({
  id: workerWorktreeId(worker.handle),
  folderPath: worktreeFolder(worker),
  worktreeRoot: worktreeFolder(worker),
  sourceProjectId: worker.projectId ?? 'preview-project-1',
  sourceProjectName: sourceName(worker),
  branch: `sidekick/${worker.handle}`,
  baseRef: 'main',
  createdAt: minutes(80 - index),
  lastUsedAt: minutes(10 - index),
  owners: [
    {
      kind: 'chat',
      id: workerId(worker.handle),
      title: worker.title,
      running: worker.state === 'working'
    }
  ],
  setAsideAt: null,
  status: {
    currentBranch: `sidekick/${worker.handle}`,
    ahead: statusOf(worker.handle).ahead,
    changedFiles: statusOf(worker.handle).changedFiles
  }
}))

// The manager writes the design itself; every other step waits on the chat doing it.
const todoList: TodoItem[] = [
  {
    id: 1,
    title: 'Look at tray, dev-instance and component setup',
    description: '',
    status: 'completed'
  },
  ...workers.map(
    (worker, index): TodoItem => ({
      id: index + 2,
      title: worker.title,
      description: '',
      status: 'not-started',
      sessionId: workerId(worker.handle)
    })
  ),
  { id: 7, title: 'Write up the design', description: '', status: 'in-progress' }
]

/** Transcripts for the manager and one worker, so both chats show their family rows. */
export const previewSessionTranscripts: Record<string, unknown[]> = {
  [MANAGER_ID]: [
    {
      id: 'preview-manager-message-1',
      conversation_id: MANAGER_ID,
      role: 'user',
      content:
        'Split the Cline review into parallel chats: question card, thinking toggle, settings polish and schedules here, plus the contract tests in sidekick-api. Report back when they are done.',
      timestamp: minutes(82)
    },
    {
      id: 'preview-manager-message-2',
      runId: 'preview-manager-run-1',
      conversation_id: MANAGER_ID,
      role: 'agent',
      content: "Five chats are running. I'll fold their results into the design once they report.",
      timestamp: minutes(81)
    },
    {
      id: 'preview-manager-message-3',
      runId: 'preview-manager-run-2',
      conversation_id: MANAGER_ID,
      role: 'agent',
      content:
        'question-card and settings-polish are done; both changed only their own files. Waiting on the rest.',
      segments: [
        {
          type: 'tool' as const,
          tool: {
            id: 'preview-manager-todos',
            name: 'manage_todo_list',
            title: 'Update the task list',
            command: 'manage_todo_list',
            status: 'success' as const,
            accessLevel: 'auto' as const,
            approvalStatus: 'auto' as const,
            input: { operation: 'write', todoList },
            data: { todoList }
          }
        },
        {
          type: 'text' as const,
          content:
            'question-card and settings-polish are done; both changed only their own files. Waiting on the rest.'
        }
      ],
      timestamp: minutes(14)
    }
  ],
  [workerId('schedules')]: [
    {
      id: 'preview-worker-message-1',
      runId: 'preview-worker-run-1',
      conversation_id: workerId('schedules'),
      role: 'agent',
      content:
        'The scheduler, its migration and the dialog are in place. Running the focused tests before reporting.',
      timestamp: minutes(75)
    },
    {
      id: 'preview-worker-message-2',
      runId: 'preview-worker-run-2',
      conversation_id: workerId('schedules'),
      role: 'agent',
      content: 'Running the scheduler tests.',
      segments: [
        { type: 'text' as const, content: 'Running the scheduler tests.' },
        {
          type: 'interaction' as const,
          interaction: {
            id: 'preview-worker-approval',
            kind: 'permission' as const,
            status: 'pending' as const,
            request: {
              title: 'Run a command?',
              arguments: { command: 'npx vitest run src/main/services/scheduler' },
              chatScope: 'this exact command'
            }
          }
        }
      ],
      timestamp: minutes(3)
    }
  ]
}

const conversationById = new Map(previewSessionConversations.map((row) => [row.id, row]))
const states = new Map<string, { state: SessionState; since: number; reason?: string }>([
  [MANAGER_ID, { state: 'working', since: minutes(1) }],
  ...workers.map(
    (worker, index) =>
      [
        workerId(worker.handle),
        { state: worker.state, since: minutes(6 - index), reason: worker.reason }
      ] as const
  )
])

let nextMessage = 0
const message = (
  from: string | null,
  to: string,
  intent: SessionMessage['intent'],
  body: string,
  ageMinutes: number,
  delivered = true
): SessionMessage => ({
  id: `preview-session-message-${(nextMessage += 1)}`,
  fromConversationId: from,
  toConversationId: to,
  intent,
  body,
  attachments: [],
  replyToMessageId: null,
  createdAt: minutes(ageMinutes),
  deliveredRunId: delivered ? 'preview-run' : null,
  deliveredAt: delivered ? minutes(ageMinutes) : null,
  readAt: null
})

const messages: SessionMessage[] = [
  ...workers.map((worker) =>
    message(
      MANAGER_ID,
      workerId(worker.handle),
      'brief',
      `${worker.title}. Done means: the change works in the running app, focused tests pass, and hand-over notes are written. Do not commit.`,
      80
    )
  ),
  message(
    workerId('question-card'),
    MANAGER_ID,
    'report',
    'Done. Numbered options, arrow-key movement and a separated footer; 12 tests pass. Branch sidekick/question-card, 1 commit.',
    20
  ),
  message(
    workerId('settings-polish'),
    MANAGER_ID,
    'report',
    'Done. Shared SettingsLayout building blocks and consistent rows across every page; 31 tests pass.',
    15
  ),
  message(
    workerId('schedules'),
    MANAGER_ID,
    'status',
    'Waiting for the user to approve npx vitest run src/main/services/scheduler.',
    3,
    false
  ),
  message(
    MANAGER_ID,
    workerId('schedules'),
    'update',
    'Keep the Schedules dialog separate from Settings.',
    12
  ),
  message(
    workerId('api-contract'),
    MANAGER_ID,
    'request',
    'Should /v1/projects return nextCursor as null or omit it on the last page?',
    2,
    false
  )
]

const proposals: SessionProposal[] = [
  {
    id: 'preview-proposal-1',
    proposerConversationId: MANAGER_ID,
    spec: {
      title: 'Fix the flaky scheduler clock test',
      brief:
        'The scheduler clock test fails about 1 in 20 runs on Windows. Find and fix the cause.',
      workIn: 'worktree'
    },
    status: 'open',
    createdAt: minutes(5),
    expiresAt: minutes(5) + SESSION_LIMITS.proposalTtlMs,
    resolvedAt: null,
    startedConversationId: null
  }
]

const grants: SessionProjectGrant[] = [
  {
    conversationId: MANAGER_ID,
    projectId: 'preview-project-2',
    grantedAt: minutes(85),
    revokedAt: null
  }
]

const listeners = new Set<(change: SessionsChangedEvent) => void>()

function publish(change: SessionsChangedEvent): void {
  for (const listener of listeners) listener(change)
}

function member(conversationId: string): SessionFamilyMember | null {
  const row = conversationById.get(conversationId)
  if (!row) return null
  return {
    ...sessionLinkFromConversation(row),
    title: row.title,
    projectId: row.project_id,
    projectName: row.home_project_name,
    state: states.get(row.id)?.state ?? 'idle'
  }
}

function liveWorkers(managerId: string): SessionFamilyMember[] {
  return previewSessionConversations
    .filter((row) => row.started_by_conversation_id === managerId && !row.archived_at)
    .map((row) => member(row.id)!)
}

function status(conversationId: string): SessionStatus {
  const current = states.get(conversationId) ?? { state: 'idle' as const, since: Date.now() }
  const family = liveWorkers(conversationId)
  return {
    conversationId,
    ...current,
    ...(family.length
      ? {
          family: {
            state: mostUrgentSessionState(family.map(({ state }) => state)),
            counts: countSessionStates(family.map(({ state }) => state))
          }
        }
      : {})
  }
}

function setState(conversationId: string, state: SessionState, reason?: string): void {
  states.set(conversationId, { state, since: Date.now(), reason })
  const managerId = conversationById.get(conversationId)?.started_by_conversation_id
  const changed = managerId ? [conversationId, managerId] : [conversationId]
  publish({ kind: 'status', conversationIds: changed, statuses: changed.map(status) })
}

function startWorker(managerId: string, spec: SessionProposal['spec']): SessionFamilyMember {
  const manager = conversationById.get(managerId)
  if (!manager) throw new Error('Chat not found')
  if (liveWorkers(managerId).length >= SESSION_LIMITS.liveWorkersPerFamily)
    throw new Error(`A chat can have at most ${SESSION_LIMITS.liveWorkersPerFamily} live workers`)
  const handle =
    spec.handle ??
    suggestSessionHandle(
      spec.title,
      liveWorkers(managerId).map(({ handle }) => handle ?? '')
    )
  const row: ProjectConversation = {
    ...manager,
    id: `preview-worker-${Date.now()}`,
    title: spec.title,
    created_at: Date.now(),
    updated_at: Date.now(),
    project_id: spec.projectId === undefined ? manager.project_id : spec.projectId,
    unread_completion_at: null,
    started_by_kind: 'session',
    started_by_conversation_id: managerId,
    report_to_conversation_id: managerId,
    session_handle: handle,
    work_in: spec.workIn ?? 'worktree',
    archived_at: null
  }
  previewSessionConversations.push(row)
  conversationById.set(row.id, row)
  messages.push(message(managerId, row.id, 'brief', spec.brief, 0))
  states.set(row.id, { state: 'queued', since: Date.now() })
  publish({ kind: 'family', conversationIds: [managerId, row.id] })
  return member(row.id)!
}

function proposal(id: string): SessionProposal {
  const found = proposals.find((candidate) => candidate.id === id)
  if (!found) throw new Error('Suggestion not found')
  return found
}

/** In-memory sessions for the UI preview. Nothing runs; state changes only through these calls. */
export function previewSessionsApi(): SessionsAPI {
  return {
    statuses: async () =>
      [...states.keys()].map(status).filter((entry) => entry.state !== 'idle' || entry.family),
    family: async (conversationId): Promise<SessionFamily | null> => {
      const row = conversationById.get(conversationId)
      if (!row) return null
      const managerId = row.started_by_conversation_id ?? row.id
      const workersOf = liveWorkers(managerId)
      if (!workersOf.length) return null
      return { rootConversationId: managerId, manager: member(managerId)!, workers: workersOf }
    },
    messages: async (conversationId, options) => {
      const matching = messages.filter(
        (entry) =>
          (entry.toConversationId === conversationId ||
            entry.fromConversationId === conversationId) &&
          (options?.beforeCreatedAt === undefined || entry.createdAt < options.beforeCreatedAt)
      )
      matching.sort((left, right) => left.createdAt - right.createdAt)
      return options?.limit ? matching.slice(-options.limit) : matching
    },
    markMessagesRead: async (conversationId) => {
      for (const entry of messages)
        if (entry.toConversationId === conversationId) entry.readAt ??= Date.now()
      publish({ kind: 'messages', conversationIds: [conversationId] })
    },
    attachment: async () => null,
    start: async (input) => {
      if (input.mode === 'propose') {
        const created = input.sessions.map(
          (spec, index): SessionProposal => ({
            id: `preview-proposal-${Date.now()}-${index}`,
            proposerConversationId: input.managerConversationId,
            spec,
            status: 'open',
            createdAt: Date.now(),
            expiresAt: Date.now() + SESSION_LIMITS.proposalTtlMs,
            resolvedAt: null,
            startedConversationId: null
          })
        )
        proposals.push(...created)
        publish({ kind: 'proposals', conversationIds: [input.managerConversationId] })
        return { started: [], proposals: created }
      }
      return {
        started: input.sessions.map((spec) => startWorker(input.managerConversationId, spec)),
        proposals: []
      }
    },
    proposals: async (conversationId) =>
      proposals.filter((entry) => entry.proposerConversationId === conversationId),
    startProposal: async (id, overrides) => {
      const found = proposal(id)
      if (found.status !== 'open') throw new Error('This suggestion is no longer open')
      const started = startWorker(found.proposerConversationId, { ...found.spec, ...overrides })
      Object.assign(found, {
        status: 'started',
        resolvedAt: Date.now(),
        startedConversationId: started.conversationId
      })
      publish({ kind: 'proposals', conversationIds: [found.proposerConversationId] })
      return started
    },
    dismissProposal: async (id) => {
      const found = proposal(id)
      Object.assign(found, { status: 'dismissed', resolvedAt: Date.now() })
      publish({ kind: 'proposals', conversationIds: [found.proposerConversationId] })
      return found
    },
    stop: async (conversationId) => setState(conversationId, 'stopped', 'Stopped by you'),
    archive: async (conversationId, options) => {
      const archived = [conversationId]
      if (options?.family)
        archived.push(
          ...liveWorkers(conversationId)
            .filter(({ state }) => state === 'done' || state === 'idle' || state === 'stopped')
            .map(({ conversationId: id }) => id)
        )
      for (const id of archived) {
        const row = conversationById.get(id)
        if (row) row.archived_at = Date.now()
      }
      publish({ kind: 'family', conversationIds: archived })
    },
    unarchive: async (conversationId) => {
      const row = conversationById.get(conversationId)
      if (row) row.archived_at = null
      publish({ kind: 'family', conversationIds: [conversationId] })
    },
    detach: async (conversationId) => {
      const row = conversationById.get(conversationId)
      const managerId = row?.started_by_conversation_id
      if (!row || !managerId) return
      Object.assign(row, { started_by_conversation_id: null, report_to_conversation_id: null })
      publish({ kind: 'family', conversationIds: [managerId, conversationId] })
    },
    interrupted: async (managerConversationId) =>
      [...states.entries()]
        .filter(
          ([id, entry]) =>
            entry.state === 'failed' &&
            entry.reason?.startsWith('Interrupted') &&
            (!managerConversationId ||
              conversationById.get(id)?.started_by_conversation_id === managerConversationId)
        )
        .map(([id, entry]) => {
          const row = conversationById.get(id)!
          return {
            conversationId: id,
            title: row.title,
            handle: row.session_handle ?? null,
            managerConversationId: row.report_to_conversation_id ?? null,
            runId: `preview-run-${id}`,
            interruptedAt: entry.since,
            canResume: true
          }
        }),
    resume: async (conversationId) => {
      setState(conversationId, 'working')
      return { runId: `preview-run-${Date.now()}`, queued: false }
    },
    grants: async (conversationId) =>
      grants.filter((grant) => grant.conversationId === conversationId),
    grantProject: async (conversationId, projectId) => {
      const existing = grants.find(
        (grant) => grant.conversationId === conversationId && grant.projectId === projectId
      )
      const grant = existing ?? {
        conversationId,
        projectId,
        grantedAt: Date.now(),
        revokedAt: null
      }
      if (existing) Object.assign(existing, { grantedAt: Date.now(), revokedAt: null })
      else grants.push(grant)
      publish({ kind: 'grants', conversationIds: [conversationId] })
      return grant
    },
    revokeProject: async (conversationId, projectId) => {
      const grant = grants.find(
        (entry) => entry.conversationId === conversationId && entry.projectId === projectId
      )
      if (grant) grant.revokedAt = Date.now()
      publish({ kind: 'grants', conversationIds: [conversationId] })
    },
    onChanged: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
}
