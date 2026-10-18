import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A dialog window the tests can answer: it records how it was made and its navigation handler.
const dialogs: Array<{
  options: { parent?: unknown }
  navigate: (url: string) => void
  destroy: ReturnType<typeof vi.fn>
}> = []
const notices: Array<{ options: { body?: string }; close: ReturnType<typeof vi.fn> }> = []

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function (this: Record<string, unknown>, options: { parent?: unknown }) {
    const record: (typeof dialogs)[number] = {
      options,
      navigate: () => undefined,
      destroy: vi.fn()
    }
    dialogs.push(record)
    let destroyed = false
    record.destroy.mockImplementation(() => (destroyed = true))
    Object.assign(this, {
      webContents: {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn((event: string, handler: (e: unknown, url: string) => void) => {
          if (event === 'will-navigate')
            record.navigate = (url) => handler({ preventDefault: () => undefined }, url)
        })
      },
      on: vi.fn(),
      isDestroyed: () => destroyed,
      destroy: record.destroy,
      isVisible: () => false,
      show: vi.fn(),
      setBounds: vi.fn(),
      loadURL: vi.fn(async () => undefined)
    })
  }),
  Notification: Object.assign(
    vi.fn(function (this: Record<string, unknown>, options: { body?: string }) {
      const close = vi.fn()
      notices.push({ options, close })
      Object.assign(this, { on: vi.fn(), show: vi.fn(), close })
    }),
    { isSupported: () => true }
  ),
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })) },
  nativeTheme: { shouldUseDarkColors: true }
}))

const parked = new Set<unknown>()
vi.mock('./browserViewHost', () => ({
  isBrowserParkingWindow: (window: unknown) => parked.has(window)
}))
vi.mock('../ipc/state', () => ({ appState: { mainWindowRef: null } }))

import { dialog, type BrowserWindow } from 'electron'
import { appState } from '../ipc/state'
import { showTrustedDialog, trustedDialogPage } from './trustedDialog'

function appWindow(initial: { focused?: boolean; visible?: boolean; minimized?: boolean } = {}) {
  const state = { focused: true, visible: true, minimized: false, ...initial }
  const listeners = new Map<string, Set<() => void>>()
  const emit = (event: string): void => listeners.get(event)?.forEach((listener) => listener())
  const window = {
    isDestroyed: () => false,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFocused: () => state.focused,
    flashFrame: vi.fn(),
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    webContents: { executeJavaScript: vi.fn(async () => 'dark') },
    on: (event: string, listener: () => void) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener))
      return window
    },
    once: (event: string, listener: () => void) => window.on(event, listener),
    off: (event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener)
      return window
    },
    show: vi.fn(() => {
      state.visible = true
      emit('show')
    }),
    restore: vi.fn(() => {
      state.minimized = false
      emit('restore')
    }),
    focus: vi.fn(),
    /** The user brings SideKick back, from the taskbar or the tray. */
    bringBack: () => {
      if (state.minimized) window.restore()
      if (!state.visible) window.show()
    }
  }
  return window
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const settingsOptions = {
  type: 'warning' as const,
  title: 'Confirm security-sensitive settings',
  message: 'Apply security-sensitive settings?',
  detail: 'Full access lets <b>agents</b> run without asking.',
  buttons: ['Cancel', 'Apply settings'],
  defaultId: 0,
  cancelId: 0
}

beforeEach(() => {
  dialogs.length = 0
  notices.length = 0
  parked.clear()
  appState.mainWindowRef = null
  vi.mocked(dialog.showMessageBox).mockClear()
})

describe('SideKick-styled trusted dialog', () => {
  it('shows text as text, never as markup', () => {
    const page = trustedDialogPage(settingsOptions, 'dark')
    expect(page).toContain('Full access lets &lt;b&gt;agents&lt;/b&gt; run without asking.')
    expect(page).not.toContain('<b>agents</b>')
  })

  it('allows only its own script', () => {
    const page = trustedDialogPage(settingsOptions, 'light')
    const script = page.match(/<script>([\s\S]*?)<\/script>/)![1]
    const hash = createHash('sha256').update(script).digest('base64')
    expect(page).toContain(`script-src 'sha256-${hash}'`)
    expect(page).toContain("default-src 'none'")
  })

  it('puts Cancel on the left, focuses the safe default, and marks the main action', () => {
    const page = trustedDialogPage(settingsOptions, 'dark')
    const buttons = [
      ...page.matchAll(
        /<button type="button" data-index="(\d)" class="([^"]*)"( autofocus)?>([^<]*)</g
      )
    ]
    expect(buttons.map((button) => [button[4], button[2], Boolean(button[3])])).toEqual([
      ['Cancel', '', true],
      ['Apply settings', 'primary', false]
    ])
  })

  it('marks the default as the main action when it is not Cancel', () => {
    const page = trustedDialogPage(
      { message: 'Install?', buttons: ['Restart and update', 'Later'], defaultId: 0, cancelId: 1 },
      'dark'
    )
    const buttons = [...page.matchAll(/data-index="(\d)" class="([^"]*)"/g)]
    expect(buttons.map((button) => [button[1], button[2]])).toEqual([
      ['1', ''],
      ['0', 'primary']
    ])
  })

  it('falls back to the system dialog without a visible window to attach to', async () => {
    await showTrustedDialog(null, settingsOptions)
    expect(dialog.showMessageBox).toHaveBeenCalledWith(settingsOptions)
  })

  it("opens over the app's window, never a browser page's off-screen window", async () => {
    const browserParking = appWindow()
    parked.add(browserParking)
    const main = appWindow()
    appState.mainWindowRef = main as unknown as BrowserWindow
    const answer = showTrustedDialog(browserParking as unknown as BrowserWindow, settingsOptions)
    await settle()
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].options.parent).toBe(main)
    dialogs[0].navigate('sidekick-dialog:respond/1/0')
    await expect(answer).resolves.toEqual({ response: 1, checkboxChecked: false })
  })

  it('calls for attention while SideKick is not in front, and stops once answered', async () => {
    const main = appWindow({ focused: false })
    const answer = showTrustedDialog(main as unknown as BrowserWindow, settingsOptions)
    await settle()
    expect(main.flashFrame).toHaveBeenCalledWith(true)
    expect(notices.map((notice) => notice.options.body)).toEqual([settingsOptions.message])
    dialogs[0].navigate('sidekick-dialog:respond/0/0')
    await answer
    expect(main.flashFrame).toHaveBeenLastCalledWith(false)
    expect(notices[0].close).toHaveBeenCalled()
  })

  it('does not interrupt when SideKick is already in front', async () => {
    const answer = showTrustedDialog(appWindow() as unknown as BrowserWindow, settingsOptions)
    await settle()
    expect(notices).toHaveLength(0)
    dialogs[0].navigate('sidekick-dialog:respond/0/0')
    await answer
  })

  it('withdraws the question, as Cancel, when whatever waits on it gives up', async () => {
    const waiting = new AbortController()
    const answer = showTrustedDialog(appWindow() as unknown as BrowserWindow, settingsOptions, {
      signal: waiting.signal
    })
    await settle()
    waiting.abort()
    await expect(answer).resolves.toEqual({ response: 0, checkboxChecked: false })
    expect(dialogs[0].destroy).toHaveBeenCalled()
  })

  it('waits for SideKick to come back from the tray or the taskbar, then asks in its own style', async () => {
    for (const state of [{ minimized: true }, { visible: false }]) {
      dialogs.length = 0
      notices.length = 0
      const main = appWindow({ ...state, focused: false })
      const answer = showTrustedDialog(main as unknown as BrowserWindow, settingsOptions)
      await settle()
      // Nothing native and nothing over a hidden window: a notification says what is asked.
      expect(dialog.showMessageBox).not.toHaveBeenCalled()
      expect(dialogs).toHaveLength(0)
      expect(notices.map((notice) => notice.options.body)).toEqual([settingsOptions.message])
      main.bringBack()
      await settle()
      expect(dialogs).toHaveLength(1)
      expect(dialogs[0].options.parent).toBe(main)
      dialogs[0].navigate('sidekick-dialog:respond/1/0')
      await expect(answer).resolves.toEqual({ response: 1, checkboxChecked: false })
    }
  })

  it('brings the window up at once to ask what the user just set off', async () => {
    const main = appWindow({ visible: false })
    const answer = showTrustedDialog(main as unknown as BrowserWindow, settingsOptions, {
      reveal: true
    })
    await settle()
    expect(main.show).toHaveBeenCalled()
    expect(dialogs).toHaveLength(1)
    dialogs[0].navigate('sidekick-dialog:respond/0/0')
    await answer
  })

  it('stops waiting, as Cancel, when whatever waits on it gives up first', async () => {
    const waiting = new AbortController()
    const main = appWindow({ minimized: true })
    const answer = showTrustedDialog(main as unknown as BrowserWindow, settingsOptions, {
      signal: waiting.signal
    })
    await settle()
    waiting.abort()
    await expect(answer).resolves.toEqual({ response: 0, checkboxChecked: false })
    expect(dialogs).toHaveLength(0)
  })
})
