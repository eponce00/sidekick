// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GitInstallNotice from './GitInstallNotice'
import type { GitInstallResult } from '../../../shared/workspaceHistory'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

async function show(
  available: (lookAgain?: boolean) => boolean,
  outcome: GitInstallResult['outcome'] = 'ready'
): Promise<HTMLElement> {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      workspace: {
        gitAvailable: vi.fn(async (lookAgain?: boolean) => available(lookAgain)),
        installGit: vi.fn(async () => ({ outcome }))
      }
    }
  })
  const host = document.createElement('div')
  root = createRoot(host)
  await act(async () => root?.render(<GitInstallNotice />))
  return host
}

const press = (host: HTMLElement, selector: string): Promise<void> =>
  act(async () => host.querySelector<HTMLElement>(selector)?.click())

describe('GitInstallNotice', () => {
  afterEach(() => {
    act(() => root?.unmount())
    root = null
  })

  it('says nothing when Git is there', async () => {
    const host = await show(() => true)
    expect(host.textContent).toBe('')
  })

  it('goes back to offering after a no, and leads to the download page after a failure', async () => {
    const declined = await show(() => false, 'declined')
    await press(declined, '.git-notice-action')
    expect(declined.textContent).toContain('Install Git')
    act(() => root?.unmount())

    const failed = await show(() => false, 'failed')
    await press(failed, '.git-notice-action')
    expect(failed.querySelector('a')?.getAttribute('href')).toBe('https://git-scm.com/downloads')
  })

  it('finds a Git installed elsewhere when the window comes back', async () => {
    const host = await show((lookAgain) => lookAgain === true, 'elsewhere')
    await press(host, '.git-notice-action')
    expect(host.textContent).toContain('Finish installing')
    await act(async () => void window.dispatchEvent(new Event('focus')))
    expect(host.textContent).toContain('Git is ready')
  })

  // Last, as being dismissed lasts until the app restarts.
  it('stays away once dismissed', async () => {
    const host = await show(() => false)
    await press(host, '.git-notice-close')
    expect(host.textContent).toBe('')
    act(() => root?.unmount())
    const again = await show(() => false)
    expect(again.textContent).toBe('')
  })
})
