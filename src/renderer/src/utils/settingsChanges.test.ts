import { describe, expect, it } from 'vitest'
import type { ProviderSettings } from '../types/app.types'
import { changedSettings } from './settingsChanges'

const base = {
  selectedModel: 'lmstudio:local/one',
  notificationsEnabled: true,
  manualLocation: 'Lisbon',
  providerInstances: [
    {
      id: 'local',
      name: 'Local',
      type: 'openai-compatible',
      enabled: true,
      baseUrl: 'http://127.0.0.1:1234/v1',
      modelSource: 'manual',
      models: [{ id: 'one', enabled: true }]
    }
  ]
} as unknown as ProviderSettings

describe('settings changes', () => {
  it('names only the settings that changed', () => {
    expect(changedSettings(base, { ...base, notificationsEnabled: false })).toEqual({
      notificationsEnabled: false
    })
    expect(changedSettings(base, structuredClone(base))).toEqual({})
  })

  it('sends a whole list when anything in it changed', () => {
    const [local] = base.providerInstances!
    const renamed = { ...base, providerInstances: [{ ...local, name: 'Renamed' }] }
    expect(changedSettings(base, renamed)).toEqual({
      providerInstances: renamed.providerInstances
    })
  })

  it('clears a setting the new copy dropped', () => {
    const changes = changedSettings(base, { ...base, manualLocation: undefined })
    expect(changes).toHaveProperty('manualLocation', undefined)
    expect(Object.keys(changes)).toEqual(['manualLocation'])
  })
})
