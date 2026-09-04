import { describe, expect, it } from 'vitest'
import { resolveBundledSkillAssetsPath } from './bundledSkillAssets'

describe('resolveBundledSkillAssetsPath', () => {
  it('uses electron-builder unpacked resources for executable packaged helpers', () => {
    const result = resolveBundledSkillAssetsPath({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\SideKick\\resources',
      appPath: 'C:\\Program Files\\SideKick\\resources\\app.asar',
      exists: (path) => path.includes('app.asar.unpacked')
    })

    expect(result).toBe(
      'C:\\Program Files\\SideKick\\resources\\app.asar.unpacked\\resources\\skills'
    )
  })

  it('keeps development helpers under the application source root', () => {
    expect(
      resolveBundledSkillAssetsPath({
        isPackaged: false,
        resourcesPath: 'unused',
        appPath: 'E:\\sidekick'
      })
    ).toBe('E:\\sidekick\\resources\\skills')
  })
})
