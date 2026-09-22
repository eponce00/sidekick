import { app, ipcMain } from 'electron'
import { join } from 'path'
import { SiteIconService } from '../services/siteIconService'

export function registerSiteIconHandlers(): void {
  const service = new SiteIconService(join(app.getPath('userData'), 'site-icons'))
  ipcMain.handle('siteIcons:get', async (_event, url: unknown) => {
    if (typeof url !== 'string' || url.length > 2_048) return { dataUrl: null }
    return { dataUrl: await service.iconFor(url) }
  })
}
