import { describe, expect, it } from 'vitest'
import type { Message } from '../types/chat.types'
import { selectPromptRefinementHistory } from './promptRefinementHistory'

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return { timestamp: Number(overrides.id.replace(/\D/g, '')) || 1, ...overrides }
}

describe('selectPromptRefinementHistory', () => {
  it('keeps recent visible conversation text with useful speaker labels', () => {
    const result = selectPromptRefinementHistory([
      message({ id: '1', role: 'user', content: 'Build the initial dashboard.' }),
      message({
        id: '2',
        role: 'agent',
        peerLabel: 'Data agent',
        content: 'The official dataset is ready.'
      }),
      message({ id: '3', role: 'system', content: 'Saved project history.' }),
      message({
        id: '4',
        role: 'agent',
        content: '',
        segments: [
          {
            type: 'tool',
            tool: {
              id: 'tool',
              title: 'Read file',
              command: 'read',
              status: 'success',
              output: 'secret output'
            }
          }
        ]
      }),
      message({ id: '5', role: 'user', content: 'Now fix the map.' })
    ])

    expect(result).toEqual({
      historyTruncated: false,
      recentHistory: [
        expect.objectContaining({
          role: 'user',
          speaker: 'You',
          content: 'Build the initial dashboard.'
        }),
        expect.objectContaining({
          role: 'assistant',
          speaker: 'Data agent',
          content: 'The official dataset is ready.'
        }),
        expect.objectContaining({ role: 'user', speaker: 'You', content: 'Now fix the map.' })
      ]
    })
  })

  it('prioritizes the newest turns and reports when the excerpt is truncated', () => {
    const result = selectPromptRefinementHistory(
      [
        message({ id: '1', role: 'user', content: 'Old requirement' }),
        message({ id: '2', role: 'agent', content: 'Recent answer' }),
        message({ id: '3', role: 'user', content: 'Newest correction' })
      ],
      { maxMessages: 2, maxCharacters: 1_000 }
    )

    expect(result.historyTruncated).toBe(true)
    expect(result.recentHistory.map(({ content }) => content)).toEqual([
      'Recent answer',
      'Newest correction'
    ])
  })

  it('uses visible text segments but never includes raw tool output or thinking', () => {
    const result = selectPromptRefinementHistory([
      message({
        id: '1',
        role: 'agent',
        content: '',
        thinking: 'private reasoning',
        segments: [
          { type: 'thinking', content: 'private segment' },
          { type: 'text', content: 'Public conclusion' },
          {
            type: 'tool',
            tool: {
              id: 'tool',
              title: 'Fetch data',
              command: 'fetch',
              status: 'success',
              output: 'large raw result'
            }
          }
        ]
      })
    ])

    expect(result.recentHistory).toEqual([
      expect.objectContaining({ content: 'Public conclusion' })
    ])
    expect(JSON.stringify(result)).not.toContain('private')
    expect(JSON.stringify(result)).not.toContain('large raw result')
  })
})
