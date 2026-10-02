// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { ContentSegment } from '../types/chat.types'
import { changedFilesFromSegments } from '../utils/turnChanges'
import { ReviewCommentSinkContext } from '../hooks/useReviewCommentSink'
import { TurnChangeReview } from './TurnChangeReview'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('changedFilesFromSegments', () => {
  it('consolidates repeated changes and assigns each unified diff to its file', () => {
    const segments: ContentSegment[] = [
      {
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
      }
    ]

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
    const segments: ContentSegment[] = [
      {
        type: 'tool',
        tool: {
          id: 'edit',
          title: 'Edit',
          command: 'apply_patch',
          status: 'success',
          changes: [{ path: 'src/App.tsx', kind: 'update' }],
          data: { diff: '@@ -1 +1 @@\n-old\n+new' }
        }
      }
    ]
    await act(async () =>
      root.render(<TurnChangeReview segments={segments} workspaceRoot="C:/repo" />)
    )
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

  it('turns a comment on selected diff lines into a message attachment', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const sink = vi.fn(() => true)
    const segments: ContentSegment[] = [
      {
        type: 'tool',
        tool: {
          id: 'edit',
          title: 'Edit',
          command: 'apply_patch',
          status: 'success',
          changes: [{ path: 'src/App.tsx', kind: 'update' }],
          data: { diff: '@@ -1,2 +1,2 @@\n context\n-old\n+new' }
        }
      }
    ]
    await act(async () =>
      root.render(
        <ReviewCommentSinkContext.Provider value={sink}>
          <TurnChangeReview segments={segments} workspaceRoot="C:/repo" />
        </ReviewCommentSinkContext.Provider>
      )
    )
    await act(async () =>
      (container.querySelector('.turn-change-file-toggle') as HTMLButtonElement).click()
    )
    const lineButtons = (): HTMLButtonElement[] => [
      ...container.querySelectorAll<HTMLButtonElement>('.rich-diff-line-number')
    ]
    expect(lineButtons().map((button) => button.textContent)).toEqual(['1', '2', '2'])

    await act(async () => lineButtons()[0].click())
    await act(async () =>
      lineButtons()[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    )
    expect(container.querySelectorAll('.rich-diff-line.is-selected')).toHaveLength(3)
    const form = container.querySelector('.rich-diff-comment-form')!
    expect(form.textContent).toContain('Lines 1–2')
    const textarea = form.querySelector('textarea')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setValue.call(textarea, 'Keep the old name')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const add = [...form.querySelectorAll('button')].find(
      (button) => button.textContent === 'Add to message'
    )!
    await act(async () => add.click())

    expect(sink).toHaveBeenCalledWith({
      path: 'src/App.tsx',
      side: 'new',
      startLine: 1,
      endLine: 2,
      excerpt: ' context\n-old\n+new',
      comment: 'Keep the old name'
    })
    expect(container.querySelector('.rich-diff-comment-form')).toBeNull()
    await act(async () => root.unmount())
    container.remove()
  })

  it('stays view-only outside a chat that can take comments', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const segments: ContentSegment[] = [
      {
        type: 'tool',
        tool: {
          id: 'edit',
          title: 'Edit',
          command: 'apply_patch',
          status: 'success',
          changes: [{ path: 'src/App.tsx', kind: 'update' }],
          data: { diff: '@@ -1 +1 @@\n-old\n+new' }
        }
      }
    ]
    await act(async () => root.render(<TurnChangeReview segments={segments} />))
    await act(async () =>
      (container.querySelector('.turn-change-file-toggle') as HTMLButtonElement).click()
    )
    expect(container.querySelector('.rich-diff-line-number')).toBeNull()
    await act(async () => root.unmount())
    container.remove()
  })
})

describe('TurnChangeReview length', () => {
  it('shows the first files of a long change and the rest on request', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const paths = Array.from({ length: 17 }, (_, index) => `web/src/file${index}.ts`)
    const segments: ContentSegment[] = [
      {
        type: 'tool',
        tool: {
          id: 'edit',
          title: 'Edit',
          command: 'apply_patch',
          status: 'success',
          changes: paths.map((path) => ({ path, kind: 'create' as const }))
        }
      }
    ]
    await act(async () => root.render(<TurnChangeReview segments={segments} />))

    const rows = (): number => container.querySelectorAll('.turn-change-file').length
    const more = container.querySelector('.turn-change-review-more') as HTMLButtonElement
    expect(rows()).toBe(4)
    expect(container.textContent).toContain('Created 17 files')
    expect(more.textContent).toBe('Show 13 more files')
    // The folder is set apart so the file name reads first.
    expect(container.querySelector('.turn-change-file-dir')?.textContent).toBe('web/src/')

    await act(async () => more.click())
    expect(rows()).toBe(17)
    expect(more.textContent).toBe('Show fewer files')

    await act(async () => root.unmount())
    container.remove()
  })
})

describe('TurnChangeReview actions', () => {
  it('opens every diff from the header and undoes the response from the card', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onUndo = vi.fn()
    const segments: ContentSegment[] = [
      {
        type: 'tool',
        tool: {
          id: 'edit',
          title: 'Edit',
          command: 'apply_patch',
          status: 'success',
          changes: [
            { path: 'src/a.ts', kind: 'update' },
            { path: 'src/b.ts', kind: 'update' }
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
              '--- a/src/b.ts',
              '+++ b/src/b.ts',
              '@@ -1 +1 @@',
              '-old',
              '+new'
            ].join('\n')
          }
        }
      }
    ]
    const render = (undone: boolean): Promise<void> =>
      act(async () =>
        root.render(<TurnChangeReview segments={segments} undo={{ onUndo, undone }} />)
      )
    await render(false)

    const button = (label: string): HTMLButtonElement =>
      [...container.querySelectorAll('button')].find((item) =>
        item.textContent?.startsWith(label)
      ) as HTMLButtonElement
    expect(container.textContent).toContain('Edited 2 files')
    await act(async () => button('View changes').click())
    expect(container.querySelectorAll('.rich-diff-block')).toHaveLength(2)
    await act(async () => button('Hide changes').click())
    expect(container.querySelectorAll('.rich-diff-block')).toHaveLength(0)

    await act(async () => button('Undo').click())
    expect(onUndo).toHaveBeenCalledTimes(1)
    await render(true)
    expect(button('Undone').disabled).toBe(true)

    await act(async () => root.unmount())
    container.remove()
  })
})
