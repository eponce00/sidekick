import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// How the next windows' loads end; a resolved load unless a test says otherwise.
const loads: Array<Promise<void>> = []
const windows: Array<{
  options: Record<string, unknown>
  navigate: (url: string) => void
  setBounds: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  load?: Promise<void>
}> = []

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function (this: Record<string, unknown>, options: Record<string, unknown>) {
    let destroyed = false
    const record: (typeof windows)[number] = {
      load: loads.shift() ?? Promise.resolve(),
      options,
      navigate: () => undefined,
      setBounds: vi.fn(),
      showInactive: vi.fn(),
      destroy: vi.fn(() => (destroyed = true))
    }
    windows.push(record)
    Object.assign(this, {
      webContents: {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn((event: string, handler: (e: unknown, url: string) => void) => {
          if (event === 'will-navigate')
            record.navigate = (url) => handler({ preventDefault: () => undefined }, url)
        })
      },
      isDestroyed: () => destroyed,
      isVisible: () => record.showInactive.mock.calls.length > 0,
      destroy: record.destroy,
      setBounds: record.setBounds,
      showInactive: record.showInactive,
      loadURL: vi.fn(() => record.load)
    })
  }),
  screen: {
    getCursorScreenPoint: () => ({ x: 2500, y: 500 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 1920, y: 0, width: 1920, height: 1040 } })
  },
  nativeTheme: { shouldUseDarkColors: true }
}))
vi.mock('../ipc/state', () => ({ appState: {} }))

import { attentionToastPage, showAttentionToast } from './attentionToast'

const look = { theme: 'light' as const, accent: '#2850b8', onAccent: '#ffffff' }

beforeEach(() => {
  windows.length = 0
})

describe('SideKick-styled notice', () => {
  it('shows text as text, in the app’s look, running only its own script', () => {
    const page = attentionToastPage({
      title: 'Open a local network address?',
      message: 'Allow <b>SideKick</b> to open http://192.168.1.8?',
      warning: true,
      look
    })
    expect(page).toContain('Allow &lt;b&gt;SideKick&lt;/b&gt; to open')
    expect(page).not.toContain('<b>SideKick</b>')
    const script = page.match(/<script>([\s\S]*?)<\/script>/)![1]
    expect(page).toContain(
      `script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`
    )
    expect(page).toContain("default-src 'none'")
  })

  it('appears in the corner of the screen the user is on without taking focus', () => {
    showAttentionToast({ title: 'T', message: 'M', warning: false, look, onOpen: vi.fn() })
    const [notice] = windows
    expect(notice.options).toMatchObject({ focusable: false, alwaysOnTop: true, skipTaskbar: true })
    notice.navigate('sidekick-notice:size/90')
    expect(notice.setBounds).toHaveBeenCalledWith({ x: 3444, y: 914, width: 380, height: 110 })
    expect(notice.showInactive).toHaveBeenCalled()
  })

  it('brings SideKick up when clicked, and goes away when clicked, dismissed or taken away', () => {
    const onOpen = vi.fn()
    showAttentionToast({ title: 'T', message: 'M', warning: false, look, onOpen })
    windows[0].navigate('sidekick-notice:close')
    expect(windows[0].destroy).toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()

    showAttentionToast({ title: 'T', message: 'M', warning: false, look, onOpen })
    windows[1].navigate('sidekick-notice:open')
    expect(onOpen).toHaveBeenCalled()
    expect(windows[1].destroy).toHaveBeenCalled()

    const takeAway = showAttentionToast({ title: 'T', message: 'M', warning: false, look, onOpen })
    takeAway()
    expect(windows[2].destroy).toHaveBeenCalled()
  })

  it('ignores any other navigation', () => {
    const onOpen = vi.fn()
    showAttentionToast({ title: 'T', message: 'M', warning: false, look, onOpen })
    windows[0].navigate('https://example.com/')
    windows[0].navigate('sidekick-notice:elsewhere')
    expect(onOpen).not.toHaveBeenCalled()
    expect(windows[0].destroy).not.toHaveBeenCalled()
  })

  it('stays up when its load is reported failed after the page came up', async () => {
    let fail!: () => void
    loads.push(new Promise<void>((_, reject) => (fail = () => reject(new Error('ERR_FAILED')))))
    showAttentionToast({ title: 'T', message: 'M', warning: false, look, onOpen: vi.fn() })
    windows[0].navigate('sidekick-notice:size/90')
    fail()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(windows[0].destroy).not.toHaveBeenCalled()
  })

  it('goes away when its page never came up', async () => {
    loads.push(Promise.reject(new Error('ERR_FAILED')))
    showAttentionToast({ title: 'T', message: 'M', warning: false, look, onOpen: vi.fn() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(windows[0].destroy).toHaveBeenCalled()
  })
})
