import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

export function resolveBundledSkillAssetsPath(input: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  exists?: (path: string) => boolean
}): string {
  if (!input.isPackaged) return join(input.appPath, 'resources', 'skills')
  const unpacked = join(input.resourcesPath, 'app.asar.unpacked', 'resources', 'skills')
  const legacy = join(input.resourcesPath, 'skills')
  return (input.exists ?? existsSync)(unpacked) ? unpacked : legacy
}

/** Trusted location of helper assets shipped with SideKick's declarative skills. */
export function getBundledSkillAssetsPath(): string {
  // electron-builder unpacks resources/** beside app.asar because those helpers
  // must remain real executable files. Older packages placed them directly in
  // resources, so retain that layout as a compatibility fallback.
  return resolveBundledSkillAssetsPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath()
  })
}
