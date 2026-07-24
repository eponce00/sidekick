import { app } from 'electron'
import { join } from 'path'

/** Trusted location of helper assets shipped with SideKick's declarative skills. */
export function getBundledSkillAssetsPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills')
}
