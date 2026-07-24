import { describe, expect, it } from 'vitest'
import { validateProviderTranscript } from './providerTranscript'

describe('validateProviderTranscript', () => {
  it('coalesces system instructions into the first provider message', () => {
    const result = validateProviderTranscript([
      { role: 'system', content: 'Core policy' },
      { role: 'system', content: 'Collaboration policy' },
      { role: 'user', content: 'Build it' }
    ])

    expect(result.messages).toEqual([
      { role: 'system', content: 'Core policy\n\nCollaboration policy' },
      { role: 'user', content: 'Build it' }
    ])
    expect(result.repairs[0]?.kind).toBe('coalesced_system_messages')
  })

  it('moves a late system instruction to the beginning', () => {
    const result = validateProviderTranscript([
      { role: 'user', content: 'Earlier input' },
      { role: 'system', content: 'Trusted policy' },
      { role: 'assistant', content: 'Response' }
    ])

    expect(result.messages.map(({ role }) => role)).toEqual(['system', 'user', 'assistant'])
    expect(result.repairs[0]?.kind).toBe('moved_system_message')
  })

  it('fills interrupted tool results before the next conversation message', () => {
    const result = validateProviderTranscript([
      { role: 'user', content: 'Inspect it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', function: { name: 'read_workspace_file', arguments: '{}' } }]
      },
      { role: 'user', content: 'What happened?' }
    ])

    expect(result.messages.map(({ role }) => role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(result.messages[2].tool_call_id).toBe('call-1')
    expect(result.messages[2].content).toContain('interrupted')
  })

  it('drops orphan and duplicate results deterministically', () => {
    const result = validateProviderTranscript([
      { role: 'tool', tool_call_id: 'orphan', content: 'bad' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', function: { name: 'wait', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'first' },
      { role: 'tool', tool_call_id: 'call-1', content: 'duplicate' }
    ])

    expect(result.messages).toHaveLength(2)
    expect(result.messages[1].content).toBe('first')
    expect(result.repairs.map(({ kind }) => kind)).toEqual([
      'dropped_orphan_tool_result',
      'dropped_duplicate_tool_result'
    ])
  })

  it('assigns stable IDs when a provider transcript lacks them', () => {
    const result = validateProviderTranscript([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ index: 2, function: { name: 'wait', arguments: { seconds: 1 } } }]
      },
      { role: 'tool', tool_call_id: 'tool_call_0_2', content: 'done' }
    ])
    expect(result.messages[0].tool_calls?.[0].id).toBe('tool_call_0_2')
    expect(result.repairs).toEqual([
      { kind: 'assigned_tool_call_id', toolCallId: 'tool_call_0_2', messageIndex: 0 }
    ])
  })
})
