export interface AppUpdateInfo {
  version: string
  releaseName: string | null
  releaseNotes: string | null
  releaseDate: string | null
  releaseUrl: string
}

export type AppUpdateDisabledReason = 'development' | 'unsupported-platform'

interface AppUpdateStateBase {
  currentVersion: string
}

export type AppUpdateState =
  | (AppUpdateStateBase & { status: 'disabled'; reason: AppUpdateDisabledReason })
  | (AppUpdateStateBase & { status: 'idle' })
  | (AppUpdateStateBase & { status: 'checking' })
  | (AppUpdateStateBase & { status: 'up-to-date'; checkedAt: number })
  | (AppUpdateStateBase & { status: 'available'; update: AppUpdateInfo })
  | (AppUpdateStateBase & {
      status: 'error'
      message: string
    })

export interface AppUpdatesAPI {
  getState: () => Promise<AppUpdateState>
  check: () => Promise<AppUpdateState>
  openRelease: () => Promise<{ opened: boolean }>
  onState: (callback: (state: AppUpdateState) => void) => () => void
}
