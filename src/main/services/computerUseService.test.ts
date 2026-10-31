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
  computerDriverManifest
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
    images: [],
    text:
      tool === 'list_windows'
        ? '- app (pid 10) "Window" [window_id: 77]'
        : tool === 'get_window_state'
          ? 'window_id=77 pid=10 elements=1 snapshot_id=s1\n- [0] Button "OK"'
          : 'ok'
  }))
  const startDriver = vi.fn(async () => ({ call, close: vi.fn(async () => undefined) }))
  const confirmApp = vi.fn(async () => confirm)
  const confirmTakeover = vi.fn(async () => confirm)
  const userIdleSeconds = vi.fn(() => 60)
  const installed: ComputerApp[] = []
  const startApp = vi.fn((path: string) => {
    const started = installed.find((a) => a.path === path)
    if (started) apps.push({ ...started, pid: 10 })
  })
  const disarm = vi.fn()
  const armStop = vi.fn((_stop: () => void) => disarm)
  const service = new ComputerUseService({
    driverPath: 'C:\\driver\\cua-driver.exe',
    dataFolder: () => 'C:\\data',
    confirmApp,
    confirmTakeover,
    userIdleSeconds,
    startApp,
    armStop,
    notifyActive: vi.fn(),
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
    confirmTakeover,
    userIdleSeconds,
    installed,
    startApp,
    armStop
  }
}

/** A driver that takes this tool only with the real mouse and keyboard, as Chrome does for typing. */
function needsForeground(call: ReturnType<typeof harness>['call'], tool: string): void {
  call.mockImplementation(async (name, args) => ({
    isError: name === tool && args?.delivery_mode !== 'foreground',
    images: [],
    text:
      name === tool && args?.delivery_mode !== 'foreground'
        ? 'Background delivery is not available for target window class'
        : name === 'list_windows'
          ? '- app (pid 10) "Window" [window_id: 77]'
          : 'ok'
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

  it('asks before using the real mouse and keyboard, once per chat', async () => {
    const { service, call, confirmTakeover } = harness([app('notes')])
    needsForeground(call, 'type_text')
    await service.requestApp('chat', 'notes', signal)
    await service.type('chat', 'notes', 'one', undefined, signal)
    await service.type('chat', 'notes', 'two', undefined, signal)
    expect(confirmTakeover).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenLastCalledWith(
      'type_text',
      expect.objectContaining({ text: 'two', delivery_mode: 'foreground' }),
      signal
    )
  })

  it('never sends real input when the takeover is denied', async () => {
    const { service, call, confirmApp } = harness([app('notes')], false)
    confirmApp.mockResolvedValue(true)
    needsForeground(call, 'type_text')
    await service.requestApp('chat', 'notes', signal)
    await expect(service.type('chat', 'notes', 'x', undefined, signal)).rejects.toThrow(
      'did not let'
    )
    expect(call).not.toHaveBeenCalledWith(
      'type_text',
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
    const { service, call, confirmTakeover } = harness([twincat])
    needsForeground(call, 'press_key')
    await service.requestApp('chat', 'TcHmi', signal)
    await expect(service.key('chat', 'TcHmi', 'return', [], signal)).rejects.toThrow('equipment')
    expect(confirmTakeover).not.toHaveBeenCalled()
  })

  it('waits for the user to pause, and gives up rather than type over them', async () => {
    vi.useFakeTimers()
    try {
      const { service, call, userIdleSeconds } = harness([app('notes')])
      needsForeground(call, 'type_text')
      userIdleSeconds.mockReturnValue(0)
      await service.requestApp('chat', 'notes', signal)
      const typing = service.type('chat', 'notes', 'x', undefined, signal)
      const refused = expect(typing).rejects.toThrow('busy')
      await vi.advanceTimersByTimeAsync(31_000)
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
      images: [],
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
      'set_config',
      'bring_to_front'
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

  it('reads a single running app as well as many', () => {
    expect(parseComputerApps('{"Id":5,"Path":"C:\\\\Apps\\\\notes.exe"}')).toMatchObject([
      { pid: 5, name: 'notes' }
    ])
    expect(parseComputerApps('')).toEqual([])
  })
})
