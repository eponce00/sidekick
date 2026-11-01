// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationMessages } from './useConversationMessages'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Controller = ReturnType<typeof useConversationMessages>

describe('useConversationMessages', () => {
  let root: Root
  let controller: Controller
  let getMessages: ReturnType<typeof vi.fn>
  let onCostUpdate: ReturnType<typeof vi.fn<(cost: number) => void>>
  let messagesChanged: ((conversationId: string) => void) | null

  function Harness(): null {
    const value = useConversationMessages({ conversationId: 'conversation-1', onCostUpdate })
    useEffect(() => {
      controller = value
    }, [value])
    return null
  }

  beforeEach(() => {
    root = createRoot(document.createElement('div'))
    getMessages = vi.fn(async () => [
      { id: 'one', role: 'user', content: 'Question', timestamp: 1 },
      {
        id: 'two',
        role: 'agent',
        content: 'Answer',
        timestamp: 2,
        checkpoints: [{ workspaceRoot: 'C:/project', hash: 'abcdef1' }],
        tokenUsage: { promptTokens: 1, completionTokens: 1, cost: 0.02 }
      },
      { id: 'three', role: 'user', content: 'Later', timestamp: 3 }
    ])
    onCostUpdate = vi.fn()
    messagesChanged = null
    const onMessagesChanged = (callback: (conversationId: string) => void): (() => void) => {
      messagesChanged = callback
      return () => {
        messagesChanged = null
      }
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { conversations: { getMessages, onMessagesChanged } }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
  })

  async function render(): Promise<void> {
    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
    })
  }

  it('loads messages, maintains the live ref, and aggregates cost', async () => {
    await render()
    expect(getMessages).toHaveBeenCalledWith('conversation-1')
    expect(controller.messages).toHaveLength(3)
    expect(controller.messagesRef.current).toHaveLength(3)
    expect(onCostUpdate).toHaveBeenLastCalledWith(0.02)
  })

  it('loads again when the phone adds a message, keeping a reply that is still running', async () => {
    await render()
    await act(async () => {
      controller.setMessages((previous) => [
        ...previous,
        { id: 'live', role: 'agent', content: 'Working', timestamp: 4, runId: 'run-1' }
      ])
    })
    getMessages.mockResolvedValueOnce([
      { id: 'one', role: 'user', content: 'Question', timestamp: 1 },
      { id: 'phone', role: 'user', content: 'From the phone', timestamp: 5 }
    ])
    await act(async () => {
      messagesChanged?.('another-conversation')
      messagesChanged?.('conversation-1')
      await Promise.resolve()
    })
    expect(getMessages).toHaveBeenCalledTimes(2)
    expect(controller.messages.map((message) => message.id)).toEqual(['one', 'phone', 'live'])
  })
})
