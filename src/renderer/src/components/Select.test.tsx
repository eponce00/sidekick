// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Select } from './Select'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = async (value: string, onChange = vi.fn()): Promise<HTMLButtonElement> => {
  await act(async () =>
    root.render(
      <Select value={value} onChange={onChange} aria-label="Fruit">
        <option value="apple">Apple</option>
        <>
          <option value="banana" disabled>
            Banana
          </option>
          {['cherry', 'damson'].map((fruit) => (
            <option key={fruit} value={fruit}>
              {fruit[0].toUpperCase() + fruit.slice(1)}
            </option>
          ))}
        </>
      </Select>
    )
  )
  return container.querySelector('button')!
}

const key = async (target: HTMLElement, name: string): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  await act(async () => target.dispatchEvent(event))
  return event
}

const list = (): HTMLElement | null => document.querySelector('[role="listbox"]')

describe('Select', () => {
  it('shows the chosen option and lists every option, through fragments and arrays', async () => {
    const trigger = await render('cherry')
    expect(trigger.textContent).toBe('Cherry')
    await act(async () => trigger.click())
    const options = [...list()!.querySelectorAll('[role="option"]')]
    expect(options.map((option) => option.textContent)).toEqual([
      'Apple',
      'Banana',
      'Cherry',
      'Damson'
    ])
    expect(options[2].getAttribute('aria-selected')).toBe('true')
    // The list floats outside the form, so a scrolling panel never clips it.
    expect(container.contains(list())).toBe(false)
  })

  it('reports a click like a native change, and nothing for the current or a disabled option', async () => {
    const onChange = vi.fn()
    const trigger = await render('apple', onChange)
    await act(async () => trigger.click())
    await act(async () => (list()!.querySelector('[data-value="banana"]') as HTMLElement).click())
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => (list()!.querySelector('[data-value="damson"]') as HTMLElement).click())
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ target: { value: 'damson' } }))
    expect(list()).toBeNull()
  })

  it('moves with the arrow keys past disabled options, and picks with Enter', async () => {
    const onChange = vi.fn()
    const trigger = await render('apple', onChange)
    await key(trigger, 'ArrowDown')
    expect(list()).not.toBeNull()
    await key(trigger, 'ArrowDown')
    // Banana is disabled, so the next stop is Cherry.
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      list()!.querySelector('[data-value="cherry"]')!.id
    )
    await key(trigger, 'Enter')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ target: { value: 'cherry' } }))
  })

  it('jumps by typing, and closes on Escape without letting a dialog close too', async () => {
    const onChange = vi.fn()
    const trigger = await render('apple', onChange)
    await key(trigger, 'ArrowDown')
    await key(trigger, 'd')
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      list()!.querySelector('[data-value="damson"]')!.id
    )
    const escape = await key(trigger, 'Escape')
    expect(escape.defaultPrevented).toBe(true)
    expect(list()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stays open through a late scroll event, and closes once the page really scrolls', async () => {
    const trigger = await render('apple')
    let top = 100
    trigger.getBoundingClientRect = () => new DOMRect(20, top, 120, 28)
    await act(async () => trigger.click())
    // The scroll that brought the button into view reports only after the list opened.
    await act(async () => {
      document.body.dispatchEvent(new Event('scroll'))
    })
    expect(list()).not.toBeNull()
    top = 60
    await act(async () => {
      document.body.dispatchEvent(new Event('scroll'))
    })
    expect(list()).toBeNull()
  })
})
