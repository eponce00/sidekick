import { describe, expect, it } from 'vitest'
import { messageTextForClipboard } from './messageClipboard'

describe('message clipboard text', () => {
  it('copies visible text and artifact code in message order', () => {
    expect(
      messageTextForClipboard({
        id: 'agent-1',
        role: 'agent',
        content: 'Fallback',
        timestamp: 1,
        segments: [
          { type: 'text', content: 'Here it is.' },
          {
            type: 'artifact',
            artifact: { type: 'html', title: 'Demo', code: '<main>Hello</main>' }
          }
        ]
      })
    ).toBe('Here it is.\n\n```html\n<main>Hello</main>\n```')
  })

  it('falls back to message content when segments contain only tool activity', () => {
    expect(
      messageTextForClipboard({
        id: 'agent-1',
        role: 'agent',
        content: 'The operation failed.',
        timestamp: 1,
        segments: [
          {
            type: 'tool',
            tool: { id: 'tool-1', title: 'Writing file', command: 'write', status: 'error' }
          }
        ]
      })
    ).toBe('The operation failed.')
  })
})
