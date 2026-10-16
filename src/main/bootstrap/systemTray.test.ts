import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

const electron = vi.hoisted(() => {
  const trays: Array<{
    handlers: Record<string, () => void>
    setContextMenu: ReturnType<typeof vi.fn>
    setToolTip: ReturnType<typeof vi.fn>
    setImage: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    displayBalloon: ReturnType<typeof vi.fn>
  }> = []
  const notices: Array<{ options: unknown; handlers: Record<string, () => void> }> = []
  const source = {
    resize: vi.fn(({ width }: { width: number }) => ({
      toBitmap: () => Buffer.alloc(width * width * 4, 0xff)
    }))
  }
  return {
    trays,
    notices,
    source,
    failTray: false,
    notificationsSupported: true,
    dock: { setMenu: vi.fn() },
    buildFromTemplate: vi.fn((template: unknown) => ({ template })),
    addRepresentation: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: { dock: electron.dock },
  Menu: { buildFromTemplate: electron.buildFromTemplate },
  nativeImage: {
    createFromPath: () => electron.source,
    createEmpty: () => ({ addRepresentation: electron.addRepresentation })
  },
  Notification: class {
    static isSupported(): boolean {
      return electron.notificationsSupported
    }
    handlers: Record<string, () => void> = {}
    constructor(options: unknown) {
      electron.notices.push({ options, handlers: this.handlers })
    }
    on(event: string, handler: () => void): void {
      this.handlers[event] = handler
    }
    show = vi.fn()
  },
  Tray: class {
    handlers: Record<string, () => void> = {}
    setContextMenu = vi.fn()
    setToolTip = vi.fn()
    setImage = vi.fn()
    destroy = vi.fn()
    displayBalloon = vi.fn()
    constructor() {
      if (electron.failTray) throw new Error('no tray host')
      electron.trays.push(this)
    }
    on(event: string, handler: () => void): void {
      this.handlers[event] = handler
    }
  }
}))

import {
  compositeBitmap,
  dockMenuTemplate,
  SystemTray,
  trayMenuTemplate,
  trayTooltip,
  updateMenuItem,
  type TrayActions,
  type TraySnapshot
} from './systemTray'

function actions(): TrayActions {
  return {
    open: vi.fn(),
    newChat: vi.fn(),
    openConversation: vi.fn(),
    openSettings: vi.fn(),
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
    openRelease: vi.fn(),
    quit: vi.fn()
  }
}

function snapshot(overrides: Partial<TraySnapshot> = {}): TraySnapshot {
  return {
    workingCount: 0,
    waiting: [],
    update: { currentVersion: '1.0.0', status: 'idle' },
    ...overrides
  }
}

function labels(template: MenuItemConstructorOptions[]): Array<string | undefined> {
  return template.map((item) => (item.type === 'separator' ? '---' : item.label))
}

describe('trayMenuTemplate', () => {
  it('keeps an idle menu short: open, new chat, status, settings, updates, quit', () => {
    const template = trayMenuTemplate('SideKick', snapshot(), actions())
    expect(labels(template)).toEqual([
      'Open SideKick',
      'New Chat',
      '---',
      'No chats working',
      '---',
      'Settings…',
      'Check for Updates…',
      '---',
      'Quit SideKick'
    ])
    expect(template.find((item) => item.label === 'No chats working')?.enabled).toBe(false)
  })

  it('wires each entry to its action', () => {
    const tray = actions()
    const template = trayMenuTemplate('SideKick', snapshot(), tray)
    const click = (label: string): void =>
      (template.find((item) => item.label === label)?.click as () => void)()
    click('Open SideKick')
    click('New Chat')
    click('Settings…')
    click('Check for Updates…')
    click('Quit SideKick')
    expect(tray.open).toHaveBeenCalledOnce()
    expect(tray.newChat).toHaveBeenCalledOnce()
    expect(tray.openSettings).toHaveBeenCalledOnce()
    expect(tray.checkForUpdates).toHaveBeenCalledOnce()
    expect(tray.quit).toHaveBeenCalledOnce()
  })

  it('lists the chats waiting on the user, oldest first, and jumps to the one chosen', () => {
    const tray = actions()
    const waiting = [
      { id: 'a', title: 'Fix the login & signup flow' },
      { id: 'b', title: '' },
      { id: 'c', title: 'A title that is much too long to fit in a tray menu entry' },
      { id: 'd', title: 'Fourth' },
      { id: 'e', title: 'Fifth' }
    ]
    const template = trayMenuTemplate('SideKick', snapshot({ waiting, workingCount: 1 }), tray)
    expect(labels(template).slice(3, 9)).toEqual([
      '5 chats waiting for you',
      // A lone & would become a keyboard mnemonic.
      'Fix the login && signup flow',
      'Untitled chat',
      'A title that is much too long to fit in…',
      '2 more in SideKick',
      '1 chat working'
    ])
    ;(template[4].click as () => void)()
    expect(tray.openConversation).toHaveBeenCalledWith('a')
  })
})

describe('updateMenuItem', () => {
  const update = {
    version: '2.0.0',
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    releaseUrl: 'https://example.invalid'
  }

  it('narrates a check in progress and offers the restart once an update is ready', () => {
    const tray = actions()
    const base = { currentVersion: '1.0.0' }
    expect(updateMenuItem({ ...base, status: 'checking' }, tray)).toMatchObject({
      label: 'Checking for Updates…',
      enabled: false
    })
    expect(
      updateMenuItem({ ...base, status: 'downloading', update, percent: 41.6 } as never, tray)
    ).toMatchObject({ label: 'Downloading Update… 42%', enabled: false })
    const ready = updateMenuItem({ ...base, status: 'ready', update } as never, tray)
    expect(ready.label).toBe('Restart to Update to 2.0.0')
    ;(ready.click as () => void)()
    expect(tray.installUpdate).toHaveBeenCalledOnce()
    const available = updateMenuItem({ ...base, status: 'available', update } as never, tray)
    ;(available.click as () => void)()
    expect(tray.openRelease).toHaveBeenCalledOnce()
    expect(
      updateMenuItem({ ...base, status: 'error', message: 'offline' } as never, tray).label
    ).toBe('Check for Updates…')
  })
})

describe('trayTooltip', () => {
  it('names the product, then what is working and waiting', () => {
    expect(trayTooltip('SideKick', snapshot())).toBe('SideKick')
    expect(trayTooltip('SideKick', snapshot({ workingCount: 2 }))).toBe(
      'SideKick — 2 chats working'
    )
    expect(
      trayTooltip('SideKick', snapshot({ workingCount: 1, waiting: [{ id: 'a', title: 'A' }] }))
    ).toBe('SideKick — 1 chat working, 1 chat waiting for you')
  })
})

describe('dockMenuTemplate', () => {
  it('adds only what the Dock lacks: a new chat and the waiting chats', () => {
    expect(labels(dockMenuTemplate(snapshot(), actions()))).toEqual(['New Chat'])
    expect(
      labels(dockMenuTemplate(snapshot({ waiting: [{ id: 'a', title: 'Deploy' }] }), actions()))
    ).toEqual(['New Chat', '---', '1 chat waiting for you', 'Deploy'])
  })
})

describe('compositeBitmap', () => {
  it('draws premultiplied pixels over the base and clips at its edges', () => {
    const base = Buffer.alloc(2 * 2 * 4, 100)
    // Its right column falls outside the base; its left holds an opaque pixel
    // above a half-transparent one, both premultiplied.
    const overlay = Buffer.from([200, 0, 0, 255, 9, 9, 9, 255, 50, 50, 50, 128, 9, 9, 9, 255])
    const result = compositeBitmap(base, 2, overlay, 2, 1, 0)
    expect([...result.subarray(0, 4)]).toEqual([100, 100, 100, 100])
    expect([...result.subarray(4, 8)]).toEqual([200, 0, 0, 255])
    expect([...result.subarray(8, 12)]).toEqual([100, 100, 100, 100])
    expect(result[12]).toBe(Math.round(50 + 100 * (1 - 128 / 255)))
    expect(base[4]).toBe(100)
  })
})

describe('SystemTray', () => {
  let tray: TrayActions
  let state: TraySnapshot

  function create(platform: NodeJS.Platform = 'win32'): SystemTray {
    return new SystemTray({
      platform,
      productName: 'SideKick',
      iconPath: 'icon.png',
      snapshot: () => state,
      actions: tray
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    electron.trays.length = 0
    electron.notices.length = 0
    electron.failTray = false
    electron.notificationsSupported = true
    tray = actions()
    state = snapshot()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the window on a click and shows the menu and tooltip', () => {
    const systemTray = create()
    expect(systemTray.install()).toBe(true)
    expect(systemTray.installed).toBe(true)
    const [icon] = electron.trays
    icon.handlers.click()
    expect(tray.open).toHaveBeenCalledOnce()
    expect(icon.setContextMenu).toHaveBeenCalledOnce()
    expect(icon.setToolTip).toHaveBeenCalledWith('SideKick')
    // Windows gets a crisp icon for each display scale.
    expect(electron.addRepresentation).toHaveBeenCalledWith(
      expect.objectContaining({ scaleFactor: 2, width: 32, height: 32 })
    )
  })

  it('marks the icon while a chat waits, and rebuilds only when something changed', () => {
    vi.useFakeTimers()
    const systemTray = create()
    systemTray.install()
    const [icon] = electron.trays
    systemTray.refresh()
    systemTray.refresh()
    vi.runAllTimers()
    expect(icon.setContextMenu).toHaveBeenCalledOnce()

    state = snapshot({ waiting: [{ id: 'a', title: 'A' }] })
    systemTray.refresh()
    systemTray.refresh()
    vi.runAllTimers()
    expect(icon.setContextMenu).toHaveBeenCalledTimes(2)
    expect(icon.setImage).toHaveBeenCalledOnce()
    expect(icon.setToolTip).toHaveBeenLastCalledWith('SideKick — 1 chat waiting for you')

    state = snapshot({ waiting: [{ id: 'a', title: 'A' }], workingCount: 1 })
    systemTray.render()
    // Still waiting, so the icon keeps its mark.
    expect(icon.setImage).toHaveBeenCalledOnce()

    state = snapshot()
    systemTray.render()
    expect(icon.setImage).toHaveBeenCalledTimes(2)
  })

  it('reports no tray when the desktop cannot host one, so closing keeps its meaning', () => {
    electron.failTray = true
    const systemTray = create('linux')
    expect(systemTray.install()).toBe(false)
    expect(systemTray.installed).toBe(false)
    systemTray.refresh()
    systemTray.render()
    expect(electron.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('uses the Dock menu on macOS instead of a menu-bar icon', () => {
    const systemTray = create('darwin')
    expect(systemTray.install()).toBe(true)
    expect(electron.trays).toHaveLength(0)
    expect(electron.dock.setMenu).toHaveBeenCalledOnce()
    systemTray.destroy()
    expect(electron.buildFromTemplate).toHaveBeenLastCalledWith([])
  })

  it('removes the icon when destroyed', () => {
    const systemTray = create()
    systemTray.install()
    systemTray.destroy()
    expect(electron.trays[0].destroy).toHaveBeenCalledOnce()
    expect(systemTray.installed).toBe(false)
  })

  it('explains where the window went, and brings it back when the notice is clicked', () => {
    const systemTray = create()
    systemTray.install()
    systemTray.showHiddenNotice()
    const [notice] = electron.notices
    expect(notice.options).toMatchObject({
      title: 'SideKick is still running',
      body: expect.stringContaining('notification area')
    })
    notice.handlers.click()
    expect(tray.open).toHaveBeenCalledOnce()

    create('linux').showHiddenNotice()
    expect(electron.notices[1].options).toMatchObject({
      body: expect.stringContaining('open SideKick again')
    })
  })

  it('falls back to a tray balloon on Windows without notifications', () => {
    electron.notificationsSupported = false
    const systemTray = create()
    systemTray.install()
    systemTray.showHiddenNotice()
    expect(electron.trays[0].displayBalloon).toHaveBeenCalledOnce()
  })
})
