import { describe, expect, it } from 'vitest'
import {
  credentialHostMatches,
  credentialWidening,
  normalizeCredentialHost,
  normalizeCredentialWebScope,
  validateCredentialInput,
  type CredentialScope
} from './credentials'

describe('credential hosts', () => {
  it.each([
    ['api.example.com', 'api.example.com'],
    ['API.Example.COM.', 'api.example.com'],
    ['https://api.example.com/', 'api.example.com'],
    ['api.example.com:443', 'api.example.com'],
    ['api.example.com:8443', 'api.example.com:8443'],
    ['*.example.com', '*.example.com'],
    ['bücher.example', 'xn--bcher-kva.example'],
    ['10.0.0.5:8443', '10.0.0.5:8443'],
    ['[::1]:8443', '[::1]:8443']
  ])('normalizes %s to %s', (raw, expected) => {
    expect(normalizeCredentialHost(raw)).toBe(expected)
  })

  it.each([
    '',
    'http://api.example.com',
    'api.example.com/path',
    'user@api.example.com',
    'api.example.com?x=1',
    '*.com',
    '*.10.0.0.5',
    'api.*.example.com',
    '*example.com',
    'api example.com',
    'api.example.com\\evil'
  ])('refuses %s', (raw) => {
    expect(normalizeCredentialHost(raw)).toBeNull()
  })

  it('matches only HTTPS on the exact host and port', () => {
    const hosts = ['api.example.com', 'files.example.com:8443', '*.partner.example']
    const matches = (url: string): boolean => credentialHostMatches(hosts, new URL(url))
    expect(matches('https://api.example.com/v1/items?x=1')).toBe(true)
    expect(matches('https://API.EXAMPLE.COM./v1')).toBe(true)
    expect(matches('https://files.example.com:8443/x')).toBe(true)
    expect(matches('https://eu.partner.example/x')).toBe(true)

    expect(matches('http://api.example.com/')).toBe(false)
    expect(matches('https://api.example.com:8443/')).toBe(false)
    expect(matches('https://files.example.com/')).toBe(false)
    expect(matches('https://partner.example/')).toBe(false)
    expect(matches('https://api.example.com.evil.example/')).toBe(false)
    expect(matches('https://evilapi.example.com/')).toBe(false)
    // The host after the user name is where the request goes.
    expect(matches('https://api.example.com@evil.example/')).toBe(false)
    expect(matches('https://user:pass@api.example.com/')).toBe(false)
  })
})

describe('credential web scope', () => {
  it('needs a host and a way to send the value', () => {
    expect(normalizeCredentialWebScope({ hosts: [], send: { as: 'basic' } }, 'sign_in')).toEqual({
      error: 'Add at least one host.'
    })
    expect(
      normalizeCredentialWebScope({ hosts: ['a.example'], send: { as: 'basic' } }, 'secret')
    ).toEqual({ error: 'Basic authentication needs a sign-in.' })
  })

  it.each(['Host', 'Content-Length', 'content-type', 'Proxy-Authorization', 'Bad Header'])(
    'refuses to place a value in the %s header',
    (name) => {
      const result = normalizeCredentialWebScope(
        { hosts: ['a.example'], send: { as: 'header', name, prefix: '' } },
        'secret'
      )
      expect(result).toHaveProperty('error')
    }
  )

  it('refuses a header prefix with a line break', () => {
    const result = normalizeCredentialWebScope(
      { hosts: ['a.example'], send: { as: 'header', name: 'Authorization', prefix: 'x\r\nY: z' } },
      'secret'
    )
    expect(result).toEqual({ error: 'Invalid header prefix.' })
  })

  it('needs both field names for a sign-in sent as form fields', () => {
    expect(
      normalizeCredentialWebScope(
        { hosts: ['a.example'], send: { as: 'form', name: 'password' } },
        'sign_in'
      )
    ).toHaveProperty('error')
    expect(
      normalizeCredentialWebScope(
        { hosts: ['a.example'], send: { as: 'form', name: 'password', usernameName: 'username' } },
        'sign_in'
      )
    ).toEqual({
      web: {
        hosts: ['a.example'],
        tokenHosts: [],
        send: { as: 'form', name: 'password', usernameName: 'username' }
      }
    })
  })

  it('normalizes the hosts inside a whole save request', () => {
    const result = validateCredentialInput({
      alias: 'partner-center',
      kind: 'secret',
      description: '',
      usernameVisible: false,
      ask: 'once_per_chat',
      scope: {
        projects: 'all',
        background: false,
        web: {
          hosts: ['Login.MicrosoftOnline.com', 'login.microsoftonline.com.'],
          tokenHosts: ['api.partner.microsoft.com'],
          send: { as: 'form', name: 'client_secret' }
        }
      },
      values: { secret: 'generated-for-test' }
    })
    expect(result).toMatchObject({
      input: {
        scope: {
          web: {
            hosts: ['login.microsoftonline.com'],
            tokenHosts: ['api.partner.microsoft.com']
          }
        }
      }
    })
  })

  it('counts new hosts, token hosts and a changed placement as widening', () => {
    const before: CredentialScope = {
      projects: 'all',
      background: false,
      web: {
        hosts: ['a.example'],
        tokenHosts: [],
        send: { as: 'header', name: 'Authorization', prefix: 'Bearer ' }
      }
    }
    const after: CredentialScope = {
      ...before,
      web: {
        hosts: ['a.example', 'b.example'],
        tokenHosts: ['c.example'],
        send: { as: 'query', name: 'key' }
      }
    }
    const settings = { ask: 'every_use' as const, usernameVisible: false }
    expect(
      credentialWidening({ ...settings, scope: before }, { ...settings, scope: after })
    ).toEqual([
      'Sent in web requests to b.example',
      'Tokens it returns sent to c.example',
      'Sent as the key query parameter'
    ])
    expect(
      credentialWidening({ ...settings, scope: after }, { ...settings, scope: before })
    ).toEqual(['Sent in the Authorization header after "Bearer"'])
  })
})
