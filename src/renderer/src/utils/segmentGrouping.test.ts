import { describe, expect, it } from 'vitest'
import type { ContentSegment } from '../types/chat.types'
import { chunkGroupsChronologically, finalAnswerText, groupSegments } from './segmentGrouping'

describe('groupSegments', () => {
  it('preserves the chronological order of interleaved thinking and tools', () => {
    const segments: ContentSegment[] = [
      { type: 'thinking', content: 'First thought' },
      {
        type: 'tool',
        tool: { id: 'tool-1', title: 'First tool', command: 'read', status: 'success' }
      },
      { type: 'thinking', content: 'Second thought' },
      {
        type: 'tool',
        tool: { id: 'tool-2', title: 'Second tool', command: 'write', status: 'success' }
      }
    ]

    expect(groupSegments(segments)).toEqual([{ type: 'actions', segments }])
  })

  it('uses a visible history marker as a hard boundary between work disclosures', () => {
    const segments: ContentSegment[] = [
      {
        type: 'tool',
        tool: { id: 'before', title: 'Before compaction', command: 'read', status: 'success' }
      },
      {
        type: 'summary',
        content: '<historical_context>handoff</historical_context>',
        summary: { originalTokens: 10_000, newTokens: 1_000, messagesCompacted: 12 }
      },
      {
        type: 'tool',
        tool: { id: 'after', title: 'After compaction', command: 'write', status: 'success' }
      }
    ]
    const groups = groupSegments(segments)
    const blocks = chunkGroupsChronologically(groups, (group) => group.type === 'actions')

    expect(blocks.map(({ type }) => type)).toEqual(['work', 'content', 'work'])
    expect(blocks[1]).toMatchObject({
      type: 'content',
      group: { type: 'content', segment: { type: 'summary' } },
      groupIndex: 1
    })
  })
})

describe('finalAnswerText', () => {
  it('is the text after the last step of work, not the narration between steps', () => {
    const segments: ContentSegment[] = [
      { type: 'thinking', content: 'Plan the change.' },
      { type: 'text', content: 'Scrolling works; trying the click again.' },
      { type: 'tool', tool: { id: 't1', title: 'Click', command: '', status: 'success' } },
      { type: 'text', content: 'The button now works.' },
      { type: 'text', content: 'Tests pass.' }
    ]
    expect(finalAnswerText({ content: 'everything', segments })).toBe(
      'The button now works.\n\nTests pass.'
    )
  })

  it('is the whole reply when there was no work', () => {
    expect(finalAnswerText({ content: 'Hello.' })).toBe('Hello.')
    expect(finalAnswerText({ content: 'Hi', segments: [{ type: 'text', content: 'Hi' }] })).toBe(
      'Hi'
    )
  })
})
