import { describe, expect, it } from 'vitest'
import { resolveDevelopmentArtifactUrl } from './artifactProtocolSecurity'

describe('resolveDevelopmentArtifactUrl', () => {
  it('keeps development artifact requests on the configured renderer origin', () => {
    expect(
      resolveDevelopmentArtifactUrl(
        'http://127.0.0.1:5173/nested/',
        '/sandbox.html',
        '?artifact=1'
      )?.toString()
    ).toBe('http://127.0.0.1:5173/sandbox.html?artifact=1')
  })

  it.each([
    '//169.254.169.254/latest/meta-data',
    '\\\\169.254.169.254\\latest\\meta-data',
    '/%5c%5c169.254.169.254/latest/meta-data',
    '/%2f%2f169.254.169.254/latest/meta-data'
  ])('rejects paths that can replace or disguise the configured origin: %s', (pathname) => {
    expect(resolveDevelopmentArtifactUrl('http://127.0.0.1:5173/', pathname)).toBeNull()
  })

  it('rejects invalid renderer bases and malformed path encoding', () => {
    expect(resolveDevelopmentArtifactUrl('not a URL', '/sandbox.html')).toBeNull()
    expect(resolveDevelopmentArtifactUrl('http://127.0.0.1:5173/', '/%E0%A4%A')).toBeNull()
  })
})
