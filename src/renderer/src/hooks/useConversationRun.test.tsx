// @vitest-environment jsdom

import { act, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentRunChangedEvent,
  StartConversationAgentRunInput
} from '../../../shared/agentRunApi'
import type { AgentRunEvent } from '../../../shared/agentRuntime'
import type { Message } from '../types/chat.types'
import { useConversationRun } from './useConversationRun'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Controller = ReturnType<typeof useConversationRun>

function runEvent(
  sequence: number,
  type: AgentRunEvent['type'],
  payload: Record<string, unknown>
): AgentRunEvent {
  return { id: `event-${sequence}`, runId: 'run-1', sequence, type, payload, timestamp: sequence }
}

const model = {
  id: 'ollama:test',
  name: 'test',
  provider: 'ollama' as const
}

describe('useConversationRun', () => {
  let container: HTMLDivElement
  let root: Root
  let controller: Controller
  let renderedMessages: Message[]
  let listener: ((change: AgentRunChangedEvent) => void) | null

  function Harness(): null {
    const [messages, setMessages] = useState<Message[]>([
      { id: 'assistant-1', role: 'agent', content: '', timestamp: 1 }
    ])
    const messagesRef = useRef(messages)
    useEffect(() => {
      messagesRef.current = messages
    }, [messages])
    const value = useConversationRun({
      conversationId: null,
      messagesRef,
      skipNextLoadRef: { current: false },
      setMessages,
      setInputValue: vi.fn(),
      onConversationCreated: vi.fn()
    })
    useEffect(() => {
      controller = value
      renderedMessages = messages
    }, [messages, value])
    return null
  }

  beforeEach(async () => {
    container = document.createElement('div')
    root = createRoot(container)
    listener = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        agentRuns: {
          startConversation: vi.fn(async (input: StartConversationAgentRunInput) => ({
            run: {
              id: input.id,
              threadId: input.conversationId,
              surface: input.mode === 'research' ? 'research' : 'conversation',
              phase: 'streaming',
              provider: input.model.provider,
              model: input.model.name,
              lastSequence: 0,
              startedAt: 1,
              updatedAt: 1
            }
          })),
          events: vi.fn(async () => ({ run: null, events: [], pendingInteractions: [] })),
          latest: vi.fn(async () => ({ run: null, events: [], pendingInteractions: [] })),
          stop: vi.fn(async () => ({ stopped: true })),
          resolveInteraction: vi.fn(async () => ({ success: true })),
          onEvent: (callback: (change: AgentRunChangedEvent) => void) => {
            listener = callback
            return () => {
              listener = null
            }
          }
        }
      }
    })
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it('projects durable events and waits for persistence finalization', async () => {
    const input: StartConversationAgentRunInput = {
      id: 'run-1',
      conversationId: 'conversation-1',
      assistantMessageId: 'assistant-1',
      model
    }
    let completion!: Promise<void>
    await act(async () => {
      completion = controller.startRun(input)
      await Promise.resolve()
    })
    expect(controller.activeMode).toBe('conversation')
    await act(async () => {
      listener?.({ event: runEvent(1, 'assistant.delta', { content: 'Hello' }) })
      listener?.({ event: runEvent(2, 'assistant.completed', { content: 'Hello', toolCalls: [] }) })
      listener?.({ event: runEvent(3, 'run.completed', { phase: 'completed' }) })
    })

    expect(controller.isLoading).toBe(true)
    expect(renderedMessages[0].content).toBe('Hello')

    await act(async () => {
      listener?.({ event: runEvent(4, 'run.finalized', { persisted: true }) })
      await completion
    })
    let pending: ReturnType<Controller['finishRun']> = null
    act(() => {
      pending = controller.finishRun()
    })
    expect(pending).toBeNull()
    expect(controller.isLoading).toBe(false)
  })

  it('retains queued messages until the finalized run is consumed', async () => {
    const input: StartConversationAgentRunInput = {
      id: 'run-1',
      conversationId: 'conversation-1',
      assistantMessageId: 'assistant-1',
      model
    }
    let completion!: Promise<void>
    await act(async () => {
      completion = controller.startRun(input)
      await Promise.resolve()
      controller.submitDuringRun('first follow-up', 'research')
      controller.submitDuringRun('second follow-up')
    })
    await act(async () => {
      listener?.({ event: runEvent(1, 'run.completed', { phase: 'completed' }) })
      listener?.({ event: runEvent(2, 'run.finalized', { persisted: true }) })
      await completion
    })

    let pending: ReturnType<Controller['finishRun']> = null
    act(() => {
      pending = controller.finishRun()
    })
    expect(pending).toEqual({ content: 'first follow-up', kind: 'queued', mode: 'research' })
    expect(controller.queuedMessages.map(({ content }) => content)).toEqual(['second follow-up'])
  })

  it('edits, reorders, removes, and promotes queued messages without losing their identity', async () => {
    const input: StartConversationAgentRunInput = {
      id: 'run-1',
      conversationId: 'conversation-1',
      assistantMessageId: 'assistant-1',
      model
    }
    await act(async () => {
      void controller.startRun(input)
      await Promise.resolve()
      controller.submitDuringRun('first')
      controller.submitDuringRun('second')
      controller.submitDuringRun('third', 'plan')
    })

    const [first, second, third] = controller.queuedMessages
    act(() => {
      controller.moveQueuedMessage(third.id, 0)
      controller.updatePendingMessage(second.id, 'second, revised')
      controller.removePendingMessage(first.id)
    })

    expect(controller.queuedMessages.map(({ id, content }) => ({ id, content }))).toEqual([
      { id: third.id, content: 'third' },
      { id: second.id, content: 'second, revised' }
    ])

    await act(async () => {
      expect(controller.steerQueuedMessage(second.id)).toBe(true)
      await Promise.resolve()
    })

    expect(controller.pivotMessage).toMatchObject({ id: second.id, content: 'second, revised' })
    expect(controller.queuedMessages.map(({ id }) => id)).toEqual([third.id])
    expect(window.api.agentRuns.stop).toHaveBeenCalledWith('run-1')
  })
})
