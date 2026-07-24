import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { open } from 'fs/promises'
import { release } from 'os'
import { PRODUCT_IDENTITY } from '../../shared/productIdentity'
import type { SupportDiagnosticsExportResult } from '../../shared/supportDiagnostics'
import { createSupportDiagnostics } from '../services/supportDiagnostics'
import { getDb, getStore } from './state'

function diagnosticFileName(date: Date): string {
  return `SideKick-diagnostics-${date
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z')}.json`
}

export function registerSupportHandlers(): void {
  ipcMain.handle(
    'support:exportDiagnostics',
    async (event): Promise<SupportDiagnosticsExportResult> => {
      const generatedAt = new Date()
      const diagnostics = createSupportDiagnostics({
        generatedAt,
        application: {
          name: PRODUCT_IDENTITY.productName,
          version: app.getVersion(),
          appId: PRODUCT_IDENTITY.appId,
          packaged: app.isPackaged
        },
        system: {
          platform: process.platform,
          architecture: process.arch,
          operatingSystemRelease: release(),
          electronVersion: process.versions.electron ?? 'unknown',
          chromeVersion: process.versions.chrome ?? 'unknown',
          nodeVersion: process.versions.node
        },
        protectedCredentialStorageAvailable: safeStorage.isEncryptionAvailable(),
        databaseOpen: getDb().open,
        settings: getStore().get('settings', {})
      })

      const parent = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: 'Export SideKick diagnostics',
        defaultPath: diagnosticFileName(generatedAt),
        buttonLabel: 'Export',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const selection = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)
      if (selection.canceled || !selection.filePath) return { success: false, canceled: true }

      try {
        const output = await open(selection.filePath, 'w', 0o600)
        try {
          if (process.platform !== 'win32') await output.chmod(0o600)
          await output.writeFile(`${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8')
        } finally {
          await output.close()
        }
        return { success: true }
      } catch (error) {
        console.error('[Support] Failed to export diagnostics:', error)
        return {
          success: false,
          error:
            'SideKick could not save the diagnostic report. Choose another location and try again.'
        }
      }
    }
  )
}
