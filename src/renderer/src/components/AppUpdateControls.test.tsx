// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '../../../shared/appUpdates'
import { AppUpdateToast } from './AppUpdateControls'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const available: AppUpdateState = {
  status: 'available',
  currentVersion: '1.0.0',
  update: {
    version: '2.0.0',
    releaseName: 'SideKick 2.0.0',
    releaseNotes: null,
    releaseDate: null,
    releaseUrl: 'https://github.com/eponce00/sidekick/releases/tag/v2.0.0'
  }
}

describe('AppUpdateToast', () => {
  let container: HTMLDivElement
  let root: Root
  let publish: (state: AppUpdateState) => void
  const openRelease = vi.fn(async () => ({ opened: true }))
  const check = vi.fn()
  const install = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        appUpdates: {
          getState: async () => available,
          check,
          install,
          openRelease,
          onState: (callback: (state: AppUpdateState) => void) => {
            publish = callback
            return () => undefined
          }
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('offers the public release for notification-only states', async () => {
    await act(async () => root.render(<AppUpdateToast />))
    expect(container.textContent).toContain('SideKick 2.0.0 is available.')

    const button = [...container.querySelectorAll('button')].find(({ textContent }) =>
      textContent?.includes('View release')
    )
    await act(async () => button?.click())
    expect(openRelease).toHaveBeenCalledOnce()
  })

  it('reports a failed check and retries only when the user chooses', async () => {
    await act(async () => root.render(<AppUpdateToast />))
    await act(async () =>
      publish({
        status: 'error',
        currentVersion: '1.0.0',
        message: 'offline'
      })
    )
    expect(container.textContent).toContain('Update failed: offline')
    const button = [...container.querySelectorAll('button')].find(({ textContent }) =>
      textContent?.includes('Retry')
    )
    await act(async () => button?.click())
    expect(check).toHaveBeenCalledOnce()
  })

  it('offers an app-only restart after verification, never during download', async () => {
    await act(async () => root.render(<AppUpdateToast />))
    const update = available.status === 'available' ? available.update : undefined!
    await act(async () =>
      publish({ status: 'downloading', currentVersion: '1.0.0', update, percent: 42 })
    )
    expect(container.textContent).toContain('42%')
    expect(container.querySelector('button')).toBeNull()
    await act(async () =>
      publish({ status: 'ready', currentVersion: '1.0.0', update, installMode: 'restart' })
    )
    expect(container.textContent).toContain('Only the app will restart')
    await act(async () => container.querySelector('button')?.click())
    expect(install).toHaveBeenCalledOnce()
  })
})
