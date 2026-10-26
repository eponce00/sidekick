import type {
  CredentialEvent,
  CredentialSummary,
  CredentialsAPI
} from '../../../shared/credentials'

/** Credentials for the renderer preview. Like the real vault, it keeps no value it could return. */
export function previewCredentialsApi(): CredentialsAPI {
  const now = Date.now()
  let credentials: CredentialSummary[] = [
    {
      id: 'preview-partner-center',
      alias: 'partner-center',
      kind: 'secret',
      description: 'Partner Center client secret for Store submissions.',
      createdAt: now - 7 * 86_400_000,
      updatedAt: now - 2 * 86_400_000,
      lastUsedAt: now - 3_600_000,
      needsValue: false
    },
    {
      id: 'preview-github-login',
      alias: 'github-login',
      kind: 'sign_in',
      description: 'Test account for the sign-in flow.',
      username: 'sidekick-test',
      sites: ['github.com'],
      createdAt: now - 3 * 86_400_000,
      updatedAt: now - 3 * 86_400_000,
      needsValue: false
    },
    {
      id: 'preview-build-server',
      alias: 'build-server',
      kind: 'sign_in',
      description: 'SSH to the build server, 10.0.0.5.',
      username: 'deploy',
      createdAt: now - 20 * 86_400_000,
      updatedAt: now - 20 * 86_400_000,
      lastUsedAt: now - 26 * 60_000,
      needsValue: false
    },
    {
      id: 'preview-weather-api',
      alias: 'weather-api',
      kind: 'secret',
      description: 'OpenWeather API key, sent as the appid query parameter.',
      createdAt: now - 40 * 86_400_000,
      updatedAt: now - 40 * 86_400_000,
      needsValue: true
    }
  ]
  const events: CredentialEvent[] = [
    {
      id: 'preview-event-1',
      credentialId: 'preview-partner-center',
      alias: 'partner-center',
      kind: 'created',
      at: now - 7 * 86_400_000
    }
  ]
  const listeners = new Set<() => void>()
  const changed = (): void => listeners.forEach((listener) => listener())

  return {
    status: async () => ({ available: true }),
    list: async () => [...credentials],
    save: async (input) => {
      const existing = credentials.find((credential) => credential.id === input.id)
      if (
        credentials.some(
          (credential) => credential.alias === input.alias && credential !== existing
        )
      ) {
        return { ok: false, error: `Another credential is already called ${input.alias}.` }
      }
      const credential: CredentialSummary = {
        id: existing?.id ?? `preview-${input.alias}`,
        alias: input.alias,
        kind: input.kind,
        description: input.description,
        ...(input.sites?.length ? { sites: input.sites } : {}),
        ...(input.kind === 'sign_in'
          ? { username: input.values?.username ?? existing?.username ?? 'preview-user' }
          : {}),
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        needsValue: false
      }
      credentials = [...credentials.filter((entry) => entry !== existing), credential].sort(
        (left, right) => left.alias.localeCompare(right.alias)
      )
      events.unshift({
        id: `preview-event-${events.length + 1}`,
        credentialId: credential.id,
        alias: credential.alias,
        kind: existing ? 'changed' : 'created',
        at: Date.now()
      })
      changed()
      return { ok: true, credential, credentials: [...credentials] }
    },
    delete: async (id) => {
      const before = credentials.length
      credentials = credentials.filter((credential) => credential.id !== id)
      if (credentials.length !== before) changed()
      return { deleted: credentials.length !== before, credentials: [...credentials] }
    },
    events: async (credentialId) =>
      events.filter((event) => !credentialId || event.credentialId === credentialId),
    onChanged: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
}
