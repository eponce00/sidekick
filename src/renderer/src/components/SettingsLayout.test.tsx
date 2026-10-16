// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Bell, Mic } from 'lucide-react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsEmptyState, SettingsRow, SettingsSection, ToggleField } from './SettingsLayout'

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

it('labels a section by its heading so it can be found by name', async () => {
  await act(async () =>
    root.render(
      <SettingsSection icon={Bell} title="Notifications" description="When SideKick tells you.">
        <p>Rows</p>
      </SettingsSection>
    )
  )
  const section = container.querySelector('section.settings-card')!
  expect(section.querySelector('h3')?.textContent).toBe('Notifications')
  expect(section.querySelector('.settings-card-icon svg')).not.toBeNull()
  expect(section.querySelector('.settings-card-content')?.textContent).toBe('Rows')
})

it('pairs a row label with its control and keeps the icon out of the accessible name', async () => {
  await act(async () =>
    root.render(
      <SettingsRow
        icon={Mic}
        label="Microphone"
        description="Dictation listens here."
        controlId="mic"
        control={<select id="mic" />}
      />
    )
  )
  const label = container.querySelector('label')!
  expect(label.textContent).toBe('Microphone')
  expect(label.htmlFor).toBe('mic')
  expect(container.querySelector('.settings-row-icon')?.getAttribute('aria-hidden')).toBe('true')
  expect(container.querySelector('.settings-row')?.classList.contains('has-icon')).toBe(true)
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

it('shows an empty state with its call to action', async () => {
  const onAdd = vi.fn()
  await act(async () =>
    root.render(
      <SettingsEmptyState
        icon={Bell}
        title="No MCP servers yet"
        description="SideKick works normally without them."
        action={
          <button type="button" onClick={onAdd}>
            Add
          </button>
        }
      />
    )
  )
  expect(container.textContent).toContain('No MCP servers yet')
  await act(async () => container.querySelector('button')!.click())
  expect(onAdd).toHaveBeenCalledOnce()
})
