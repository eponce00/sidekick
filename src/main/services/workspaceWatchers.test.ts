import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const watchMock = vi.hoisted(() => vi.fn())
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, watch: watchMock }
})

import { WorkspaceWatchers } from './workspaceWatchers'

interface FakeWatcher {
  on: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  fail: (error: Error) => void
  change: (filename: string) => void
}

function fakeWatcher(): FakeWatcher {
  const listeners = new Map<string, (error: Error) => void>()
  const watcher: FakeWatcher = {
    on: vi.fn((event: string, handler: (error: Error) => void) => {
      listeners.set(event, handler)
    }),
    close: vi.fn(),
    fail: (error) => listeners.get('error')?.(error),
    change: () => undefined
  }
  return watcher
}

/** Returns each created watcher, wired to the change callback fs.watch was given. */
function captureWatchers(): FakeWatcher[] {
  const created: FakeWatcher[] = []
  watchMock.mockImplementation(
    (_folder: string, _options: unknown, onChange: (event: string, name: string) => void) => {
      const watcher = fakeWatcher()
      watcher.change = (filename) => onChange('change', filename)
      created.push(watcher)
      return watcher
    }
  )
  return created
}

function fakeWindow(): WebContents & { fireDestroyed: () => void } {
  let onDestroyed: (() => void) | undefined
  return {
    send: vi.fn(),
    isDestroyed: () => false,
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'destroyed') onDestroyed = handler
    }),
    fireDestroyed: () => onDestroyed?.()
  } as unknown as WebContents & { fireDestroyed: () => void }
}

describe('WorkspaceWatchers', () => {
  let watchers: WorkspaceWatchers

  beforeEach(() => {
    vi.useFakeTimers()
    watchMock.mockReset()
    watchers = new WorkspaceWatchers()
  })

  afterEach(() => {
    watchers.closeAll()
    vi.useRealTimers()
  })

  it('shares one watch per folder and tells each subscriber about changes', async () => {
    const created = captureWatchers()
    const window = fakeWindow()
    const first = watchers.subscribe('C:\\project', window)
    const second = watchers.subscribe('C:\\project', window)
    const other = watchers.subscribe('C:\\other', window)
    expect(watchMock).toHaveBeenCalledTimes(2)

    created[0].change('src\\index.ts')
    created[0].change('src\\app.ts')
    await vi.advanceTimersByTimeAsync(400)

    // Bursts collapse into one notice per subscriber, and only for the folder that changed.
    expect(vi.mocked(window.send).mock.calls).toEqual([
      ['workspace:filesChanged', first],
      ['workspace:filesChanged', second]
    ])
    expect(other).not.toBe(first)
  })

  it('ignores Git internals but not files that merely start with .git', async () => {
    const created = captureWatchers()
    const window = fakeWindow()
    watchers.subscribe('C:\\project', window)

    created[0].change('.git\\index')
    await vi.advanceTimersByTimeAsync(400)
    expect(window.send).not.toHaveBeenCalled()

    created[0].change('.gitignore')
    await vi.advanceTimersByTimeAsync(400)
    expect(window.send).toHaveBeenCalledOnce()
  })

  it('closes a folder watch with its last subscriber, and only for the window that owns it', () => {
    const created = captureWatchers()
    const owner = fakeWindow()
    const stranger = fakeWindow()
    const first = watchers.subscribe('C:\\project', owner)
    const second = watchers.subscribe('C:\\project', owner)

    watchers.unsubscribe(first, stranger)
    watchers.unsubscribe(first, owner)
    expect(created[0].close).not.toHaveBeenCalled()

    watchers.unsubscribe(second, owner)
    expect(created[0].close).toHaveBeenCalledOnce()
  })

  it('drops every subscription of a window that goes away', () => {
    const created = captureWatchers()
    const window = fakeWindow()
    watchers.subscribe('C:\\project', window)
    watchers.subscribe('C:\\other', window)

    window.fireDestroyed()

    expect(created.map((watcher) => watcher.close.mock.calls.length)).toEqual([1, 1])
  })

  it('re-establishes a watch that drops instead of going silent', async () => {
    const created = captureWatchers()
    watchers.subscribe('C:\\project', fakeWindow())

    created[0].fail(new Error('EPERM'))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(watchMock).toHaveBeenCalledTimes(2)
  })

  it('stops retrying a folder that never comes back', async () => {
    watchMock.mockImplementation(() => {
      const watcher = fakeWatcher()
      queueMicrotask(() => watcher.fail(new Error('ENOENT')))
      return watcher
    })

    watchers.subscribe('C:\\deleted', fakeWindow())
    await vi.advanceTimersByTimeAsync(60_000)

    // One initial attempt plus the bounded retry budget, then it gives up.
    expect(watchMock).toHaveBeenCalledTimes(6)
  })
})
