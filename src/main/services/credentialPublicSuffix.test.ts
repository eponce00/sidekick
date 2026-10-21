import { describe, expect, it } from 'vitest'
import type { CredentialScope } from '../../shared/credentials'
import { publicSuffixWildcardRefusal } from './credentialPublicSuffix'

function scope(hosts: string[], tokenHosts: string[] = []): CredentialScope {
  return {
    projects: 'all',
    background: false,
    web: { hosts, tokenHosts, send: { as: 'header', name: 'Authorization', prefix: 'Bearer ' } }
  }
}

describe('publicSuffixWildcardRefusal', () => {
  it.each(['*.co.uk', '*.github.io', '*.com', '*.s3.amazonaws.com', '*.co.uk:8443'])(
    'refuses %s, which covers sites anyone can register',
    (host) => {
      expect(publicSuffixWildcardRefusal(scope([host]))).toContain(host)
      expect(publicSuffixWildcardRefusal(scope(['api.example.com'], [host]))).toContain(host)
    }
  )

  it.each(['*.example.com', '*.example.co.uk', '*.mine.github.io', 'github.io', 'co.uk'])(
    'allows %s',
    (host) => {
      expect(publicSuffixWildcardRefusal(scope([host]))).toBeNull()
    }
  )

  it('has nothing to check without web use', () => {
    expect(publicSuffixWildcardRefusal({ projects: 'all', background: false })).toBeNull()
  })
})
