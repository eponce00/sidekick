// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PullRequestStatusResult } from '../../../shared/pullRequests'
import { previewPullRequestStates } from '../dev/pullRequestPreview'
import { PULL_REQUEST_POLL_MS } from '../hooks/usePullRequestStatus'
import { PullRequestBar } from './PullRequestBar'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const createUrl = 'https://github.com/sidekick-labs/sidekick/compare/main...feature?expand=1'

function withPullRequest(name: string): PullRequestStatusResult {
  const sample = previewPullRequestStates[name]
  return {
    ok: true,
    status: {
      repository: 'sidekick-labs/sidekick',
      branch: 'feature/pr-bar',
      createUrl,
      pullRequest: sample === 'none' ? null : sample
    }
  }
}

describe('PullRequestBar', () => {
  let container: HTMLDivElement
  let root: Root
  let getStatus: ReturnType<typeof vi.fn<(root: string) => Promise<PullRequestStatusResult>>>

  beforeEach(() => {
    getStatus = vi.fn(async () => withPullRequest('running'))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { pullRequests: { getStatus } }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  async function render(workspaceRoot: string | null = 'C:\\Projects\\sidekick'): Promise<void> {
    await act(async () => root.render(<PullRequestBar workspaceRoot={workspaceRoot} />))
  }

  const bar = (): HTMLElement | null => container.querySelector('.pull-request-bar')
  const text = (): string => bar()?.textContent ?? ''

  it('reads the status of the open folder and links the pull request out of the app', async () => {
    await render()
    expect(getStatus).toHaveBeenCalledWith('C:\\Projects\\sidekick')
    const link = container.querySelector<HTMLAnchorElement>('.pull-request-bar-number')
    expect(link?.href).toBe('https://github.com/sidekick-labs/sidekick-demo/pull/128')
    expect(link?.target).toBe('_blank')
  })

  it('renders nothing when there is nothing to show or no folder', async () => {
    getStatus.mockResolvedValue({ ok: true, status: null })
    await render()
    expect(bar()).toBeNull()

    await render(null)
    expect(bar()).toBeNull()
  })

  it('stays hidden when the first read fails', async () => {
    getStatus.mockResolvedValue({ ok: false, error: 'Could not load pull request status.' })
    await render()
    expect(bar()).toBeNull()
  })

  it('refreshes on demand, on window focus, and on an interval', async () => {
    vi.useFakeTimers()
    await render()
    expect(getStatus).toHaveBeenCalledTimes(1)

    await act(async () =>
      container.querySelector<HTMLButtonElement>('.pull-request-bar-refresh')!.click()
    )
    expect(getStatus).toHaveBeenCalledTimes(2)

    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(getStatus).toHaveBeenCalledTimes(3)

    await act(async () => vi.advanceTimersByTime(PULL_REQUEST_POLL_MS))
    expect(getStatus).toHaveBeenCalledTimes(4)
  })

  it('does not poll while the window is hidden', async () => {
    vi.useFakeTimers()
    await render()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => vi.advanceTimersByTime(PULL_REQUEST_POLL_MS * 3))
    expect(getStatus).toHaveBeenCalledTimes(1)
    visibility.mockRestore()
  })

  it('keeps the last status and shows a dismissible error when a later read fails', async () => {
    await render()
    getStatus.mockResolvedValue({ ok: false, error: 'GitHub’s API rate limit was reached.' })
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.pull-request-bar-refresh')!.click()
    )
    expect(text()).toContain('#128')
    expect(container.querySelector('.pull-request-bar-error')).not.toBeNull()

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Dismiss pull request error"]')!
        .click()
    )
    expect(container.querySelector('.pull-request-bar-error')).toBeNull()
    // A dismissed error stays dismissed through retries until a read succeeds.
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.pull-request-bar-refresh')!.click()
    )
    expect(container.querySelector('.pull-request-bar-error')).toBeNull()
  })

  it('does not show one folder’s pull request for another', async () => {
    await render('C:\\Projects\\sidekick')
    let resolveSecond: (result: PullRequestStatusResult) => void = () => undefined
    getStatus.mockImplementation(() => new Promise((resolve) => (resolveSecond = resolve)))
    await render('C:\\Projects\\other')
    expect(bar()).toBeNull()
    await act(async () => resolveSecond(withPullRequest('merged')))
    expect(container.querySelector('.pull-request-bar-merge')?.textContent).toBe('Merged')
  })
})
