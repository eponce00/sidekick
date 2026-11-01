import { ipcMain } from 'electron'
import type { PinnedModel } from '../../shared/models'
import { pinnedModelsFromProviderInstances } from '../../shared/providerInstances'
import type { ProviderSettings } from '../../shared/settings'
import { ConversationModelStore } from '../services/conversationModelStore'
import { loadStoredSettings } from './settings'
import { getDb } from './state'

function configured(): { models: PinnedModel[]; defaultModelId: string | undefined } {
  const settings = loadStoredSettings() as unknown as ProviderSettings
  return {
    models: pinnedModelsFromProviderInstances(settings.providerInstances ?? []),
    defaultModelId: settings.selectedModel
  }
}

export function registerConversationModelHandlers(): void {
  const store = new ConversationModelStore(getDb())
  try {
    const { models, defaultModelId } = configured()
    const adopted = store.adoptUnassigned(models, defaultModelId)
    if (adopted) console.log(`[Conversations] Gave ${adopted} chat(s) their own model`)
  } catch (error) {
    // Those chats show the new-chat default until a model is chosen in them.
    console.warn('[Conversations] Could not give older chats their own model:', error)
  }

  // Choosing a model in a chat changes that chat only.
  ipcMain.handle('conversations:setModel', async (_, id: unknown, modelId: unknown) => {
    if (typeof id !== 'string' || !id || id.length > 100) throw new Error('Invalid chat')
    if (!configured().models.some((model) => model.id === modelId)) {
      throw new Error('That model is not set up')
    }
    return { success: store.set(id, modelId as string) }
  })
}
