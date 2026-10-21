/**
 * Finds the tokens in a response to a request that used a stored credential and replaces each
 * with an alias, so a bearer token the service mints is as hidden as the secret that obtained it.
 * It fails closed: whatever it cannot read, or a token-like value it could not replace, withholds
 * the body rather than show it.
 */

/** Gives a token an alias the agent can pass back as `credential`. */
export type DeriveToken = (value: string, expiresInSeconds?: number) => string

export type AliasedResponse =
  | { ok: true; body: string; location?: string; tokens: string[] }
  | { ok: false; reason: string }

/** More than this many tokens in one response is not a token exchange; it is withheld. */
const MAX_TOKENS = 32
/** A value shorter than this beside a token-like name reads as a word, not a token. */
const MIN_RAW_TOKEN = 12
const ALIAS = /^[a-z0-9][a-z0-9_-]{0,63}~\d+$/

/** Pagination cursors are named like tokens but grant nothing; aliasing them breaks paging. */
const CURSOR_NAME =
  /(page|pagination|next|prev|previous|cursor|continuation|sync|delta|resume|skip|start|after|before)tokens?$/
const TOKEN_NAME =
  /(tokens?|jwt|secret|secretkey|password|passwd|passphrase|apikey|accesskey|privatekey|signingkey|sessionid|sessionkey|assertion|credentials?|cookie|authorization)$/

/** Whether a field, parameter or element name holds a token: `access_token`, `sessionToken`... */
export function tokenLikeName(name: string, inRedirect = false): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!key || CURSOR_NAME.test(key)) return false
  // An authorization code in a redirect can be exchanged for a token.
  if (inRedirect && key === 'code') return true
  return key === 'auth' || TOKEN_NAME.test(key)
}

function counted(derive: DeriveToken): DeriveToken & { aliases: string[] } {
  const aliases: string[] = []
  const wrapped = (value: string, expiresIn?: number): string => {
    if (aliases.length >= MAX_TOKENS) throw new Error('too many tokens')
    const alias = derive(value, expiresIn)
    aliases.push(alias)
    return alias
  }
  return Object.assign(wrapped, { aliases })
}

function expiry(record: Record<string, unknown>): number | undefined {
  const value = record.expires_in ?? record.expiresIn
  return typeof value === 'number' ? value : undefined
}

/** Every string under a token-like name, however deep, becomes an alias. */
function aliasJson(
  value: unknown,
  derive: DeriveToken,
  inToken: boolean,
  expiresIn?: number
): unknown {
  if (typeof value === 'string') return inToken && value ? derive(value, expiresIn) : value
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => aliasJson(item, derive, inToken, expiresIn))
  const record = value as Record<string, unknown>
  const own = expiry(record) ?? expiresIn
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    next[key] = aliasJson(item, derive, inToken || tokenLikeName(key), own)
  }
  return next
}

function aliasParams(params: URLSearchParams, derive: DeriveToken, inRedirect: boolean): string {
  const next = new URLSearchParams()
  const expiresIn = Number(params.get('expires_in')) || undefined
  for (const [key, value] of params) {
    next.append(key, value && tokenLikeName(key, inRedirect) ? derive(value, expiresIn) : value)
  }
  // `~` needs no escaping in a URL; left as %7E, an alias would not read as one.
  return next.toString().replace(/%7E/gi, '~')
}

/** The query and the fragment of a redirect, where an implicit grant puts its token. */
function aliasLocation(location: string, derive: DeriveToken): string {
  const base = 'https://sidekick.invalid'
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(location)
  const url = new URL(location, base)
  if (url.search) url.search = aliasParams(url.searchParams, derive, true)
  if (url.hash.includes('=')) {
    url.hash = aliasParams(new URLSearchParams(url.hash.slice(1)), derive, true)
  }
  return absolute || url.origin !== base ? url.href : url.href.slice(base.length)
}

const FORM_BODY = /^[^\s=&]+=[^\s&]*(?:&[^\s=&]+=[^\s&]*)*$/
/** `name: value`, `name=value`, `"name": "value"` and `<name>value`, escaped quotes included. */
const RAW_PAIR =
  /([A-Za-z][\w.-]{0,80})(?:\\?["'])?\s*(?::|=|>)\s*(?:\\?["'])?([^\s"'\\<>&,;{}[\]()]+)/g
const TAG = /<[^<>]{1,4000}>/g
const ATTRIBUTE = /([\w:-]+)\s*=\s*["']([^"']*)["']/g

function tokenLeft(name: string, value: string, inRedirect = false): boolean {
  return value.length >= MIN_RAW_TOKEN && !ALIAS.test(value) && tokenLikeName(name, inRedirect)
}

/** Whether text still shows a token-like name beside a value that is not an alias. */
export function unreplacedToken(text: string, inRedirect = false): boolean {
  for (const match of text.matchAll(RAW_PAIR)) {
    if (tokenLeft(match[1], match[2], inRedirect)) return true
  }
  // `<input name="csrf_token" value="...">` and `<meta name="api-token" content="...">`.
  for (const [tag] of text.matchAll(TAG)) {
    const attributes = [...tag.matchAll(ATTRIBUTE)].map(([, name, value]) => ({ name, value }))
    const named = attributes.some(
      ({ name, value }) => /^(name|id|property|key)$/i.test(name) && tokenLikeName(value)
    )
    if (
      named &&
      attributes.some(
        ({ name, value }) =>
          /^(value|content)$/i.test(name) && value.length >= MIN_RAW_TOKEN && !ALIAS.test(value)
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * Replaces the tokens in a credentialed response, whatever its content type: JSON, a form-encoded
 * body, and a redirect's query and fragment. Any other text is shown only when nothing in it
 * looks like a token.
 */
export function aliasResponseTokens(
  input: { body: string; contentType: string; location?: string },
  derive: DeriveToken
): AliasedResponse {
  const withheld = (reason: string): AliasedResponse => ({ ok: false, reason })
  const count = counted(derive)
  const raw = input.body.replace(/^\uFEFF/, '')
  if (raw.includes('\u0000')) return withheld('it is in an encoding SideKick could not read')
  const trimmed = raw.trim()
  let body = raw
  try {
    if (/json/i.test(input.contentType) || /^[[{]/.test(trimmed)) {
      if (trimmed) body = JSON.stringify(aliasJson(JSON.parse(trimmed), count, false), null, 2)
    } else if (
      /x-www-form-urlencoded/i.test(input.contentType) ||
      (FORM_BODY.test(trimmed) && !/html|xml/i.test(input.contentType))
    ) {
      body = aliasParams(new URLSearchParams(trimmed), count, false)
    }
  } catch {
    return withheld('SideKick could not read it to replace every token in it')
  }
  let location = input.location
  if (location !== undefined) {
    try {
      location = aliasLocation(location, count)
    } catch {
      return withheld('SideKick could not read its Location header to replace every token in it')
    }
    if (unreplacedToken(location, true)) {
      return withheld('its Location header holds a token SideKick could not replace')
    }
  }
  if (unreplacedToken(body)) return withheld('it holds a token SideKick could not replace')
  return { ok: true, body, ...(location !== undefined ? { location } : {}), tokens: count.aliases }
}
