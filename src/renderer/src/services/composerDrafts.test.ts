// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_COMPOSER_DRAFTS,
  MAX_COMPOSER_DRAFT_CHARACTERS,
  MAX_COMPOSER_DRAFT_TEXT,
  deleteComposerDraft,
  loadComposerDraft,
  saveComposerDraft
} from './composerDrafts'
import type { MessageImageAttachment } from '../../../shared/messageImages'

const image: MessageImageAttachment = {
  id: 'image-1',
  name: 'shot.png',
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,AAAA'
}

describe('composer drafts', () => {
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('round-trips text, images and attachments per conversation', () => {
    const attachment = { id: 'a', kind: 'file' as const, name: 'a.ts', relativePath: 'src/a.ts' }
    saveComposerDraft('chat-1', { text: 'half typed', images: [image], attachments: [attachment] })
    saveComposerDraft('chat-2', { text: 'other', images: [], attachments: [] })

    expect(loadComposerDraft('chat-1')).toEqual({
      text: 'half typed',
      images: [image],
      attachments: [attachment]
    })
    expect(loadComposerDraft('chat-2').text).toBe('other')
    expect(loadComposerDraft('missing')).toEqual({ text: '', images: [], attachments: [] })
  })

  it('removes the stored draft once the box is empty or the chat is deleted', () => {
    saveComposerDraft('chat-1', { text: 'hello', images: [], attachments: [] })
    saveComposerDraft('chat-1', { text: '  ', images: [], attachments: [] })
    expect(localStorage.length).toBe(0)

    saveComposerDraft('chat-1', { text: 'hello', images: [], attachments: [] })
    deleteComposerDraft('chat-1')
    expect(loadComposerDraft('chat-1').text).toBe('')
  })

  it('ignores malformed stored drafts', () => {
    localStorage.setItem('sidekick.composerDraft.chat-1', '{not json')
    expect(loadComposerDraft('chat-1').text).toBe('')
    localStorage.setItem(
      'sidekick.composerDraft.chat-2',
      JSON.stringify({ text: 5, images: 'x', attachments: [{ kind: 'archive' }] })
    )
    expect(loadComposerDraft('chat-2')).toEqual({ text: '', images: [], attachments: [] })
  })

  it('caps the text and gives up images before exceeding the size limit', () => {
    const large = {
      ...image,
      dataUrl: `data:image/png;base64,${'A'.repeat(MAX_COMPOSER_DRAFT_CHARACTERS)}`
    }
    saveComposerDraft('chat-1', {
      text: 'x'.repeat(MAX_COMPOSER_DRAFT_TEXT + 10),
      images: [large],
      attachments: []
    })
    const draft = loadComposerDraft('chat-1')
    expect(draft.text).toHaveLength(MAX_COMPOSER_DRAFT_TEXT)
    expect(draft.images).toEqual([])
  })

  it('keeps only the newest drafts', () => {
    const now = vi.spyOn(Date, 'now')
    for (let index = 0; index <= MAX_COMPOSER_DRAFTS; index++) {
      now.mockReturnValue(1_000 + index)
      saveComposerDraft(`chat-${index}`, { text: `draft ${index}`, images: [], attachments: [] })
    }
    expect(localStorage.length).toBe(MAX_COMPOSER_DRAFTS)
    expect(loadComposerDraft('chat-0').text).toBe('')
    expect(loadComposerDraft(`chat-${MAX_COMPOSER_DRAFTS}`).text).toBe(
      `draft ${MAX_COMPOSER_DRAFTS}`
    )
  })

  it('keeps the text when storage is full', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    setItem.mockImplementationOnce(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    saveComposerDraft('chat-1', { text: 'keep me', images: [image], attachments: [] })
    expect(loadComposerDraft('chat-1')).toEqual({ text: 'keep me', images: [], attachments: [] })
  })

  it('does not throw when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() =>
      saveComposerDraft('chat-1', { text: 'x', images: [], attachments: [] })
    ).not.toThrow()
    expect(loadComposerDraft('chat-1').text).toBe('')
  })
})
