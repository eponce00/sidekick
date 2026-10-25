import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { BrowserImportRequest } from '../../shared/browserLibrary'
import { browserIcon } from '../services/browserImport/browserIcons'
import { BrowserImportService } from '../services/browserImport/browserImportService'
import { BrowserLibraryStore } from '../services/browserImport/browserLibraryStore'
import { getDb } from './state'

export function registerBrowserLibraryHandlers(): void {
  const store = new BrowserLibraryStore(getDb)
  const imports = new BrowserImportService(store)
  ipcMain.handle('browserLibrary:importSources', () => imports.sources())
  ipcMain.handle('browserLibrary:browserIcon', (_event, browser: unknown) => browserIcon(browser))
  ipcMain.handle('browserLibrary:previewImport', (_event, browser: unknown, profileId: unknown) =>
    imports.preview(browser, profileId)
  )
  ipcMain.handle('browserLibrary:runImport', (_event, request: BrowserImportRequest) =>
    imports.run(request)
  )
  // The file is chosen here, in a system dialog, so the renderer never names a path to read.
  ipcMain.handle('browserLibrary:importBookmarksFile', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Import bookmarks file',
      properties: ['openFile'] as ['openFile'],
      filters: [{ name: 'Bookmarks file', extensions: ['html', 'htm'] }]
    }
    const selected = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (selected.canceled || selected.filePaths.length !== 1) return null
    return imports.importFile(selected.filePaths[0])
  })
  ipcMain.handle('browserLibrary:sources', () => store.sources())
  ipcMain.handle('browserLibrary:suggest', (_event, query: unknown) =>
    typeof query === 'string' ? store.suggest(query) : []
  )
  ipcMain.handle('browserLibrary:remove', (_event, sourceId: unknown) => {
    if (sourceId === undefined || typeof sourceId === 'string') store.remove(sourceId)
    return store.sources()
  })
}
