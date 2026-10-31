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
  computerActionPoint,
  computerOpenWindows,
  computerWindowBounds
} from './computerUseDriver'
import { ComputerUseService } from './computerUseService'

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
      tool === 'list_windows'
        ? '- app (pid 10) "Window" [window_id: 77]'
        : tool === 'get_window_state'
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
    ignoresPostedClicks: vi.fn(async (_window: number) => false)
  }
  const hideActive = vi.fn()
  const moveCursor = vi.fn()
  const service = new ComputerUseService({
    driverPath: 'C:\\driver\\cua-driver.exe',
    dataFolder: () => 'C:\\data',
    confirmApp,
    userIdleSeconds,
    appWindows,
    startApp,
    armStop,
    notifyActive: vi.fn(),
    showActive,
    hideActive,
    moveCursor,
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
        : name === 'list_windows'
          ? '- app (pid 10) "Window" [window_id: 77]'
          : 'ok',
    structured:
      name === 'bring_to_front'
        ? { landed_on_target: true, previous_fg_hwnd: '0x9', target_hwnd: '0x4d' }
        : undefined
  }))
}

describe('what the agent may reach', () => {
  it.each(['KeePass', 'Bitwarden', 'consent', 'LogonUI', 'LockApp', 'SideKick', 'electron'])(
    'never offers %s, however it is spelled',
    async (name) => {
      for (const spelled of [name, name.toUpperCase(), `${name}.exe`]) {
        const { service, confirmApp } = harness([app(name)])
        await expect(service.requestApp('chat', spelled, signal)).rejects.toThrow('cannot be used')
        expect(confirmApp).not.toHaveBeenCalled()
      }
      expect(await harness([app(name)]).service.apps(signal)).not.toContain(name)
    }
  )

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

  it('brings the app forward before real input, and puts the user’s window back', async () => {
    const { service, call, restoreForeground } = harness([app('notes')])
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
    expect(restoreForeground).toHaveBeenCalledWith(9)
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
    expect(notes[0]).toContain('did not land')
    expect(notes[2]).toContain('Stop trying')
    await expect(service.scroll('chat', 'notes', 'up', 3, {}, signal)).rejects.toThrow(
      'changed nothing'
    )
    service.runEnded('chat')
    await service.requestApp('chat', 'notes', signal)
    await expect(service.scroll('chat', 'notes', 'up', 3, {}, signal)).resolves.toBeTruthy()
  })

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

  it('stops before pressing something risky, whether by row or by pixel', async () => {
    const { service, call, appWindows } = harness([app('notes')])
    call.mockImplementation(async (tool) => ({
      isError: false,
      images: [] as Array<{ mimeType: string; data: string }>,
      structured:
        tool === 'list_windows'
          ? {
              windows: [
                { window_id: 77, title: 'W', bounds: { x: 0, y: 0, width: 100, height: 100 } }
              ]
            }
          : (undefined as unknown),
      text:
        tool === 'list_windows'
          ? '- app (pid 10) "Window" [window_id: 77]'
          : tool === 'get_window_state'
            ? 'window_id=77 pid=10 elements=2 snapshot_id=s1\n- [0] Button "OK"\n- [1] Button "Delete account" [actions=[invoke]]'
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

  it('zooms through the driver and clicks on what the zoom showed', async () => {
    const { service, call } = harness([app('notes')])
    await service.requestApp('chat', 'notes', signal)
    await service.zoom('chat', 'notes', { x: 10, y: 20, toX: 110, toY: 80 }, signal)
    expect(call).toHaveBeenLastCalledWith(
      'zoom',
      expect.objectContaining({ x1: 10, y1: 20, x2: 110, y2: 80 }),
      signal
    )
    await service.click('chat', 'notes', { x: 3, y: 4, fromZoom: true }, signal)
    expect(call).toHaveBeenLastCalledWith(
      'click',
      expect.objectContaining({ x: 3, y: 4, from_zoom: true }),
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
    const { service, call } = harness([app('notes')])
    call.mockImplementation(async (tool) => ({
      isError: false,
      images: [] as Array<{ mimeType: string; data: string }>,
      structured: undefined as unknown,
      text:
        tool === 'list_windows'
          ? '- app "One" [window_id: 77]\n- app "Two" [window_id: 88]'
          : 'snapshot_id=s1'
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

  it('works in an app’s real windows, largest first, not the desktop or taskbar', () => {
    const window = (window_id: number, title: string, width: number, minimized = false) => ({
      window_id,
      title,
      minimized,
      bounds: { x: 0, y: 0, width, height: 10 }
    })
    expect(
      computerOpenWindows({
        windows: [
          window(1, '', 900),
          window(2, 'Program Manager', 800),
          window(3, 'Small', 5),
          window(4, 'Big', 50),
          window(5, 'Hidden', 500, true)
        ]
      })
    ).toEqual([4, 3])
    expect(computerOpenWindows('nonsense')).toBeNull()
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

  it('outlines only a window it knows, and not a minimized one', () => {
    const bounds = { x: 60, y: 195, width: 1431, height: 1280 }
    const windows = (minimized: boolean) => ({ windows: [{ window_id: 7, minimized, bounds }] })
    expect(computerWindowBounds(windows(false), 7)).toEqual(bounds)
    expect(computerWindowBounds(windows(true), 7)).toBeNull()
    expect(computerWindowBounds(windows(false), 8)).toBeNull()
    expect(computerWindowBounds('nonsense', 7)).toBeNull()
  })

  it('reads a single running app as well as many', () => {
    expect(parseComputerApps('{"Id":5,"Path":"C:\\\\Apps\\\\notes.exe"}')).toMatchObject([
      { pid: 5, name: 'notes' }
    ])
    expect(parseComputerApps('')).toEqual([])
  })
})
