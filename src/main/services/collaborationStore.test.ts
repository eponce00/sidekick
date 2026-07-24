import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { CollaborationStore } from './collaborationStore'

describe('CollaborationStore', () => {
  let db: Database.Database
  let store: CollaborationStore

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    store = new CollaborationStore(db)
    const insert = db.prepare(
      `INSERT INTO projects (id, name, folder_path, is_pinned, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1, 1)`
    )
    insert.run('project-a', 'Desktop', '/tmp/sidekick-project-a')
    insert.run('project-b', 'API', '/tmp/sidekick-project-b')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  function createGroup() {
    return store.createGroup({
      title: 'Ship the feature',
      participants: [
        {
          projectId: 'project-a',
          providerTarget: { providerKind: 'ollama', model: 'model-a' }
        },
        {
          projectId: 'project-b',
          providerTarget: { providerKind: 'litellm', model: 'model-b' }
        }
      ]
    })
  }

  it('creates a persistent group with two project-scoped agents', () => {
    const detail = createGroup()
    expect(detail.group.title).toBe('Ship the feature')
    expect(detail.participants).toHaveLength(2)
    expect(detail.participants.map(({ projectId }) => projectId)).toEqual([
      'project-a',
      'project-b'
    ])
    expect(detail.agentSessions).toHaveLength(2)
    expect(detail.agentSessions.map(({ participantId }) => participantId)).toEqual(
      detail.participants.map(({ id }) => id)
    )
    expect(detail.events[0].kind).toBe('system')
    expect(store.listGroups()[0].participantCount).toBe(2)
    expect(store.listGroups()[0].agentSessions).toHaveLength(2)
  })

  it('projects busy state per linked agent session instead of per group mission', () => {
    const detail = createGroup()
    const { mission } = store.sendUserMessage({ groupId: detail.group.id, text: 'Start work' })
    store.updateMission(mission.id, { status: 'running' })
    store.updateParticipantRun(mission.id, detail.participants[0].id, { status: 'waiting' })
    store.updateParticipantRun(mission.id, detail.participants[1].id, { status: 'working' })

    const sessions = store.listGroups()[0].agentSessions
    expect(sessions.map(({ activeRunStatus }) => activeRunStatus)).toEqual(['waiting', 'working'])
  })

  it('persists unread completion markers until the related chat is opened', () => {
    const detail = createGroup()
    const { mission } = store.sendUserMessage({ groupId: detail.group.id, text: 'Finish this' })
    store.updateMission(mission.id, { status: 'running' })

    store.updateParticipantRun(mission.id, detail.participants[0].id, { status: 'completed' })
    let group = store.listGroups()[0]
    expect(group.agentSessions[0].unreadCompletionAt).toEqual(expect.any(Number))
    expect(group.unreadCompletionAt).toBeNull()

    store.updateMission(mission.id, { status: 'completed' })
    group = store.listGroups()[0]
    expect(group.unreadCompletionAt).toEqual(expect.any(Number))
    expect(group.agentSessions.every((session) => session.unreadCompletionAt !== null)).toBe(true)

    expect(store.markGroupRead(group.id)).toBe(true)
    group = store.listGroups()[0]
    expect(group.unreadCompletionAt).toBeNull()
    expect(group.agentSessions.every((session) => session.unreadCompletionAt === null)).toBe(true)
  })

  it('persists each agent private transcript and a monotonic shared-channel cursor', () => {
    const detail = createGroup()
    const [firstSession] = detail.agentSessions
    const user = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Only wake the desktop agent',
      targetParticipantIds: [detail.participants[0].id]
    })
    const peer = store.appendAgentEvent({
      groupId: detail.group.id,
      missionId: user.mission.id,
      participantId: detail.participants[0].id,
      kind: 'peer_message',
      payload: { text: 'Public interface update', targetParticipantIds: [] }
    })

    const publicMessages = store.listSharedChannelEvents(detail.group.id)
    expect(publicMessages.map(({ id }) => id)).toEqual([user.event.id, peer.id])

    const transcript = store.appendAgentSessionMessage({
      sessionId: firstSession.id,
      missionId: user.mission.id,
      role: 'assistant',
      kind: 'assistant',
      content: 'Inspecting the desktop project.'
    })
    store.updateAgentSessionCursor(firstSession.id, peer.seq)
    store.updateAgentSessionCursor(firstSession.id, user.event.seq)

    expect(store.listAgentSessionMessages(firstSession.id)).toEqual([transcript])
    expect(store.getAgentSession(firstSession.id)?.lastEventSeq).toBe(peer.seq)
  })

  it('returns the newest group messages after a long-running agent event stream', () => {
    const detail = createGroup()
    const first = store.sendUserMessage({ groupId: detail.group.id, text: 'Initial request' })
    for (let index = 0; index < 600; index++) {
      store.appendSystemEvent({
        groupId: detail.group.id,
        missionId: first.mission.id,
        kind: 'agent_activity',
        payload: { text: `Internal activity ${index}` }
      })
    }
    const followUp = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'This follow-up must stay visible'
    })

    const refreshed = store.getDetail(detail.group.id)!
    expect(refreshed.events.find(({ id }) => id === first.event.id)?.payload.text).toBe(
      'Initial request'
    )
    expect(refreshed.events.find(({ id }) => id === followUp.event.id)?.payload.text).toBe(
      'This follow-up must stay visible'
    )
    expect(refreshed.events.at(-1)?.id).toBe(followUp.event.id)
  })

  it('classifies durable session records by human-facing presentation', () => {
    const detail = createGroup()
    const sessionId = detail.agentSessions[0].id
    const reminder = store.appendAgentSessionMessage({
      sessionId,
      role: 'user',
      kind: 'system',
      content: 'Coordinate before continuing',
      metadata: { coordinationReminder: true }
    })
    const failure = store.appendAgentSessionMessage({
      sessionId,
      role: 'system',
      kind: 'system',
      presentation: 'notice',
      content: 'Provider unavailable',
      metadata: { error: true }
    })

    expect(reminder.presentation).toBe('internal')
    expect(failure.presentation).toBe('notice')
    expect(failure.metadata.presentation).toBe('notice')
  })

  it('gives project-agent chats normal prompt-based titles and preserves manual renames', () => {
    const detail = createGroup()
    expect(detail.agentSessions.map(({ title }) => title)).toEqual([
      'New Conversation',
      'New Conversation'
    ])

    store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Build a polished Cuba population dashboard with charts'
    })
    const titled = store.listGroups()[0].agentSessions
    expect(titled.map(({ title }) => title)).toEqual([
      'Build a polished Cuba population dashboard with',
      'Build a polished Cuba population dashboard with'
    ])

    store.updateAgentSession(titled[0].id, 'Population dashboard frontend')
    store.updateGroup(detail.group.id, { title: 'Renamed group' })
    expect(store.getAgentSession(titled[0].id)?.title).toBe('Population dashboard frontend')
  })

  it('creates a mission and targeted durable deliveries from the first user message', () => {
    const detail = createGroup()
    const target = detail.participants[0]
    const result = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Implement the new endpoint',
      targetParticipantIds: [target.id]
    })

    expect(result.mission.status).toBe('queued')
    expect(result.mission.requestedParticipantIds).toEqual([target.id])
    expect(store.listPendingEvents(target.id).map(({ id }) => id)).toContain(result.event.id)
    expect(store.listPendingEvents(detail.participants[1].id)).toHaveLength(0)

    store.consumeDeliveries(target.id, [result.event.id])
    expect(store.listPendingEvents(target.id)).toHaveLength(0)
    expect(store.getParticipantRun(result.mission.id, target.id)?.lastIngestedSeq).toBe(
      result.event.seq
    )
  })

  it('requeues a stopped participant when the human addresses it again', () => {
    const detail = createGroup()
    const participant = detail.participants[0]
    const first = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Start',
      targetParticipantIds: [participant.id]
    })
    store.updateMission(first.mission.id, { status: 'running' })
    store.updateParticipantRun(first.mission.id, participant.id, { status: 'stopped' })

    store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Continue with a new direction',
      targetParticipantIds: [participant.id]
    })

    expect(store.getParticipantRun(first.mission.id, participant.id)?.status).toBe('queued')
  })

  it('replaces a user-message timeline tail while preserving its original recipients', () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const detail = createGroup()
    now = 2_000
    const first = store.sendUserMessage({ groupId: detail.group.id, text: 'Keep this request' })
    now = 2_100
    store.appendAgentEvent({
      groupId: detail.group.id,
      missionId: first.mission.id,
      participantId: detail.participants[0].id,
      kind: 'agent_message',
      payload: { text: 'Keep this answer' }
    })
    store.appendAgentSessionMessage({
      sessionId: detail.agentSessions[0].id,
      missionId: first.mission.id,
      role: 'assistant',
      kind: 'assistant',
      content: 'Keep this private work'
    })
    store.updateMission(first.mission.id, { status: 'completed' })

    now = 3_000
    const followUp = store.sendUserMessage({
      groupId: detail.group.id,
      text: 'Discard this follow-up',
      targetParticipantIds: [detail.participants[1].id]
    })
    now = 3_100
    store.appendAgentSessionMessage({
      sessionId: detail.agentSessions[0].id,
      missionId: followUp.mission.id,
      role: 'system',
      kind: 'system',
      presentation: 'history',
      content: '',
      metadata: {
        checkpointHash: 'affected-checkpoint',
        coveredThroughEventSeq: followUp.event.seq,
        agentRunId: 'affected-run'
      }
    })
    store.createArtifact({
      groupId: detail.group.id,
      missionId: followUp.mission.id,
      senderParticipantId: detail.participants[0].id,
      name: 'discard.csv',
      sourcePath: 'discard.csv',
      content: 'discard',
      byteSize: 7,
      sha256: 'discard'
    })
    store.updateAgentSessionCursor(detail.agentSessions[0].id, followUp.event.seq)

    now = 4_000
    const replacement = store.replaceTimelineFromUserMessage({
      groupId: detail.group.id,
      eventId: followUp.event.id,
      text: 'Use this corrected follow-up'
    })

    expect(replacement.event.seq).toBe(followUp.event.seq)
    expect(replacement.event.payload).toMatchObject({
      text: 'Use this corrected follow-up',
      targetParticipantIds: [detail.participants[1].id]
    })
    expect(store.listEvents(detail.group.id, 0, 2_000).map(({ payload }) => payload.text)).toEqual(
      expect.arrayContaining([
        'Keep this request',
        'Keep this answer',
        'Use this corrected follow-up'
      ])
    )
    expect(
      store
        .listEvents(detail.group.id, 0, 2_000)
        .some(({ payload }) => payload.text?.includes('Discard this'))
    ).toBe(false)
    expect(
      store.listAgentSessionMessages(detail.agentSessions[0].id).map(({ content }) => content)
    ).toEqual(['Keep this private work'])
    expect(store.listArtifacts(detail.group.id)).toEqual([])
    expect(store.getAgentSession(detail.agentSessions[0].id)?.lastEventSeq).toBe(
      followUp.event.seq - 1
    )
    expect(store.getMission(followUp.mission.id)).toBeNull()
  })

  it('keeps shared peer messages ordered and deliverable to the other agent', () => {
    const detail = createGroup()
    const result = store.sendUserMessage({ groupId: detail.group.id, text: 'Work together' })
    const [sender, recipient] = detail.participants
    const peer = store.appendAgentEvent({
      groupId: detail.group.id,
      missionId: result.mission.id,
      participantId: sender.id,
      kind: 'peer_message',
      payload: { text: 'Please confirm the interface.' },
      deliverToParticipantIds: [recipient.id]
    })

    expect(peer.seq).toBeGreaterThan(result.event.seq)
    expect(store.listPendingEvents(recipient.id).map(({ id }) => id)).toContain(peer.id)
  })

  it('persists immutable group artifacts separately from project workspaces', () => {
    const detail = createGroup()
    const { mission } = store.sendUserMessage({ groupId: detail.group.id, text: 'Share data' })
    const sender = detail.participants[0]
    const artifact = store.createArtifact({
      groupId: detail.group.id,
      missionId: mission.id,
      senderParticipantId: sender.id,
      name: 'population.csv',
      sourcePath: 'data/population.csv',
      content: 'year,population\n2024,10000000\n',
      byteSize: 33,
      sha256: 'abc123'
    })

    expect(store.listArtifacts(detail.group.id)).toEqual([artifact])
    expect(store.getArtifact(artifact.id)).toMatchObject({
      ...artifact,
      content: 'year,population\n2024,10000000\n'
    })
  })

  it('pauses interrupted missions during startup recovery', () => {
    const detail = createGroup()
    const { mission } = store.sendUserMessage({ groupId: detail.group.id, text: 'Start' })
    store.updateMission(mission.id, { status: 'running' })

    expect(store.recoverInterruptedMissions()).toBe(1)
    expect(store.getMission(mission.id)?.status).toBe('paused')
  })

  it('tracks independent per-agent iteration budgets', () => {
    const detail = createGroup()
    const { mission } = store.sendUserMessage({ groupId: detail.group.id, text: 'Start' })
    store.updateMission(mission.id, { status: 'running' })
    const [first, second] = detail.participants
    const firstRun = store.getParticipantRun(mission.id, first.id)!

    for (let index = 0; index < firstRun.maxIterations; index++) {
      expect(store.claimParticipantIteration(mission.id, first.id).claimed).toBe(true)
    }
    const exhausted = store.claimParticipantIteration(mission.id, first.id)
    expect(exhausted.claimed).toBe(false)
    expect(exhausted.run.iterationCount).toBe(firstRun.maxIterations)

    const independent = store.claimParticipantIteration(mission.id, second.id)
    expect(independent.claimed).toBe(true)
    expect(independent.run.iterationCount).toBe(1)
    expect(store.getMission(mission.id)?.iterationCount).toBe(firstRun.maxIterations + 1)
  })

  it('adopts a raised configured budget before extending an exhausted current budget', () => {
    const detail = createGroup()
    const { mission } = store.sendUserMessage({ groupId: detail.group.id, text: 'Start' })
    const participant = detail.participants[0]
    db.prepare(
      `UPDATE collaboration_participant_runs
       SET max_iterations = 100, iteration_count = 100, status = 'paused'
       WHERE mission_id = ? AND participant_id = ?`
    ).run(mission.id, participant.id)

    store.extendParticipantRuns(mission.id, 1000)
    expect(store.getParticipantRun(mission.id, participant.id)).toMatchObject({
      status: 'queued',
      iterationCount: 100,
      maxIterations: 1000
    })

    db.prepare(
      `UPDATE collaboration_participant_runs
       SET iteration_count = 1000, status = 'paused'
       WHERE mission_id = ? AND participant_id = ?`
    ).run(mission.id, participant.id)
    store.extendParticipantRuns(mission.id, 1000)
    expect(store.getParticipantRun(mission.id, participant.id)?.maxIterations).toBe(2000)
  })

  it('updates an idle participant model but protects an active provider run', () => {
    const detail = createGroup()
    const participant = detail.participants[0]
    const updated = store.updateParticipant(participant.id, {
      providerTarget: {
        providerInstanceId: 'local-provider',
        providerKind: 'openai-compatible',
        model: 'new-model',
        contextLength: 65_536
      }
    })
    expect(updated.providerTarget).toMatchObject({ model: 'new-model', contextLength: 65_536 })

    const { mission } = store.sendUserMessage({ groupId: detail.group.id, text: 'Start' })
    expect(() =>
      store.updateParticipant(participant.id, {
        providerTarget: { providerKind: 'ollama', model: 'unsafe-mid-run-change' }
      })
    ).toThrow(/Pause the addressed agents/)
    expect(store.getParticipantRun(mission.id, participant.id)?.status).toBe('queued')
  })

  it('rejects nested project roots', () => {
    db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(
      '/tmp/sidekick-project-a/nested',
      'project-b'
    )
    expect(() => createGroup()).toThrow(/cannot contain one another/)
  })

  it('archives safely without deleting the durable timeline', () => {
    const detail = createGroup()
    const { mission } = store.sendUserMessage({ groupId: detail.group.id, text: 'Start' })
    store.updateMission(mission.id, { status: 'running' })

    store.deleteGroup(detail.group.id)

    expect(store.getGroup(detail.group.id)?.status).toBe('archived')
    expect(store.getMission(mission.id)?.status).toBe('stopped')
    expect(store.listParticipants(detail.group.id)).toHaveLength(0)
    expect(store.listEvents(detail.group.id)).not.toHaveLength(0)
  })
})
