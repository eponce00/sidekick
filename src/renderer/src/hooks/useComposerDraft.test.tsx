// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerDraft } from './useComposerDraft'
import {
  NEW_CHAT_DRAFT_KEY,
  deleteComposerDraft,
  loadComposerDraft,
  saveComposerDraft
} from '../services/composerDrafts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function Harness({ conversationId, text }: { conversationId: string | null; text: string }): null {
  useComposerDraft(conversationId, { text, images: NO_IMAGES, attachments: NO_ATTACHMENTS })
  return null
}
const NO_IMAGES = [] as never[]
const NO_ATTACHMENTS = [] as never[]

describe('useComposerDraft', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('saves what is typed after a pause and clears it once sent', async () => {
    await act(async () => root.render(<Harness conversationId="chat-1" text="hel" />))
    await act(async () => root.render(<Harness conversationId="chat-1" text="hello" />))
    expect(loadComposerDraft('chat-1').text).toBe('')
    await act(async () => vi.advanceTimersByTime(300))
    expect(loadComposerDraft('chat-1').text).toBe('hello')

    await act(async () => root.render(<Harness conversationId="chat-1" text="" />))
    await act(async () => vi.advanceTimersByTime(300))
    expect(loadComposerDraft('chat-1').text).toBe('')
    await act(async () => root.unmount())
  })

  it('flushes an unsaved change when the chat is closed', async () => {
    await act(async () => root.render(<Harness conversationId="chat-1" text="quick" />))
    await act(async () => root.unmount())
    expect(loadComposerDraft('chat-1').text).toBe('quick')
  })

  it('does not write back a draft that was saved and then deleted', async () => {
    await act(async () => root.render(<Harness conversationId="chat-1" text="gone" />))
    await act(async () => vi.advanceTimersByTime(300))
    deleteComposerDraft('chat-1')
    await act(async () => root.unmount())
    expect(loadComposerDraft('chat-1').text).toBe('')
  })

  it('uses up the new-chat draft when the chat gets its id', async () => {
    saveComposerDraft(NEW_CHAT_DRAFT_KEY, { text: 'first message', images: [], attachments: [] })
    await act(async () => root.render(<Harness conversationId={null} text="first message" />))
    await act(async () => root.render(<Harness conversationId="chat-new" text="" />))
    await act(async () => vi.advanceTimersByTime(300))
    expect(loadComposerDraft(NEW_CHAT_DRAFT_KEY).text).toBe('')
    expect(loadComposerDraft('chat-new').text).toBe('')
    await act(async () => root.unmount())
  })
})
