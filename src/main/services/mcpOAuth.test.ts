import { describe, expect, it, vi } from 'vitest'
import type { McpHttpServerConfig } from '../../shared/types'
import { ConnectorCredentialStore } from './connectorCredentialStore'
import {
  createMcpOAuthCallback,
  McpOAuthProvider,
  McpOAuthSessionStore,
  type McpOAuthCallback
} from './mcpOAuth'

function credentials(): ConnectorCredentialStore {
  let persisted: Record<string, string> = {}
  return new ConnectorCredentialStore(
    {
      isAvailable: () => true,
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => Buffer.from(value).toString()
    },
    {
      read: () => ({ ...persisted }),
      write: (next) => {
        persisted = { ...next }
      }
    }
  )
}

function server(): McpHttpServerConfig {
  return {
    id: 'atlassian',
    name: 'Atlassian',
    transport: 'streamable-http',
    url: 'https://connect.example.com/mcp',
    authentication: 'oauth',
    approvalMode: 'prompt',
    enabled: true
  }
}

describe('MCP OAuth', () => {
  it('accepts only a loopback callback with the expected state', async () => {
    const callback = await createMcpOAuthCallback(2_000)
    try {
      const rejected = await fetch(`${callback.redirectUrl}?state=wrong&code=stolen`)
      expect(rejected.status).toBe(400)

      const accepted = await fetch(
        `${callback.redirectUrl}?state=${encodeURIComponent(callback.state)}&code=authorized`
      )
      expect(accepted.status).toBe(200)
      await expect(callback.waitForCode()).resolves.toBe('authorized')
    } finally {
      await callback.close()
    }
  })

  it('persists a resumable OAuth session through the encrypted credential contract', async () => {
    const store = new McpOAuthSessionStore(credentials())
    const callback: McpOAuthCallback = {
      redirectUrl: 'http://127.0.0.1:54321/oauth/callback',
      state: 'secure-state',
      waitForCode: vi.fn(async () => 'code'),
      close: vi.fn(async () => undefined)
    }
    const provider = await store.providerForInteractiveSession(server(), callback, vi.fn())
    await provider.saveClientInformation({ client_id: 'sidekick-client' })
    await provider.saveCodeVerifier('pkce-verifier')
    await provider.saveTokens({ access_token: 'access', token_type: 'bearer' })

    const resumed = await store.providerForExistingSession(server())

    expect(resumed).toBeInstanceOf(McpOAuthProvider)
    await expect(resumed?.tokens()).resolves.toMatchObject({ access_token: 'access' })
    await expect(resumed?.clientInformation()).resolves.toMatchObject({
      client_id: 'sidekick-client'
    })
  })

  it('rejects an insecure authorization endpoint before opening a browser', () => {
    const provider = new McpOAuthProvider(
      server(),
      credentials(),
      'http://127.0.0.1:54321/oauth/callback',
      'state',
      vi.fn()
    )

    expect(() =>
      provider.redirectToAuthorization(new URL('http://attacker.example.com/authorize'))
    ).toThrow('must use HTTPS')
  })
})
