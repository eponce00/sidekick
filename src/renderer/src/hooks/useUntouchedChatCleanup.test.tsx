// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveComposerDraft } from '../services/composerDrafts'
import type { Conversation } from '../types/app.types'
import { useUntouchedChatCleanup } from './useUntouchedChatCleanup'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const chat = (id: string, title_source: Conversation['title_source']): Conversation =>
  ({ id, title: 'New Conversation', title_source }) as Conversation

describe('useUntouchedChatCleanup', () => {
  let root: Root
  const discardIfUntouched = vi.fn(async () => ({ discarded: true }))
  const onDiscarded = vi.fn()

  function Harness(props: {
    ready: boolean
    conversations: Conversation[]
    current: string | null
  }): null {
    useUntouchedChatCleanup({
      ready: props.ready,
      conversations: props.conversations,
      currentConversationId: props.current,
      onDiscarded
    })
    return null
  }

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    discardIfUntouched.mockClear()
    onDiscarded.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { conversations: { discardIfUntouched } }
    })
    root = createRoot(document.createElement('div'))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
  })

  const render = (current: string | null, conversations: Conversation[], ready = false) =>
    act(async () =>
      root.render(<Harness ready={ready} conversations={conversations} current={current} />)
    )

  it('removes a new chat left without anything in it', async () => {
    const chats = [chat('new', 'placeholder'), chat('old', 'generated')]
    await render('new', chats)
    await render('old', chats)
    expect(discardIfUntouched).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(discardIfUntouched).toHaveBeenCalledWith('new')
    expect(onDiscarded).toHaveBeenCalledWith('new')
  })

  it('keeps a new chat with something typed in its message box', async () => {
    const chats = [chat('new', 'placeholder'), chat('old', 'generated')]
    saveComposerDraft('new', { text: 'Half a thought', images: [], attachments: [] })
    await render('new', chats)
    await render('old', chats)
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(discardIfUntouched).not.toHaveBeenCalled()
  })

  it('leaves a chat that was named or used alone', async () => {
    const chats = [chat('used', 'generated'), chat('other', 'generated')]
    await render('used', chats)
    await render('other', chats)
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(discardIfUntouched).not.toHaveBeenCalled()
  })

  it('clears empty chats an earlier session left behind', async () => {
    await render(null, [chat('stale', 'placeholder'), chat('kept', 'generated')], true)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(discardIfUntouched).toHaveBeenCalledTimes(1)
    expect(discardIfUntouched).toHaveBeenCalledWith('stale')
  })
})
