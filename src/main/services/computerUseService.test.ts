import { describe, expect, it, vi } from 'vitest'
import {
  computerAppAccess,
  matchInstalledApp,
  parseComputerApps,
  type ComputerApp
} from './computerUseApps'
import {
  COMPUTER_DRIVER_TOOLS,
  computerDriverEnvironment,
  computerDriverManifest,
  computerActionPoint
} from './computerUseDriver'
import { ComputerUseService, type ComputerTeachStep } from './computerUseService'
import {
  parseComputerScreen,
  parseComputerWindows,
  type ComputerAppWindow,
  type ComputerPopup,
  type ComputerUseWindows
} from './computerUseWindows'

const app = (name: string, pid = 10): ComputerApp => {
  const path = `C:\\Apps\\${name}.exe`
  return { pid, name, path, access: computerAppAccess(path) }
}
const signal = new AbortController().signal

function harness(apps: ComputerApp[], confirm = true) {
  const call = vi.fn(async (tool: string, _args?: Record<string, unknown>) => ({
    isError: false,
    images: [] as Array<{ mimeType: string; data: string }>,
    structured: undefined as unknown,
    text:
      tool === 'get_window_state'
        ? 'window_id=77 pid=10 elements=1 snapshot_id=s1\n- [0] Button "OK"'
        : 'ok'
  }))
  const startDriver = vi.fn(async () => ({ call, close: vi.fn(async () => undefined) }))
  const confirmApp = vi.fn(async () => confirm)
  const userIdleSeconds = vi.fn(() => 60)
  const installed: ComputerApp[] = []
  const startApp = vi.fn((path: string) => {
    const started = installed.find((a) => a.path === path)
    if (started) apps.push({ ...started, pid: 10 })
  })
  const disarm = vi.fn()
  const armStop = vi.fn((_stop: () => void) => disarm)
  const showActive = vi.fn()
  const restoreForeground = vi.fn(async (_window: number) => true)
  const appWindows = {
    text: vi.fn(async (_window: number, _text: string) => false),
    key: vi.fn(async (_window: number, _vk: number) => false),
    wheel: vi.fn(
      async (
        _window: number,
        _direction: 'up' | 'down',
        _ticks: number,
        _point: { x: number; y: number }
      ) => false
    ),
    restore: restoreForeground,
    visible: vi.fn(async (_window: number) => true),
    front: vi.fn(async () => 0),
    controlAt: vi.fn(async (_pid: number, _point: { x: number; y: number }) => ''),
    ignoresPostedClicks: vi.fn(async (_window: number) => false),
    isWebBased: vi.fn(async (_window: number) => false),
    pressControl: vi.fn(
      async (_window: number, _control: { label: string; actions: readonly string[] }) => true
    ),
    expandStates: vi.fn(async (_window: number) => []),
    otherAppAt: vi.fn(async (_window: number, _point: { x: number; y: number }) => false),
    windowsOf: vi.fn(
      async (_pid: number): Promise<ComputerAppWindow[]> => [
        { id: 77, title: 'Window', bounds: null }
      ]
    ),
    pointer: vi.fn(async () => ({ x: 900, y: 900 }) as { x: number; y: number } | null),
    pointerTo: vi.fn(async (_point: { x: number; y: number }) => true),
    pathOf: vi.fn(async (_pid: number) => 'C:\\Windows\\System32\\ApplicationFrameHost.exe'),
    popups: vi.fn(async (_window: number) => [] as ComputerPopup[]),
    restoreBehind: vi.fn(async (_pid: number) => 0),
    minimizeAgain: vi.fn(async (_window: number) => true),
    mouseButton: vi.fn(async (_button: string, _down: boolean) => true),
    keyState: vi.fn(async (_vk: number, _down: boolean) => true),
    clipboardInfo: vi.fn(
      async () =>
        ({ sequence: 5, owner: 0, hasText: true, markedPrivate: false }) as Awaited<
          ReturnType<ComputerUseWindows['clipboardInfo']>
        >
    ),
    clipboardText: vi.fn(
      async (_evenPrivate: boolean) =>
        ({ sequence: 5, text: 'copied' }) as { sequence: number; text: string } | null
    ),
    clipboardWrite: vi.fn(async (_text: string, _notForHistory: boolean) => 6),
    clipboardSave: vi.fn(async () => true),
    clipboardRestore: vi.fn(async (_sequence: number) => true),
    clipboardForget: vi.fn(async () => true),
    screen: vi.fn(
      async (_display: number, _maxWidth: number, _hidden: readonly string[]) =>
        null as Awaited<ReturnType<ComputerUseWindows['screen']>>
    )
  }
  const hideActive = vi.fn()
  const moveCursor = vi.fn()
  const confirmAccess = vi.fn(
    async (_what: 'screen' | 'clipboard', _signal: AbortSignal) => confirm
  )
  const showTeachStep = vi.fn(
    async (_step: ComputerTeachStep, _signal: AbortSignal) => 'next' as 'next' | 'exit'
  )
  const hideTeachStep = vi.fn()
  const service = new ComputerUseService({
    driverPath: 'C:\\driver\\cua-driver.exe',
    dataFolder: () => 'C:\\data',
    confirmApp,
    confirmAccess,
    showTeachStep,
    hideTeachStep,
    userIdleSeconds,
    appWindows,
    startApp,
    armStop,
    notifyActive: vi.fn(),
    showActive,
    hideActive,
    moveCursor,
    showPreview: vi.fn(),
    listApps: async () => apps,
    findInstalled: async (name) => installed.find((a) => a.name.toLowerCase() === name) ?? null,
    startDriver: startDriver as never,
    setTimer: (() => 0) as never
  })
  return {
    service,
    call,
    startDriver,
    confirmApp,
    confirmAccess,
    showTeachStep,
    hideTeachStep,
    userIdleSeconds,
    installed,
    startApp,
    armStop,
    disarm,
    restoreForeground,
    appWindows,
    showActive,
    hideActive,
    moveCursor
  }
}

/** A driver that takes this tool only with the real mouse and keyboard, as Chrome does for typing. */
function needsForeground(call: ReturnType<typeof harness>['call'], tool: string): void {
  call.mockImplementation(async (name, args) => ({
    isError: name === tool && args?.delivery_mode !== 'foreground',
    images: [] as Array<{ mimeType: string; data: string }>,
    text:
      name === tool && args?.delivery_mode !== 'foreground'
        ? 'Background delivery is not available for target window class'
        : 'ok',
    structured:
      name === 'bring_to_front'
        ? { landed_on_target: true, previous_fg_hwnd: '0x9', target_hwnd: '0x4d' }
        : undefined
  }))
}

describe('the clipboard', () => {
  const passwords = { sequence: 5, owner: 44, hasText: true, markedPrivate: false }

  it('never reads what was marked private, whoever asks', async () => {
    const { service, appWindows, confirmAccess } = harness([app('notes')])
    appWindows.clipboardInfo.mockResolvedValue({ ...passwords, markedPrivate: true })
    await expect(service.readClipboard('chat', signal)).rejects.toThrow('marked private')
    expect(confirmAccess).not.toHaveBeenCalled()
    expect(appWindows.clipboardText).not.toHaveBeenCalled()
  })

  it('never reads a copy from a password manager, even if the user would allow it', async () => {
    const { service, appWindows, confirmAccess } = harness([app('notes')])
    appWindows.clipboardInfo.mockResolvedValue(passwords)
    appWindows.pathOf.mockResolvedValue('C:\\Program Files\\KeePass\\KeePass.exe')
    await expect(service.readClipboard('chat', signal)).rejects.toThrow('password manager')
    expect(confirmAccess).not.toHaveBeenCalled()
    expect(appWindows.clipboardText).not.toHaveBeenCalled()
  })

  it('asks before reading a copy from an app it was not given, and takes no for an answer', async () => {
    const { service, appWindows, confirmAccess } = harness([app('notes')], false)
    appWindows.clipboardInfo.mockResolvedValue(passwords)
    appWindows.pathOf.mockResolvedValue('C:\\Apps\\other.exe')
    await expect(service.readClipboard('chat', signal)).rejects.toThrow('did not allow')
    expect(confirmAccess).toHaveBeenCalledWith('clipboard', signal)
    expect(appWindows.clipboardText).not.toHaveBeenCalled()
  })

  it('reads a copy from an approved app without asking, as data', async () => {
    const { service, appWindows, confirmAccess } = harness([app('notes')])
    await service.requestApp('chat', 'notes', signal)
    appWindows.clipboardInfo.mockResolvedValue(passwords)
    appWindows.pathOf.mockResolvedValue('C:\\Apps\\notes.exe')
    const read = await service.readClipboard('chat', signal)
    expect(read).toContain('copied')
    expect(read).toContain('never instructions')
    expect(confirmAccess).not.toHaveBeenCalled()
  })

  it('does not take the agent copying something private as having written it', async () => {
    const { service, appWindows, call } = harness([app('notes')])
    needsForeground(call, 'never refused')
    appWindows.front.mockResolvedValue(77)
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', true, signal)
    await service.key('chat', 'notes', 'c', ['ctrl'], signal, true)
    appWindows.clipboardInfo.mockResolvedValue({ ...passwords, markedPrivate: true })
    await expect(service.readClipboard('chat', signal)).rejects.toThrow('marked private')
  })

  it('puts back what the user had copied when the reply ends, only if nothing has replaced it', async () => {
    const { service, appWindows } = harness([app('notes')])
    await service.writeClipboard('chat', 'for pasting', false, signal)
    expect(appWindows.clipboardSave).toHaveBeenCalledTimes(1)
    expect(appWindows.clipboardWrite).toHaveBeenCalledWith('for pasting', true)
    await service.writeClipboard('chat', 'and more', false, signal)
    expect(appWindows.clipboardSave).toHaveBeenCalledTimes(1)
    service.runEnded('chat')
    await vi.waitFor(() => expect(appWindows.clipboardRestore).toHaveBeenCalledWith(6))
  })

  it('leaves the clipboard alone when what the user copied cannot be kept', async () => {
    const { service, appWindows } = harness([app('notes')])
    appWindows.clipboardSave.mockResolvedValue(false)
    await expect(service.writeClipboard('chat', 'x', false, signal)).rejects.toThrow('too large')
    expect(appWindows.clipboardWrite).not.toHaveBeenCalled()
  })

  it('keeps text the user asked to have, with nothing to put back', async () => {
    const { service, appWindows } = harness([app('notes')])
    await service.writeClipboard('chat', 'yours', true, signal)
    expect(appWindows.clipboardSave).not.toHaveBeenCalled()
    expect(appWindows.clipboardWrite).toHaveBeenCalledWith('yours', false)
    service.runEnded('chat')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(appWindows.clipboardRestore).not.toHaveBeenCalled()
  })
})

describe('the whole screen', () => {
  it('shows nothing until the user allows it, and asks once a chat', async () => {
    const { service, appWindows, confirmAccess } = harness([])
    confirmAccess.mockResolvedValueOnce(false)
    await expect(service.lookAtScreen('chat', 0, signal)).rejects.toThrow('did not allow')
    expect(appWindows.screen).not.toHaveBeenCalled()
    appWindows.screen.mockResolvedValue({
      display: 0,
      displays: 1,
      bounds: { x: 0, y: 0, width: 2000, height: 1000 },
      width: 1000,
      height: 500,
      data: 'cGlj',
      windows: [
        {
          path: 'C:\\Apps\\notes.exe',
          bounds: { x: 200, y: 100, width: 400, height: 200 },
          hidden: false
        },
        {
          path: 'C:\\Apps\\KeePass.exe',
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          hidden: true
        }
      ]
    })
    const seen = await service.lookAtScreen('chat', 0, signal)
    await service.lookAtScreen('chat', 0, signal)
    expect(confirmAccess).toHaveBeenCalledTimes(2)
    expect(seen.text).toContain('- notes: 100,50 to 300,150')
    expect(seen.text).toContain('- Hidden by SideKick: 0,0 to 50,50')
    expect(seen.text).not.toContain('KeePass')
  })

  it('blanks password managers, security prompts and SideKick', async () => {
    const { service, appWindows } = harness([])
    await expect(service.lookAtScreen('chat', 0, signal)).rejects.toThrow('no picture')
    const hidden = appWindows.screen.mock.calls[0][2]
    for (const name of ['keepass', '1password', 'consent', 'lockapp', 'sidekick', 'electron']) {
      expect(hidden).toContain(name)
    }
  })

  it('has to be allowed again after Esc', async () => {
    const { service, confirmAccess, appWindows } = harness([])
    appWindows.screen.mockResolvedValue(parseComputerScreen('0,1,0,0,10,10,10,10;;cGlj'))
    await service.lookAtScreen('chat', 0, signal)
    await service.stop()
    await service.lookAtScreen('chat', 0, signal)
    expect(confirmAccess).toHaveBeenCalledTimes(2)
  })
})

describe('a held mouse button', () => {
  const ready = async (idle = 60) => {
    const parts = harness([app('notes')])
    needsForeground(parts.call, 'never refused')
    parts.userIdleSeconds.mockReturnValue(idle)
    parts.appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'Window', bounds: { x: 0, y: 0, width: 1000, height: 800 } }
    ])
    await parts.service.requestApp('chat', 'notes', signal)
    await parts.service.look('chat', 'notes', true, signal)
    parts.appWindows.front.mockResolvedValue(77)
    parts.appWindows.pointer.mockResolvedValue({ x: 1, y: 2 })
    return parts
  }

  it('lets go when the reply ends, so the user is never left with it down', async () => {
    const { service, appWindows } = await ready()
    await service.mouseDown('chat', 'notes', { x: 1, y: 2 }, signal)
    expect(appWindows.mouseButton).toHaveBeenLastCalledWith('left', true)
    service.runEnded('chat')
    await vi.waitFor(() => expect(appWindows.mouseButton).toHaveBeenLastCalledWith('left', false))
  })

  it('lets go when stopped with Esc', async () => {
    const { service, appWindows } = await ready()
    await service.mouseDown('chat', 'notes', { x: 1, y: 2 }, signal)
    await service.stop()
    expect(appWindows.mouseButton).toHaveBeenLastCalledWith('left', false)
  })

  it('lets go when the user moves the mouse, and says so', async () => {
    const { service, appWindows } = await ready()
    await service.mouseDown('chat', 'notes', { x: 1, y: 2 }, signal)
    appWindows.pointer.mockResolvedValue({ x: 300, y: 300 })
    await vi.waitFor(() => expect(appWindows.mouseButton).toHaveBeenLastCalledWith('left', false))
    await vi.waitFor(() =>
      expect(service.mouseUp('chat', 'notes', {}, signal)).rejects.toThrow('moved the mouse')
    )
  })

  it("won't press or release on a risky control unasked", async () => {
    const { service, appWindows } = await ready()
    appWindows.controlAt.mockResolvedValue('Button Delete')
    await expect(service.mouseDown('chat', 'notes', { x: 1, y: 2 }, signal)).rejects.toThrow(
      'may not be reversible'
    )
    expect(appWindows.mouseButton).not.toHaveBeenCalled()
    appWindows.controlAt.mockResolvedValue('Pane')
    await service.mouseDown('chat', 'notes', { x: 1, y: 2 }, signal)
    appWindows.controlAt.mockResolvedValue('Button Delete')
    await expect(service.hover('chat', 'notes', { x: 5, y: 5 }, signal)).rejects.toThrow(
      'may not be reversible'
    )
    await expect(service.mouseUp('chat', 'notes', { x: 5, y: 5 }, signal)).rejects.toThrow(
      'may not be reversible'
    )
    expect(appWindows.mouseButton).toHaveBeenCalledTimes(1)
    await service.letGo('test')
  })

  it("won't click somewhere else while it is down", async () => {
    const { service } = await ready()
    await service.mouseDown('chat', 'notes', { x: 1, y: 2 }, signal)
    await expect(service.click('chat', 'notes', { x: 5, y: 5 }, signal)).rejects.toThrow('held')
    await service.mouseUp('chat', 'notes', {}, signal)
  })

  it('is never for software that controls equipment', async () => {
    const twincat = app('TcXaeShell')
    const { service, appWindows } = harness([twincat])
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'Window', bounds: { x: 0, y: 0, width: 1000, height: 800 } }
    ])
    await service.requestApp('chat', 'TcXaeShell', signal)
    await service.look('chat', 'TcXaeShell', true, signal)
    await expect(service.mouseDown('chat', 'TcXaeShell', { x: 1, y: 2 }, signal)).rejects.toThrow(
      'equipment'
    )
    await expect(service.holdKey('chat', 'TcXaeShell', 'a', 1, signal)).rejects.toThrow('equipment')
    expect(appWindows.mouseButton).not.toHaveBeenCalled()
    expect(appWindows.keyState).not.toHaveBeenCalled()
  })
})

describe('a held key', () => {
  it('lets go as soon as the app stops being in front', async () => {
    const { service, appWindows } = harness([app('notes')])
    await service.requestApp('chat', 'notes', signal)
    appWindows.front.mockResolvedValue(77)
    const holding = service.holdKey('chat', 'notes', 'a', 5, signal)
    await vi.waitFor(() => expect(appWindows.keyState).toHaveBeenCalledWith(0x41, true))
    appWindows.front.mockResolvedValue(99)
    await expect(holding).resolves.toContain('stopped being in front')
    expect(appWindows.keyState).toHaveBeenLastCalledWith(0x41, false)
  })

  it("won't hold Esc, the Windows key, or something that isn't one key", async () => {
    const { service, appWindows } = harness([app('notes')])
    await service.requestApp('chat', 'notes', signal)
    for (const key of ['escape', 'esc', 'win', 'ctrl+alt+delete', 'scroll_lock']) {
      await expect(service.holdKey('chat', 'notes', key, 1, signal)).rejects.toThrow()
    }
    expect(appWindows.keyState).not.toHaveBeenCalled()
  })
})

describe('a walkthrough', () => {
  it('waits for the user, and nothing else can act while it does', async () => {
    const { service, showTeachStep, appWindows } = harness([app('notes')])
    appWindows.front.mockResolvedValue(77)
    await service.requestApp('chat', 'notes', signal)
    let answer: (value: 'next' | 'exit') => void = () => undefined
    showTeachStep.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const step = service.teach('chat', 'notes', { text: 'Open the menu', nextDoes: 1 }, signal)
    await vi.waitFor(() => expect(showTeachStep).toHaveBeenCalled())
    await expect(service.click('chat', 'notes', { x: 1, y: 1 }, signal)).rejects.toThrow(
      'walkthrough'
    )
    answer('next')
    await expect(step).resolves.toBe('next')
  })

  it('treats Next as the go-ahead for real input, even with the user just having clicked', async () => {
    const { service, userIdleSeconds, call, appWindows } = harness([app('notes')])
    needsForeground(call, 'never refused')
    appWindows.front.mockResolvedValue(77)
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', true, signal)
    userIdleSeconds.mockReturnValue(0)
    await service.teach('chat', 'notes', { text: 'Now this', nextDoes: 1 }, signal)
    await service.click('chat', 'notes', { x: 1, y: 1 }, signal, true)
    expect(call).toHaveBeenCalledWith(
      'click',
      expect.objectContaining({ delivery_mode: 'foreground' }),
      signal
    )
  })

  it('ends when stopped, which answers an open step', async () => {
    const { service, showTeachStep, hideTeachStep, appWindows } = harness([app('notes')])
    appWindows.front.mockResolvedValue(77)
    await service.requestApp('chat', 'notes', signal)
    let answer: (value: 'next' | 'exit') => void = () => undefined
    showTeachStep.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    hideTeachStep.mockImplementation(() => answer('exit'))
    const step = service.teach('chat', 'notes', { text: 'Open the menu', nextDoes: 0 }, signal)
    await vi.waitFor(() => expect(showTeachStep).toHaveBeenCalled())
    await service.stop()
    await expect(step).resolves.toBe('exit')
  })
})

describe('what the agent may reach', () => {
  it.each([
    'KeePass',
    'Bitwarden',
    'consent',
    'LogonUI',
    'LockApp',
    'SideKick',
    'electron',
    'cua-driver'
  ])('never offers %s, however it is spelled', async (name) => {
    for (const spelled of [name, name.toUpperCase(), `${name}.exe`]) {
      const { service, confirmApp } = harness([app(name)])
      await expect(service.requestApp('chat', spelled, signal)).rejects.toThrow('cannot be used')
      expect(confirmApp).not.toHaveBeenCalled()
    }
    expect(await harness([app(name)]).service.apps(signal)).not.toContain(name)
  })

  it('judges an app by its real path, not a friendly name', () => {
    expect(computerAppAccess('C:\\Windows\\System32\\consent.exe').kind).toBe('blocked')
    expect(computerAppAccess('C:\\Tools\\notes\\KEEPASS.EXE').kind).toBe('blocked')
    expect(computerAppAccess('C:\\Windows\\System32\\charmap.exe').kind).toBe('allowed')
  })

  it.each(['cmd', 'WindowsTerminal', 'code', 'explorer', 'regedit', 'chrome', 'firefox'])(
    'lets the user allow %s, only after a warning about what it hands over',
    async (name) => {
      const { service, confirmApp } = harness([app(name)])
      expect(computerAppAccess(`C:\\Apps\\${name}.exe`)).toMatchObject({
        kind: 'powerful',
        warning: expect.stringMatching(/.+/)
      })
      await service.requestApp('chat', name, signal)
      expect(confirmApp).toHaveBeenCalledTimes(1)
    }
  )

  it('starts an installed app only after approval, and never one it may not offer', async () => {
    const denied = harness([], false)
    denied.installed.push(app('notes'))
    await expect(denied.service.requestApp('chat', 'notes', signal)).rejects.toThrow(
      'did not allow'
    )
    expect(denied.startApp).not.toHaveBeenCalled()

    const blocked = harness([])
    blocked.installed.push(app('KeePass'))
    await expect(blocked.service.requestApp('chat', 'keepass', signal)).rejects.toThrow(
      'cannot be used'
    )
    expect(blocked.confirmApp).not.toHaveBeenCalled()
    expect(blocked.startApp).not.toHaveBeenCalled()

    const allowed = harness([])
    allowed.installed.push(app('notes'))
    await expect(allowed.service.requestApp('chat', 'notes', signal)).resolves.toContain('started')
    expect(allowed.confirmApp).toHaveBeenCalledWith(expect.anything(), signal, true)
    expect(allowed.startApp).toHaveBeenCalledWith('C:\\Apps\\notes.exe')
  })

  it('finds a Start Menu app by its executable or shortcut name', () => {
    const stdout =
      '[{"Name":"Google Chrome","Path":"C:\\\\Apps\\\\chrome.exe"},{"Name":"Notes","Path":"C:\\\\Apps\\\\n.exe"}]'
    expect(matchInstalledApp(stdout, 'chrome')).toMatchObject({ name: 'chrome', pid: 0 })
    expect(matchInstalledApp(stdout, 'google chrome')).toMatchObject({ name: 'chrome' })
    expect(matchInstalledApp(stdout, 'calc')).toBeNull()
  })

  it('keeps the app in front through real input, and gives the front back when the reply ends', async () => {
    const { service, call, restoreForeground, appWindows } = harness([app('notes')])
    needsForeground(call, 'scroll')
    await service.requestApp('chat', 'notes', signal)
    await service.scroll('chat', 'notes', 'up', 1, { x: 5, y: 6 }, signal, true)
    const tools = call.mock.calls.map(([tool]) => tool)
    expect(tools.indexOf('bring_to_front')).toBeGreaterThan(-1)
    expect(tools.lastIndexOf('scroll')).toBeGreaterThan(tools.indexOf('bring_to_front'))
    expect(call).toHaveBeenLastCalledWith(
      'scroll',
      expect.objectContaining({ delivery_mode: 'foreground', amount: 2, x: 5, y: 6 }),
      signal
    )
    expect(restoreForeground).not.toHaveBeenCalled()
    appWindows.front.mockResolvedValue(77)
    service.runEnded('chat')
    await vi.waitFor(() => expect(restoreForeground).toHaveBeenCalledWith(9))
  })

  it('leaves the user alone if they have already moved on when the reply ends', async () => {
    const { service, call, restoreForeground, appWindows } = harness([app('notes')])
    needsForeground(call, 'scroll')
    await service.requestApp('chat', 'notes', signal)
    await service.scroll('chat', 'notes', 'up', 1, {}, signal, true)
    appWindows.front.mockResolvedValue(500)
    service.runEnded('chat')
    await vi.waitFor(() => expect(appWindows.front).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(restoreForeground).not.toHaveBeenCalled()
  })

  it('does not stop itself when the agent presses Esc with real input', async () => {
    const { service, call, armStop, confirmApp } = harness([app('notes')])
    needsForeground(call, 'press_key')
    await service.requestApp('chat', 'notes', signal)
    await service.key('chat', 'notes', 'escape', [], signal, true)
    const disarmed = armStop.mock.results[0].value as ReturnType<typeof vi.fn>
    expect(disarmed).toHaveBeenCalled()
    expect(armStop.mock.calls.length).toBeGreaterThan(1)
    await service.key('chat', 'notes', 'a', [], signal, true)
    expect(confirmApp).toHaveBeenCalledTimes(1)
  })

  it('tries the background first, without asking and without real input', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    needsForeground(call, 'type_text')
    appWindows.text.mockResolvedValue(true)
    await service.requestApp('chat', 'notes', signal)
    await expect(service.type('chat', 'notes', 'hi', undefined, signal)).resolves.toContain(
      'in the background'
    )
    expect(appWindows.text).toHaveBeenCalledWith(77, 'hi')
    expect(call).not.toHaveBeenCalledWith('bring_to_front', expect.anything(), signal)
  })

  it('leaves real input to the agent: nothing happens unless it chooses that', async () => {
    const { service, call } = harness([app('notes')])
    needsForeground(call, 'type_text')
    await service.requestApp('chat', 'notes', signal)
    await expect(service.type('chat', 'notes', 'hi', undefined, signal)).rejects.toThrow(
      'real_input'
    )
    expect(call).not.toHaveBeenCalledWith('bring_to_front', expect.anything(), signal)
    expect(call).not.toHaveBeenCalledWith(
      'type_text',
      expect.objectContaining({ delivery_mode: 'foreground' }),
      signal
    )
  })

  it('uses real input when the agent asks, instead of trying the background again', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    needsForeground(call, 'never refused')
    await service.requestApp('chat', 'notes', signal)
    await service.click('chat', 'notes', { x: 1, y: 2 }, signal, true)
    expect(call).toHaveBeenCalledWith('bring_to_front', expect.anything(), signal)
    expect(call).toHaveBeenLastCalledWith(
      'click',
      expect.objectContaining({ delivery_mode: 'foreground' }),
      signal
    )
    expect(appWindows.text).not.toHaveBeenCalled()
  })

  it('says when a step changed nothing, whatever the driver claimed, then stops sending', async () => {
    const { service, call } = harness([app('notes')])
    const png = Buffer.from('same picture').toString('base64')
    const answer = call.getMockImplementation()!
    call.mockImplementation(async (tool, args) => ({
      ...(await answer(tool, args)),
      images: tool === 'get_window_state' ? [{ mimeType: 'image/png', data: png }] : []
    }))
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', true, signal)
    const notes: string[] = []
    for (let step = 0; step < 5; step++) {
      await service.scroll('chat', 'notes', 'up', 3, {}, signal)
      notes.push((await service.lookAfterAction('chat', 'notes', signal)).note)
    }
    expect(notes[0]).toContain('may not have landed')
    expect(notes[2]).toContain('stop and tell the user')
    await expect(service.scroll('chat', 'notes', 'up', 3, {}, signal)).rejects.toThrow(
      'changed nothing'
    )
    service.runEnded('chat')
    await service.requestApp('chat', 'notes', signal)
    await expect(service.scroll('chat', 'notes', 'up', 3, {}, signal)).resolves.toBeTruthy()
  }, 20_000)

  it('sends no click to an app that ignores them, and lets the agent choose real input', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    needsForeground(call, 'never refused')
    appWindows.ignoresPostedClicks.mockResolvedValue(true)
    await service.requestApp('chat', 'notes', signal)
    await expect(service.click('chat', 'notes', { x: 1, y: 2 }, signal)).rejects.toThrow(
      'ignores clicks'
    )
    expect(call).not.toHaveBeenCalledWith('click', expect.anything(), signal)
    await service.click('chat', 'notes', { x: 1, y: 2 }, signal, true)
    expect(call).toHaveBeenLastCalledWith(
      'click',
      expect.objectContaining({ delivery_mode: 'foreground' }),
      signal
    )
  })

  it('presses a named row in an app that ignores clicks, and hands the front back', async () => {
    const { service, call, appWindows, restoreForeground } = harness([app('notes')])
    const answer = call.getMockImplementation()!
    call.mockImplementation(async (tool, args) => ({
      ...(await answer(tool, args)),
      structured: {
        elements: [
          {
            element_index: 0,
            label: 'OK',
            actions: ['invoke'],
            frame: { x: 10, y: 10, w: 20, h: 20 }
          }
        ]
      }
    }))
    appWindows.ignoresPostedClicks.mockResolvedValue(true)
    appWindows.front.mockResolvedValueOnce(5).mockResolvedValue(77)
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', false, signal)
    await expect(service.click('chat', 'notes', { element: 0 }, signal)).resolves.toContain(
      'Click sent'
    )
    expect(appWindows.pressControl).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ label: 'OK', actions: ['invoke'] })
    )
    expect(restoreForeground).toHaveBeenCalledWith(5)
    expect(call).not.toHaveBeenCalledWith('click', expect.anything(), signal)
    // A press that finds nothing sent nothing, so the agent still gets to choose.
    appWindows.pressControl.mockResolvedValue(false)
    await expect(service.click('chat', 'notes', { element: 0 }, signal)).rejects.toThrow(
      'ignores clicks'
    )
  })

  it('sends no real click where another app is on top', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    needsForeground(call, 'never refused')
    appWindows.front.mockResolvedValue(77)
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'W', bounds: { x: 0, y: 0, width: 100, height: 100 } }
    ])
    await service.requestApp('chat', 'notes', signal)
    appWindows.otherAppAt.mockResolvedValueOnce(true)
    await expect(service.click('chat', 'notes', { x: 5, y: 5 }, signal, true)).rejects.toThrow(
      'on top of notes'
    )
    expect(call).not.toHaveBeenCalledWith('click', expect.anything(), signal)
    await service.click('chat', 'notes', { x: 5, y: 5 }, signal, true)
    expect(call).toHaveBeenCalledWith('click', expect.anything(), signal)
  })

  it('stops a real click on something risky once the app is in front to say what it is', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    needsForeground(call, 'never refused')
    appWindows.front.mockResolvedValue(77)
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'W', bounds: { x: 0, y: 0, width: 100, height: 100 } }
    ])
    await service.requestApp('chat', 'notes', signal)
    // Covered, so nothing could be said about the pixel the first time it was asked.
    appWindows.controlAt.mockResolvedValueOnce('').mockResolvedValueOnce('Button Delete')
    await expect(service.click('chat', 'notes', { x: 5, y: 5 }, signal, true)).rejects.toThrow(
      'Delete'
    )
    expect(call).not.toHaveBeenCalledWith('click', expect.anything(), signal)
  })

  it('refuses the shortcuts that belong to Windows, and leaves others alone', async () => {
    const { service, call } = harness([app('notes')])
    needsForeground(call, 'never refused')
    await service.requestApp('chat', 'notes', signal)
    for (const combination of [
      'alt+tab',
      'alt+shift+tab',
      'alt+f4',
      'ctrl+shift+esc',
      'ctrl+esc'
    ]) {
      await expect(service.key('chat', 'notes', combination, [], signal, true)).rejects.toThrow(
        'belongs to Windows'
      )
    }
    await service.key('chat', 'notes', 'ctrl+s', [], signal, true)
    await service.key('chat', 'notes', 'f4', [], signal, true)
    expect(call.mock.calls.filter(([tool]) => tool === 'press_key')).toHaveLength(2)
  })

  it('keeps the numbers of rows a long list leaves out, and can read them back', async () => {
    const { service, call } = harness([app('notes')])
    const rows = Array.from({ length: 150 }, (_, row) => `    - [${row}] Button "B${row}"`)
    const long = ['window_id=77 pid=10 snapshot_id=s1', '- Window "W"', '  - Pane "All"', ...rows]
    call.mockImplementation(async () => ({
      isError: false,
      images: [] as Array<{ mimeType: string; data: string }>,
      structured: undefined as unknown,
      text: long.join('\n')
    }))
    await service.requestApp('chat', 'notes', signal)
    const seen = await service.look('chat', 'notes', false, signal)
    expect(seen.text).toContain('Pane "All" (150 more inside: part 1)')
    expect(seen.text).not.toContain('B149')
    const part = await service.lookPart('chat', 'notes', 1, signal)
    expect(part.text).toContain('[149] Button "B149"')
    // Not listed, and still there to press.
    await service.click('chat', 'notes', { element: 149 }, signal)
    expect(call).toHaveBeenLastCalledWith(
      'click',
      expect.objectContaining({ element_token: 's1:149' }),
      signal
    )
    await expect(service.lookPart('chat', 'notes', 2, signal)).rejects.toThrow('no part 2')
  })

  it('stops before pressing something risky, whether by row or by pixel', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'W', bounds: { x: 0, y: 0, width: 100, height: 100 } }
    ])
    call.mockImplementation(async (tool) => ({
      isError: false,
      images: [] as Array<{ mimeType: string; data: string }>,
      structured: undefined as unknown,
      text:
        tool === 'get_window_state'
          ? 'window_id=77 pid=10 elements=2 snapshot_id=s1\nelement_token for row [1] is "s1:1"\n- [0] Button "OK"\n  - [1] Button "Delete account" [actions=[invoke]]'
          : 'ok'
    }))
    const sent = () => call.mock.calls.filter(([tool]) => tool === 'click')
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', false, signal)
    await expect(service.click('chat', 'notes', { element: 1 }, signal)).rejects.toThrow('Delete')
    appWindows.controlAt.mockResolvedValueOnce('Button Send')
    await expect(service.click('chat', 'notes', { x: 5, y: 5 }, signal)).rejects.toThrow('Send')
    expect(sent()).toHaveLength(0)
    await expect(service.click('chat', 'notes', { element: 0 }, signal)).resolves.toContain(
      'Click sent to Button "OK"'
    )
    await service.click('chat', 'notes', { element: 1 }, signal, false, true)
    expect(sent()).toHaveLength(2)
  })

  it('reads the size of a zoom picture, and fits a region that is too wide', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    const answer = call.getMockImplementation()!
    // A minimal JPEG: start, then a frame header 500 wide.
    const { createCanvas } = await import('@napi-rs/canvas')
    const picture = (width: number, height: number): string =>
      createCanvas(width, height).toBuffer('image/png').toString('base64')
    call.mockImplementation(async (tool, args) => ({
      ...(await answer(tool, args)),
      images:
        tool !== 'get_window_state'
          ? []
          : [
              {
                mimeType: 'image/png',
                data: args?.display_only ? picture(2000, 1000) : picture(1000, 500)
              }
            ]
    }))
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'W', bounds: { x: 0, y: 0, width: 1000, height: 500 } }
    ])
    await service.requestApp('chat', 'notes', signal)
    await expect(
      service.click('chat', 'notes', { x: 1, y: 1, fromZoom: true }, signal)
    ).rejects.toThrow('Use zoom first')
    await service.look('chat', 'notes', true, signal)
    const zoomed = await service.zoom('chat', 'notes', { x: 0, y: 0, toX: 1000, toY: 50 }, signal)
    // The middle 500 of the look is 1000 of the full picture, enlarged to 1200.
    const { loadImage } = await import('@napi-rs/canvas')
    expect((await loadImage(Buffer.from(zoomed.images[0].data, 'base64'))).width).toBe(1200)
    await service.click('chat', 'notes', { x: 600, y: 60, fromZoom: true }, signal)
    expect(call).toHaveBeenLastCalledWith(
      'click',
      expect.objectContaining({ x: 500, y: 25 }),
      signal
    )
    expect(appWindows.controlAt).toHaveBeenCalledWith(10, { x: 500, y: 25 })
  })

  it('types tabs and line breaks as real keys, since they get lost as text', async () => {
    const { service, call } = harness([app('notes')])
    await service.requestApp('chat', 'notes', signal)
    await service.type('chat', 'notes', 'a\tb\r\nc', undefined, signal)
    const sent = call.mock.calls
      .filter(([tool]) => tool === 'type_text' || tool === 'press_key')
      .map(([, args]) => args?.text ?? args?.key)
    expect(sent).toEqual(['a', 'tab', 'b', 'return', 'c'])
  })

  it('never sends a key combination in the background, where it loses its modifier', async () => {
    const { service, call } = harness([app('notes')])
    needsForeground(call, 'never refused')
    await service.requestApp('chat', 'notes', signal)
    await expect(service.key('chat', 'notes', 's', ['ctrl'], signal)).rejects.toThrow('modifiers')
    expect(call).not.toHaveBeenCalledWith('press_key', expect.anything(), signal)
    await service.key('chat', 'notes', 's', ['ctrl'], signal, true)
    expect(call).toHaveBeenLastCalledWith(
      'press_key',
      expect.objectContaining({ modifiers: ['ctrl'], delivery_mode: 'foreground' }),
      signal
    )
  })

  it('works in a minimized app, and leaves it minimized as it found it', async () => {
    const { service, appWindows } = harness([app('notes')])
    await service.requestApp('chat', 'notes', signal)
    let shown: ComputerAppWindow[] = []
    appWindows.windowsOf.mockImplementation(async () => shown)
    appWindows.restoreBehind.mockImplementationOnce(async () => {
      shown = [{ id: 77, title: 'Window', bounds: null }]
      return 77
    })
    await service.look('chat', 'notes', false, signal)
    expect(appWindows.restoreBehind).toHaveBeenCalledWith(10)
    expect(appWindows.minimizeAgain).not.toHaveBeenCalled()
    service.runEnded('chat')
    await vi.waitFor(() => expect(appWindows.minimizeAgain).toHaveBeenCalledWith(77))
  })

  it('opens a window for an app running without one, as File Explorer does', async () => {
    const { service, appWindows, startApp } = harness([app('explorer')])
    let shown: ComputerAppWindow[] = []
    appWindows.windowsOf.mockImplementation(async () => shown)
    startApp.mockImplementation(() => {
      shown = [{ id: 77, title: 'Home', bounds: null }]
    })
    await service.requestApp('chat', 'explorer', signal)
    expect(startApp).toHaveBeenCalledWith('C:\\Apps\\explorer.exe')
    expect((await service.look('chat', 'explorer', false, signal)).controls).toBe(true)
  })

  it('finds a Store app by its Start menu name, and starts it through its entry', async () => {
    const { service, startApp, installed, confirmApp } = harness([])
    const running = [] as ComputerApp[]
    const calculator = { ...app('CalculatorApp'), startTarget: 'shell:AppsFolder\\calc!App' }
    const lookup = vi.fn(async () => calculator)
    installed.push(calculator)
    const custom = new ComputerUseService({
      ...(service as unknown as { deps: ConstructorParameters<typeof ComputerUseService>[0] }).deps,
      listApps: async () => running,
      findInstalled: lookup
    })
    startApp.mockImplementation(() => running.push(app('CalculatorApp')))
    await custom.requestApp('chat', 'Calculator', signal)
    expect(startApp).toHaveBeenCalledWith('shell:AppsFolder\\calc!App')
    expect(confirmApp).toHaveBeenCalledTimes(1)
    // The agent goes on calling it what it asked for.
    expect((await custom.look('chat', 'Calculator', false, signal)).controls).toBe(true)
  })

  it('refuses to act past the edge of the picture, where it would land on something else', async () => {
    const { service, call } = harness([app('notes')])
    const { createCanvas } = await import('@napi-rs/canvas')
    const data = createCanvas(1280, 672).toBuffer('image/png').toString('base64')
    const answer = call.getMockImplementation()!
    call.mockImplementation(async (tool, args) => ({
      ...(await answer(tool, args)),
      images: tool === 'get_window_state' ? [{ mimeType: 'image/png', data }] : [],
      structured: tool === 'get_window_state' ? { screenshot_height: 672 } : undefined
    }))
    await service.requestApp('chat', 'notes', signal)
    expect((await service.look('chat', 'notes', true, signal)).text).toContain('1280 by 672')
    await expect(service.click('chat', 'notes', { x: 10, y: 700 }, signal)).rejects.toThrow(
      'outside the picture'
    )
    expect(call).not.toHaveBeenCalledWith('click', expect.anything(), signal)
    await service.click('chat', 'notes', { x: 10, y: 600 }, signal)
    expect(call).toHaveBeenLastCalledWith('click', expect.objectContaining({ y: 600 }), signal)
  })

  it('gives an app time to open its editor after the first real key', async () => {
    const { service, call } = harness([app('notes')])
    needsForeground(call, 'never refused')
    await service.requestApp('chat', 'notes', signal)
    await service.type('chat', 'notes', 'Start', undefined, signal, true)
    const typed = call.mock.calls.filter(([tool]) => tool === 'type_text').map(([, a]) => a?.text)
    expect(typed).toEqual(['S', 'tart'])
  })

  it('keeps a picture behind a search, so a click by pixel still has one', async () => {
    const { service, call } = harness([app('notes')])
    await service.requestApp('chat', 'notes', signal)
    const found = await service.look('chat', 'notes', true, signal, undefined, 'OK')
    expect(call).toHaveBeenLastCalledWith(
      'get_window_state',
      expect.objectContaining({ include_screenshot: true, query: 'OK' }),
      signal
    )
    expect(found.images).toEqual([])
  })

  it('works in a Store app through its frame, and only ever that app\u2019s', async () => {
    const { service, call, appWindows, startDriver } = harness([app('notes')])
    appWindows.windowsOf.mockResolvedValue([{ id: 77, owner: 500, title: 'Notes', bounds: null }])
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', true, signal)
    expect(call).toHaveBeenLastCalledWith(
      'get_window_state',
      expect.objectContaining({ pid: 500, window_id: 77 }),
      signal
    )
    expect(JSON.stringify(startDriver.mock.calls.at(-1))).toContain('ApplicationFrameHost')
    await expect(service.look('chat', 'notes', true, signal, 88)).rejects.toThrow('no window 88')
    // Nothing but the known host may be added to what the driver can reach.
    appWindows.pathOf.mockResolvedValue('C:\\Apps\\other.exe')
    await expect(service.look('chat', 'notes', true, signal)).rejects.toThrow('no window')
  })

  it('refuses a key it has no name for, rather than typing the name', async () => {
    const { service, call } = harness([app('notes')])
    await service.requestApp('chat', 'notes', signal)
    await expect(service.key('chat', 'notes', 'scroll_lock', [], signal)).rejects.toThrow(
      'no key called'
    )
    expect(call).not.toHaveBeenCalledWith('press_key', expect.anything(), signal)
    for (const key of ['return', 'F2', 'W', '7', '+']) {
      await service.key('chat', 'notes', key, [], signal)
    }
  })

  it('drags from one row to another by where they are on screen', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    const { createCanvas } = await import('@napi-rs/canvas')
    const data = createCanvas(500, 250).toBuffer('image/png').toString('base64')
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'W', bounds: { x: 100, y: 200, width: 1000, height: 500 } }
    ])
    needsForeground(call, 'never refused')
    const answer = call.getMockImplementation()!
    const frame = { x: 300, y: 400, w: 20, h: 10 }
    call.mockImplementation(async (tool, args) => ({
      ...(await answer(tool, args)),
      text: tool === 'get_window_state' ? 'snapshot_id=s1\n- [0] A\n- [1] B' : 'ok',
      images: tool === 'get_window_state' ? [{ mimeType: 'image/png', data }] : [],
      structured:
        tool === 'bring_to_front'
          ? { landed_on_target: true, previous_fg_hwnd: '0x9', target_hwnd: '0x4d' }
          : tool === 'get_window_state'
            ? {
                elements: [
                  { element_index: 0, frame },
                  { element_index: 1, frame: { ...frame, x: 700 } }
                ]
              }
            : undefined
    }))
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', true, signal)
    await service.drag('chat', 'notes', { element: 0 }, { element: 1 }, signal, true)
    // The middle of each frame, back in the picture's pixels, which are half the screen's here.
    expect(call).toHaveBeenLastCalledWith(
      'drag',
      expect.objectContaining({ from_x: 105, from_y: 103, to_x: 305, to_y: 103 }),
      signal
    )
    await expect(
      service.drag('chat', 'notes', { element: 9 }, { x: 1, y: 1 }, signal)
    ).rejects.toThrow('no place on screen')
  })

  it('draws an open menu onto the picture, since a picture of the window leaves it out', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    const { createCanvas, loadImage } = await import('@napi-rs/canvas')
    const data = createCanvas(100, 50).toBuffer('image/png').toString('base64')
    const menu = createCanvas(40, 40)
    const brush = menu.getContext('2d')
    // A clear margin around it, as WinUI leaves for a shadow, which mustn't cover what is beneath.
    brush.fillStyle = '#ff0000'
    brush.fillRect(10, 10, 20, 20)
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'W', bounds: { x: 100, y: 100, width: 200, height: 100 } }
    ])
    appWindows.popups.mockResolvedValue([
      {
        x: 110,
        y: 110,
        width: 40,
        height: 40,
        data: menu.toBuffer('image/png').toString('base64')
      }
    ])
    const answer = call.getMockImplementation()!
    call.mockImplementation(async (tool, args) => ({
      ...(await answer(tool, args)),
      images: tool === 'get_window_state' ? [{ mimeType: 'image/png', data }] : []
    }))
    await service.requestApp('chat', 'notes', signal)
    const seen = await service.look('chat', 'notes', true, signal)
    expect(seen.text).toContain('menu or dropdown is open')
    const picture = await loadImage(Buffer.from(seen.images[0].data, 'base64'))
    const canvas = createCanvas(picture.width, picture.height)
    const context = canvas.getContext('2d')
    context.drawImage(picture, 0, 0)
    // Half the screen's size, so the menu's (20, 20) on the window is (10, 10) here.
    expect([...context.getImageData(15, 15, 1, 1).data].slice(0, 3)).toEqual([255, 0, 0])
    expect(context.getImageData(40, 40, 1, 1).data[0]).not.toBe(255)
  })

  it('says a step may have worked when the window changes under it', async () => {
    const { service, call } = harness([app('notes')])
    needsForeground(call, 'never refused')
    const answer = call.getMockImplementation()!
    call.mockImplementation(async (tool, args) =>
      tool === 'click'
        ? {
            isError: true,
            images: [],
            text: 'foreground_unavailable: exact target',
            structured: undefined
          }
        : answer(tool, args)
    )
    await service.requestApp('chat', 'notes', signal)
    await expect(service.click('chat', 'notes', { x: 1, y: 2 }, signal, true)).rejects.toThrow(
      'may well have worked'
    )
  })

  it('looks at a dialog that opened just after the windows were listed', async () => {
    const { service, appWindows, call } = harness([app('notes')])
    const first = { id: 77, title: 'W', bounds: null }
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', false, signal)
    let listed = 0
    appWindows.windowsOf.mockImplementation(async () =>
      ++listed > 2 ? [first, { id: 88, title: 'Save', bounds: null }] : [first]
    )
    await service.lookAfterAction('chat', 'notes', signal)
    expect(call).toHaveBeenLastCalledWith(
      'get_window_state',
      expect.objectContaining({ window_id: 88 }),
      signal
    )
  })

  it('rests the real pointer on a row, only once the user has stepped away', async () => {
    const { service, call, appWindows, userIdleSeconds, moveCursor } = harness([app('notes')])
    needsForeground(call, 'never refused')
    userIdleSeconds.mockReturnValue(60)
    await service.requestApp('chat', 'notes', signal)
    await service.hover('chat', 'notes', { x: 5, y: 6 }, signal).catch(() => undefined)
    expect(appWindows.pointerTo).not.toHaveBeenCalled()
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'W', bounds: { x: 10, y: 20, width: 100, height: 100 } }
    ])
    await service.hover('chat', 'notes', { x: 5, y: 6 }, signal)
    expect(appWindows.pointerTo).toHaveBeenCalledWith({ x: 15, y: 26 })
    expect(moveCursor).toHaveBeenCalledWith({ x: 15, y: 26 })
  })

  it('keeps its own pointer the one to watch, and gives the real one back', async () => {
    const { service, call, appWindows, moveCursor } = harness([app('notes')])
    needsForeground(call, 'never refused')
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'W', bounds: { x: 0, y: 0, width: 100, height: 100 } }
    ])
    await service.requestApp('chat', 'notes', signal)
    // Where the step left it, so nobody else has touched it.
    appWindows.pointer.mockResolvedValueOnce({ x: 900, y: 900 })
    appWindows.pointer.mockResolvedValueOnce({ x: 5, y: 6 })
    await service.click('chat', 'notes', { x: 5, y: 6 }, signal, true)
    expect(moveCursor).toHaveBeenCalledWith({ x: 5, y: 6 })
    expect(appWindows.pointerTo).toHaveBeenLastCalledWith({ x: 900, y: 900 })
    // The driver put it back to where a drag began, which is still not where the user left it.
    appWindows.pointerTo.mockClear()
    appWindows.pointer.mockResolvedValueOnce({ x: 900, y: 900 })
    appWindows.pointer.mockResolvedValueOnce({ x: 5, y: 6 })
    await service.drag('chat', 'notes', { x: 5, y: 6 }, { x: 50, y: 60 }, signal, true)
    expect(appWindows.pointerTo).toHaveBeenLastCalledWith({ x: 900, y: 900 })
    // The user took the mouse during the step, so it is theirs now.
    appWindows.pointerTo.mockClear()
    appWindows.pointer.mockResolvedValueOnce({ x: 900, y: 900 })
    appWindows.pointer.mockResolvedValueOnce({ x: 300, y: 300 })
    await service.click('chat', 'notes', { x: 5, y: 6 }, signal, true)
    expect(appWindows.pointerTo).not.toHaveBeenCalled()
  })

  it('notices a small change where a step happened, though not one elsewhere', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    const { createCanvas } = await import('@napi-rs/canvas')
    const picture = (mark?: { x: number; y: number }): string => {
      const canvas = createCanvas(1000, 500)
      const context = canvas.getContext('2d')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, 1000, 500)
      if (mark) {
        context.fillStyle = '#000000'
        context.fillRect(mark.x, mark.y, 10, 10)
      }
      return canvas.toBuffer('image/png').toString('base64')
    }
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'W', bounds: { x: 0, y: 0, width: 1000, height: 500 } }
    ])
    let shown = picture()
    const answer = call.getMockImplementation()!
    call.mockImplementation(async (tool, args) => ({
      ...(await answer(tool, args)),
      images: tool === 'get_window_state' ? [{ mimeType: 'image/png', data: shown }] : []
    }))
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', true, signal)
    await service.click('chat', 'notes', { x: 100, y: 100 }, signal)
    shown = picture({ x: 110, y: 110 })
    expect((await service.lookAfterAction('chat', 'notes', signal)).changed).toBe(true)
    shown = picture({ x: 800, y: 400 })
    await service.look('chat', 'notes', true, signal)
    await service.click('chat', 'notes', { x: 100, y: 100 }, signal)
    shown = picture({ x: 810, y: 410 })
    expect((await service.lookAfterAction('chat', 'notes', signal)).changed).toBe(false)
  })

  it('holds a key during a click only with real input, and only ones it allows', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    needsForeground(call, 'never refused')
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'W', bounds: { x: 0, y: 0, width: 100, height: 100 } }
    ])
    await service.requestApp('chat', 'notes', signal)
    const where = { x: 5, y: 6 }
    await expect(
      service.click('chat', 'notes', { ...where, modifiers: ['ctrl'] }, signal)
    ).rejects.toThrow('real_input')
    await expect(
      service.click('chat', 'notes', { ...where, modifiers: ['win'] }, signal, true)
    ).rejects.toThrow('not win')
    await service.click('chat', 'notes', { ...where, modifiers: ['Control'] }, signal, true)
    expect(call).toHaveBeenLastCalledWith(
      'click',
      expect.objectContaining({ modifier: ['ctrl'], delivery_mode: 'foreground' }),
      signal
    )
  })

  it('presses a row by its place for a triple click, still checking what it is', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    needsForeground(call, 'never refused')
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'W', bounds: { x: 0, y: 0, width: 100, height: 100 } }
    ])
    const frame = { x: 40, y: 50, w: 10, h: 10 }
    const answer = call.getMockImplementation()!
    call.mockImplementation(async (tool, args) => ({
      ...(await answer(tool, args)),
      text:
        tool === 'get_window_state'
          ? 'snapshot_id=s1\n- [0] Edit "Name"\n- [1] Button "Delete account"'
          : 'ok',
      structured:
        tool === 'bring_to_front'
          ? { landed_on_target: true, previous_fg_hwnd: '0x9', target_hwnd: '0x4d' }
          : tool === 'get_window_state'
            ? {
                elements: [
                  { element_index: 0, frame },
                  { element_index: 1, frame }
                ]
              }
            : undefined
    }))
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', true, signal)
    await expect(
      service.click('chat', 'notes', { element: 0, triple: true }, signal)
    ).rejects.toThrow('real_input')
    await service.click('chat', 'notes', { element: 0, triple: true }, signal, true)
    expect(call).toHaveBeenLastCalledWith(
      'click',
      expect.objectContaining({ x: 45, y: 55, count: 3 }),
      signal
    )
    expect(call.mock.lastCall?.[1]).not.toHaveProperty('element_token')
    await expect(
      service.click('chat', 'notes', { element: 1, triple: true }, signal, true)
    ).rejects.toThrow('may not be reversible')
    await expect(
      service.click('chat', 'notes', { element: 0, middle: true }, signal)
    ).rejects.toThrow('real_input')
  })

  it('never lets background text go wherever the focus happens to be', async () => {
    const { service, call } = harness([app('notes')])
    needsForeground(call, 'never refused')
    const answer = call.getMockImplementation()!
    call.mockImplementation(async (tool, args) => ({
      ...(await answer(tool, args)),
      text:
        tool === 'get_window_state' ? 'snapshot_id=s1\n- [0] Edit "Name"\n- [1] Button "Go"' : 'ok',
      structured:
        tool === 'bring_to_front'
          ? { landed_on_target: true, previous_fg_hwnd: '0x9', target_hwnd: '0x4d' }
          : tool === 'get_window_state'
            ? {
                elements: [
                  { element_index: 0, value: 'one ', actions: ['set_value', 'text'] },
                  { element_index: 1, actions: ['invoke'] }
                ]
              }
            : undefined
    }))
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', true, signal)
    await service.type('chat', 'notes', 'two', 0, signal)
    expect(call).toHaveBeenLastCalledWith(
      'set_value',
      expect.objectContaining({ value: 'one two', element_token: 's1:0' }),
      signal
    )
    await expect(service.type('chat', 'notes', 'two', 1, signal)).rejects.toThrow('real_input')
    expect(call).not.toHaveBeenCalledWith('type_text', expect.anything(), signal)
    // With real keys, the row gets the focus first.
    await service.type('chat', 'notes', 'x', 0, signal, true)
    const sent = call.mock.calls.map(([tool]) => tool)
    expect(sent.lastIndexOf('click')).toBeLessThan(sent.lastIndexOf('type_text'))
    expect(sent.lastIndexOf('click')).toBeGreaterThan(-1)
  })

  it('holds a key combination written as one key to the same limits', async () => {
    const { service, call } = harness([app('notes')])
    needsForeground(call, 'never refused')
    await service.requestApp('chat', 'notes', signal)
    for (const key of ['win+r', 'WIN + R', 'cmd+r', 'win']) {
      await expect(service.key('chat', 'notes', key, [], signal, true)).rejects.toThrow(
        'Windows key'
      )
    }
    await expect(service.key('chat', 'notes', 'ctrl+s', [], signal)).rejects.toThrow('modifiers')
    expect(call).not.toHaveBeenCalledWith('press_key', expect.anything(), signal)
    await service.key('chat', 'notes', 'ctrl+s', [], signal, true)
    expect(call).toHaveBeenLastCalledWith(
      'press_key',
      expect.objectContaining({ key: 's', modifiers: ['ctrl'] }),
      signal
    )
  })

  it("doesn't take the agent's own real input for the user coming back", async () => {
    const { service, appWindows, userIdleSeconds, call } = harness([app('notes')])
    needsForeground(call, 'never refused')
    appWindows.front.mockResolvedValue(77)
    await service.requestApp('chat', 'notes', signal)
    await service.key('chat', 'notes', 'a', [], signal, true)
    // Windows now reports no idle time at all, because of the key the agent just pressed.
    userIdleSeconds.mockReturnValue(0)
    const sent = call.mock.calls.length
    await service.key('chat', 'notes', 'b', [], signal, true)
    expect(call.mock.calls.length).toBe(sent + 1)
    // But input that comes well after the agent's is the user's, so it waits and gives up.
    vi.useFakeTimers({ now: Date.now() + 60_000 })
    try {
      const waiting = service.key('chat', 'notes', 'c', [], signal, true)
      const refused = expect(waiting).rejects.toThrow('still using')
      await vi.advanceTimersByTimeAsync(80_000)
      await refused
    } finally {
      vi.useRealTimers()
    }
  })

  it('after an action, sends only the rows that changed, and every row when most did', async () => {
    const { service, call } = harness([app('notes')])
    let tree = ['- [0] Button "A"', '- [1] Button "B"', '- [2] Button "C"', '- [3] Button "D"']
    call.mockImplementation(async (tool) => ({
      isError: false,
      images: [] as Array<{ mimeType: string; data: string }>,
      structured: undefined as unknown,
      text: tool === 'get_window_state' ? `snapshot_id=s1\n${tree.join('\n')}` : 'ok'
    }))
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', true, signal)
    tree = ['- [0] Button "A"', '- [1] Button "B2"', '- [2] Button "C"', '- [3] Button "D"']
    const few = await service.lookAfterAction('chat', 'notes', signal)
    expect(few.text).toContain('[1] Button "B2"')
    expect(few.text).not.toContain('Button "A"')
    tree = [
      '- [0] Button "A"',
      '- [1] Button "B2"',
      '- [2] Button "C"',
      '- [3] Button "D"',
      '- Text "New"'
    ]
    expect((await service.lookAfterAction('chat', 'notes', signal)).text).toContain('Text "New"')
    expect((await service.look('chat', 'notes', true, signal)).text).toContain('Button "A"')
    const searched = await service.look('chat', 'notes', true, signal, undefined, 'nothing')
    expect(searched.controls).toBe(true)
    tree = ['- [0] Button "W"', '- [1] Button "X"', '- [2] Button "Y"', '- [3] Button "Z"']
    expect((await service.lookAfterAction('chat', 'notes', signal)).text).toContain('Button "W"')
  })

  it('moves to a window that has just opened, as a dialog does', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    const windows = (...ids: number[]) =>
      ids.map((id) => ({
        id,
        title: 'W',
        bounds: { x: 0, y: 0, width: 100 * id, height: 10 }
      }))
    let open = windows(9, 2)
    appWindows.windowsOf.mockImplementation(async () => open)
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', false, signal)
    expect(call).toHaveBeenLastCalledWith(
      'get_window_state',
      expect.objectContaining({ window_id: 9 }),
      signal
    )
    open = windows(9, 2, 3)
    await service.look('chat', 'notes', false, signal)
    expect(call).toHaveBeenLastCalledWith(
      'get_window_state',
      expect.objectContaining({ window_id: 3 }),
      signal
    )
    open = windows(9, 2)
    await service.look('chat', 'notes', false, signal)
    expect(call).toHaveBeenLastCalledWith(
      'get_window_state',
      expect.objectContaining({ window_id: 9 }),
      signal
    )
  })

  it('sends no drag in the background, where it reports success and moves nothing', async () => {
    const { service, call } = harness([app('notes')])
    needsForeground(call, 'never refused')
    await service.requestApp('chat', 'notes', signal)
    const from = { x: 1, y: 2 }
    const to = { x: 3, y: 4 }
    await expect(service.drag('chat', 'notes', from, to, signal)).rejects.toThrow('real_input')
    expect(call).not.toHaveBeenCalledWith('drag', expect.anything(), signal)
    await service.drag('chat', 'notes', from, to, signal, true)
    expect(call).toHaveBeenLastCalledWith(
      'drag',
      expect.objectContaining({ delivery_mode: 'foreground' }),
      signal
    )
  })

  it('puts the user’s window back when a background click pulls the app forward', async () => {
    const { service, appWindows } = harness([app('notes')])
    appWindows.front.mockResolvedValueOnce(500).mockResolvedValueOnce(77)
    await service.requestApp('chat', 'notes', signal)
    await service.click('chat', 'notes', { x: 1, y: 2 }, signal)
    expect(appWindows.restore).toHaveBeenCalledWith(500)
  })

  it('does not send a key with modifiers through the background path', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    needsForeground(call, 'press_key')
    await service.requestApp('chat', 'notes', signal)
    await expect(service.key('chat', 'notes', 'a', ['ctrl'], signal)).rejects.toThrow('real_input')
    expect(appWindows.key).not.toHaveBeenCalled()
  })

  it('sends no real input when the app did not reach the front', async () => {
    const { service, call } = harness([app('notes')])
    needsForeground(call, 'scroll')
    const answer = call.getMockImplementation()!
    call.mockImplementation(async (tool, args) =>
      tool === 'bring_to_front'
        ? { isError: false, images: [], text: 'ok', structured: { landed_on_target: false } }
        : answer(tool, args)
    )
    await service.requestApp('chat', 'notes', signal)
    await expect(service.scroll('chat', 'notes', 'up', 3, {}, signal, true)).rejects.toThrow(
      'nothing was sent'
    )
    expect(call).not.toHaveBeenCalledWith(
      'scroll',
      expect.objectContaining({ delivery_mode: 'foreground' }),
      signal
    )
  })

  it('refuses real input for software that can move a machine, without asking', async () => {
    const twincat: ComputerApp = {
      pid: 10,
      name: 'TcHmi',
      path: 'C:\\TwinCAT\\TcHmi.exe',
      access: computerAppAccess('C:\\TwinCAT\\TcHmi.exe')
    }
    const { service, call } = harness([twincat])
    needsForeground(call, 'press_key')
    await service.requestApp('chat', 'TcHmi', signal)
    await expect(service.key('chat', 'TcHmi', 'return', [], signal, true)).rejects.toThrow(
      'equipment'
    )
    expect(call).not.toHaveBeenCalledWith('bring_to_front', expect.anything(), signal)
  })

  it('waits for the user to step away, and gives up rather than type over them', async () => {
    vi.useFakeTimers()
    try {
      const { service, call, userIdleSeconds } = harness([app('notes')])
      needsForeground(call, 'type_text')
      userIdleSeconds.mockReturnValue(0)
      await service.requestApp('chat', 'notes', signal)
      const typing = service.type('chat', 'notes', 'x', undefined, signal, true)
      const refused = expect(typing).rejects.toThrow('still using')
      await vi.advanceTimersByTimeAsync(76_000)
      await refused
      expect(call).not.toHaveBeenCalledWith(
        'type_text',
        expect.objectContaining({ delivery_mode: 'foreground' }),
        signal
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('flags software that can move real equipment, for the dialog to warn about', () => {
    expect(computerAppAccess('C:\\TwinCAT\\3.1\\Components\\TcXaeShell.exe').kind).toBe('physical')
    expect(computerAppAccess('C:\\Program Files\\Rockwell\\Studio 5000\\x.exe').kind).toBe(
      'physical'
    )
  })

  it('acts on nothing the user has not approved, and starts no driver for it', async () => {
    const { service, startDriver } = harness([app('notes')])
    await expect(service.look('chat', 'notes', false, signal)).rejects.toThrow('not approved')
    await expect(service.click('chat', 'notes', { x: 1, y: 1 }, signal)).rejects.toThrow(
      'not approved'
    )
    expect(startDriver).not.toHaveBeenCalled()
  })

  it('stays on the window the agent chose, and refuses one the app does not have', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    appWindows.windowsOf.mockResolvedValue([
      { id: 77, title: 'One', bounds: null },
      { id: 88, title: 'Two', bounds: null }
    ])
    call.mockImplementation(async () => ({
      isError: false,
      images: [] as Array<{ mimeType: string; data: string }>,
      structured: undefined as unknown,
      text: 'snapshot_id=s1'
    }))
    await service.requestApp('chat', 'notes', signal)
    await expect(service.look('chat', 'notes', false, signal, 99)).rejects.toThrow('no window 99')
    expect((await service.look('chat', 'notes', false, signal, 88)).text).toContain('"Two"')
    await service.click('chat', 'notes', { element: 0 }, signal)
    expect(call).toHaveBeenLastCalledWith(
      'click',
      expect.objectContaining({ window_id: 88, element_token: 's1:0' }),
      signal
    )
  })

  it('gives everything back when the reply ends, keeping the chat’s approvals', async () => {
    const { service, disarm, hideActive, confirmApp } = harness([app('notes')])
    await service.requestApp('first', 'notes', signal)
    await service.look('first', 'notes', false, signal)
    service.runEnded('someone else')
    expect(hideActive).not.toHaveBeenCalled()
    service.runEnded('first')
    expect(disarm).toHaveBeenCalled()
    expect(hideActive).toHaveBeenCalled()
    await vi.waitFor(() => expect(service['driver']).toBeNull())
    await expect(service.requestApp('second', 'notes', signal)).resolves.toContain('approved')
    expect(confirmApp).toHaveBeenCalledTimes(2)
    service.runEnded('second')
    await expect(service.requestApp('first', 'notes', signal)).resolves.toContain('already')
  })

  it('takes a denial as final and approves nothing', async () => {
    const { service, startDriver } = harness([app('notes')], false)
    await expect(service.requestApp('chat', 'notes', signal)).rejects.toThrow('did not allow')
    await expect(service.look('chat', 'notes', false, signal)).rejects.toThrow('not approved')
    expect(startDriver).not.toHaveBeenCalled()
  })

  it('keeps an approval to its own chat', async () => {
    const { service } = harness([app('notes')])
    await service.requestApp('first', 'notes', signal)
    await service.stop()
    await expect(service.look('second', 'notes', false, signal)).rejects.toThrow('not approved')
  })

  it('lets one chat drive the computer at a time', async () => {
    const { service } = harness([app('notes')])
    await service.requestApp('first', 'notes', signal)
    await expect(service.requestApp('second', 'notes', signal)).rejects.toThrow('Another chat')
  })

  it('holds no claim on the computer after a denial', async () => {
    const answers = [false, true]
    const { service, confirmApp } = harness([app('notes')])
    confirmApp.mockImplementation(async () => answers.shift() ?? false)
    await expect(service.requestApp('first', 'notes', signal)).rejects.toThrow('did not allow')
    await expect(service.requestApp('second', 'notes', signal)).resolves.toContain('approved')
  })

  it('re-checks a named app that became something else after approval', async () => {
    const apps = [app('notes')]
    const { service } = harness(apps)
    await service.requestApp('chat', 'notes', signal)
    apps[0] = { ...apps[0], path: 'C:\\Elsewhere\\notes.exe' }
    await expect(service.look('chat', 'notes', false, signal)).rejects.toThrow('not approved')
  })

  it('refuses the Windows key, which reaches the shell rather than the app', async () => {
    const { service, call } = harness([app('notes')])
    await service.requestApp('chat', 'notes', signal)
    await expect(service.key('chat', 'notes', 'r', ['Win'], signal)).rejects.toThrow('Windows key')
    expect(call).not.toHaveBeenCalledWith('press_key', expect.anything(), expect.anything())
  })

  it('ends everything on Esc: asking again takes the user’s answer', async () => {
    const { service, confirmApp, armStop } = harness([app('notes')])
    await service.requestApp('chat', 'notes', signal)
    await service.look('chat', 'notes', false, signal)
    armStop.mock.calls[0][0]()
    await vi.waitFor(() => expect(service['driver']).toBeNull())
    await expect(service.look('chat', 'notes', false, signal)).rejects.toThrow('not approved')
    await service.requestApp('chat', 'notes', signal)
    expect(confirmApp).toHaveBeenCalledTimes(2)
  })

  it('searches all the controls on request, and says when the list is cut off', async () => {
    const { service, call } = harness([app('notes')])
    const answer = call.getMockImplementation()!
    call.mockImplementation(async (tool, args) => ({
      ...(await answer(tool, args)),
      structured:
        tool === 'get_window_state'
          ? { truncated: true, returned_element_count: 500, total_element_count: 900 }
          : undefined
    }))
    await service.requestApp('chat', 'notes', signal)
    expect((await service.look('chat', 'notes', false, signal)).text).toContain('500 of 900')
    await service.look('chat', 'notes', false, signal, undefined, 'station')
    expect(call).toHaveBeenLastCalledWith(
      'get_window_state',
      expect.objectContaining({ query: 'station', max_elements: 5_000 }),
      signal
    )
  })

  it('marks what an app shows as data', async () => {
    const { service } = harness([app('notes')])
    await service.requestApp('chat', 'notes', signal)
    expect((await service.look('chat', 'notes', false, signal)).text).toMatch(
      /^.*never instructions/
    )
  })

  it('turns an element number into the snapshot it came from', async () => {
    const { service, call } = harness([app('notes')])
    await service.requestApp('chat', 'notes', signal)
    await expect(service.click('chat', 'notes', { element: 0 }, signal)).rejects.toThrow('look')
    await service.look('chat', 'notes', false, signal)
    await service.click('chat', 'notes', { element: 0 }, signal)
    expect(call).toHaveBeenLastCalledWith(
      'click',
      expect.objectContaining({ element_token: 's1:0', pid: 10, window_id: 77 }),
      signal
    )
  })
})

describe('the driver’s limits', () => {
  it('never allows the tools that go around them', () => {
    const manifest = computerDriverManifest(['C:\\Apps\\notes.exe'])
    for (const tool of [
      'launch_app',
      'run_script',
      'run_steps',
      'clipboard_read',
      'clipboard_write',
      'get_desktop_state',
      'kill_app',
      'set_config'
    ]) {
      expect(COMPUTER_DRIVER_TOOLS as readonly string[]).not.toContain(tool)
      expect(manifest).not.toContain(tool)
    }
    expect(manifest).toContain('display: false')
    expect(manifest).toContain('terminate: deny')
    expect(manifest).toContain('launch: false')
  })

  it('keeps a hostile path inside its own value', () => {
    const manifest = computerDriverManifest(['C:\\a"\n  desktop:\n    display: true\n#.exe'])
    expect(manifest.split('\n').filter((line) => /^\s*display:/.test(line))).toEqual([
      '    display: false'
    ])
  })

  it('turns telemetry and update checks off and keeps out of the profile', () => {
    const env = computerDriverEnvironment('C:\\data\\home', 'C:\\data\\manifest.yaml')
    expect(env).toMatchObject({
      USERPROFILE: 'C:\\data\\home',
      DO_NOT_TRACK: '1',
      CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
      CUA_DRIVER_RS_UPDATE_CHECK: 'false',
      CUA_DRIVER_PERMISSION_MODE: 'bounded'
    })
  })

  it('finds where an action landed in what the driver reports', () => {
    expect(computerActionPoint('✅ Performed UIA Invoke on [1] (screen (1093,1240)).')).toEqual({
      x: 1093,
      y: 1240
    })
    expect(
      computerActionPoint('✅ Posted click to Chromium pid 3 at (879,864) (background)')
    ).toEqual({ x: 879, y: 864 })
    expect(computerActionPoint('Sent drag on pid 3 from screen (1,2) → (30,40) in 500ms')).toEqual({
      x: 30,
      y: 40
    })
    expect(computerActionPoint('Typed 1 char(s) on pid 3')).toBeNull()
  })

  it('reads what the helper says is open', () => {
    expect(parseComputerApps('5|C:\\Apps\\notes.exe?6|C:\\Apps\\My App.exe?')).toMatchObject([
      { pid: 5, name: 'notes' },
      { pid: 6, name: 'My App' }
    ])
    expect(parseComputerApps('')).toEqual([])
    expect(parseComputerApps('no')).toEqual([])
    expect(parseComputerWindows('', 9)).toEqual([])
    expect(parseComputerWindows('no', 9)).toEqual([])
    expect(
      parseComputerWindows(
        '3,9,0,0,5,5,Small\u00014,9,-8,-8,50,50,Big, with a comma\u00015,8,0,0,0,0,Empty',
        9
      )
    ).toEqual([
      { id: 4, title: 'Big, with a comma', bounds: { x: -8, y: -8, width: 50, height: 50 } },
      { id: 3, title: 'Small', bounds: { x: 0, y: 0, width: 5, height: 5 } },
      { id: 5, owner: 8, title: 'Empty', bounds: null }
    ])
  })
})
