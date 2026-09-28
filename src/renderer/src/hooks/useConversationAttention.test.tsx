// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationAttentionState } from '../../../shared/conversationAttention'
import { useConversationAttention } from './useConversationAttention'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let listener: ((state: ConversationAttentionState) => void) | null = null
let resolveInitial: (state: ConversationAttentionState) => void = () => undefined
const probe: { latest: ReadonlySet<string> } = { latest: new Set() }
let root: Root | null = null
let container: HTMLDivElement | null = null

function Probe({ onAlert }: { onAlert: (alert: unknown) => void }): null {
  const waiting = useConversationAttention(onAlert)
  useEffect(() => {
    probe.latest = waiting
  }, [waiting])
  return null
}

beforeEach(() => {
  listener = null
  probe.latest = new Set()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      agentRuns: {
        attention: vi.fn(
          () =>
            new Promise<ConversationAttentionState>((resolve) => {
              resolveInitial = resolve
            })
        ),
        onAttention: vi.fn((callback: (state: ConversationAttentionState) => void) => {
          listener = callback
          return () => {
            listener = null
          }
        })
      }
    }
  })
  container = document.createElement('div')
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container = null
})

describe('useConversationAttention', () => {
  it('loads the waiting conversations and follows changes, passing alerts on', async () => {
    const onAlert = vi.fn()
    act(() => root!.render(<Probe onAlert={onAlert} />))
    await act(async () => resolveInitial({ waitingConversationIds: ['a'] }))
    expect([...probe.latest]).toEqual(['a'])

    act(() =>
      listener?.({
        waitingConversationIds: ['a', 'b'],
        alert: { conversationId: 'b', reason: 'question' }
      })
    )
    expect([...probe.latest]).toEqual(['a', 'b'])
    expect(onAlert).toHaveBeenCalledWith({ conversationId: 'b', reason: 'question' })
  })

  it('keeps a live change over an initial read that answers later', async () => {
    act(() => root!.render(<Probe onAlert={vi.fn()} />))
    act(() => listener?.({ waitingConversationIds: [] }))
    await act(async () => resolveInitial({ waitingConversationIds: ['stale'] }))
    expect([...probe.latest]).toEqual([])
  })

  it('stops listening when unmounted', () => {
    act(() => root!.render(<Probe onAlert={vi.fn()} />))
    expect(listener).not.toBeNull()
    act(() => root!.unmount())
    root = null
    expect(listener).toBeNull()
  })
})
