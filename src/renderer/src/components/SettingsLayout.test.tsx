// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToggleField } from './SettingsLayout'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('toggles a switch row from anywhere on the row, and not while disabled', async () => {
  const onChange = vi.fn()
  const render = (disabled: boolean): Promise<void> =>
    act(async () =>
      root.render(
        <ToggleField
          label="Completion notifications"
          hint="When a response finishes."
          checked={false}
          disabled={disabled}
          onChange={onChange}
        />
      )
    )
  await render(false)
  await act(async () => container.querySelector<HTMLElement>('.settings-row-description')!.click())
  expect(onChange).toHaveBeenCalledWith(true)

  onChange.mockClear()
  await render(true)
  await act(async () => container.querySelector<HTMLElement>('.settings-row-label')!.click())
  expect(onChange).not.toHaveBeenCalled()
  expect(container.querySelector('input[type="checkbox"]')?.hasAttribute('disabled')).toBe(true)
})
