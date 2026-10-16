import type { ProviderInstance } from '../../shared/settings'
import type { SettingsRecord } from '../ipc/settings'
import type { AppStore } from '../ipc/state'

/** A copy of the stored settings record, encrypted fields included; never sent to a client. */
export function storedSettings(store: AppStore): SettingsRecord {
  const value = store.get('settings', {})
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as SettingsRecord) }
    : {}
}

export function providerInstances(stored: SettingsRecord): ProviderInstance[] {
  return Array.isArray(stored.providerInstances)
    ? (stored.providerInstances as unknown[]).filter(
        (instance): instance is ProviderInstance =>
          Boolean(instance) &&
          typeof instance === 'object' &&
          typeof (instance as ProviderInstance).id === 'string' &&
          Array.isArray((instance as ProviderInstance).models)
      )
    : []
}

/** Resolves to null when `promise` fails or takes longer than `milliseconds`. */
export function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), milliseconds)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}
