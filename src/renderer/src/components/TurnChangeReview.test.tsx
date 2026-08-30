// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { ContentSegment } from '../types/chat.types'
import { changedFilesFromSegments } from '../utils/turnChanges'
import { TurnChangeReview } from './TurnChangeReview'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('changedFilesFromSegments', () => {
  it('consolidates repeated changes and assigns each unified diff to its file', () => {
    const segments: ContentSegment[] = [{
      type: 'tool',
      tool: {
        id: 'edit-1',
        title: 'Edit files',
        command: 'apply_patch',
        status: 'success',
        changes: [
          { path: 'src/a.ts', kind: 'update' },
          { path: 'src/b.ts', kind: 'create' }
        ],
        data: {
          diff: [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            'diff --git a/src/b.ts b/src/b.ts',
            '--- /dev/null',
            '+++ b/src/b.ts',
            '@@ -0,0 +1 @@',
            '+created'
          ].join('\n')
        }
      }
    }]

    expect(changedFilesFromSegments(segments)).toMatchObject([
      { path: 'src/a.ts', kind: 'update', additions: 1, deletions: 1 },
      { path: 'src/b.ts', kind: 'create', additions: 1, deletions: 0 }
    ])
  })
})

describe('TurnChangeReview interactions', () => {
  it('expands a file diff and opens or reveals its path', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const openFile = vi.fn(async () => undefined)
    const showPathMenu = vi.fn(async () => undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { workspace: { openFile, showPathMenu } }
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) }
    })
    const segments: ContentSegment[] = [{
      type: 'tool',
      tool: {
        id: 'edit', title: 'Edit', command: 'apply_patch', status: 'success',
        changes: [{ path: 'src/App.tsx', kind: 'update' }],
        data: { diff: '@@ -1 +1 @@\n-old\n+new' }
      }
    }]
    await act(async () => root.render(<TurnChangeReview segments={segments} workspaceRoot="C:/repo" />))
    const row = container.querySelector('.turn-change-file-row') as HTMLDivElement
    const toggle = container.querySelector('.turn-change-file-toggle') as HTMLButtonElement
    await act(async () => toggle.click())
    expect(container.querySelector('.rich-diff-block')).not.toBeNull()
    const open = container.querySelector('[aria-label="Open src/App.tsx"]') as HTMLButtonElement
    await act(async () => open.click())
    expect(openFile).toHaveBeenCalledWith('src/App.tsx', 'C:/repo')
    await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(showPathMenu).toHaveBeenCalledWith('src/App.tsx', 'C:/repo')
    await act(async () => (container.querySelector('.rich-tool-copy') as HTMLButtonElement).click())
    expect(navigator.clipboard.writeText).toHaveBeenCalled()
    await act(async () => root.unmount())
    container.remove()
  })
})
