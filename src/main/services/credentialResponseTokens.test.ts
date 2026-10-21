import { randomBytes } from 'crypto'
import { describe, expect, it } from 'vitest'
import { aliasResponseTokens, tokenLikeName, unreplacedToken } from './credentialResponseTokens'

describe('tokenLikeName', () => {
  it.each([
    'access_token',
    'refresh_token',
    'id_token',
    'token',
    'accessToken',
    'client_token',
    'sessionToken',
    'X-Auth-Token',
    'SecretAccessKey',
    'client_secret',
    'api_key',
    'password',
    'auth'
  ])('treats %s as a token', (name) => {
    expect(tokenLikeName(name)).toBe(true)
  })

  it.each([
    'token_type',
    'expires_in',
    'nextPageToken',
    'page_token',
    'NextToken',
    'continuationToken',
    'skiptoken',
    'AccessKeyId',
    'key',
    'code'
  ])('leaves %s alone', (name) => {
    expect(tokenLikeName(name)).toBe(false)
  })

  it('treats an authorization code in a redirect as a token', () => {
    expect(tokenLikeName('code', true)).toBe(true)
  })
})

describe('aliasResponseTokens', () => {
  let count = 0
  const derive = () => `api-key~${++count}`

  it('fails closed on a parse error, and never echoes the body in its reason', () => {
    const token = randomBytes(24).toString('hex')
    const result = aliasResponseTokens(
      { body: `{"access_token":"${token}"`, contentType: 'application/json' },
      derive
    )
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(token)
  })

  it('leaves numbers under a token-like name, such as token counts', () => {
    const body = JSON.stringify({ usage: { max_tokens: 1024, input_tokens: 12 } }, null, 2)
    expect(aliasResponseTokens({ body, contentType: 'application/json' }, derive)).toEqual({
      ok: true,
      body,
      tokens: []
    })
  })

  it('keeps aliases readable in a form-encoded body', () => {
    const result = aliasResponseTokens(
      {
        body: `access_token=${randomBytes(24).toString('hex')}&token_type=bearer`,
        contentType: ''
      },
      derive
    )
    expect(result).toMatchObject({
      ok: true,
      body: expect.stringMatching(/^access_token=api-key~\d+&token_type=bearer$/)
    })
  })

  it('finds a token-like name beside an escaped quote in a string of JSON', () => {
    const token = randomBytes(24).toString('hex')
    expect(
      unreplacedToken(JSON.stringify({ payload: JSON.stringify({ access_token: token }) }))
    ).toBe(true)
  })
})
