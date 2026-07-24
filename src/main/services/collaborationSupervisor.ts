import { promises as fs } from 'fs'
import { basename, resolve } from 'path'
import { createHash, randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import type {
  CollaborationAgentSessionMessage,
  CollaborationEvent,
  CollaborationMission,
  CollaborationParticipant,
  RewriteCollaborationMessageInput,
  RewriteCollaborationMessageResult
} from '../../shared/collaboration'
import {
  isCollaborationTransportEvent,
  normalizeCollaborationHumanAddress
} from '../../shared/collaboration'
import type { AgentRunEvent, ToolExecutionResult } from '../../shared/agentRuntime'
import type { ProviderChatMessage, ProviderToolCall } from '../../shared/providerRuntime'
import { DEFAULT_TOOL_CALL_LIMIT, normalizeToolCallLimit } from '../../shared/agentLimits'
import { executeWorkspaceMutation } from './workspaceMutationService'
import { resolveSecureWorkspacePath } from '../utils/workspacePaths'
import {
  beginCheckpointCapture,
  createCheckpoint,
  listCheckpoints,
  rewindWorkspacesToBeforeCheckpoints
} from './checkpoints'
import {
  beginWorkspaceInstructionScope,
  resolveWorkspaceInstructionsForPath
} from './workspaceRules'
import type { AgentToolExecutionContext } from './agentToolRegistry'
import type { AgentRuntimeCoordinator } from './agentRuntimeCoordinator'
import { CollaborationStore } from './collaborationStore'

type Changed = (groupId: string, reason: 'event' | 'mission') => void

interface CollaborationSupervisorOptions {
  toolCallLimit?: () => unknown
}

type CollaborationMessageType = 'request' | 'response' | 'update' | 'completion'

const MESSAGE_TYPES = new Set<CollaborationMessageType>([
  'request',
  'response',
  'update',
  'completion'
])
const MAX_TRANSCRIPT_EVENTS = 160
const MAX_TRANSCRIPT_CHARS = 96_000
const MAX_ARTIFACT_BYTES = 1024 * 1024
const PRIVATE_TOOL_COORDINATION_INTERVAL = 8

interface ActiveParticipant {
  runId: string
  missionId: string
  participantId: string
  projectId: string
}

function messageTypeFromEvent(event: CollaborationEvent): CollaborationMessageType {
  const value = event.payload.metadata?.messageType
  return typeof value === 'string' && MESSAGE_TYPES.has(value as CollaborationMessageType)
    ? (value as CollaborationMessageType)
    : event.payload.targetParticipantIds?.length
      ? 'request'
      : 'update'
}

function eventRequiresResponse(event: CollaborationEvent, participantId: string): boolean {
  if (!event.payload.targetParticipantIds?.includes(participantId)) return false
  return (
    event.kind === 'user_message' ||
    (event.kind === 'peer_message' && messageTypeFromEvent(event) === 'request')
  )
}

function isHumanVisibleCompletion(event: CollaborationEvent, participantId: string): boolean {
  if (event.actorParticipantId !== participantId) return false
  if (event.kind === 'agent_message') return true
  if (event.kind !== 'peer_message' || messageTypeFromEvent(event) !== 'completion') return false
  return event.payload.metadata?.audience !== 'other_agent'
}

function isParticipantResponse(event: CollaborationEvent, participantId: string): boolean {
  if (event.actorParticipantId !== participantId) return false
  if (event.kind === 'agent_message') return true
  if (event.kind !== 'peer_message') return false
  return ['response', 'completion'].includes(messageTypeFromEvent(event))
}

function displayEvent(event: CollaborationEvent, participants: CollaborationParticipant[]): string {
  const participant = participants.find(({ id }) => id === event.actorParticipantId)
  const actor =
    event.actorType === 'user'
      ? 'User'
      : event.actorType === 'system'
        ? 'SideKick'
        : participant?.label || 'Project agent'
  const project = participant ? `; project=${JSON.stringify(participant.projectName)}` : ''
  const messageType =
    event.kind === 'peer_message' ? `; message_type=${messageTypeFromEvent(event)}` : ''
  return `[group event ${event.seq}; from=${JSON.stringify(actor)}${project}; kind=${event.kind}${messageType}] ${event.payload.text || event.payload.title || ''}`
}

function providerMessagesFromSession(
  records: CollaborationAgentSessionMessage[]
): ProviderChatMessage[] {
  const resultIds = new Set(
    records
      .filter(({ role, toolCallId }) => role === 'tool' && toolCallId)
      .map(({ toolCallId }) => toolCallId!)
  )
  const projected: ProviderChatMessage[] = []
  for (const record of records) {
    if (record.role === 'system') continue
    if (record.role === 'assistant') {
      projected.push({
        role: 'assistant',
        content: record.content || null,
        ...(record.toolCalls.length ? { tool_calls: record.toolCalls } : {})
      })
      for (const call of record.toolCalls) {
        if (call.id && !resultIds.has(call.id)) {
          projected.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              ok: false,
              error: 'The prior run ended before this tool returned. Re-check current state.'
            })
          })
        }
      }
    } else if (record.role === 'tool') {
      projected.push({
        role: 'tool',
        tool_call_id: record.toolCallId || undefined,
        content: record.content
      })
    } else projected.push({ role: 'user', content: record.content })
  }
  while (projected[0]?.role === 'tool') projected.shift()
  let chars = 0
  let start = projected.length
  for (let index = projected.length - 1; index >= 0; index--) {
    chars += JSON.stringify(projected[index]).length
    if (chars > MAX_TRANSCRIPT_CHARS || projected.length - index > MAX_TRANSCRIPT_EVENTS) break
    start = index
  }
  const bounded = projected.slice(start)
  while (bounded[0]?.role === 'tool') bounded.shift()
  return bounded
}

function toolCallsFromEvent(event: AgentRunEvent): ProviderToolCall[] {
  const calls = Array.isArray(event.payload.toolCalls)
    ? (event.payload.toolCalls as Array<Record<string, unknown>>)
    : []
  return calls.map((call, index) => ({
    id: String(call.id || randomUUID()),
    index,
    type: 'function',
    function: {
      name: String(call.name || 'unknown_tool'),
      arguments: (call.arguments as Record<string, unknown>) ?? {}
    }
  }))
}

function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`)
  return value.trim()
}

export class CollaborationSupervisor {
  private readonly active = new Map<string, ActiveParticipant>()
  private readonly activeProjects = new Map<string, string>()
  private readonly projectQueues = new Map<
    string,
    Array<{ missionId: string; participantId: string }>
  >()
  private readonly queued = new Set<string>()
  private readonly senders = new Map<string, WebContents>()
  private readonly participantTasks = new Map<string, Promise<void>>()
  private readonly rewritingGroups = new Set<string>()

  constructor(
    private readonly store: CollaborationStore,
    private readonly runtime: AgentRuntimeCoordinator,
    private readonly changed: Changed,
    private readonly options: CollaborationSupervisorOptions = {}
  ) {}

  private toolCallLimit(): number {
    return normalizeToolCallLimit(this.options.toolCallLimit?.() ?? DEFAULT_TOOL_CALL_LIMIT)
  }

  recover(): number {
    for (const group of this.store.listGroups()) {
      if (group.activeMissionId) this.finishMissionIfSettled(group.activeMissionId)
    }
    return this.store.recoverInterruptedMissions()
  }

  start(missionId: string, sender: WebContents, requestedParticipantIds?: string[]): void {
    const mission = this.store.getMission(missionId)
    if (!mission || !['queued', 'running', 'paused'].includes(mission.status)) return
    this.senders.set(mission.groupId, sender)
    if (mission.status !== 'running') {
      this.store.updateMission(mission.id, { status: 'running', error: null })
      this.store.appendSystemEvent({
        groupId: mission.groupId,
        missionId: mission.id,
        kind: 'mission_status',
        payload: {
          text: mission.status === 'paused' ? 'Mission resumed' : 'Mission started',
          status: 'running'
        }
      })
      this.changed(mission.groupId, 'mission')
    }
    const pending = this.store
      .listParticipants(mission.groupId)
      .filter((participant) =>
        this.store.listPendingEvents(participant.id).some((event) => event.missionId === mission.id)
      )
      .map(({ id }) => id)
    for (const participantId of new Set([
      ...mission.requestedParticipantIds,
      ...pending,
      ...(requestedParticipantIds ?? [])
    ])) {
      this.store.ensureParticipantRun(mission.id, participantId, this.toolCallLimit())
      this.schedule(mission.id, participantId)
    }
  }

  pause(missionId: string): CollaborationMission {
    const mission = this.store.updateMission(missionId, { status: 'paused' })
    this.abortMission(missionId)
    this.changed(mission.groupId, 'mission')
    return mission
  }

  resume(missionId: string, sender: WebContents): CollaborationMission {
    const mission = this.store.getMission(missionId)
    if (!mission) throw new Error('Mission not found')
    if (mission.status !== 'paused') throw new Error('Only paused missions can be resumed')
    this.store.extendParticipantRuns(mission.id, this.toolCallLimit())
    this.start(mission.id, sender)
    return this.store.getMission(mission.id)!
  }

  stop(missionId: string): CollaborationMission {
    const mission = this.store.updateMission(missionId, { status: 'stopped' })
    this.abortMission(missionId)
    this.changed(mission.groupId, 'mission')
    return mission
  }

  assertGroupWritable(groupId: string): void {
    if (this.rewritingGroups.has(groupId)) {
      throw new Error('This group timeline is currently being restarted')
    }
  }

  async rewriteMessage(
    input: RewriteCollaborationMessageInput,
    sender: WebContents
  ): Promise<RewriteCollaborationMessageResult> {
    this.assertGroupWritable(input.groupId)
    this.store.prepareTimelineRewrite(input)
    this.rewritingGroups.add(input.groupId)
    try {
      const activeMission = this.store.getActiveMission(input.groupId)
      if (activeMission) {
        this.stop(activeMission.id)
        const activeTasks = [...this.participantTasks.entries()]
          .filter(([key]) => key.startsWith(`${activeMission.id}:`))
          .map(([, task]) => task)
        await Promise.allSettled(activeTasks)
      }

      const plan = this.store.prepareTimelineRewrite(input)
      const targets: Array<{ workspaceRoot: string; checkpointHash: string }> = []
      const participantForRoot = new Map(
        plan.participants.map((participant) => [resolve(participant.projectFolder), participant])
      )
      for (const participant of plan.participants) {
        if (participant.historyUnavailable) {
          throw new Error(
            `Could not safely restart from this message because SideKick History was unavailable while ${participant.projectName} changed files. The timeline was left intact.`
          )
        }
        if (!participant.checkpointHashes.length) continue
        const candidateHashes = new Set(participant.checkpointHashes)
        const activeCandidates = (await listCheckpoints(participant.projectFolder)).filter(
          ({ hash }) => candidateHashes.has(hash)
        )
        const earliestAffected = activeCandidates.at(-1)
        if (earliestAffected) {
          targets.push({
            workspaceRoot: participant.projectFolder,
            checkpointHash: earliestAffected.hash
          })
        }
      }
      const historyResult = await rewindWorkspacesToBeforeCheckpoints(targets)
      if (!historyResult.ok) {
        const details = historyResult.conflicts
          .map((conflict) => {
            const participant = participantForRoot.get(conflict.workspaceRoot)
            const reason =
              conflict.reason === 'staged-in-git'
                ? 'is staged in Git'
                : conflict.reason === 'changed-after'
                  ? 'was changed after the agent run'
                  : 'is not a regular file'
            return `${participant?.projectName || basename(conflict.workspaceRoot)}: ${conflict.path} ${reason}`
          })
          .join('; ')
        throw new Error(
          `Could not restart from this message because newer work would be overwritten. ${details}`
        )
      }

      const replacement = this.store.replaceTimelineFromUserMessage(input)
      this.changed(input.groupId, 'event')
      this.start(replacement.mission.id, sender, replacement.event.payload.targetParticipantIds)
      return {
        ...replacement,
        rewound: historyResult.workspaces.map((workspace) => {
          const participant = participantForRoot.get(workspace.workspaceRoot)!
          return {
            participantId: participant.id,
            projectName: participant.projectName,
            ...workspace
          }
        })
      }
    } finally {
      this.rewritingGroups.delete(input.groupId)
    }
  }

  stopParticipant(missionId: string, participantId: string) {
    const mission = this.store.getMission(missionId)
    const participant = this.store.getParticipant(participantId)
    const run = this.store.getParticipantRun(missionId, participantId)
    if (!mission || !participant || participant.groupId !== mission.groupId || !run) {
      throw new Error('Active participant run not found')
    }
    if (!['queued', 'working'].includes(run.status)) {
      throw new Error('This agent is not currently running')
    }

    const key = `${missionId}:${participantId}`
    const active = this.active.get(key)
    this.queued.delete(key)
    const projectQueue = this.projectQueues.get(participant.projectId)
    if (projectQueue) {
      const remaining = projectQueue.filter(
        (queued) => queued.missionId !== missionId || queued.participantId !== participantId
      )
      if (remaining.length) this.projectQueues.set(participant.projectId, remaining)
      else this.projectQueues.delete(participant.projectId)
    }

    const pending = this.store
      .listPendingEvents(participantId)
      .filter((event) => event.missionId === missionId)
    if (pending.length) {
      this.store.consumeDeliveries(
        participantId,
        pending.map(({ id }) => id)
      )
    }
    const stopped = this.store.updateParticipantRun(missionId, participantId, {
      status: 'stopped',
      currentActivity: null,
      error: null
    })
    const session = this.store.ensureParticipantAgentSession(participantId)
    this.store.appendAgentSessionMessage({
      sessionId: session.id,
      missionId,
      role: 'system',
      kind: 'system',
      presentation: 'notice',
      content: 'Generation stopped.',
      metadata: { stoppedByUser: true }
    })
    if (active) this.runtime.stop(active.runId)
    this.changed(mission.groupId, 'mission')
    if (!active) this.finishMissionIfSettled(missionId)
    return stopped
  }

  shutdown(): void {
    for (const active of this.active.values()) this.runtime.stop(active.runId)
    this.active.clear()
    this.activeProjects.clear()
    this.projectQueues.clear()
    this.queued.clear()
    this.participantTasks.clear()
    this.rewritingGroups.clear()
  }

  hasActiveWork(): boolean {
    return this.active.size > 0 || this.queued.size > 0 || this.participantTasks.size > 0
  }

  private abortMission(missionId: string): void {
    for (const active of this.active.values()) {
      if (active.missionId === missionId) this.runtime.stop(active.runId)
    }
  }

  private schedule(missionId: string, participantId: string): void {
    const key = `${missionId}:${participantId}`
    if (this.active.has(key) || this.queued.has(key)) return
    const mission = this.store.getMission(missionId)
    const participant = this.store.getParticipant(participantId)
    const participantRun = this.store.getParticipantRun(missionId, participantId)
    if (
      !mission ||
      mission.status !== 'running' ||
      !participant ||
      participant.status !== 'active' ||
      participantRun?.status === 'stopped'
    ) {
      return
    }
    if (this.activeProjects.has(participant.projectId)) {
      const queue = this.projectQueues.get(participant.projectId) ?? []
      queue.push({ missionId, participantId })
      this.projectQueues.set(participant.projectId, queue)
      this.queued.add(key)
      return
    }
    const active: ActiveParticipant = {
      runId: randomUUID(),
      missionId,
      participantId,
      projectId: participant.projectId
    }
    this.active.set(key, active)
    this.activeProjects.set(participant.projectId, key)
    const task = this.runParticipant(mission, participant, active)
      .catch((error: unknown) => this.failParticipant(mission, participant, error))
      .finally(() => {
        this.participantTasks.delete(key)
        this.active.delete(key)
        if (this.activeProjects.get(participant.projectId) === key) {
          this.activeProjects.delete(participant.projectId)
        }
        this.finishMissionIfSettled(mission.id)
        this.drainProjectQueue(participant.projectId)
      })
    this.participantTasks.set(key, task)
  }

  private drainProjectQueue(projectId: string): void {
    if (this.activeProjects.has(projectId)) return
    const queue = this.projectQueues.get(projectId)
    while (queue?.length) {
      const next = queue.shift()!
      this.queued.delete(`${next.missionId}:${next.participantId}`)
      if (this.store.getMission(next.missionId)?.status !== 'running') continue
      if (!queue.length) this.projectQueues.delete(projectId)
      this.schedule(next.missionId, next.participantId)
      return
    }
    this.projectQueues.delete(projectId)
  }

  private async runParticipant(
    mission: CollaborationMission,
    participant: CollaborationParticipant,
    active: ActiveParticipant
  ): Promise<void> {
    const session = this.store.ensureParticipantAgentSession(participant.id)
    const runStartEventSeq = session.lastEventSeq
    const participants = this.store.listParticipants(mission.groupId)
    const rules = await beginWorkspaceInstructionScope(active.runId, participant.projectFolder)
    const memory = this.store.getWorkspaceMemory(participant.projectFolder)
    let capturePromise: Promise<string | null> | null = null
    let historyCaptureError: string | null = null
    const ensureCapture = async (): Promise<void> => {
      if (!capturePromise) {
        capturePromise = beginCheckpointCapture(
          participant.projectFolder,
          `collaboration:${mission.groupId}`,
          active.runId
        ).catch((error: unknown) => {
          historyCaptureError = error instanceof Error ? error.message : String(error)
          return null
        })
      }
      await capturePromise
    }
    let consumedSeq = session.lastEventSeq
    const issuedCoordinationReminders = new Set<string>()

    const coordinationReminder = (
      key: string,
      content: string,
      metadata: Record<string, unknown> = {}
    ): ProviderChatMessage[] => {
      if (issuedCoordinationReminders.has(key)) return []
      issuedCoordinationReminders.add(key)
      this.store.appendAgentSessionMessage({
        sessionId: session.id,
        missionId: mission.id,
        role: 'user',
        kind: 'system',
        presentation: 'internal',
        content,
        metadata: { coordinationReminder: true, reason: key.split(':')[0], ...metadata }
      })
      return [{ role: 'user', content }]
    }

    const ingestSharedChannel = async (): Promise<ProviderChatMessage[]> => {
      const unseen = this.store.listSharedChannelEvents(mission.groupId, consumedSeq, 2_000)
      const injected: ProviderChatMessage[] = []
      if (unseen.length) {
        consumedSeq = unseen.at(-1)!.seq
        this.store.updateAgentSessionCursor(session.id, consumedSeq)
        const pending = this.store.listPendingEvents(participant.id)
        if (pending.length)
          this.store.consumeDeliveries(
            participant.id,
            pending.map(({ id }) => id)
          )
        const relevant = unseen.filter((event) => event.actorParticipantId !== participant.id)
        if (relevant.length) {
          const content = `New shared group messages:\n${relevant
            .map((event) => displayEvent(event, participants))
            .join(
              '\n'
            )}\n\nTreat the user as the mission authority. Respond to peer requests with collaboration_send message_type="response"; incorporate updates without acknowledgment-only chatter.`
          this.store.appendAgentSessionMessage({
            sessionId: session.id,
            missionId: mission.id,
            role: 'user',
            kind: 'shared_event',
            presentation: 'internal',
            content,
            metadata: {
              firstSeq: relevant[0].seq,
              lastSeq: relevant.at(-1)!.seq,
              eventIds: relevant.map(({ id }) => id)
            }
          })
          injected.push({ role: 'user', content })
        }
      }

      const missionEvents = this.store.listMissionEvents(mission.id)
      const objectiveSeq = missionEvents.find(({ id }) => id === mission.objectiveEventId)?.seq ?? 0
      const publicCoordination = missionEvents.filter(
        (event) =>
          event.actorParticipantId === participant.id &&
          event.kind === 'peer_message' &&
          !isCollaborationTransportEvent(event)
      )
      const lastPublicSeq = Math.max(0, ...publicCoordination.map(({ seq }) => seq))
      if (lastPublicSeq <= objectiveSeq) {
        injected.push(
          ...coordinationReminder(
            `ownership:${objectiveSeq}`,
            'Before nontrivial private work, post one concise collaboration_send update to everyone: state the scope you are taking, the deliverable you intend to produce, and any dependency or question for the peer. Then continue working independently.'
          )
        )
      }

      const lastPeerRequest = Math.max(
        0,
        ...missionEvents
          .filter(
            (event) =>
              event.actorParticipantId !== participant.id &&
              event.kind === 'peer_message' &&
              messageTypeFromEvent(event) === 'request' &&
              event.payload.targetParticipantIds?.includes(participant.id)
          )
          .map(({ seq }) => seq)
      )
      const lastPeerResponse = Math.max(
        0,
        ...publicCoordination
          .filter((event) => messageTypeFromEvent(event) === 'response')
          .map(({ seq }) => seq)
      )
      if (lastPeerRequest > lastPeerResponse) {
        injected.push(
          ...coordinationReminder(
            `peer-request:${lastPeerRequest}`,
            'A peer handoff or request is pending. Inspect and import any artifact you need, then post a concise collaboration_send response describing what you used, what you need changed, or what blocks integration. Do not leave the request silently unresolved.',
            { peerRequestSeq: lastPeerRequest }
          )
        )
      }

      const privateToolsSincePublic = missionEvents.filter(
        (event) =>
          event.seq > lastPublicSeq &&
          event.actorParticipantId === participant.id &&
          event.kind === 'tool_result' &&
          !String(event.payload.toolName || '').startsWith('collaboration_')
      ).length
      if (privateToolsSincePublic >= PRIVATE_TOOL_COORDINATION_INTERVAL) {
        const bucket = Math.floor(privateToolsSincePublic / PRIVATE_TOOL_COORDINATION_INTERVAL)
        injected.push(
          ...coordinationReminder(
            `cadence:${lastPublicSeq}:${bucket}`,
            `You have completed ${privateToolsSincePublic} private tool calls since your last public coordination message. Before another nontrivial batch, use collaboration_send message_type="update" with a concise result, decision, blocker, or next handoff. Keep it useful; do not narrate every tool call.`,
            { privateToolCalls: privateToolsSincePublic, lastPublicSeq }
          )
        )
      }
      return injected
    }

    this.store.updateParticipantRun(mission.id, participant.id, {
      status: 'working',
      currentActivity: 'Thinking',
      error: null
    })
    this.changed(mission.groupId, 'mission')

    const collaborationInstructions = `You are ${participant.label}, the independent SideKick agent for ${participant.projectName} in a shared group chat.

Collaboration protocol:
- Your immutable project root is ${participant.projectFolder}; never access another participant's project directly.
- Every workspace file path and command cwd is relative to that root. Never prefix paths with the project name, rename/move/delete the root, use a leading cd, or traverse to its parent.
- The shared channel is an ordered public conversation between the human and all project agents. You work concurrently; no shared turn lock exists.
- collaboration_send always posts to that public channel. Its audience routes attention, not visibility: use human for the user, other_agent for peers, and everyone only when both need the message.
- Never write @User or @Human. Address the user naturally and select audience="human"; SideKick marks human requests as needing attention in the group channel.
- Before nontrivial private work, send one concise update taking ownership and naming your intended deliverable. Work actively after that; do not wait for a turn.
- Use request only when a peer must act or answer, response when answering a request, update for meaningful progress or a handoff, and completion only when your work is verified.
- Read newly injected group events before each model step. Use collaboration_read after long-running work when you need an immediate refresh.
- Share cross-project text files only through collaboration_share_file and collaboration_import_artifact.
- Artifact delivery is private transport and automatically wakes peers. After sharing, post a human-readable update or request explaining its purpose; never expose raw artifact ids unless troubleshooting.
- A message that merely names a file in your project is not a handoff. Share every peer-required deliverable as an artifact; import peer deliverables before claiming integrated work.
- Validate your own project before calling collaboration_claim_complete. Do not claim another agent's work without a shared-channel report.
- Avoid acknowledgment-only loops and keep public messages useful.`

    const result = await this.runtime.runCollaborationParticipant({
      id: active.runId,
      threadId: session.id,
      workspaceRoot: participant.projectFolder,
      target: participant.providerTarget,
      messages: providerMessagesFromSession(this.store.listRecentAgentSessionMessages(session.id)),
      projectInstructions: rules,
      projectMemory: memory,
      collaborationInstructions,
      maxToolRounds: this.toolCallLimit(),
      beforeModelStep: ingestSharedChannel,
      onWorkspaceWillMutate: ensureCapture,
      collaboration: {
        execute: async (name, args, context) => {
          if (name === 'collaboration_import_artifact') await ensureCapture()
          return this.executeCollaborationTool(
            mission,
            participant,
            session.id,
            name,
            args,
            context
          )
        }
      },
      onEvent: (event) => this.recordKernelEvent(mission, participant, session.id, event)
    })

    let checkpointHash: string | null = null
    if (capturePromise) {
      const captureId = await capturePromise
      if (captureId) {
        const checkpoint = await createCheckpoint(
          participant.projectFolder,
          `Group mission: ${this.store.getGroup(mission.groupId)?.title || 'collaboration'}`,
          captureId
        ).catch((error: unknown) => {
          historyCaptureError = error instanceof Error ? error.message : String(error)
          return null
        })
        checkpointHash = checkpoint?.hash ?? null
        if (checkpoint) {
          this.store.appendAgentSessionMessage({
            sessionId: session.id,
            missionId: mission.id,
            role: 'system',
            kind: 'system',
            presentation: 'history',
            content: '',
            metadata: {
              agentRunId: active.runId,
              checkpointHash: checkpoint.hash,
              checkpointChangeCount: checkpoint.changeCount,
              runStartEventSeq,
              coveredThroughEventSeq: consumedSeq,
              runPhase: result.phase
            }
          })
        }
      }
      if (historyCaptureError) {
        this.store.appendAgentSessionMessage({
          sessionId: session.id,
          missionId: mission.id,
          role: 'system',
          kind: 'system',
          presentation: 'history',
          content: '',
          metadata: {
            agentRunId: active.runId,
            historyCaptureFailed: true,
            historyCaptureError,
            runStartEventSeq,
            coveredThroughEventSeq: consumedSeq,
            runPhase: result.phase
          }
        })
      }
    }

    if (result.phase === 'failed') {
      this.failParticipant(mission, participant, result.error || 'Agent run failed')
      return
    }
    if (result.phase === 'cancelled') return

    const alreadyPublishedCompletion = this.store
      .listMissionEvents(mission.id)
      .some((event) => isHumanVisibleCompletion(event, participant.id))
    const publicCompletion = (result.finalResponse ?? result.content).trim()
    if (publicCompletion && !alreadyPublishedCompletion) {
      const usage = this.latestRunUsage(session.id, active.runId)
      this.store.appendAgentEvent({
        groupId: mission.groupId,
        missionId: mission.id,
        participantId: participant.id,
        kind: 'agent_message',
        payload: {
          text: publicCompletion,
          targetParticipantIds: [],
          metadata: {
            audience: 'human',
            sessionId: session.id,
            checkpointHash,
            ...(usage ? { usage } : {})
          }
        }
      })
      this.changed(mission.groupId, 'event')
    }
    this.store.updateParticipantRun(mission.id, participant.id, {
      status: this.hasFreshCompletionClaim(mission.id, participant.id) ? 'completed' : 'waiting',
      currentActivity: null,
      error: null
    })
    this.changed(mission.groupId, 'mission')
  }

  private recordKernelEvent(
    mission: CollaborationMission,
    participant: CollaborationParticipant,
    sessionId: string,
    event: AgentRunEvent
  ): void {
    if (event.type === 'run.retrying') {
      const reason = String(event.payload.reason || '')
      if (reason === 'editing_contract_calibration_started') {
        this.store.updateParticipantRun(mission.id, participant.id, {
          status: 'working',
          currentActivity: 'Testing a compatible file-editing contract',
          error: null
        })
        this.changed(mission.groupId, 'mission')
      }
      if (reason === 'editing_contract_switched') {
        this.store.updateParticipantRun(mission.id, participant.id, {
          status: 'working',
          currentActivity: `Retrying with ${String(event.payload.to || 'a verified editing contract')}`,
          error: null
        })
        this.changed(mission.groupId, 'mission')
      }
    }
    if (event.type === 'compaction.started') {
      this.store.updateParticipantRun(mission.id, participant.id, {
        status: 'working',
        currentActivity: 'Compacting context',
        error: null
      })
      this.store.appendAgentSessionMessage({
        sessionId,
        missionId: mission.id,
        role: 'system',
        kind: 'system',
        presentation: 'notice',
        content: 'Compacting context…',
        metadata: {
          agentRunId: event.runId,
          compaction: { status: 'started', ...event.payload }
        }
      })
      this.changed(mission.groupId, 'mission')
      return
    }
    if (event.type === 'compaction.completed') {
      const messagesCompacted = Number(
        event.payload.messagesCompacted || event.payload.previousMessageCount || 0
      )
      const originalTokens = Number(event.payload.originalTokens || 0)
      const summaryTokens = Number(event.payload.summaryTokens || 0)
      const savedPercent =
        originalTokens > 0
          ? Math.round(Math.max(0, Math.min(1, 1 - summaryTokens / originalTokens)) * 100)
          : null
      const details = [
        messagesCompacted > 0
          ? `${messagesCompacted} message${messagesCompacted === 1 ? '' : 's'}`
          : '',
        savedPercent === null ? '' : `${savedPercent}% saved`
      ].filter(Boolean)
      this.store.updateParticipantRun(mission.id, participant.id, {
        status: 'working',
        currentActivity: 'Continuing with compacted context',
        error: null
      })
      this.store.appendAgentSessionMessage({
        sessionId,
        missionId: mission.id,
        role: 'system',
        kind: 'system',
        presentation: 'notice',
        content: `Context compacted${details.length ? `: ${details.join(', ')}` : ''}. Continuing…`,
        metadata: {
          agentRunId: event.runId,
          compaction: { status: 'completed', ...event.payload }
        }
      })
      this.changed(mission.groupId, 'mission')
      return
    }
    if (event.type === 'permission.requested' || event.type === 'question.requested') {
      const interaction = {
        id: String(event.payload.interactionId || ''),
        kind:
          event.type === 'permission.requested'
            ? 'permission'
            : String(event.payload.kind || 'question'),
        status: 'pending',
        request: (event.payload.request as Record<string, unknown>) ?? {}
      }
      this.recordInteraction(mission, participant, sessionId, event.runId, interaction)
    }
    if (event.type === 'permission.resolved' || event.type === 'question.resolved') {
      const requested = this.runtime
        .events(event.runId)
        .events.find(
          (candidate) =>
            (candidate.type === 'permission.requested' ||
              candidate.type === 'question.requested') &&
            candidate.payload.interactionId === event.payload.interactionId
        )
      const interaction = {
        id: String(event.payload.interactionId || ''),
        kind:
          event.type === 'permission.resolved'
            ? 'permission'
            : String(event.payload.kind || 'question'),
        status: event.payload.status === 'cancelled' ? 'cancelled' : 'resolved',
        request:
          (event.payload.request as Record<string, unknown>) ??
          (requested?.payload.request as Record<string, unknown>) ??
          {},
        response: (event.payload.response as Record<string, unknown>) ?? {}
      }
      this.recordInteraction(mission, participant, sessionId, event.runId, interaction)
    }
    if (event.type === 'assistant.completed') {
      this.store.appendAgentSessionMessage({
        sessionId,
        missionId: mission.id,
        role: 'assistant',
        kind: 'assistant',
        presentation: 'conversation',
        content: String(event.payload.content || ''),
        toolCalls: toolCallsFromEvent(event),
        metadata: {
          thinking: event.payload.thinking,
          usage: event.payload.usage,
          agentRunId: event.runId
        }
      })
      // Session transcripts and their provider usage are separate from the
      // public channel. Notify the renderer immediately so a terminal first
      // response does not wait for a later tool or mission event to appear.
      this.changed(mission.groupId, 'event')
    }
    if (event.type === 'tool.running') {
      this.store.updateParticipantRun(mission.id, participant.id, {
        status: 'working',
        currentActivity: String(event.payload.title || event.payload.name || 'Using tool'),
        error: null
      })
      this.store.appendAgentEvent({
        groupId: mission.groupId,
        missionId: mission.id,
        participantId: participant.id,
        kind: 'tool_call',
        payload: {
          toolName: String(event.payload.name || ''),
          toolCallId: String(event.payload.toolCallId || ''),
          title: String(event.payload.title || event.payload.name || 'Tool'),
          args: (event.payload.arguments as Record<string, unknown>) ?? {}
        }
      })
      this.changed(mission.groupId, 'event')
    }
    if (event.type === 'tool.completed') {
      const result = event.payload.result as ToolExecutionResult | undefined
      const toolCallId = String(event.payload.toolCallId || '')
      const content = result?.modelContent || JSON.stringify(result ?? {})
      this.store.appendAgentSessionMessage({
        sessionId,
        missionId: mission.id,
        role: 'tool',
        kind: 'tool_result',
        presentation: 'conversation',
        content,
        toolCallId,
        metadata: {
          toolName: event.payload.name,
          title: result?.title,
          success: result?.status === 'success',
          status: result?.status,
          agentRunId: event.runId
        }
      })
      this.store.appendAgentEvent({
        groupId: mission.groupId,
        missionId: mission.id,
        participantId: participant.id,
        kind: 'tool_result',
        payload: {
          toolName: String(event.payload.name || ''),
          toolCallId,
          success: result?.status === 'success',
          result: content.slice(0, 2_000),
          metadata: { status: result?.status, errorCode: result?.error?.code }
        }
      })
      this.changed(mission.groupId, 'event')
    }
  }

  private recordInteraction(
    mission: CollaborationMission,
    participant: CollaborationParticipant,
    sessionId: string,
    runId: string,
    interaction: Record<string, unknown>
  ): void {
    if (!interaction.id) return
    this.store.appendAgentSessionMessage({
      sessionId,
      missionId: mission.id,
      role: 'system',
      kind: 'system',
      presentation: 'conversation',
      content: '',
      metadata: { agentInteraction: interaction, agentRunId: runId }
    })
    this.store.appendAgentEvent({
      groupId: mission.groupId,
      missionId: mission.id,
      participantId: participant.id,
      kind: 'system',
      payload: {
        text: '',
        metadata: {
          agentInteraction: interaction,
          agentRunId: runId,
          actorLabel: participant.label,
          projectName: participant.projectName
        }
      }
    })
    this.changed(mission.groupId, 'event')
  }

  private async executeCollaborationTool(
    mission: CollaborationMission,
    participant: CollaborationParticipant,
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    context: AgentToolExecutionContext
  ): Promise<unknown> {
    if (name === 'collaboration_read') {
      const session = this.store.getAgentSession(sessionId)
      if (!session) throw new Error('Agent session not found')
      const events = this.store.listSharedChannelEvents(mission.groupId, session.lastEventSeq, 500)
      if (events.length) this.store.updateAgentSessionCursor(session.id, events.at(-1)!.seq)
      const pending = this.store.listPendingEvents(participant.id)
      if (pending.length)
        this.store.consumeDeliveries(
          participant.id,
          pending.map(({ id }) => id)
        )
      return {
        events: events
          .filter((event) => event.actorParticipantId !== participant.id)
          .map((event) => displayEvent(event, this.store.listParticipants(mission.groupId)))
      }
    }
    if (name === 'collaboration_send') {
      const normalizedMessage = normalizeCollaborationHumanAddress(textArg(args, 'message'))
      const usage = this.latestRunUsage(sessionId, context.runId)
      const audience = ['human', 'other_agent', 'everyone'].includes(String(args.audience))
        ? String(args.audience)
        : 'everyone'
      const messageType = MESSAGE_TYPES.has(String(args.message_type) as CollaborationMessageType)
        ? (String(args.message_type) as CollaborationMessageType)
        : 'update'
      const peers = this.store
        .listParticipants(mission.groupId)
        .filter(({ id }) => id !== participant.id)
        .map(({ id }) => id)
      const recipients = audience === 'human' ? [] : peers
      const wake = messageType === 'request' || messageType === 'response' ? recipients : []
      const event = this.store.appendAgentEvent({
        groupId: mission.groupId,
        missionId: mission.id,
        participantId: participant.id,
        kind: 'peer_message',
        payload: {
          text: normalizedMessage.text,
          targetParticipantIds: messageType === 'request' ? recipients : [],
          metadata: {
            audience,
            sessionId,
            messageType,
            humanAttention: audience === 'human' || normalizedMessage.mentionedHuman,
            ...(usage ? { usage } : {})
          }
        },
        deliverToParticipantIds: wake
      })
      this.changed(mission.groupId, 'event')
      for (const recipientId of wake) this.schedule(mission.id, recipientId)
      return { sent: true, eventId: event.id, audience, messageType, recipients, woken: wake }
    }
    if (name === 'collaboration_share_file') {
      const relativePath = textArg(args, 'file_path')
      const file = await resolveSecureWorkspacePath(participant.projectFolder, relativePath)
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) {
        throw new Error('Only UTF-8 text files up to 1 MB can be shared')
      }
      const bytes = await fs.readFile(file)
      if (bytes.includes(0)) throw new Error('Only UTF-8 text files can be shared')
      const content = bytes.toString('utf8')
      if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error('File is not valid UTF-8')
      const artifact = this.store.createArtifact({
        groupId: mission.groupId,
        missionId: mission.id,
        senderParticipantId: participant.id,
        name: basename(
          typeof args.name === 'string' && args.name.trim() ? args.name : relativePath
        ),
        sourcePath: relativePath,
        content,
        byteSize: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
      const recipients = this.store
        .listParticipants(mission.groupId)
        .filter(({ id }) => id !== participant.id)
        .map(({ id }) => id)
      this.store.appendAgentEvent({
        groupId: mission.groupId,
        missionId: mission.id,
        participantId: participant.id,
        kind: 'peer_message',
        payload: {
          text: `Shared ${artifact.name} (artifact ${artifact.id})`,
          targetParticipantIds: recipients,
          metadata: {
            audience: 'everyone',
            sessionId,
            messageType: 'request',
            artifactId: artifact.id,
            artifactName: artifact.name,
            transportOnly: true
          }
        },
        deliverToParticipantIds: recipients
      })
      this.changed(mission.groupId, 'event')
      for (const recipientId of recipients) this.schedule(mission.id, recipientId)
      return {
        shared: true,
        artifact,
        recipients,
        nextAction:
          'Post a concise collaboration_send update or request explaining what the peer should do with this handoff. Do not paste the artifact id into the human channel.'
      }
    }
    if (name === 'collaboration_list_artifacts') {
      return { artifacts: this.store.listArtifacts(mission.groupId) }
    }
    if (name === 'collaboration_import_artifact') {
      const artifact = this.store.getArtifact(textArg(args, 'artifact_id'))
      if (!artifact || artifact.groupId !== mission.groupId) throw new Error('Artifact not found')
      if (artifact.senderParticipantId === participant.id) {
        throw new Error('This artifact already belongs to your project')
      }
      const destinationPath = textArg(args, 'destination_path')
      const scoped = await resolveWorkspaceInstructionsForPath(
        context.runId,
        participant.projectFolder,
        destinationPath,
        false,
        true
      )
      if (scoped.retryRequired) {
        return {
          imported: false,
          retryRequired: true,
          projectInstructions: scoped.content,
          error: 'New directory-scoped instructions apply. Review them, then retry the import.'
        }
      }
      const mutation = await executeWorkspaceMutation(
        participant.projectFolder,
        {
          kind: 'write',
          filePath: destinationPath,
          content: artifact.content,
          accessLevel: args.accessLevel === 'confirm' ? 'confirm' : 'auto'
        },
        { requireReadReceipt: true }
      )
      if (!mutation.ok && /read receipt required/i.test(mutation.error || '')) {
        mutation.error = `Destination already exists: ${destinationPath}. Choose a new path; artifact import never overwrites project files.`
      }
      return {
        imported: mutation.ok && mutation.changed,
        artifactId: artifact.id,
        destinationPath,
        mutation
      }
    }
    if (name === 'collaboration_status') {
      return {
        mission: this.store.getMission(mission.id),
        participants: this.store
          .listParticipants(mission.groupId)
          .map(({ id, label, projectName }) => ({
            id,
            label,
            projectName,
            running: this.active.has(`${mission.id}:${id}`)
          }))
      }
    }
    if (name === 'collaboration_claim_complete') {
      this.store.appendAgentEvent({
        groupId: mission.groupId,
        missionId: mission.id,
        participantId: participant.id,
        kind: 'agent_activity',
        payload: {
          text: `Completed: ${textArg(args, 'summary')}`,
          success: true,
          metadata: { completionClaim: true, sessionId }
        }
      })
      this.changed(mission.groupId, 'event')
      return { recorded: true }
    }
    throw new Error(`Unsupported collaboration tool: ${name}`)
  }

  private latestRunUsage(sessionId: string, runId: string): Record<string, unknown> | undefined {
    const assistant = this.store
      .listRecentAgentSessionMessages(sessionId, 40)
      .reverse()
      .find(
        (message) =>
          message.role === 'assistant' &&
          message.metadata.agentRunId === runId &&
          message.metadata.usage &&
          typeof message.metadata.usage === 'object'
      )
    return assistant?.metadata.usage as Record<string, unknown> | undefined
  }

  private failParticipant(
    mission: CollaborationMission,
    participant: CollaborationParticipant,
    error: unknown
  ): void {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
    const session = this.store.ensureParticipantAgentSession(participant.id)
    this.store.updateParticipantRun(mission.id, participant.id, {
      status: 'failed',
      currentActivity: null,
      error: message
    })
    this.store.appendAgentSessionMessage({
      sessionId: session.id,
      missionId: mission.id,
      role: 'system',
      kind: 'system',
      presentation: 'notice',
      content: `Agent stopped: ${message}`,
      metadata: { error: true }
    })
    this.store.appendAgentEvent({
      groupId: mission.groupId,
      missionId: mission.id,
      participantId: participant.id,
      kind: 'agent_message',
      payload: {
        text: `I couldn't continue because the agent run stopped: ${message}`,
        success: false,
        metadata: { audience: 'human', error: true, sessionId: session.id }
      }
    })
    if (this.store.getMission(mission.id)?.status === 'running') {
      this.store.updateMission(mission.id, { status: 'paused', error: message })
      this.abortMission(mission.id)
    }
    this.changed(mission.groupId, 'mission')
  }

  private hasFreshCompletionClaim(missionId: string, participantId: string): boolean {
    const events = this.store.listMissionEvents(missionId)
    const lastInputSeq = Math.max(
      0,
      ...events.filter((event) => eventRequiresResponse(event, participantId)).map(({ seq }) => seq)
    )
    const lastClaimSeq = Math.max(
      0,
      ...events
        .filter(
          (event) =>
            event.kind === 'agent_activity' &&
            event.actorParticipantId === participantId &&
            (event.payload.metadata?.completionClaim === true ||
              event.payload.text?.startsWith('Completed:'))
        )
        .map(({ seq }) => seq)
    )
    return lastClaimSeq > lastInputSeq
  }

  private finishMissionIfSettled(missionId: string): void {
    const mission = this.store.getMission(missionId)
    if (!mission || mission.status !== 'running') return
    if ([...this.active.values()].some((active) => active.missionId === missionId)) return
    const participants = this.store.listParticipants(mission.groupId)
    const pendingParticipants = participants.filter(
      (participant) =>
        this.store.getParticipantRun(missionId, participant.id)?.status !== 'stopped' &&
        this.store.listPendingEvents(participant.id).some((event) => event.missionId === missionId)
    )
    if (pendingParticipants.length) {
      for (const participant of pendingParticipants) this.schedule(missionId, participant.id)
      return
    }
    const events = this.store.listMissionEvents(missionId)
    const required = new Set(mission.requestedParticipantIds)
    for (const event of events) {
      if (event.kind === 'user_message' || messageTypeFromEvent(event) === 'request') {
        for (const id of event.payload.targetParticipantIds ?? []) required.add(id)
      }
    }
    const settled = [...required].every((participantId) => {
      if (this.store.getParticipantRun(missionId, participantId)?.status === 'stopped') return true
      const lastInput = Math.max(
        0,
        ...events
          .filter((event) => eventRequiresResponse(event, participantId))
          .map(({ seq }) => seq)
      )
      const lastResponse = Math.max(
        0,
        ...events
          .filter((event) => isParticipantResponse(event, participantId))
          .map(({ seq }) => seq)
      )
      return lastResponse > lastInput
    })
    if (!settled) return
    this.store.updateMission(missionId, { status: 'completed' })
    for (const run of this.store.listParticipantRuns(missionId)) {
      if (run.status === 'waiting' || run.status === 'queued') {
        this.store.updateParticipantRun(missionId, run.participantId, {
          status: 'completed',
          currentActivity: null,
          error: null
        })
      }
    }
    this.store.appendSystemEvent({
      groupId: mission.groupId,
      missionId,
      kind: 'mission_status',
      payload: { text: 'Mission completed', status: 'completed' }
    })
    this.changed(mission.groupId, 'mission')
  }
}
