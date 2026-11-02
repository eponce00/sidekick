import { describe, expect, it, vi } from 'vitest'
import { installGit, type GitInstallParts } from './gitInstaller'

function parts(overrides: Partial<GitInstallParts> = {}) {
  return {
    platform: 'win32' as const,
    localAppData: 'C:\\Users\\me\\AppData\\Local',
    gitWorks: vi.fn(async () => false),
    run: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    openDownloadPage: vi.fn(async () => undefined),
    ...overrides
  }
}

describe('installing Git', () => {
  it('installs nothing without the yes', async () => {
    const run = vi.fn(async () => undefined)
    const declined = parts({ run, confirm: vi.fn(async () => false) })
    await expect(installGit(declined)).resolves.toEqual({ outcome: 'declined' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('winget.exe'),
      ['--version'],
      expect.any(Number)
    )
  })

  it('goes by whether Git runs afterward, not by what winget says', async () => {
    const failing = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[0] === 'install') throw new Error('exit code 2316632107')
    })
    const worked = parts({
      run: failing,
      gitWorks: vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true)
    })
    await expect(installGit(worked)).resolves.toEqual({ outcome: 'ready' })
    const failed = parts({ run: failing })
    await expect(installGit(failed)).resolves.toEqual({ outcome: 'failed' })
  })

  it('sends the user to the download page where there is no winget', async () => {
    const noWinget = parts({ run: vi.fn(async () => Promise.reject(new Error('ENOENT'))) })
    await expect(installGit(noWinget)).resolves.toEqual({ outcome: 'elsewhere' })
    expect(noWinget.openDownloadPage).toHaveBeenCalled()
    expect(noWinget.confirm).not.toHaveBeenCalled()
  })
})
