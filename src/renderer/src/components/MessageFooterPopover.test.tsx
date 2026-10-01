// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageFooterPopover } from './MessageFooterPopover'

describe('MessageFooterPopover', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <div className="message">
          {['first', 'second'].map((name) => (
            <MessageFooterPopover
              key={name}
              className={name}
              cardClassName="card"
              title={name}
              label={name}
            >
              <button type="button">Inside {name}</button>
            </MessageFooterPopover>
          ))}
          <p className="outside">Elsewhere</p>
        </div>
      )
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const details = (name: string): HTMLDetailsElement =>
    container.querySelector(`.${name}`) as HTMLDetailsElement
  const open = async (name: string): Promise<void> => {
    await act(async () => {
      details(name).open = true
      details(name).dispatchEvent(new Event('toggle'))
    })
  }
  const pointerDown = async (target: Element): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
  }

  it('stays open for a click inside its card', async () => {
    await open('first')
    await pointerDown(container.querySelector('.first button')!)
    expect(details('first').open).toBe(true)
  })

  it('closes on a click elsewhere, including on another footer item', async () => {
    await open('first')
    await pointerDown(container.querySelector('.outside')!)
    expect(details('first').open).toBe(false)

    await open('first')
    await pointerDown(container.querySelector('.second summary')!)
    expect(details('first').open).toBe(false)
  })

  it('closes on Escape', async () => {
    await open('second')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(details('second').open).toBe(false)
  })
})
