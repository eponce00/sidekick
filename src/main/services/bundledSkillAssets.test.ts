import { describe, expect, it } from 'vitest'
import { join, resolve } from 'path'
import { resolveBundledSkillAssetsPath } from './bundledSkillAssets'

describe('resolveBundledSkillAssetsPath', () => {
  it('uses electron-builder unpacked resources for executable packaged helpers', () => {
    const resourcesPath = resolve('fixtures', 'SideKick', 'resources')
    const result = resolveBundledSkillAssetsPath({
      isPackaged: true,
      resourcesPath,
      appPath: join(resourcesPath, 'app.asar'),
      exists: (path) => path.includes('app.asar.unpacked')
    })

    expect(result).toBe(join(resourcesPath, 'app.asar.unpacked', 'resources', 'skills'))
  })

  it('keeps development helpers under the application source root', () => {
    const appPath = resolve('fixtures', 'sidekick')
    expect(
      resolveBundledSkillAssetsPath({
        isPackaged: false,
        resourcesPath: 'unused',
        appPath
      })
    ).toBe(join(appPath, 'resources', 'skills'))
  })
})
