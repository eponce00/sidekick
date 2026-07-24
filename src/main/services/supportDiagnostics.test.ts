import { describe, expect, it } from 'vitest'
import { createSupportDiagnostics } from './supportDiagnostics'

describe('support diagnostics', () => {
  it('exports useful release metadata without user content, endpoints, paths, or credentials', () => {
    const privateValues = [
      'personal prompt text',
      'sk-private-provider-key',
      'https://private.provider.example/v1',
      'private-provider-name',
      'private-model-name',
      'https://private.connector.example/mcp',
      'private-connector-name',
      '/private/project/path',
      'personal@example.com',
      'New York, NY'
    ]
    const diagnostics = createSupportDiagnostics({
      generatedAt: new Date('2026-07-22T12:00:00.000Z'),
      application: {
        name: 'SideKick',
        version: '0.3.0',
        appId: 'io.github.eponce00.sidekick',
        packaged: true
      },
      system: {
        platform: 'darwin',
        architecture: 'arm64',
        operatingSystemRelease: '25.5.0',
        electronVersion: '39.0.0',
        chromeVersion: '142.0.0.0',
        nodeVersion: '22.20.0'
      },
      protectedCredentialStorageAvailable: true,
      databaseOpen: true,
      settings: {
        commandPermissionMode: 'agent-decides',
        manualLocation: privateValues[9],
        selectedModel: privateValues[4],
        openRouterApiKey: privateValues[1],
        providerInstances: [
          {
            id: 'private-provider-id',
            name: privateValues[3],
            type: 'anthropic',
            enabled: true,
            baseUrl: privateValues[2],
            apiKey: privateValues[1],
            models: [{ id: privateValues[4], name: privateValues[4] }]
          },
          { type: 'ollama', enabled: false },
          { type: privateValues[8], enabled: true }
        ],
        mcpServers: [
          {
            id: 'private-connector-id',
            name: privateValues[6],
            transport: 'streamable-http',
            url: privateValues[5],
            authentication: 'oauth',
            enabled: true
          },
          {
            id: 'local-private-connector',
            name: privateValues[6],
            transport: 'stdio',
            command: privateValues[7],
            args: [privateValues[0], privateValues[8]],
            cwd: privateValues[7],
            enabled: false
          }
        ]
      }
    })

    expect(diagnostics.configuration).toEqual({
      permissionMode: 'agent-decides',
      providers: {
        total: 3,
        enabled: 2,
        byType: {
          ollama: 1,
          'ollama-cloud': 0,
          openrouter: 0,
          anthropic: 1,
          litellm: 0,
          'openai-compatible': 0,
          llamacpp: 0,
          unknown: 1
        }
      },
      connectors: { total: 2, enabled: 1, local: 1, remote: 1, oauth: 1 }
    })
    expect(diagnostics.privacy).toEqual({
      contentIncluded: false,
      credentialsIncluded: false,
      endpointsIncluded: false,
      pathsIncluded: false,
      logsIncluded: false
    })

    const serialized = JSON.stringify(diagnostics)
    for (const privateValue of privateValues) expect(serialized).not.toContain(privateValue)
  })

  it('does not reflect arbitrary corrupted settings values into the export', () => {
    const secret = 'do-not-reflect-this-value'
    const diagnostics = createSupportDiagnostics({
      generatedAt: new Date(0),
      application: { name: 'SideKick', version: '0.3.0', appId: 'app-id', packaged: false },
      system: {
        platform: 'test',
        architecture: 'test',
        operatingSystemRelease: 'test',
        electronVersion: 'test',
        chromeVersion: 'test',
        nodeVersion: 'test'
      },
      protectedCredentialStorageAvailable: false,
      databaseOpen: false,
      settings: {
        commandPermissionMode: secret,
        providerInstances: [{ type: secret }],
        mcpServers: [{ transport: secret, authentication: secret }]
      }
    })

    expect(JSON.stringify(diagnostics)).not.toContain(secret)
    expect(diagnostics.configuration.permissionMode).toBe('unknown')
    expect(diagnostics.configuration.providers.byType.unknown).toBe(1)
  })
})
