import { describe, expect, it } from 'vitest'
import type {
  CollaborationAgentSessionMessage,
  CollaborationEvent,
  CollaborationParticipant
} from '../../../shared/collaboration'
import { projectGroupAgentConversation } from './groupAgentConversation'

const participant = {
  id: 'agent-a',
  groupId: 'group',
  projectId: 'project-a',
  projectName: 'Webpage',
  projectFolder: '/tmp/webpage',
  label: 'Webpage agent',
  providerTarget: { providerKind: 'litellm', model: 'model-a' },
  status: 'active',
  joinedAt: 1,
  removedAt: null,
  lastReadSeq: 0
} satisfies CollaborationParticipant

const peer = {
  ...participant,
  id: 'agent-b',
  projectId: 'project-b',
  projectName: 'Data',
  projectFolder: '/tmp/data',
  label: 'Data agent'
} satisfies CollaborationParticipant

describe('projectGroupAgentConversation', () => {
  it('renders public context and private work using normal chat messages without raw envelopes', () => {
    const events: CollaborationEvent[] = [
      {
        id: 'user-event',
        groupId: 'group',
        missionId: 'mission',
        seq: 1,
        actorType: 'user',
        actorParticipantId: null,
        kind: 'user_message',
        payload: { text: 'Build the dashboard' },
        replyToEventId: null,
        createdAt: 10
      },
      {
        id: 'peer-event',
        groupId: 'group',
        missionId: 'mission',
        seq: 2,
        actorType: 'agent',
        actorParticipantId: peer.id,
        kind: 'peer_message',
        payload: {
          text: 'The dataset is ready.',
          targetParticipantIds: [participant.id],
          metadata: { audience: 'other_agent' }
        },
        replyToEventId: null,
        createdAt: 20
      }
    ]
    const records: CollaborationAgentSessionMessage[] = [
      {
        id: 'raw-envelope',
        sessionId: 'session',
        missionId: 'mission',
        role: 'user',
        kind: 'shared_event',
        presentation: 'internal',
        content: 'New shared group messages: [group event 1]',
        toolCalls: [],
        toolCallId: null,
        metadata: {},
        createdAt: 11
      },
      {
        id: 'assistant',
        sessionId: 'session',
        missionId: 'mission',
        role: 'assistant',
        kind: 'assistant',
        presentation: 'conversation',
        content: 'I will inspect the files.',
        toolCalls: [
          {
            id: 'call',
            function: { name: 'shell', arguments: { command: 'npm test' } }
          }
        ],
        toolCallId: null,
        metadata: {
          usage: { promptTokens: 100, completionTokens: 20, tokensPerSecond: 10 }
        },
        createdAt: 30
      },
      {
        id: 'result',
        sessionId: 'session',
        missionId: 'mission',
        role: 'tool',
        kind: 'tool_result',
        presentation: 'conversation',
        content: 'passed',
        toolCalls: [],
        toolCallId: 'call',
        metadata: {
          toolName: 'shell',
          title: 'Run tests',
          success: true,
          args: { command: 'npm test' }
        },
        createdAt: 40
      },
      {
        id: 'assistant-final',
        sessionId: 'session',
        missionId: 'mission',
        role: 'assistant',
        kind: 'assistant',
        presentation: 'conversation',
        content: 'The tests passed.',
        toolCalls: [],
        toolCallId: null,
        metadata: {
          usage: { promptTokens: 150, completionTokens: 30, tokensPerSecond: 30 }
        },
        createdAt: 50
      },
      {
        id: 'checkpoint-notice',
        sessionId: 'session',
        missionId: 'mission',
        role: 'system',
        kind: 'system',
        presentation: 'history',
        content: 'Saved 6 project file changes to SideKick History.',
        toolCalls: [],
        toolCallId: null,
        metadata: { checkpointHash: 'abc123', workspaceRoot: '/tmp/webpage' },
        createdAt: 60
      }
    ]

    const projection = projectGroupAgentConversation({
      participant,
      participants: [participant, peer],
      events,
      sessionMessages: records
    })

    expect(projection.messages.map(({ content }) => content)).toEqual([
      'Build the dashboard',
      'The dataset is ready.',
      'I will inspect the files.\n\nThe tests passed.'
    ])
    expect(projection.messages[1]).toMatchObject({ role: 'agent', peerLabel: 'Data agent' })
    expect(projection.messages.at(-1)?.segments?.map(({ type }) => type)).toEqual([
      'text',
      'tool',
      'text'
    ])
    expect(projection.messages.at(-1)?.segments?.at(1)?.tool).toMatchObject({
      title: 'Run tests',
      status: 'success',
      command: 'npm test'
    })
    expect(projection.messages.at(-1)?.tokenUsage).toEqual({
      promptTokens: 250,
      completionTokens: 50,
      tokensPerSecond: 50 / 3
    })
    expect(projection.activities).toEqual([
      expect.objectContaining({ title: 'Run tests', status: 'success', command: 'npm test' })
    ])
  })

  it('starts a new visual loop when a public message arrives between provider iterations', () => {
    const events: CollaborationEvent[] = [
      {
        id: 'peer-event',
        groupId: 'group',
        missionId: 'mission',
        seq: 2,
        actorType: 'agent',
        actorParticipantId: peer.id,
        kind: 'peer_message',
        payload: {
          text: 'Please use the revised dataset.',
          targetParticipantIds: [participant.id],
          metadata: { audience: 'other_agent' }
        },
        replyToEventId: null,
        createdAt: 20
      }
    ]
    const records: CollaborationAgentSessionMessage[] = [
      {
        id: 'before-peer',
        sessionId: 'session',
        missionId: 'mission',
        role: 'assistant',
        kind: 'assistant',
        presentation: 'conversation',
        content: 'I will inspect the first dataset.',
        toolCalls: [],
        toolCallId: null,
        metadata: {},
        createdAt: 10
      },
      {
        id: 'after-peer',
        sessionId: 'session',
        missionId: 'mission',
        role: 'assistant',
        kind: 'assistant',
        presentation: 'conversation',
        content: 'I will switch to the revision.',
        toolCalls: [],
        toolCallId: null,
        metadata: {},
        createdAt: 30
      }
    ]

    const projection = projectGroupAgentConversation({
      participant,
      participants: [participant, peer],
      events,
      sessionMessages: records
    })

    expect(projection.messages.map(({ content }) => content)).toEqual([
      'I will inspect the first dataset.',
      'Please use the revised dataset.',
      'I will switch to the revision.'
    ])
  })

  it('renders the agent own public coordination as messages instead of send-tool rows', () => {
    const events: CollaborationEvent[] = [
      {
        id: 'own-reply',
        groupId: 'group',
        missionId: 'mission',
        seq: 2,
        actorType: 'agent',
        actorParticipantId: participant.id,
        kind: 'peer_message',
        payload: {
          text: 'I will use your revised dataset now.',
          targetParticipantIds: [peer.id],
          metadata: { audience: 'other_agent', messageType: 'response' }
        },
        replyToEventId: null,
        createdAt: 20
      },
      {
        id: 'peer-follow-up',
        groupId: 'group',
        missionId: 'mission',
        seq: 3,
        actorType: 'agent',
        actorParticipantId: peer.id,
        kind: 'peer_message',
        payload: {
          text: 'The revision is ready.',
          targetParticipantIds: [participant.id],
          metadata: { audience: 'other_agent', messageType: 'update' }
        },
        replyToEventId: null,
        createdAt: 30
      }
    ]
    const records: CollaborationAgentSessionMessage[] = [
      {
        id: 'send-call',
        sessionId: 'session',
        missionId: 'mission',
        role: 'assistant',
        kind: 'assistant',
        presentation: 'conversation',
        content: '',
        toolCalls: [
          {
            id: 'send-tool',
            function: {
              name: 'collaboration_send',
              arguments: { message: 'I will use your revised dataset now.' }
            }
          }
        ],
        toolCallId: null,
        metadata: {},
        createdAt: 19
      },
      {
        id: 'send-result',
        sessionId: 'session',
        missionId: 'mission',
        role: 'tool',
        kind: 'tool_result',
        presentation: 'conversation',
        content: '{"sent":true}',
        toolCalls: [],
        toolCallId: 'send-tool',
        metadata: { toolName: 'collaboration_send', success: true },
        createdAt: 21
      }
    ]

    const projection = projectGroupAgentConversation({
      participant,
      participants: [participant, peer],
      events,
      sessionMessages: records
    })

    expect(projection.messages).toEqual([
      expect.objectContaining({
        id: 'own-reply',
        role: 'agent',
        content: 'I will use your revised dataset now.'
      }),
      expect.objectContaining({
        id: 'peer-follow-up',
        peerLabel: 'Data agent',
        content: 'The revision is ready.'
      })
    ])
    expect(projection.activities).toEqual([])
  })

  it('keeps private artifact transport envelopes out of the visible agent conversation', () => {
    const transport: CollaborationEvent = {
      id: 'artifact-transport',
      groupId: 'group',
      missionId: 'mission',
      seq: 2,
      actorType: 'agent',
      actorParticipantId: peer.id,
      kind: 'peer_message',
      payload: {
        text: 'Shared dataset.csv (artifact artifact-id)',
        targetParticipantIds: [participant.id],
        metadata: { artifactId: 'artifact-id', transportOnly: true }
      },
      replyToEventId: null,
      createdAt: 20
    }

    expect(
      projectGroupAgentConversation({
        participant,
        participants: [participant, peer],
        events: [transport],
        sessionMessages: []
      }).messages
    ).toEqual([])
  })

  it('does not inject human-only or differently targeted messages into a private agent chat', () => {
    const events: CollaborationEvent[] = [
      {
        id: 'human-update',
        groupId: 'group',
        missionId: 'mission',
        seq: 1,
        actorType: 'agent',
        actorParticipantId: peer.id,
        kind: 'peer_message',
        payload: { text: 'For the human', metadata: { audience: 'human' } },
        replyToEventId: null,
        createdAt: 10
      },
      {
        id: 'other-target',
        groupId: 'group',
        missionId: 'mission',
        seq: 2,
        actorType: 'user',
        actorParticipantId: null,
        kind: 'user_message',
        payload: { text: 'Only for Data', targetParticipantIds: [peer.id] },
        replyToEventId: null,
        createdAt: 20
      }
    ]

    const projection = projectGroupAgentConversation({
      participant,
      participants: [participant, peer],
      events,
      sessionMessages: []
    })

    expect(projection.messages).toEqual([])
  })

  it('keeps orchestration prompts private while presenting actionable failures as notices', () => {
    const records: CollaborationAgentSessionMessage[] = [
      {
        id: 'coordination-reminder',
        sessionId: 'session',
        missionId: 'mission',
        role: 'user',
        kind: 'system',
        presentation: 'internal',
        content: 'Use collaboration_send before continuing.',
        toolCalls: [],
        toolCallId: null,
        metadata: { coordinationReminder: true },
        createdAt: 10
      },
      {
        id: 'run-error',
        sessionId: 'session',
        missionId: 'mission',
        role: 'system',
        kind: 'system',
        presentation: 'notice',
        content: 'Agent run stopped: provider unavailable',
        toolCalls: [],
        toolCallId: null,
        metadata: { error: true },
        createdAt: 20
      }
    ]

    const projection = projectGroupAgentConversation({
      participant,
      participants: [participant, peer],
      events: [],
      sessionMessages: records
    })

    expect(projection.messages).toEqual([
      expect.objectContaining({
        id: 'run-error',
        role: 'system',
        noticeTone: 'error',
        content: 'Agent run stopped: provider unavailable'
      })
    ])
  })
})
