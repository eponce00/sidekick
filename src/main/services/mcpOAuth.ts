import { createServer, type Server } from 'http'
import { randomBytes } from 'crypto'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { isSecureMcpUrl } from '../../shared/mcp'
import type { McpHttpServerConfig } from '../../shared/types'
import { PRODUCT_IDENTITY } from '../../shared/productIdentity'
import packageMetadata from '../../../package.json'
import { ConnectorCredentialStore } from './connectorCredentialStore'

interface McpOAuthBundle {
  version: 1
  redirectUrl?: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  discoveryState?: OAuthDiscoveryState
}

export interface McpOAuthCallback {
  redirectUrl: string
  state: string
  waitForCode(): Promise<string>
  close(): Promise<void>
}

const CALLBACK_TIMEOUT_MS = 3 * 60_000

function credentialId(serverId: string): string {
  return `mcp-oauth:${serverId}`
}

function emptyBundle(): McpOAuthBundle {
  return { version: 1 }
}

function parseBundle(value: string | undefined): McpOAuthBundle {
  if (!value) return emptyBundle()
  try {
    const parsed = JSON.parse(value) as Partial<McpOAuthBundle>
    return parsed && parsed.version === 1 ? (parsed as McpOAuthBundle) : emptyBundle()
  } catch {
    return emptyBundle()
  }
}

function callbackPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:420px;padding:32px;text-align:center}p{color:#aaa;line-height:1.5}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })
}

/** RFC 8252 loopback callback: random port, loopback-only bind, PKCE state validation. */
export async function createMcpOAuthCallback(
  timeoutMs = CALLBACK_TIMEOUT_MS
): Promise<McpOAuthCallback> {
  const state = randomBytes(32).toString('base64url')
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  let settled = false
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    }
    if (request.method !== 'GET' || requestUrl.pathname !== '/oauth/callback') {
      response.writeHead(404, headers).end('Not found')
      return
    }
    if (requestUrl.searchParams.get('state') !== state) {
      response
        .writeHead(400, headers)
        .end(callbackPage('Sign-in rejected', 'The authorization state did not match.'))
      return
    }
    const oauthError = requestUrl.searchParams.get('error')
    if (oauthError) {
      settled = true
      response
        .writeHead(400, headers)
        .end(callbackPage('Sign-in cancelled', 'SideKick did not receive authorization.'))
      rejectCode(new Error(`OAuth authorization failed: ${oauthError}`))
      void closeServer(server)
      return
    }
    const authorizationCode = requestUrl.searchParams.get('code')
    if (!authorizationCode) {
      response
        .writeHead(400, headers)
        .end(callbackPage('Sign-in incomplete', 'No authorization code was returned.'))
      return
    }
    settled = true
    response
      .writeHead(200, headers)
      .end(callbackPage('Connected to SideKick', 'You can close this tab and return to the app.'))
    resolveCode(authorizationCode)
    void closeServer(server)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Could not create the OAuth callback listener.')
  }
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    rejectCode(new Error('OAuth sign-in timed out.'))
    void closeServer(server)
  }, timeoutMs)
  return {
    redirectUrl: `http://127.0.0.1:${address.port}/oauth/callback`,
    state,
    waitForCode: () => code.finally(() => clearTimeout(timer)),
    close: async () => {
      clearTimeout(timer)
      await closeServer(server)
    }
  }
}

export class McpOAuthProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata

  constructor(
    private readonly server: McpHttpServerConfig,
    private readonly credentials: ConnectorCredentialStore,
    readonly redirectUrl: string,
    private readonly oauthState: string,
    private readonly onAuthorization: (url: URL) => void | Promise<void>
  ) {
    this.clientMetadata = {
      redirect_uris: [redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: PRODUCT_IDENTITY.productName,
      software_id: PRODUCT_IDENTITY.appId,
      software_version: packageMetadata.version
    }
  }

  private async bundle(): Promise<McpOAuthBundle> {
    return parseBundle(await this.credentials.get(credentialId(this.server.id)))
  }

  private update(updater: (bundle: McpOAuthBundle) => McpOAuthBundle): Promise<void> {
    return this.credentials.modify(credentialId(this.server.id), async (current) =>
      JSON.stringify(updater(parseBundle(current)))
    )
  }

  state(): string {
    return this.oauthState
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.bundle()).clientInformation
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    return this.update((bundle) => ({ ...bundle, clientInformation }))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.bundle()).tokens
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.update((bundle) => ({ ...bundle, tokens }))
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    if (!isSecureMcpUrl(authorizationUrl.toString())) {
      throw new Error('OAuth authorization URL must use HTTPS or a loopback address.')
    }
    return this.onAuthorization(authorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): Promise<void> {
    return this.update((bundle) => ({ ...bundle, codeVerifier }))
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.bundle()).codeVerifier
    if (!verifier) throw new Error('OAuth PKCE verifier is missing.')
    return verifier
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    return this.update((bundle) => ({ ...bundle, discoveryState }))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.bundle()).discoveryState
  }

  invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    if (scope === 'all') return this.credentials.delete(credentialId(this.server.id))
    return this.update((bundle) => {
      const next = { ...bundle }
      if (scope === 'client') delete next.clientInformation
      if (scope === 'tokens') delete next.tokens
      if (scope === 'verifier') delete next.codeVerifier
      if (scope === 'discovery') delete next.discoveryState
      return next
    })
  }
}

export class McpOAuthSessionStore {
  constructor(private readonly credentials: ConnectorCredentialStore) {}

  async providerForExistingSession(
    server: McpHttpServerConfig
  ): Promise<McpOAuthProvider | undefined> {
    const bundle = parseBundle(await this.credentials.get(credentialId(server.id)))
    if (!bundle.tokens?.access_token || !bundle.redirectUrl) return undefined
    return new McpOAuthProvider(server, this.credentials, bundle.redirectUrl, '', () => undefined)
  }

  async providerForInteractiveSession(
    server: McpHttpServerConfig,
    callback: McpOAuthCallback,
    onAuthorization: (url: URL) => void | Promise<void>
  ): Promise<McpOAuthProvider> {
    await this.credentials.modify(credentialId(server.id), async (current) => {
      const bundle = parseBundle(current)
      return JSON.stringify({
        version: 1,
        redirectUrl: callback.redirectUrl,
        discoveryState: bundle.discoveryState
      } satisfies McpOAuthBundle)
    })
    return new McpOAuthProvider(
      server,
      this.credentials,
      callback.redirectUrl,
      callback.state,
      onAuthorization
    )
  }

  disconnect(serverId: string): Promise<void> {
    return this.credentials.delete(credentialId(serverId))
  }
}
