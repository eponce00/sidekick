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
  const rewindToBeforeCheckpoint = vi.fn(async () => ({ ok: true, parentHash: null }))
  const authorize = vi.fn(async () => ({ approved: true, token: 'undo-token' }))

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

  let latestMessages: Message[] = []

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
    useEffect(() => {
      latestMessages = messages
    }, [messages])
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
        },
        permissions: { authorize },
        workspace: {
          rewindToBeforeCheckpoint
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
      expect(rerunStream).toHaveBeenCalledWith([researchRequest], 'conversation-1', 'research', {
        discardsGoalStart: false
      })
    })
    expect(deleteMessagesAfter).toHaveBeenCalledWith('conversation-1', 1)
  })

  it('starts one reply for a double-clicked retry', async () => {
    // The second start was refused and took the first reply down with it.
    act(() => {
      controller.retryMessage(researchResponse)
      controller.retryMessage(researchResponse)
    })

    await vi.waitFor(() => expect(rerunStream).toHaveBeenCalledTimes(1))
    expect(deleteMessagesAfter).toHaveBeenCalledTimes(1)
  })

  it('does not answer on top of history it failed to truncate', async () => {
    deleteMessagesAfter.mockRejectedValueOnce(new Error('database is locked'))

    act(() => controller.retryMessage(researchResponse))

    await vi.waitFor(() => expect(deleteMessagesAfter).toHaveBeenCalled())
    // Replying here would interleave the stale response with the new one the
    // next time this conversation is loaded from the database.
    expect(rerunStream).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(latestMessages.at(-1)).toMatchObject({ role: 'agent', noticeTone: 'error' })
    )
    expect(latestMessages.at(-1)?.content).toContain('database is locked')
  })

  it('undoes the changes owned by the response instead of restoring its after-state', async () => {
    await act(async () => root.unmount())
    function WorkspaceHarness(): null {
      const [messages, setMessages] = useState<Message[]>([
        researchRequest,
        {
          ...researchResponse,
          checkpointHash: 'abcdef123456',
          checkpointWorkspaceRoot: 'C:\\project'
        }
      ])
      const value = useConversationActions({
        messages,
        setMessages,
        conversationId: 'conversation-1',
        selectedModel: 'model-1',
        workspaceFolder: 'C:\\project',
        rerunStream
      })
      useEffect(() => {
        controller = value
      }, [value])
      return null
    }
    root = createRoot(container)
    await act(async () => root.render(<WorkspaceHarness />))
    act(() => controller.requestCheckpointRestore('abcdef123456'))
    await act(async () => controller.confirmCheckpointRestore())

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'checkpoint', requestedAccess: 'auto' })
    )
    expect(rewindToBeforeCheckpoint).toHaveBeenCalledWith('C:\\project', 'abcdef123456', {
      requestedAccess: 'auto',
      authorizationToken: 'undo-token'
    })
  })

  it.each([true, false])(
    'rewinds to before a message without answering, back into the message box (files: %s)',
    async (restoreFiles) => {
      await act(async () => root.unmount())
      rewindToBeforeCheckpoint.mockClear()
      const restoreDraft = vi.fn()
      function RewindHarness(): null {
        const [messages, setMessages] = useState<Message[]>([
          researchRequest,
          {
            ...researchResponse,
            checkpointHash: 'abcdef123456',
            checkpointWorkspaceRoot: 'C:\\project'
          }
        ])
        const value = useConversationActions({
          messages,
          setMessages,
          conversationId: 'conversation-1',
          selectedModel: 'model-1',
          workspaceFolder: 'C:\\project',
          rerunStream,
          restoreDraft
        })
        useEffect(() => {
          controller = value
        }, [value])
        useEffect(() => {
          latestMessages = messages
        }, [messages])
        return null
      }
      root = createRoot(container)
      await act(async () => root.render(<RewindHarness />))

      await act(async () => controller.rewindToMessage(researchRequest, restoreFiles))

      // The message itself leaves the chat along with everything after it.
      expect(deleteMessagesAfter).toHaveBeenCalledWith('conversation-1', 0)
      expect(latestMessages).toEqual([])
      expect(restoreDraft).toHaveBeenCalledWith(researchRequest, false)
      expect(rerunStream).not.toHaveBeenCalled()
      expect(rewindToBeforeCheckpoint).toHaveBeenCalledTimes(restoreFiles ? 1 : 0)
    }
  )
})

describe('useConversationActions with a persistent goal', () => {
  // A goal is conversation state, not a mode stored on the message, so a retry
  // used to replay the goal's first message as an ordinary one.
  const greeting: Message = { id: 'user-0', role: 'user', content: 'Hi', timestamp: 1 }
  const greetingReply: Message = { id: 'agent-0', role: 'agent', content: 'Hello', timestamp: 2 }
  const goalStart: Message = {
    id: 'user-1',
    role: 'user',
    content: 'Build a weather card for Reno',
    timestamp: 3,
    startsGoal: true
  }
  const goalReply: Message = { id: 'agent-1', role: 'agent', content: 'Done', timestamp: 4 }

  let container: HTMLDivElement
  let root: Root
  let controller: ReturnType<typeof useConversationActions>
  const rerunStream = vi.fn(async () => undefined)

  function Harness(): null {
    const [messages, setMessages] = useState<Message[]>([
      greeting,
      greetingReply,
      goalStart,
      goalReply
    ])
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
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        conversations: {
          deleteMessagesAfter: vi.fn(async () => ({ success: true })),
          updateMessage: vi.fn(async () => ({ success: true }))
        }
      }
    })
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it('starts the goal again when its first message is retried', async () => {
    act(() => controller.retryMessage(goalReply))

    await vi.waitFor(() =>
      expect(rerunStream).toHaveBeenCalledWith(
        [greeting, greetingReply, goalStart],
        'conversation-1',
        'conversation',
        { restartObjective: 'Build a weather card for Reno', discardsGoalStart: false }
      )
    )
  })

  it('starts the goal with the edited objective when its first message is edited', async () => {
    const click = {
      currentTarget: { closest: () => null }
    } as unknown as React.MouseEvent<HTMLButtonElement>
    act(() => controller.startEditMessage(goalStart, click))
    act(() =>
      controller.submitEdit({
        content: 'Build a weather card for Tahoe',
        images: [],
        attachments: [],
        runMode: 'conversation',
        startsGoal: true
      })
    )

    await vi.waitFor(() =>
      expect(rerunStream).toHaveBeenCalledWith(
        expect.any(Array),
        'conversation-1',
        'conversation',
        { restartObjective: 'Build a weather card for Tahoe', discardsGoalStart: false }
      )
    )
  })

  it('reports a goal whose first message a rewind discards', async () => {
    act(() => controller.retryMessage(greetingReply))

    await vi.waitFor(() =>
      expect(rerunStream).toHaveBeenCalledWith([greeting], 'conversation-1', 'conversation', {
        discardsGoalStart: true
      })
    )
  })
})

describe('useConversationActions editing', () => {
  const message: Message = { id: 'user-0', role: 'user', content: 'Hi', timestamp: 1 }

  function Harness({
    beginEdit,
    onReady
  }: {
    beginEdit: (message: Message) => void
    onReady: (value: ReturnType<typeof useConversationActions>) => void
  }): null {
    const [messages, setMessages] = useState<Message[]>([message])
    const value = useConversationActions({
      messages,
      setMessages,
      conversationId: 'conversation-1',
      selectedModel: 'model-1',
      workspaceFolder: null,
      rerunStream: vi.fn(async () => undefined),
      beginEdit
    })
    useEffect(() => onReady(value), [onReady, value])
    return null
  }

  it('reaches the current composer from an Edit button rendered earlier', async () => {
    const root = createRoot(document.createElement('div'))
    const first: Array<ReturnType<typeof useConversationActions>> = []
    const keepFirst = (value: ReturnType<typeof useConversationActions>): void => {
      if (!first.length) first.push(value)
    }
    const stale = vi.fn()
    const current = vi.fn()
    await act(async () => root.render(<Harness beginEdit={stale} onReady={keepFirst} />))
    await act(async () => root.render(<Harness beginEdit={current} onReady={keepFirst} />))

    const click = {
      currentTarget: { closest: () => null }
    } as unknown as React.MouseEvent<HTMLButtonElement>
    act(() => first[0].startEditMessage(message, click))

    expect(current).toHaveBeenCalledWith(message, null)
    expect(stale).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })
})

describe('useConversationActions leaving messages', () => {
  const question: Message = { id: 'user-0', role: 'user', content: 'Hi', timestamp: 1 }
  const answer: Message = { id: 'agent-0', role: 'agent', content: 'Hello', timestamp: 2 }

  let root: Root
  let controller: ReturnType<typeof useConversationActions>
  let latestMessages: Message[] = []
  let finishLeaving: () => void = () => undefined
  const beforeMessagesLeave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishLeaving = resolve
      })
  )
  const rerunStream = vi.fn(async () => undefined)
  const restoreDraft = vi.fn()

  function Harness(): null {
    const [messages, setMessages] = useState<Message[]>([question, answer])
    const value = useConversationActions({
      messages,
      setMessages,
      conversationId: 'conversation-1',
      selectedModel: 'model-1',
      workspaceFolder: null,
      rerunStream,
      restoreDraft,
      beforeMessagesLeave
    })
    useEffect(() => {
      controller = value
      latestMessages = messages
    }, [messages, value])
    return null
  }

  beforeEach(async () => {
    root = createRoot(document.createElement('div'))
    beforeMessagesLeave.mockClear()
    rerunStream.mockClear()
    restoreDraft.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        conversations: {
          deleteMessagesAfter: vi.fn(async () => ({ success: true })),
          updateMessage: vi.fn(async () => ({ success: true }))
        }
      }
    })
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it('lets the replaced reply leave before answering again', async () => {
    act(() => controller.retryMessage(answer))

    await vi.waitFor(() => expect(beforeMessagesLeave).toHaveBeenCalledWith(question, 'retry'))
    expect(rerunStream).not.toHaveBeenCalled()

    await act(async () => finishLeaving())
    await vi.waitFor(() => expect(rerunStream).toHaveBeenCalled())
  })

  it('keeps an edited message stepped back until what it replaces has left', async () => {
    const click = {
      currentTarget: { closest: () => null }
    } as unknown as React.MouseEvent<HTMLButtonElement>
    act(() => controller.startEditMessage(question, click))
    act(() =>
      controller.submitEdit({
        content: 'Hello there',
        images: [],
        attachments: [],
        runMode: 'conversation',
        startsGoal: false
      })
    )

    expect(controller.editingMessageId).toBeNull()
    expect(controller.steppedBackFromId).toBe(question.id)
    await vi.waitFor(() => expect(beforeMessagesLeave).toHaveBeenCalledWith(question, 'edit'))
    expect(controller.steppedBackFromId).toBe(question.id)

    await act(async () => finishLeaving())
    await vi.waitFor(() => expect(controller.steppedBackFromId).toBeNull())
    expect(rerunStream).toHaveBeenCalled()
  })

  it('returns a rewound message to the box while it and its reply leave', async () => {
    const rewinding = controller.rewindToMessage(question, false)

    await vi.waitFor(() => expect(beforeMessagesLeave).toHaveBeenCalledWith(question, 'rewind'))
    await vi.waitFor(() => expect(restoreDraft).toHaveBeenCalledWith(question, false))
    expect(latestMessages).toHaveLength(2)

    await act(async () => {
      finishLeaving()
      await rewinding
    })
    expect(latestMessages).toEqual([])
  })
})
