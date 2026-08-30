// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckpointHistoryItem } from '../../../shared/checkpointTitles'
import type { PinnedModel } from '../types/models.types'
import type { TitleGenerationConfig } from '../utils/chatPanelHelpers'
import { useCheckpointTitleBackfill } from './useCheckpointTitleBackfill'

const titleMocks = vi.hoisted(() => ({ generate: vi.fn() }))

vi.mock('../utils/chatPanelHelpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('../utils/chatPanelHelpers')>()
  return { ...original, generateConversationTitle: titleMocks.generate }
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('useCheckpointTitleBackfill', () => {
  let container: HTMLDivElement
  let root: Root
  const workspaceFolder = '/workspace/project'
  const checkpoint: CheckpointHistoryItem = {
    hash: 'a'.repeat(40),
    message: 'Sure, let me redesign the entire page with animations',
    timestamp: 1_000,
    workspaceRoot: workspaceFolder,
    titleSource: 'legacy',
    titleVersion: 0
  }
  const model: PinnedModel = {
    id: 'local-model',
    name: 'local-model',
    provider: 'lmstudio',
    contextLength: 32_768
  }
  const onTitleApplied = vi.fn()
  const claim = vi.fn()
  const complete = vi.fn()
  const fail = vi.fn()
  const getDiff = vi.fn()
  const getContext = vi.fn()

  function Harness(): null {
    useCheckpointTitleBackfill({
      enabled: true,
      workspaceFolder,
      checkpoints: [checkpoint],
      model,
      isAgentBusy: false,
      onTitleApplied
    })
    return null
  }

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    root = createRoot(container)
    onTitleApplied.mockReset()
    claim.mockReset().mockResolvedValue({ claimed: true })
    complete.mockReset().mockResolvedValue({ applied: true })
    fail.mockReset().mockResolvedValue({ recorded: true })
    getDiff.mockReset().mockResolvedValue({ ok: true, diff: 'app.css | 20 +++++++++' })
    getContext.mockReset().mockResolvedValue({
      userContent: 'Improve the landing page styling',
      assistantContent: 'Updated the layout, palette, and animations.'
    })
    titleMocks.generate
      .mockReset()
      .mockImplementation(async (config: TitleGenerationConfig, hash: string) => {
        await config.onUpdateTitle(hash, 'Refine landing page styling')
        return 'Refine landing page styling'
      })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        workspace: {
          claimCheckpointTitleBackfill: claim,
          completeCheckpointTitleBackfill: complete,
          failCheckpointTitleBackfill: fail,
          getCheckpointDiff: getDiff,
          getCheckpointTitleContext: getContext
        }
      }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
  })

  it('refines one visible legacy History label without renaming the Git checkpoint', async () => {
    await act(async () => root.render(<Harness />))
    await act(async () => vi.advanceTimersByTimeAsync(3_999))
    expect(claim).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(1))

    const identity = {
      workspaceRoot: workspaceFolder,
      hash: checkpoint.hash,
      expectedTitle: checkpoint.message
    }
    expect(claim).toHaveBeenCalledWith(identity)
    expect(getContext).toHaveBeenCalledWith(workspaceFolder, checkpoint.hash, checkpoint.timestamp)
    expect(complete).toHaveBeenCalledWith({
      ...identity,
      title: 'Refine landing page styling'
    })
    expect(onTitleApplied).toHaveBeenCalledWith(checkpoint.hash, 'Refine landing page styling')
    expect(window.api.workspace.renameCheckpoint).toBeUndefined()
  })

  it('replaces a meta title from a weak model with a deterministic diff label', async () => {
    getDiff.mockResolvedValue({
      ok: true,
      diff: 'diff --git a/cuba-population/index.html b/cuba-population/index.html'
    })
    titleMocks.generate.mockImplementation(async (config: TitleGenerationConfig, hash: string) => {
      await config.onUpdateTitle(hash, 'The user wants me to create an imperative')
      return 'The user wants me to create an imperative'
    })

    await act(async () => root.render(<Harness />))
    await act(async () => vi.advanceTimersByTimeAsync(4_000))

    expect(complete).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Update Cuba population' })
    )
    expect(onTitleApplied).toHaveBeenCalledWith(checkpoint.hash, 'Update Cuba population')
  })
})
