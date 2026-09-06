export const SUPPORT_DIAGNOSTICS_SCHEMA_VERSION = 1 as const

export interface SupportDiagnostics {
  schemaVersion: typeof SUPPORT_DIAGNOSTICS_SCHEMA_VERSION
  generatedAt: string
  application: {
    name: string
    version: string
    appId: string
    packaged: boolean
    artifact?: {
      scope: 'main-bundle-on-disk'
      algorithm: 'sha256'
      sha256: string | null
    }
  }
  system: {
    platform: string
    architecture: string
    operatingSystemRelease: string
    electronVersion: string
    chromeVersion: string
    nodeVersion: string
  }
  security: {
    protectedCredentialStorageAvailable: boolean
    rendererSandboxed: true
    shellSandboxed: boolean
    shellIsolationScope?: 'shell-commands-only'
  }
  storage: {
    databaseOpen: boolean
  }
  configuration: {
    permissionMode: 'always-ask' | 'sensitive-only' | 'full-access' | 'unknown'
    providers: {
      total: number
      enabled: number
      byType: Record<string, number>
    }
    connectors: {
      total: number
      enabled: number
      local: number
      remote: number
      oauth: number
    }
  }
  privacy: {
    contentIncluded: false
    credentialsIncluded: false
    endpointsIncluded: false
    pathsIncluded: false
    logsIncluded: false
  }
}

export interface SupportDiagnosticsExportResult {
  success: boolean
  canceled?: boolean
  error?: string
}

export interface SupportDiagnosticsAPI {
  export: () => Promise<SupportDiagnosticsExportResult>
}
