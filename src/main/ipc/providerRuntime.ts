import { BrowserWindow, ipcMain } from 'electron'
import type {
  ProviderChatRequest,
  ProviderDiscoveryRequest,
  ProviderTarget
} from '../../shared/providerRuntime'
import {
  completeProviderChat,
  discoverProviderModels,
  getProviderGenerationStats,
  resolveProviderContext,
  setProviderHealthPublisher
} from '../providers/providerRuntime'
import { editingCompatibilityService } from '../services/editingCompatibilityService'

export function registerProviderRuntimeHandlers(): void {
  setProviderHealthPublisher((change) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('providers:healthChanged', change)
    }
  })
  ipcMain.handle('providers:complete', (_event, request: ProviderChatRequest) =>
    completeProviderChat(request)
  )
  ipcMain.handle('providers:discoverModels', (_event, request: ProviderDiscoveryRequest) =>
    discoverProviderModels(request)
  )
  ipcMain.handle('providers:resolveContext', (_event, target: ProviderTarget) =>
    resolveProviderContext(target)
  )
  ipcMain.handle('providers:calibrateEditing', (_event, request) =>
    editingCompatibilityService.calibrate(request)
  )
  ipcMain.handle(
    'providers:getGenerationStats',
    (_event, target: ProviderTarget, generationId: string) =>
      getProviderGenerationStats(target, generationId)
  )
}
