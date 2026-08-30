import Database from 'better-sqlite3'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { toolExecutionSucceeded, type AgentRunEvent } from '../../shared/agentRuntime'
import type { AgentRuntimeCoordinator } from './agentRuntimeCoordinator'
import { CollaborationStore } from './collaborationStore'
import { CollaborationSupervisor } from './collaborationSupervisor'
import {
  beginCheckpointCapture,
  configureCheckpointStorageRoot,
  createCheckpoint
} from './checkpoints'

type CollaborationRunInput = Parameters<AgentRuntimeCoordinator['runCollaborationParticipant']>[0]
const CHECKPOINT_INTEGRATION_TIMEOUT_MS = process.platform === 'win32' ? 15_000 : 10_000

describe('CollaborationSupervisor', () => {
  let db: Database.Database
  let root: string
  let store: CollaborationStore

  beforeEach(async () => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    root = await mkdtemp(join(tmpdir(), 'sidekick-collaboration-supervisor-'))
    await Promise.all([
      mkdir(join(root, 'webpage'), { recursive: true }),
      mkdir(join(root, 'data'), { recursive: true })
    ])
    configureCheckpointStorageRoot(join(root, 'history'))
    store = new CollaborationStore(db)
    const insert = db.prepare(
      `INSERT INTO projects (id, name, folder_path, is_pinned, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1, 1)`
    )
    insert.run('project-a', 'Webpage', join(root, 'webpage'))
    insert.run('project-b', 'Data', join(root, 'data'))
  })

  afterEach(async () => {
    db.close()
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    })
  })

  it('pauses and surfaces provider failures instead of leaving agents silently waiting', async () => {
    const detail = store.createGroup({
      title: 'Webpage + Data',
      participants: [
        {
          projectId: 'project-a',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        },
        {
          projectId: 'project-b',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        }
      ]
    })
    const request = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Build the dashboard'
    })
    const runtime = {
      runCollaborationParticipant: vi.fn(async (input: { id: string }) => ({
        runId: input.id,
        phase: 'failed' as const,
        content: '',
        thinking: '',
        messages: [],
        toolRounds: 0,
        error: 'System message must be at the beginning'
      })),
      stop: vi.fn()
    } as unknown as AgentRuntimeCoordinator
    const supervisor = new CollaborationSupervisor(store, runtime, () => undefined)

    supervisor.start(request.mission.id, {} as WebContents)

    await vi.waitFor(() => {
      expect(store.getMission(request.mission.id)?.status).toBe('paused')
      expect(
        store.listParticipantRuns(request.mission.id).some(({ status }) => status === 'waiting')
      ).toBe(false)
    })

    const failures = store
      .listMissionEvents(request.mission.id)
      .filter((event) => event.kind === 'agent_message' && event.payload.metadata?.error === true)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures[0].payload.text).toContain('agent run stopped')

    const notices = detail.agentSessions.flatMap((session) =>
      store
        .listAgentSessionMessages(session.id)
        .filter((message) => message.presentation === 'notice' && message.metadata.error === true)
    )
    expect(notices.length).toBeGreaterThan(0)
    supervisor.shutdown()
  })

  it('shows ordered compaction feedback and continues the participant run', async () => {
    const detail = store.createGroup({
      title: 'Webpage + Data',
      participants: [
        {
          projectId: 'project-a',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        },
        {
          projectId: 'project-b',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        }
      ]
    })
    const request = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Build the dashboard'
    })
    const runtime = {
      runCollaborationParticipant: vi.fn(
        async (input: {
          id: string
          onEvent: (event: AgentRunEvent) => void
          beforeModelStep?: (
            messages: unknown[],
            signal: AbortSignal,
            toolRounds: number
          ) => Promise<unknown[]>
        }) => {
          await input.beforeModelStep?.([], new AbortController().signal, 0)
          const emit = (
            sequence: number,
            type: AgentRunEvent['type'],
            payload: Record<string, unknown>
          ): void =>
            input.onEvent({
              id: `${input.id}:${sequence}`,
              runId: input.id,
              sequence,
              type,
              timestamp: Date.now() + sequence,
              payload
            })
          emit(1, 'compaction.started', { messageCount: 42 })
          emit(2, 'compaction.completed', {
            previousMessageCount: 42,
            messageCount: 6,
            messagesCompacted: 36,
            originalTokens: 120_000,
            summaryTokens: 6_000
          })
          return {
            runId: input.id,
            phase: 'completed' as const,
            content: 'Private setup narration. Finished after compaction',
            finalResponse: 'Finished after compaction',
            thinking: '',
            messages: [],
            toolRounds: 0
          }
        }
      ),
      stop: vi.fn()
    } as unknown as AgentRuntimeCoordinator
    const supervisor = new CollaborationSupervisor(store, runtime, () => undefined)

    supervisor.start(request.mission.id, {} as WebContents)

    await vi.waitFor(() => expect(runtime.runCollaborationParticipant).toHaveBeenCalledTimes(2))
    const compactionNotices = detail.agentSessions.map((session) =>
      store
        .listAgentSessionMessages(session.id)
        .filter((message) => Boolean(message.metadata.compaction))
        .map((message) => message.content)
    )
    expect(compactionNotices).toEqual([
      ['Compacting context…', 'Context compacted: 36 messages, 95% saved. Continuing…'],
      ['Compacting context…', 'Context compacted: 36 messages, 95% saved. Continuing…']
    ])
    expect(
      store
        .listMissionEvents(request.mission.id)
        .filter((event) => event.kind === 'agent_message')
        .map((event) => event.payload.text)
    ).toEqual(['Finished after compaction', 'Finished after compaction'])
    expect(store.getMission(request.mission.id)?.status).not.toBe('paused')
    supervisor.shutdown()
  })

  it('notifies the renderer as soon as first-turn assistant usage is persisted', async () => {
    const detail = store.createGroup({
      title: 'Webpage + Data',
      participants: [
        {
          projectId: 'project-a',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        },
        {
          projectId: 'project-b',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        }
      ]
    })
    const request = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Build the dashboard',
      targetParticipantIds: [detail.participants[0].id]
    })
    let finishRun!: () => void
    const holdRun = new Promise<void>((resolve) => {
      finishRun = resolve
    })
    const runtime = {
      runCollaborationParticipant: vi.fn(async (input: CollaborationRunInput) => {
        await input.beforeModelStep?.([], new AbortController().signal, 0)
        input.onEvent?.({
          id: `${input.id}:1`,
          runId: input.id,
          sequence: 1,
          type: 'assistant.completed',
          timestamp: Date.now(),
          payload: {
            content: 'Starting now.',
            toolCalls: [],
            usage: { promptTokens: 1_200, completionTokens: 80 }
          }
        })
        await holdRun
        return {
          runId: input.id,
          phase: 'completed' as const,
          content: 'Starting now.',
          finalResponse: 'Starting now.',
          thinking: '',
          messages: [],
          toolRounds: 0
        }
      }),
      stop: vi.fn()
    } as unknown as AgentRuntimeCoordinator
    const changed = vi.fn()
    const supervisor = new CollaborationSupervisor(store, runtime, changed)

    supervisor.start(request.mission.id, {} as WebContents)

    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(detail.group.id, 'event'))
    expect(store.listAgentSessionMessages(detail.agentSessions[0].id).at(-1)).toMatchObject({
      role: 'assistant',
      metadata: { usage: { promptTokens: 1_200, completionTokens: 80 } }
    })
    finishRun()
    await vi.waitFor(() => expect(store.getMission(request.mission.id)?.status).toBe('completed'))
    supervisor.shutdown()
  })

  it('injects ownership and useful cadence reminders into the private agent loop', async () => {
    const detail = store.createGroup({
      title: 'Webpage + Data',
      participants: [
        {
          projectId: 'project-a',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        },
        {
          projectId: 'project-b',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        }
      ]
    })
    const participant = detail.participants[0]
    const request = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Build the dashboard',
      targetParticipantIds: [participant.id]
    })
    const injectedPrompts: string[][] = []
    const runtime = {
      runCollaborationParticipant: vi.fn(async (input: CollaborationRunInput) => {
        injectedPrompts.push(
          ((await input.beforeModelStep?.([], new AbortController().signal, 0)) ?? []).map(
            ({ content }) => String(content || '')
          )
        )
        for (let index = 1; index <= 8; index++) {
          input.onEvent?.({
            id: `${input.id}:tool-${index}`,
            runId: input.id,
            sequence: index,
            type: 'tool.completed',
            timestamp: Date.now() + index,
            payload: {
              toolCallId: `tool-${index}`,
              name: 'read',
              result: toolExecutionSucceeded({ title: `Read ${index}`, data: { ok: true } })
            }
          })
        }
        injectedPrompts.push(
          ((await input.beforeModelStep?.([], new AbortController().signal, 8)) ?? []).map(
            ({ content }) => String(content || '')
          )
        )
        return {
          runId: input.id,
          phase: 'completed' as const,
          content: 'Done',
          finalResponse: 'Done',
          thinking: '',
          messages: [],
          toolRounds: 8
        }
      }),
      stop: vi.fn()
    } as unknown as AgentRuntimeCoordinator
    const supervisor = new CollaborationSupervisor(store, runtime, () => undefined)

    supervisor.start(request.mission.id, {} as WebContents)

    await vi.waitFor(() => expect(runtime.runCollaborationParticipant).toHaveBeenCalledOnce())
    expect(injectedPrompts[0].join('\n')).toContain('scope you are taking')
    expect(injectedPrompts[1].join('\n')).toContain('8 private tool calls')
    expect(
      store
        .listAgentSessionMessages(detail.agentSessions[0].id)
        .filter(({ metadata }) => metadata.coordinationReminder === true)
    ).toHaveLength(2)
    supervisor.shutdown()
  })

  it('stops one participant without cancelling the peer or the shared mission', async () => {
    const detail = store.createGroup({
      title: 'Webpage + Data',
      participants: [
        {
          projectId: 'project-a',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        },
        {
          projectId: 'project-b',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        }
      ]
    })
    const request = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Build the dashboard'
    })
    const runtime = {
      runCollaborationParticipant: vi.fn(() => new Promise<never>(() => undefined)),
      stop: vi.fn(() => true)
    } as unknown as AgentRuntimeCoordinator
    const supervisor = new CollaborationSupervisor(store, runtime, () => undefined)

    supervisor.start(request.mission.id, {} as WebContents)
    await vi.waitFor(() => expect(runtime.runCollaborationParticipant).toHaveBeenCalledTimes(2))

    const [stoppedParticipant, workingParticipant] = detail.participants
    supervisor.stopParticipant(request.mission.id, stoppedParticipant.id)

    expect(store.getParticipantRun(request.mission.id, stoppedParticipant.id)?.status).toBe(
      'stopped'
    )
    expect(store.getParticipantRun(request.mission.id, workingParticipant.id)?.status).toBe(
      'working'
    )
    expect(store.getMission(request.mission.id)?.status).toBe('running')
    expect(runtime.stop).toHaveBeenCalledTimes(1)
    expect(store.listAgentSessionMessages(detail.agentSessions[0].id).at(-1)).toMatchObject({
      content: 'Generation stopped.',
      presentation: 'notice'
    })
    supervisor.shutdown()
  })

  it('publishes only the terminal response and does not duplicate an explicit completion', async () => {
    const detail = store.createGroup({
      title: 'Webpage + Data',
      participants: [
        {
          projectId: 'project-a',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        },
        {
          projectId: 'project-b',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        }
      ]
    })
    const request = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Build the dashboard'
    })
    const runtime = {
      runCollaborationParticipant: vi.fn(
        async (input: {
          id: string
          threadId: string
          beforeModelStep?: (
            messages: unknown[],
            signal: AbortSignal,
            toolRounds: number
          ) => Promise<unknown[]>
        }) => {
          await input.beforeModelStep?.([], new AbortController().signal, 0)
          const session = store.getAgentSession(input.threadId)!
          store.appendAgentEvent({
            groupId: detail.group.id,
            missionId: request.mission.id,
            participantId: session.participantId,
            kind: 'peer_message',
            payload: {
              text: 'Verified project completion',
              metadata: { audience: 'everyone', messageType: 'completion' }
            }
          })
          return {
            runId: input.id,
            phase: 'completed' as const,
            content: 'Private setup. More private narration. Duplicate final answer.',
            finalResponse: 'Duplicate final answer.',
            thinking: '',
            messages: [],
            toolRounds: 2
          }
        }
      ),
      stop: vi.fn()
    } as unknown as AgentRuntimeCoordinator
    const supervisor = new CollaborationSupervisor(store, runtime, () => undefined)

    supervisor.start(request.mission.id, {} as WebContents)

    await vi.waitFor(() => expect(store.getMission(request.mission.id)?.status).toBe('completed'))
    const publicEvents = store
      .listMissionEvents(request.mission.id)
      .filter((event) => event.kind === 'peer_message' || event.kind === 'agent_message')
    expect(publicEvents.map((event) => event.payload.text)).toEqual([
      'Verified project completion',
      'Verified project completion'
    ])
    expect(publicEvents.some((event) => event.kind === 'agent_message')).toBe(false)
    expect(store.listParticipantRuns(request.mission.id).map(({ status }) => status)).toEqual([
      'completed',
      'completed'
    ])
    supervisor.shutdown()
  })

  it('settles a participant whose shared response answered the latest request', async () => {
    const detail = store.createGroup({
      title: 'Webpage + Data',
      participants: [
        {
          projectId: 'project-a',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        },
        {
          projectId: 'project-b',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        }
      ]
    })
    const request = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Build the dashboard'
    })
    const responded = new Set<string>()
    const runtime = {
      runCollaborationParticipant: vi.fn(async (input: CollaborationRunInput) => {
        await input.beforeModelStep?.([], new AbortController().signal, 0)
        const session = store.getAgentSession(input.threadId)!
        const participant = detail.participants.find(({ id }) => id === session.participantId)!
        if (responded.has(participant.id)) {
          return {
            runId: input.id,
            phase: 'completed' as const,
            content: '',
            finalResponse: '',
            thinking: '',
            messages: [],
            toolRounds: 1
          }
        }
        responded.add(participant.id)
        if (participant.projectId === 'project-b') {
          store.appendAgentEvent({
            groupId: detail.group.id,
            missionId: request.mission.id,
            participantId: participant.id,
            kind: 'peer_message',
            payload: {
              text: 'The requested dataset is ready for integration.',
              targetParticipantIds: [detail.participants[0].id],
              metadata: { audience: 'other_agent', messageType: 'response' }
            }
          })
          return {
            runId: input.id,
            phase: 'completed' as const,
            content: '',
            finalResponse: '',
            thinking: '',
            messages: [],
            toolRounds: 1
          }
        }
        return {
          runId: input.id,
          phase: 'completed' as const,
          content: 'Dashboard integration is complete.',
          finalResponse: 'Dashboard integration is complete.',
          thinking: '',
          messages: [],
          toolRounds: 1
        }
      }),
      stop: vi.fn()
    } as unknown as AgentRuntimeCoordinator
    const supervisor = new CollaborationSupervisor(store, runtime, () => undefined)

    supervisor.start(request.mission.id, {} as WebContents)

    await vi.waitFor(() => expect(store.getMission(request.mission.id)?.status).toBe('completed'))
    expect(store.listParticipantRuns(request.mission.id).map(({ status }) => status)).toEqual([
      'completed',
      'completed'
    ])
    supervisor.shutdown()
  })

  it('reconciles an already-finished mission before pausing interrupted work at startup', () => {
    const detail = store.createGroup({
      title: 'Webpage + Data',
      participants: [
        {
          projectId: 'project-a',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        },
        {
          projectId: 'project-b',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        }
      ]
    })
    const request = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Build the dashboard'
    })
    store.updateMission(request.mission.id, { status: 'running' })
    store.appendAgentEvent({
      groupId: detail.group.id,
      missionId: request.mission.id,
      participantId: detail.participants[0].id,
      kind: 'agent_message',
      payload: { text: 'Dashboard complete', metadata: { audience: 'human' } }
    })
    store.appendAgentEvent({
      groupId: detail.group.id,
      missionId: request.mission.id,
      participantId: detail.participants[1].id,
      kind: 'peer_message',
      payload: {
        text: 'Dataset delivered',
        metadata: { audience: 'everyone', messageType: 'response' }
      }
    })
    for (const participant of detail.participants) {
      const pending = store.listPendingEvents(participant.id)
      store.consumeDeliveries(
        participant.id,
        pending.map(({ id }) => id)
      )
    }
    const runtime = {
      runCollaborationParticipant: vi.fn(),
      stop: vi.fn()
    } as unknown as AgentRuntimeCoordinator
    const supervisor = new CollaborationSupervisor(store, runtime, () => undefined)

    const recovered = supervisor.recover()
    expect(recovered).toBe(0)
    expect(store.getMission(request.mission.id)?.status).toBe('completed')
    expect(runtime.runCollaborationParticipant).not.toHaveBeenCalled()
    supervisor.shutdown()
  })

  it(
    'rewinds both participant projects before replacing a group message',
    async () => {
      const detail = store.createGroup({
        title: 'Webpage + Data',
        participants: [
          {
            projectId: 'project-a',
            providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
          },
          {
            projectId: 'project-b',
            providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
          }
        ]
      })
      const request = store.sendUserMessage({
        groupId: detail.group.id,
        text: 'Build the first version'
      })
      for (const [index, participant] of detail.participants.entries()) {
        const path = join(participant.projectFolder, 'result.txt')
        await writeFile(path, `before ${index}\n`, 'utf8')
        const capture = await beginCheckpointCapture(
          participant.projectFolder,
          detail.group.id,
          `run-${index}`
        )
        await writeFile(path, `after ${index}\n`, 'utf8')
        const checkpoint = await createCheckpoint(
          participant.projectFolder,
          `Participant ${index}`,
          capture
        )
        store.appendAgentSessionMessage({
          sessionId: detail.agentSessions[index].id,
          missionId: request.mission.id,
          role: 'system',
          kind: 'system',
          presentation: 'history',
          content: '',
          metadata: {
            checkpointHash: checkpoint!.hash,
            coveredThroughEventSeq: request.event.seq,
            agentRunId: `run-${index}`
          }
        })
      }
      store.updateMission(request.mission.id, { status: 'completed' })
      const runtime = {
        runCollaborationParticipant: vi.fn(async (input: CollaborationRunInput) => {
          await input.beforeModelStep?.([], new AbortController().signal, 0)
          return {
            runId: input.id,
            phase: 'completed' as const,
            content: 'Corrected work complete',
            finalResponse: 'Corrected work complete',
            thinking: '',
            messages: [],
            toolRounds: 0
          }
        }),
        stop: vi.fn()
      } as unknown as AgentRuntimeCoordinator
      const supervisor = new CollaborationSupervisor(store, runtime, () => undefined)

      const replacement = await supervisor.rewriteMessage(
        {
          groupId: detail.group.id,
          eventId: request.event.id,
          text: 'Build the corrected version'
        },
        {} as WebContents
      )

      expect(replacement.rewound).toHaveLength(2)
      expect(replacement.event.seq).toBe(request.event.seq)
      expect(replacement.event.payload.text).toBe('Build the corrected version')
      expect(await readFile(join(root, 'webpage', 'result.txt'), 'utf8')).toBe('before 0\n')
      expect(await readFile(join(root, 'data', 'result.txt'), 'utf8')).toBe('before 1\n')
      await vi.waitFor(() => expect(runtime.runCollaborationParticipant).toHaveBeenCalledTimes(2))
      await vi.waitFor(() =>
        expect(store.getMission(replacement.mission.id)?.status).toBe('completed')
      )
      supervisor.shutdown()
    },
    CHECKPOINT_INTEGRATION_TIMEOUT_MS
  )

  it('captures and rewinds partial file changes from an active run before replaying', async () => {
    const detail = store.createGroup({
      title: 'Webpage + Data',
      participants: [
        {
          projectId: 'project-a',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        },
        {
          projectId: 'project-b',
          providerTarget: { providerKind: 'litellm', model: 'local-loaded-model' }
        }
      ]
    })
    const participant = detail.participants[0]
    const path = join(participant.projectFolder, 'active.txt')
    await writeFile(path, 'before\n', 'utf8')
    const request = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Build the active version',
      targetParticipantIds: [participant.id]
    })
    let finishActiveRun!: (
      result: Awaited<ReturnType<AgentRuntimeCoordinator['runCollaborationParticipant']>>
    ) => void
    let firstRunReady!: () => void
    const ready = new Promise<void>((resolveReady) => {
      firstRunReady = resolveReady
    })
    let calls = 0
    const runtime = {
      runCollaborationParticipant: vi.fn(async (input: CollaborationRunInput) => {
        calls += 1
        await input.beforeModelStep?.([], new AbortController().signal, 0)
        if (calls === 1) {
          await input.onWorkspaceWillMutate?.()
          await writeFile(path, 'partial agent change\n', 'utf8')
          firstRunReady()
          return new Promise((resolveRun) => {
            finishActiveRun = resolveRun
          })
        }
        return {
          runId: input.id,
          phase: 'completed' as const,
          content: 'Corrected work complete',
          finalResponse: 'Corrected work complete',
          thinking: '',
          messages: [],
          toolRounds: 0
        }
      }),
      stop: vi.fn((runId: string) => {
        finishActiveRun({
          runId,
          phase: 'cancelled',
          content: '',
          thinking: '',
          messages: [],
          toolRounds: 0
        })
        return true
      })
    } as unknown as AgentRuntimeCoordinator
    const supervisor = new CollaborationSupervisor(store, runtime, () => undefined)
    supervisor.start(request.mission.id, {} as WebContents)
    await ready

    const replacement = await supervisor.rewriteMessage(
      {
        groupId: detail.group.id,
        eventId: request.event.id,
        text: 'Build the corrected active version'
      },
      {} as WebContents
    )

    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(replacement.rewound).toHaveLength(1)
    expect(await readFile(path, 'utf8')).toBe('before\n')
    await vi.waitFor(() =>
      expect(store.getMission(replacement.mission.id)?.status).toBe('completed')
    )
    supervisor.shutdown()
  })
})
