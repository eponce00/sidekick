import { BrowserWindow } from 'electron'
import { watch as fsWatch } from 'fs'
import Database from 'better-sqlite3'

/**
 * Shared mutable state for the main process.
 * Initialized during app.whenReady() in index.ts.
 */
export interface AppStore {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
}

export const appState = {
  store: null as AppStore | null,
  db: null as Database.Database | null,
  gitAvailable: false,
  mainWindowRef: null as BrowserWindow | null,
  workspaceWatcher: null as ReturnType<typeof fsWatch> | null,
  watchDebounceTimer: null as ReturnType<typeof setTimeout> | null
}

/** Type-safe accessor — throws if store is not yet initialized. */
export function getStore(): AppStore {
  if (!appState.store) throw new Error('Store not initialized')
  return appState.store
}

/** Type-safe accessor — throws if db is not yet initialized. */
export function getDb(): Database.Database {
  if (!appState.db) throw new Error('Database not initialized')
  return appState.db
}
