import { describe, expect, it } from 'vitest'
import type { CollaborationAgentSessionMessage } from '../../../shared/collaboration'
import { estimateVisibleMessageTokens } from './messageFormatting'
import { groupAgentContextTokens } from './groupAgentContext'

function message(
  overrides: Partial<CollaborationAgentSessionMessage>
): CollaborationAgentSessionMessage {
  return {
    id: crypto.randomUUID(),
    sessionId: 'session',
    missionId: 'mission',
    role: 'user',
    kind: 'shared_event',
    presentation: 'internal',
    content: '',
    toolCalls: [],
    toolCallId: null,
    metadata: {},
    createdAt: 1,
    ...overrides
  }
}

describe('groupAgentContextTokens', () => {
  it('uses the latest authoritative provider count and includes newer transcript records', () => {
    const followUp = 'Please also verify the responsive layout.'
    const records = [
      message({ content: 'Build the dashboard' }),
      message({
        role: 'assistant',
        kind: 'assistant',
        presentation: 'conversation',
        content: 'Starting now.',
        metadata: {
          usage: { promptTokens: 1_200, completionTokens: 80, doneReason: 'tool_calls' }
        }
      }),
      message({ content: followUp, createdAt: 2 })
    ]

    expect(groupAgentContextTokens(records)).toBe(1_280 + estimateVisibleMessageTokens(followUp))
  })

  it('prefers the newest run usage instead of summing the durable cross-mission transcript', () => {
    const records = [
      ...Array.from({ length: 300 }, (_, index) =>
        message({
          content: `Historical tool output ${index} ${'x'.repeat(1_000)}`,
          createdAt: index
        })
      ),
      message({
        role: 'assistant',
        kind: 'assistant',
        presentation: 'conversation',
        content: 'Continuing with the current run.',
        metadata: { usage: { promptTokens: 55_052, completionTokens: 75 } },
        createdAt: 301
      }),
      message({
        role: 'tool',
        kind: 'tool_result',
        presentation: 'conversation',
        content: 'Current tool result',
        createdAt: 302
      })
    ]

    expect(groupAgentContextTokens(records)).toBe(
      55_127 + estimateVisibleMessageTokens('Current tool result')
    )
  })

  it('still reads legacy top-level usage records', () => {
    const records = [
      message({
        role: 'assistant',
        kind: 'assistant',
        presentation: 'conversation',
        metadata: { promptTokens: 900, completionTokens: 40 }
      })
    ]

    expect(groupAgentContextTokens(records)).toBe(940)
  })

  it('falls back to visible content when a provider reports an empty usage envelope', () => {
    const user = 'First request'
    const assistant = 'First response'
    const records = [
      message({ content: user }),
      message({
        role: 'assistant',
        kind: 'assistant',
        presentation: 'conversation',
        content: assistant,
        metadata: { usage: { promptTokens: 0, completionTokens: 0 } }
      })
    ]

    expect(groupAgentContextTokens(records)).toBe(
      estimateVisibleMessageTokens(user) + estimateVisibleMessageTokens(assistant)
    )
  })

  it('estimates old session records while excluding UI-only system notices', () => {
    const user = 'Build the dashboard'
    const assistant = 'I will start with the data model.'
    const records = [
      message({ content: user }),
      message({
        role: 'assistant',
        kind: 'assistant',
        presentation: 'conversation',
        content: assistant
      }),
      message({
        role: 'system',
        kind: 'system',
        presentation: 'history',
        content: 'Saved project files to history.'
      })
    ]

    expect(groupAgentContextTokens(records)).toBe(
      estimateVisibleMessageTokens(user) + estimateVisibleMessageTokens(assistant)
    )
  })
})
