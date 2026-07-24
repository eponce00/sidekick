// @vitest-environment jsdom

import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../types/chat.types'
import { useConversationActions } from './useConversationActions'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('useConversationActions', () => {
  let container: HTMLDivElement
  let root: Root
  let controller: ReturnType<typeof useConversationActions>
  const rerunStream = vi.fn(async () => undefined)
  const deleteMessagesAfter = vi.fn(async () => ({ success: true }))

  const researchRequest: Message = {
    id: 'user-1',
    role: 'user',
    content: 'Research this claim',
    timestamp: 1,
    runMode: 'research'
  }
  const researchResponse: Message = {
    id: 'assistant-1',
    role: 'agent',
    content: 'Report',
    timestamp: 2,
    runMode: 'research'
  }

  function Harness(): null {
    const [messages, setMessages] = useState<Message[]>([researchRequest, researchResponse])
    const value = useConversationActions({
      messages,
      setMessages,
      conversationId: 'conversation-1',
      selectedModel: 'model-1',
      workspaceFolder: null,
      rerunStream
    })
    useEffect(() => {
      controller = value
    }, [value])
    return null
  }

  beforeEach(async () => {
    container = document.createElement('div')
    root = createRoot(container)
    rerunStream.mockClear()
    deleteMessagesAfter.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        conversations: {
          deleteMessagesAfter,
          updateMessage: vi.fn(async () => ({ success: true }))
        }
      }
    })
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it('retries with the durable mode of the original request', async () => {
    act(() => controller.retryMessage(researchResponse))

    await vi.waitFor(() => {
      expect(rerunStream).toHaveBeenCalledWith([researchRequest], 'conversation-1', 'research')
    })
    expect(deleteMessagesAfter).toHaveBeenCalledWith('conversation-1', 1)
  })
})
