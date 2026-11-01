// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppMenuRequest } from '../../../shared/appMenus'
import { AppMenuHost } from './AppMenuHost'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let show: ((request: AppMenuRequest) => void) | null
const choose = vi.fn(async () => undefined)
const dismiss = vi.fn(async () => undefined)

const request: AppMenuRequest = {
  token: 'menu-1',
  x: 40,
  y: 60,
  items: [
    { id: 'open', type: 'normal', label: 'Open in VS Code' },
    { id: 'gone', type: 'normal', label: 'Unavailable', enabled: false },
    { id: 'sep', type: 'separator' },
    {
      id: 'with',
      type: 'submenu',
      label: 'Open with',
      submenu: [{ id: 'default', type: 'normal', label: 'Default app' }]
    },
    { id: 'phone', type: 'checkbox', label: 'Phone', checked: true }
  ]
}

beforeEach(async () => {
  show = null
  choose.mockClear()
  dismiss.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      menus: {
        onShow: (callback: (request: AppMenuRequest) => void) => {
          show = callback
          return () => undefined
        },
        choose,
        dismiss
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<AppMenuHost />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const open = async (): Promise<void> => {
  await act(async () => show!(request))
}
const key = async (name: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  })
}
const rows = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')
]

describe('AppMenuHost', () => {
  it('reports the chosen item by token, and nothing for a disabled one', async () => {
    await open()
    await act(async () => rows()[1].click())
    expect(choose).not.toHaveBeenCalled()
    await act(async () => rows()[0].click())
    expect(choose).toHaveBeenCalledWith('menu-1', 'open')
    expect(container.querySelector('.app-menu')).toBeNull()
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('moves with the keys past disabled rows and into a submenu', async () => {
    await open()
    await key('ArrowDown')
    await key('ArrowDown')
    // "Unavailable" is skipped, so the second step lands on "Open with".
    expect(rows()[2].classList.contains('is-active')).toBe(true)
    await key('ArrowRight')
    expect(container.querySelectorAll('.app-menu')).toHaveLength(2)
    await key('ArrowDown')
    await key('Enter')
    expect(choose).toHaveBeenCalledWith('menu-1', 'default')
  })

  it('tells the main process when it closes without a choice', async () => {
    await open()
    await key('Escape')
    expect(container.querySelector('.app-menu')).toBeNull()
    expect(dismiss).toHaveBeenCalledWith('menu-1')
  })
})
