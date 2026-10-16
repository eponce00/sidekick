import { describe, expect, it, vi } from 'vitest'
import {
  parseRegistryPath,
  runRegistry,
  updateUserPath,
  userPathIncludes,
  withoutPathEntry,
  withPathEntry,
  type RegistryRunner
} from './windowsPath'

const BIN = 'C:\\Users\\me\\AppData\\Local\\Programs\\SideKick\\bin'

function registry(
  initial: string | null,
  type = 'REG_EXPAND_SZ'
): {
  run: RegistryRunner & ReturnType<typeof vi.fn>
  value: () => string | null
} {
  let value = initial
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'query' && args.length === 2) return { code: 0, stdout: '' }
    if (args[0] === 'query') {
      return value === null
        ? { code: 1, stdout: '' }
        : {
            code: 0,
            stdout: `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    ${type}    ${value}\r\n\r\n`
          }
    }
    value = args[args.indexOf('/d') + 1]
    return { code: 0, stdout: '' }
  })
  return { run, value: () => value }
}

describe('PATH entry editing', () => {
  it('appends once and matches case- and slash-insensitively', () => {
    expect(withPathEntry('C:\\a;%USERPROFILE%\\b', BIN)).toBe(`C:\\a;%USERPROFILE%\\b;${BIN}`)
    expect(withPathEntry(`C:\\a;${BIN.toUpperCase()}\\`, BIN)).toBe(`C:\\a;${BIN.toUpperCase()}\\`)
    expect(withPathEntry('C:\\a;;', BIN)).toBe(`C:\\a;${BIN}`)
    expect(withPathEntry('', BIN)).toBe(BIN)
  })

  it('removes only its own entry and keeps everything else in order', () => {
    expect(withoutPathEntry(`C:\\a;${BIN};%LOCALAPPDATA%\\x;;C:\\z`, BIN)).toBe(
      'C:\\a;%LOCALAPPDATA%\\x;;C:\\z'
    )
    expect(withoutPathEntry('C:\\a;C:\\Users\\me\\AppData\\Local\\Programs\\SideKick', BIN)).toBe(
      'C:\\a;C:\\Users\\me\\AppData\\Local\\Programs\\SideKick'
    )
  })

  it('parses reg query output, including an empty value', () => {
    expect(parseRegistryPath('    Path    REG_SZ    C:\\a;C:\\b  ')).toEqual({
      type: 'REG_SZ',
      value: 'C:\\a;C:\\b  '
    })
    expect(parseRegistryPath('    Path    REG_EXPAND_SZ    ')).toEqual({
      type: 'REG_EXPAND_SZ',
      value: ''
    })
    expect(parseRegistryPath('ERROR: something')).toBeNull()
  })
})

describe('updateUserPath', () => {
  it('keeps the value type so variables still expand', async () => {
    const reg = registry('%USERPROFILE%\\tools')
    expect(await updateUserPath('add', BIN, reg.run)).toBe(0)
    expect(reg.run).toHaveBeenLastCalledWith([
      'add',
      'HKCU\\Environment',
      '/v',
      'Path',
      '/t',
      'REG_EXPAND_SZ',
      '/d',
      `%USERPROFILE%\\tools;${BIN}`,
      '/f'
    ])
  })

  it('does not write when nothing changes', async () => {
    const reg = registry(`C:\\a;${BIN}`, 'REG_SZ')
    expect(await updateUserPath('add', BIN, reg.run)).toBe(0)
    expect(reg.run.mock.calls.some(([args]) => args[0] === 'add')).toBe(false)
  })

  it('creates the value when the user has no PATH of their own', async () => {
    const reg = registry(null)
    expect(await updateUserPath('add', BIN, reg.run)).toBe(0)
    expect(reg.value()).toBe(BIN)
  })

  it('never writes after a read it does not understand', async () => {
    const run = vi.fn(async (args: string[]) =>
      args[0] === 'query' ? { code: 0, stdout: 'unexpected output' } : { code: 0, stdout: '' }
    )
    expect(await updateUserPath('add', BIN, run)).toBe(1)
    expect(run.mock.calls.some(([args]) => args[0] === 'add')).toBe(false)

    const failing = vi.fn(async (_args: string[]) => ({ code: 5, stdout: '' }))
    expect(await updateUserPath('remove', BIN, failing)).toBe(1)
    expect(failing.mock.calls.some(([args]) => args[0] === 'add')).toBe(false)
  })

  it.each(['', 'C:\\a;C:\\b', 'C:\\a" /f'])('refuses directory %j', async (directory) => {
    const reg = registry('C:\\a')
    expect(await updateUserPath('add', directory, reg.run)).toBe(1)
    expect(reg.run).not.toHaveBeenCalled()
  })

  it('refuses to grow PATH past what Windows accepts', async () => {
    const reg = registry('x'.repeat(29_990))
    expect(await updateUserPath('add', BIN, reg.run)).toBe(1)
    expect(reg.value()).toHaveLength(29_990)
  })

  it('reports whether the folder is on PATH', async () => {
    expect(await userPathIncludes(BIN, registry(`C:\\a;${BIN}`).run)).toBe(true)
    expect(await userPathIncludes(BIN, registry('C:\\a').run)).toBe(false)
    expect(await userPathIncludes(BIN, registry(null).run)).toBe(false)
  })
})

// Round-trips through the real reg.exe on a scratch key, never the user's environment.
describe.skipIf(process.platform !== 'win32')('updateUserPath with reg.exe', () => {
  const key = `HKCU\\Software\\SideKickCliPathTest${process.pid}`

  it('adds and removes an entry while keeping expandable variables literal', async () => {
    const original = '%USERPROFILE%\\tools;C:\\Program Files\\Thing\\'
    try {
      await runRegistry(['add', key, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', original, '/f'])
      expect(await updateUserPath('add', BIN, runRegistry, key)).toBe(0)
      expect(await userPathIncludes(BIN, runRegistry, key)).toBe(true)
      const added = parseRegistryPath((await runRegistry(['query', key, '/v', 'Path'])).stdout)
      expect(added).toEqual({ type: 'REG_EXPAND_SZ', value: `${original};${BIN}` })
      expect(await updateUserPath('remove', BIN, runRegistry, key)).toBe(0)
      const removed = parseRegistryPath((await runRegistry(['query', key, '/v', 'Path'])).stdout)
      expect(removed).toEqual({ type: 'REG_EXPAND_SZ', value: original })
    } finally {
      await runRegistry(['delete', key, '/f'])
    }
  })
})
