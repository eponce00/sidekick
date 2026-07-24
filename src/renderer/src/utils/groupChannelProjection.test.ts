import { describe, expect, it } from 'vitest'
import type {
  CollaborationEvent,
  CollaborationEventKind,
  CollaborationParticipant
} from '../../../shared/collaboration'
import { projectGroupChannelMessages, visibleGroupChannelEvents } from './groupChannelProjection'

function event(kind: CollaborationEventKind): CollaborationEvent {
  return {
    id: kind,
    groupId: 'group',
    missionId: 'mission',
    seq: 1,
    actorType: kind === 'user_message' ? 'user' : 'agent',
    actorParticipantId: kind === 'user_message' ? null : 'participant',
    kind,
    payload: { text: kind },
    replyToEventId: null,
    createdAt: 1
  }
}

describe('group channel projection', () => {
  it('keeps the public channel message-only', () => {
    const projected = visibleGroupChannelEvents([
      event('user_message'),
      event('tool_call'),
      event('tool_result'),
      event('agent_activity'),
      event('peer_message'),
      event('agent_message'),
      event('mission_status')
    ])

    expect(projected.map(({ kind }) => kind)).toEqual([
      'user_message',
      'peer_message',
      'agent_message'
    ])
  })

  it('hides artifact transport envelopes while preserving useful agent messages', () => {
    const transport = event('peer_message')
    transport.payload = {
      text: 'Shared Cuba data (artifact artifact-id)',
      metadata: {
        audience: 'everyone',
        messageType: 'request',
        artifactId: 'artifact-id',
        transportOnly: true
      }
    }
    const update = event('peer_message')
    update.id = 'useful-update'
    update.payload = { text: 'The demographic datasets are ready for integration.' }

    expect(visibleGroupChannelEvents([transport, update]).map(({ id }) => id)).toEqual([
      'useful-update'
    ])
  })

  it('projects channel events through the normal chat message model with author context', () => {
    const participants = [
      {
        id: 'participant',
        label: 'Data agent',
        projectName: 'Data',
        status: 'active'
      } as CollaborationParticipant
    ]
    const userEvent = event('user_message')
    userEvent.payload.targetParticipantIds = ['participant']
    const agentEvent = event('peer_message')
    agentEvent.payload.metadata = {
      audience: 'human',
      usage: { promptTokens: 100, completionTokens: 20, tokensPerSecond: 36.5 }
    }

    expect(projectGroupChannelMessages([userEvent, agentEvent], participants)).toEqual([
      expect.objectContaining({
        id: 'user_message',
        role: 'user',
        senderLabel: 'You',
        senderContext: 'to everyone'
      }),
      expect.objectContaining({
        id: 'peer_message',
        role: 'agent',
        senderLabel: 'Data agent',
        senderContext: 'Data · to you',
        tokenUsage: { promptTokens: 100, completionTokens: 20, tokensPerSecond: 36.5 }
      })
    ])
  })

  it('turns legacy @User text into a human attention label instead of a fake participant', () => {
    const participants = [
      {
        id: 'participant',
        label: 'Data agent',
        projectName: 'Data',
        status: 'active'
      } as CollaborationParticipant
    ]
    const agentEvent = event('peer_message')
    agentEvent.payload = {
      text: '@User — please verify the chart contrast.',
      metadata: { audience: 'everyone', messageType: 'request', humanAttention: true }
    }

    expect(projectGroupChannelMessages([agentEvent], participants)).toEqual([
      expect.objectContaining({
        content: 'You — please verify the chart contrast.',
        senderContext: 'Data · to everyone · needs your input'
      })
    ])
  })
})
