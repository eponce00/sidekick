// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SettingsModal, { type ProviderSettings } from './SettingsModal'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SETTINGS = { providerInstances: [], accentPalette: 'teal' } as unknown as ProviderSettings

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      appUpdates: {
        getState: async () => ({ status: 'idle', currentVersion: '1.0.0' }),
        onState: () => () => undefined
      },
      mcp: { listTools: async () => ({ statuses: [] }) },
      commandLine: {
        status: async () => ({
          mode: 'development',
          installed: true,
          location: '',
          onPath: null,
          hint: 'Run npm run sidekick.'
        }),
        install: vi.fn()
      }
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function button(name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === name
  )
  expect(match, name).toBeDefined()
  return match!
}

const footer = (): string => container.querySelector('.settings-footer-status')?.textContent ?? ''

it('says when there are unsaved changes and saves them', async () => {
  const onSave = vi.fn(async () => ({ success: true }))
  const onClose = vi.fn()
  await act(async () =>
    root.render(
      <SettingsModal
        settings={SETTINGS}
        onSave={onSave}
        onClose={onClose}
        initialSection="appearance"
      />
    )
  )
  expect(footer()).toBe('Changes apply after you save.')

  await act(async () => button('Blue').click())
  expect(footer()).toBe('Unsaved changes')
  expect(button('Blue').getAttribute('aria-checked')).toBe('true')

  await act(async () => button('Save changes').click())
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ accentPalette: 'blue' }))
  expect(onClose).toHaveBeenCalledOnce()
})

it('keeps the window open and shows why when saving fails', async () => {
  const onClose = vi.fn()
  await act(async () =>
    root.render(
      <SettingsModal
        settings={SETTINGS}
        onSave={async () => ({ success: false, error: 'Disk full' })}
        onClose={onClose}
        initialSection="appearance"
      />
    )
  )
  await act(async () => button('Save changes').click())
  expect(container.querySelector('.settings-footer [role="alert"]')?.textContent).toBe('Disk full')
  expect(onClose).not.toHaveBeenCalled()
})

it('opens Integrations and explains an invalid enabled connector instead of saving', async () => {
  const onSave = vi.fn(async () => ({ success: true }))
  await act(async () =>
    root.render(
      <SettingsModal
        settings={
          {
            ...SETTINGS,
            mcpServers: [
              {
                id: 'broken',
                name: 'Broken',
                transport: 'stdio',
                command: '',
                args: [],
                approvalMode: 'prompt',
                enabled: true
              }
            ]
          } as ProviderSettings
        }
        onSave={onSave}
        onClose={vi.fn()}
        initialSection="appearance"
      />
    )
  )
  await act(async () => button('Save changes').click())
  expect(onSave).not.toHaveBeenCalled()
  expect(container.querySelector('h2')?.textContent).toBe('Integrations')
  expect(
    Array.from(container.querySelectorAll('[role="alert"]')).some((alert) =>
      alert.textContent?.includes('Enabled MCP connectors need a valid ID')
    )
  ).toBe(true)
})
