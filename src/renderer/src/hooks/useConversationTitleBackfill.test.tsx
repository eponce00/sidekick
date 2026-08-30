// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedModel } from '../types/models.types'
import type { TitleGenerationConfig } from '../utils/chatPanelHelpers'
import { useConversationTitleBackfill } from './useConversationTitleBackfill'

const titleMocks = vi.hoisted(() => ({ generate: vi.fn() }))

vi.mock('../utils/chatPanelHelpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('../utils/chatPanelHelpers')>()
  return { ...original, generateConversationTitle: titleMocks.generate }
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('useConversationTitleBackfill', () => {
  let container: HTMLDivElement
  let root: Root
  const model: PinnedModel = {
    id: 'local-model',
    name: 'local-model',
    provider: 'lmstudio',
    providerModelId: 'local-model',
    contextLength: 32_768
  }
  const onTitleApplied = vi.fn()
  const listCandidates = vi.fn()
  const claimTitleBackfill = vi.fn()
  const completeTitleBackfill = vi.fn()
  const failTitleBackfill = vi.fn()
  const preserveTitle = vi.fn()

  function Harness({ busy }: { busy: boolean }): null {
    useConversationTitleBackfill({
      enabled: true,
      model,
      isAgentBusy: busy,
      onTitleApplied
    })
    return null
  }

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    root = createRoot(container)
    onTitleApplied.mockReset()
    listCandidates.mockReset().mockResolvedValue([
      {
        id: 'old-chat',
        title: 'Explain SQLite atomic updates',
        titleSource: 'fallback',
        titleVersion: 0,
        firstUserMessage: 'explain SQLite atomic updates for background jobs',
        firstAssistantMessage: 'Use a guarded update inside a transaction.'
      }
    ])
    claimTitleBackfill.mockReset().mockResolvedValue({ claimed: true })
    completeTitleBackfill.mockReset().mockResolvedValue({ applied: true })
    failTitleBackfill.mockReset().mockResolvedValue({ recorded: true })
    preserveTitle.mockReset().mockResolvedValue({ preserved: true })
    titleMocks.generate
      .mockReset()
      .mockImplementation(async (config: TitleGenerationConfig, conversationId: string) => {
        await config.onUpdateTitle(conversationId, 'Atomic SQLite Backfill')
        return 'Atomic SQLite Backfill'
      })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        conversations: {
          listTitleBackfillCandidates: listCandidates,
          claimTitleBackfill,
          completeTitleBackfill,
          failTitleBackfill,
          preserveTitle
        }
      }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
  })

  it('does no startup work, pauses while the agent is busy, then processes one idle title', async () => {
    await act(async () => root.render(<Harness busy />))

    await act(async () => vi.advanceTimersByTimeAsync(11_999))
    expect(listCandidates).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(listCandidates).not.toHaveBeenCalled()

    await act(async () => root.render(<Harness busy={false} />))
    await act(async () => vi.advanceTimersByTimeAsync(10_000))

    expect(listCandidates).toHaveBeenCalledTimes(1)
    expect(claimTitleBackfill).toHaveBeenCalledWith({
      id: 'old-chat',
      expectedTitle: 'Explain SQLite atomic updates'
    })
    expect(titleMocks.generate).toHaveBeenCalledTimes(1)
    expect(completeTitleBackfill).toHaveBeenCalledWith({
      id: 'old-chat',
      expectedTitle: 'Explain SQLite atomic updates',
      title: 'Atomic SQLite Backfill'
    })
    expect(onTitleApplied).toHaveBeenCalledWith('old-chat', 'Atomic SQLite Backfill')
  })

  it('applies a useful deterministic fallback when the title model output is unusable', async () => {
    titleMocks.generate.mockResolvedValueOnce(null)
    await act(async () => root.render(<Harness busy={false} />))
    await act(async () => vi.advanceTimersByTimeAsync(12_000))

    expect(completeTitleBackfill).toHaveBeenCalledWith({
      id: 'old-chat',
      expectedTitle: 'Explain SQLite atomic updates',
      title: 'Explain SQLite atomic updates for background jobs',
      source: 'fallback'
    })
    expect(onTitleApplied).toHaveBeenCalledWith(
      'old-chat',
      'Explain SQLite atomic updates for background jobs',
      'fallback'
    )
    expect(failTitleBackfill).not.toHaveBeenCalled()
  })
})
