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
  let deleteMessagesAfter: ReturnType<typeof vi.fn>
  let onCostUpdate: ReturnType<typeof vi.fn<(cost: number) => void>>
  let onRollbackConsumed: ReturnType<typeof vi.fn<() => void>>

  function Harness({ rollbackHash }: { rollbackHash?: string }): null {
    const value = useConversationMessages({
      conversationId: 'conversation-1',
      rollbackHash,
      onCostUpdate,
      onRollbackConsumed
    })
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
        checkpointHash: 'checkpoint-1',
        tokenUsage: { promptTokens: 1, completionTokens: 1, cost: 0.02 }
      },
      { id: 'three', role: 'user', content: 'Later', timestamp: 3 }
    ])
    deleteMessagesAfter = vi.fn(async () => undefined)
    onCostUpdate = vi.fn()
    onRollbackConsumed = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { conversations: { getMessages, deleteMessagesAfter } }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
  })

  async function render(rollbackHash?: string): Promise<void> {
    await act(async () => {
      root.render(<Harness rollbackHash={rollbackHash} />)
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

  it('truncates once at a requested checkpoint', async () => {
    await render('checkpoint-1')
    expect(controller.messages.map((message) => message.id)).toEqual(['one', 'two'])
    expect(deleteMessagesAfter).toHaveBeenCalledWith('conversation-1', 2)
    expect(onRollbackConsumed).toHaveBeenCalledOnce()

    await render('checkpoint-1')
    expect(deleteMessagesAfter).toHaveBeenCalledOnce()
  })
})
