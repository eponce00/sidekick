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
import { streamProviderChat } from '../providers/providerRuntime'
import { probeProvider } from '../providers/providerProbe'

export function registerProviderRuntimeHandlers(): void {
  const probes = new Map<number, AbortController>()
  ipcMain.handle('providers:probe', async (event, target: ProviderTarget, includeVision: boolean) => {
    if (probes.has(event.sender.id)) throw new Error('A capability test is already running')
    const controller = new AbortController()
    const senderId = event.sender.id
    probes.set(senderId, controller)
    const cancel = (): void => controller.abort()
    event.sender.once('destroyed', cancel)
    const timeout = setTimeout(cancel, 120_000)
    try {
      return await probeProvider(target, streamProviderChat, controller.signal, includeVision === true)
    } finally {
      clearTimeout(timeout)
      event.sender.removeListener('destroyed', cancel)
      probes.delete(senderId)
    }
  })
  ipcMain.handle('providers:cancelProbe', (event) => probes.get(event.sender.id)?.abort())
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
  ipcMain.handle(
    'providers:getGenerationStats',
    (_event, target: ProviderTarget, generationId: string) =>
      getProviderGenerationStats(target, generationId)
  )
}
