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

it('saves the changed settings along with the ones Settings opened with', async () => {
  const onSave = vi.fn(async () => ({ success: true }))
  const onClose = vi.fn()
  await act(async () =>
    root.render(
      <SettingsModal
        settings={SETTINGS}
        onSave={onSave}
        onTextScaleChange={vi.fn()}
        onClose={onClose}
        initialSection="appearance"
      />
    )
  )
  await act(async () => button('Blue').click())
  await act(async () => button('Save changes').click())
  // What Settings opened with goes along, so the save can name only what changed.
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ accentPalette: 'blue' }),
    expect.objectContaining({ accentPalette: 'teal' })
  )
  expect(onClose).toHaveBeenCalledOnce()
})

it('applies a text size at once and follows one set by the zoom shortcuts', async () => {
  // As the window does: the size is saved, and Settings is passed the stored value.
  const onTextScaleChange = vi.fn((textScale: number) => render(textScale))
  const render = (textScale?: number): void =>
    root.render(
      <SettingsModal
        settings={{ ...SETTINGS, textScale }}
        onSave={vi.fn(async () => ({ success: true }))}
        onTextScaleChange={onTextScaleChange}
        onClose={vi.fn()}
        initialSection="appearance"
      />
    )
  const shown = (): string => container.querySelector('.settings-stepper output')?.textContent ?? ''
  await act(async () => render())
  expect(shown()).toBe('100%')

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Larger text"]')!.click()
  )
  expect(onTextScaleChange).toHaveBeenCalledWith(110)
  expect(shown()).toBe('110%')

  // Ctrl + saves the setting from the main process; the window passes the new value down.
  await act(async () => render(120))
  expect(shown()).toBe('120%')
  await act(async () => button('Reset').click())
  expect(onTextScaleChange).toHaveBeenLastCalledWith(100)
})

it('keeps the window open when saving fails', async () => {
  const onClose = vi.fn()
  await act(async () =>
    root.render(
      <SettingsModal
        settings={SETTINGS}
        onSave={async () => ({ success: false, error: 'Disk full' })}
        onTextScaleChange={vi.fn()}
        onClose={onClose}
        initialSection="appearance"
      />
    )
  )
  await act(async () => button('Save changes').click())
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
        onTextScaleChange={vi.fn()}
        onClose={vi.fn()}
        initialSection="appearance"
      />
    )
  )
  await act(async () => button('Save changes').click())
  expect(onSave).not.toHaveBeenCalled()
  expect(container.querySelector('h2')?.textContent).toBe('Integrations')
})
