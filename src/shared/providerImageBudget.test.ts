import { describe, expect, it } from 'vitest'
import { countTranscriptImages, enforceImageBudget } from './providerImageBudget'
import type { ProviderChatMessage } from './providerRuntime'

const shot = (name: string) =>
  ({
    type: 'image',
    mimeType: 'image/png',
    source: { type: 'data_url', dataUrl: `data:${name}` },
    name
  }) as const

describe('enforceImageBudget', () => {
  it('keeps the newest images and tells the model what was dropped', () => {
    const messages: ProviderChatMessage[] = [
      { role: 'user', content: 'Look', images: ['data:u1', 'data:u2'] },
      { role: 'tool', tool_call_id: 'a', content: 'shot 1', media: [shot('s1')] },
      { role: 'tool', tool_call_id: 'b', content: 'shot 2', media: [shot('s2')] },
      { role: 'tool', tool_call_id: 'c', content: 'shot 3', media: [shot('s3')] }
    ]
    const { messages: pruned, removed } = enforceImageBudget(messages, 2)

    expect(removed).toBe(3)
    expect(countTranscriptImages(pruned)).toBe(2)
    expect(pruned[3].media?.map((m) => m.name)).toEqual(['s3'])
    expect(pruned[2].media?.map((m) => m.name)).toEqual(['s2'])
    expect(pruned[1].media).toBeUndefined()
    expect(pruned[1].content).toContain('1 earlier image omitted')
    expect(pruned[0].images).toBeUndefined()
    expect(pruned[0].content).toContain('2 earlier images omitted')
  })

  it('leaves a transcript within budget untouched', () => {
    const messages: ProviderChatMessage[] = [
      { role: 'tool', tool_call_id: 'a', content: 'shot', media: [shot('s1')] }
    ]
    const result = enforceImageBudget(messages, 4)
    expect(result.removed).toBe(0)
    expect(result.messages).toEqual(messages)
  })

  it('splits the budget inside one message, keeping its latest images', () => {
    const messages: ProviderChatMessage[] = [
      {
        role: 'tool',
        tool_call_id: 'a',
        content: 'page',
        media: [shot('old'), shot('mid'), shot('new')]
      }
    ]
    const { messages: pruned, removed } = enforceImageBudget(messages, 1)
    expect(removed).toBe(2)
    expect(pruned[0].media?.map((m) => m.name)).toEqual(['new'])
  })

  it('does not mutate the input transcript', () => {
    const messages: ProviderChatMessage[] = [
      { role: 'tool', tool_call_id: 'a', content: 'shot', media: [shot('s1'), shot('s2')] }
    ]
    enforceImageBudget(messages, 1)
    expect(messages[0].media).toHaveLength(2)
  })
})
