/**
 * Credentials the user stores for SideKick's agent to use by alias. Values live only in the main
 * process: nothing here, and nothing the renderer or the model receives, ever carries one.
 */

export const CREDENTIAL_KINDS = ['secret', 'sign_in'] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

/**
 * Where a value goes in a web request. The agent says, for each request; SideKick puts the value
 * there itself, so the agent never handles it.
 */
export type CredentialSend =
  | { as: 'header'; name: string; prefix: string }
  | { as: 'basic' }
  | { as: 'query'; name: string }
  | { as: 'form'; name: string; usernameName?: string }
  | { as: 'json'; name: string; usernameName?: string }

/** What the renderer and the agent may know about an entry. */
export interface CredentialSummary {
  id: string
  alias: string
  kind: CredentialKind
  description: string
  /** A sign-in's username, which the agent may read as a password manager shows it. */
  username?: string
  /**
   * The sites it belongs to, as a password manager keeps a login's website: web requests and
   * sign-ins go only to these hosts and their subdomains. Absent or empty means anywhere.
   */
  sites?: string[]
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  /**
   * The stored record cannot be read on this computer, as after copying the profile to another
   * one. It keeps its alias and description but needs its values entered again.
   */
  needsValue: boolean
}

/** New values, each optional when editing: an absent field keeps the stored one. */
export interface CredentialValues {
  secret?: string
  username?: string
  password?: string
}

export interface CredentialSaveInput {
  /** Absent for a new entry. */
  id?: string
  alias: string
  kind: CredentialKind
  description: string
  sites?: string[]
  values?: CredentialValues
}

export type CredentialSaveResult =
  | { ok: true; credential: CredentialSummary; credentials: CredentialSummary[] }
  | { ok: false; error: string; cancelled?: boolean }

export type CredentialEventKind =
  | 'created'
  | 'value_replaced'
  | 'changed'
  | 'deleted'
  | 'used'
  | 'denied'
  | 'refused'

/** One audit record. It names what was used and where, never a value, its length or a hash. */
export interface CredentialEvent {
  id: string
  credentialId: string
  alias: string
  kind: CredentialEventKind
  at: number
  tool?: string
  target?: string
  conversationId?: string
  runId?: string
  /** Plain words, such as which settings changed or why a use was refused. */
  detail?: string
}

export interface CredentialStatus {
  available: boolean
  reason?: string
}

/** What SideKick's agent asked the user to add or update in Settings. */
export interface CredentialRequest {
  alias: string
  description?: string
  kind?: CredentialKind
  /** The website the agent suggests, already reduced to its host name. */
  site?: string
}

export interface CredentialsAPI {
  status(): Promise<CredentialStatus>
  list(): Promise<CredentialSummary[]>
  save(input: CredentialSaveInput): Promise<CredentialSaveResult>
  delete(id: string): Promise<{ deleted: boolean; credentials: CredentialSummary[] }>
  events(credentialId?: string): Promise<CredentialEvent[]>
  onChanged(callback: () => void): () => void
}

export const CREDENTIAL_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const MAX_CREDENTIAL_DESCRIPTION = 500
export const MAX_CREDENTIAL_VALUE = 16_384
/** Values shorter than this are hard to keep out of output; Settings warns when saving one. */
export const SHORT_CREDENTIAL_VALUE = 8
/** Shorter values would cut ordinary words out of output, so they are never hidden or stored. */
export const MIN_CREDENTIAL_VALUE = 4

/**
 * A value as stored: one kind of line ending, so a pasted key matches output line by line, and,
 * except for a password, without the spaces around it that copying a token often adds.
 */
export function normalizeCredentialValue(field: keyof CredentialValues, value: string): string {
  const text = value.replace(/\r\n?/g, '\n')
  return field === 'password' ? text : text.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Headers a credential may never be placed in: they decide how the request itself travels. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect'
])
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/
const FIELD_NAME = /^[\w.\-[\]]{1,100}$/

export function isReservedCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return RESERVED_HEADERS.has(lower) || lower.startsWith('proxy-')
}

/** A placement the agent asked for, normalized, or why it cannot be used. */
export function normalizeCredentialSend(
  value: unknown,
  kind: CredentialKind
): CredentialSend | string {
  if (!isRecord(value))
    return 'credential_as must be an object such as {"as": "header", "name": "X-Api-Key"}.'
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const usernameName = typeof value.usernameName === 'string' ? value.usernameName.trim() : ''
  switch (value.as) {
    case 'header': {
      if (!HEADER_NAME.test(name) || isReservedCredentialHeader(name)) {
        return 'Name a header SideKick can send the value in, such as Authorization or X-Api-Key.'
      }
      const prefix = typeof value.prefix === 'string' ? value.prefix : ''
      if (prefix.length > 50 || /[\r\n\0]/.test(prefix)) return 'Invalid header prefix.'
      return { as: 'header', name, prefix }
    }
    case 'basic':
      if (kind !== 'sign_in') return 'Basic authentication needs a sign-in with a username.'
      return { as: 'basic' }
    case 'query':
      if (!FIELD_NAME.test(name)) return 'Name the query parameter.'
      return { as: 'query', name }
    case 'form':
    case 'json': {
      if (!FIELD_NAME.test(name)) return 'Name the field.'
      if (kind === 'sign_in') {
        if (!FIELD_NAME.test(usernameName) || usernameName === name) {
          return 'Name the username field (username_name), different from the password field.'
        }
        return { as: value.as, name, usernameName }
      }
      return { as: value.as, name }
    }
    default:
      return 'credential_as.as must be header, basic, query, form or json.'
  }
}

/** Where a value goes when the agent does not say: a bearer token, or Basic for a sign-in. */
export function defaultCredentialSend(kind: CredentialKind): CredentialSend {
  return kind === 'sign_in'
    ? { as: 'basic' }
    : { as: 'header', name: 'Authorization', prefix: 'Bearer ' }
}

/** The placement an `http_request` call asks for, in the tool's own argument names. */
export function credentialSendFor(raw: unknown, kind: CredentialKind): CredentialSend | string {
  if (raw === undefined || raw === null) return defaultCredentialSend(kind)
  if (!isRecord(raw)) return normalizeCredentialSend(raw, kind)
  return normalizeCredentialSend(
    { ...raw, usernameName: raw.username_name ?? raw.usernameName },
    kind
  )
}

/**
 * The program a command runs when it is one simple command: no chaining, pipes, redirection,
 * subshells, script blocks or command substitution, in Bash or PowerShell. Null otherwise.
 * Variables may be referenced, as `$NAME`, `${NAME}` or `$env:NAME`.
 */
export function simpleCommandProgram(command: string): string | null {
  const text = command.trim()
  if (!text || text.length > 4_000) return null
  const withoutVariables = text.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, '$V')
  if (/[;|&<>`\r\n(){}]|\$\(/.test(withoutVariables)) return null
  const first = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(text)
  const program = (first?.[1] ?? first?.[2] ?? first?.[3] ?? '').toLowerCase()
  // A bare name, found on PATH: a path could point at a script the agent wrote under that name.
  if (!/^[a-z0-9][a-z0-9._+-]*$/.test(program)) return null
  return program.replace(/\.(exe|cmd|bat|ps1|com)$/, '') || null
}

/**
 * Environment variables a credential may not be put in, because they change which program runs,
 * where code is loaded from, or how the shell behaves.
 */
const RESERVED_VARIABLES = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SHELL',
  'BASH_ENV',
  'ENV',
  'IFS',
  'PROMPT_COMMAND',
  'COMSPEC',
  'PSMODULEPATH',
  'SYSTEMROOT',
  'WINDIR',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'GIT_PAGER',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'WORKSPACE_FOLDER',
  'TERM'
])
const RESERVED_VARIABLE_PREFIXES = [
  'LD_',
  'DYLD_',
  'NODE_',
  'PYTHON',
  'PERL',
  'RUBY',
  'SIDEKICK_',
  'GIT_CONFIG',
  'NPM_CONFIG_'
]

/** Why a credential cannot go in this environment variable, or null. */
export function credentialVariableRefusal(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    return `${name} is not a valid environment variable name.`
  }
  const upper = name.toUpperCase()
  if (
    RESERVED_VARIABLES.has(upper) ||
    RESERVED_VARIABLE_PREFIXES.some((prefix) => upper.startsWith(prefix))
  ) {
    return `${name} changes how commands run, so a credential cannot go in it. Choose another name.`
  }
  return null
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * The canonical origin of a site: HTTPS, or plain HTTP only on this computer's loopback address,
 * with no path. Browsers treat both as secure contexts; a sign-in is filled in on nothing else.
 */
export function normalizeCredentialOrigin(raw: string): string | null {
  const text = raw.trim()
  if (!text || /\s/.test(text)) return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  const hostname = url.hostname.replace(/\.$/, '')
  if (!hostname) return null
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(hostname))) {
    return null
  }
  return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}`
}

/** The origin of a page address, or null when it is not one a sign-in may be filled on. */
export function credentialPageOrigin(address: string): string | null {
  try {
    const url = new URL(address)
    if (url.username || url.password) return null
    return normalizeCredentialOrigin(`${url.protocol}//${url.host}`)
  } catch {
    return null
  }
}

export const MAX_CREDENTIAL_SITES = 10

/**
 * A site as the user typed it, such as `github.com` or `https://login.example.com/path`, reduced to
 * its host name: lowercase, without a scheme, port, path or trailing dot. Null when it is not one.
 */
export function normalizeCredentialSite(raw: string): string | null {
  const text = raw.trim().toLowerCase()
  if (!text || /\s/.test(text)) return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.username || url.password) return null
  const host = url.hostname.replace(/\.$/, '')
  return host && !host.includes('*') ? host : null
}

/** The sites typed into one field, separated by commas or spaces. */
export function credentialSitesFrom(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((site) => site.trim())
    .filter(Boolean)
}

/** Whether a host is one of an entry's sites or under one; an entry with none goes anywhere. */
export function credentialSiteMatches(sites: readonly string[] | undefined, host: string): boolean {
  if (!sites?.length) return true
  const name = host.toLowerCase().replace(/\.$/, '')
  return sites.some((site) => name === site || name.endsWith(`.${site}`))
}

/**
 * Checks a save request's shape. `existing` is the entry being edited, which decides whether
 * values are required.
 */
export function validateCredentialInput(
  input: unknown,
  existing?: { kind: CredentialKind; needsValue: boolean }
): { input: CredentialSaveInput } | { error: string } {
  if (!isRecord(input)) return { error: 'Invalid credential.' }
  const alias = typeof input.alias === 'string' ? input.alias.trim() : ''
  if (!CREDENTIAL_ALIAS_PATTERN.test(alias)) {
    return {
      error:
        'The name must be 1 to 64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.'
    }
  }
  if (!CREDENTIAL_KINDS.includes(input.kind as CredentialKind)) {
    return { error: 'Choose Secret or Sign-in.' }
  }
  const kind = input.kind as CredentialKind
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (description.length > MAX_CREDENTIAL_DESCRIPTION) {
    return { error: `The description can be at most ${MAX_CREDENTIAL_DESCRIPTION} characters.` }
  }
  if (input.id !== undefined && (typeof input.id !== 'string' || !input.id)) {
    return { error: 'Invalid credential id.' }
  }
  const sites: string[] = []
  if (input.sites !== undefined) {
    if (!Array.isArray(input.sites) || input.sites.length > MAX_CREDENTIAL_SITES) {
      return { error: `Name at most ${MAX_CREDENTIAL_SITES} websites.` }
    }
    for (const raw of input.sites) {
      const site = typeof raw === 'string' ? normalizeCredentialSite(raw) : null
      if (!site) return { error: `${typeof raw === 'string' ? raw : 'That'} is not a website.` }
      if (!sites.includes(site)) sites.push(site)
    }
  }

  const raw = input.values === undefined ? {} : input.values
  if (!isRecord(raw)) return { error: 'Invalid credential values.' }
  const values: CredentialValues = {}
  for (const field of ['secret', 'username', 'password'] as const) {
    if (raw[field] === undefined) continue
    if (typeof raw[field] !== 'string') return { error: 'Invalid credential values.' }
    const value = normalizeCredentialValue(field, raw[field])
    if (!value) return { error: 'A new value cannot be empty.' }
    if (value.length > MAX_CREDENTIAL_VALUE) return { error: 'That value is too long.' }
    if (field !== 'username' && value.length < MIN_CREDENTIAL_VALUE) {
      return {
        error: `The password or key must be at least ${MIN_CREDENTIAL_VALUE} characters; SideKick cannot keep shorter values out of output.`
      }
    }
    values[field] = value
  }
  const fields = kind === 'secret' ? (['secret'] as const) : (['username', 'password'] as const)
  if (Object.keys(values).some((field) => !(fields as readonly string[]).includes(field))) {
    return { error: 'Those values do not belong to this kind of credential.' }
  }
  // A new entry, a changed kind, or a record this computer cannot read needs every value.
  const needsEvery = !existing || existing.kind !== kind || existing.needsValue
  if (needsEvery && fields.some((field) => !values[field])) {
    return {
      error: kind === 'secret' ? 'Enter the password or key.' : 'Enter the password.'
    }
  }
  return {
    input: {
      ...(typeof input.id === 'string' ? { id: input.id } : {}),
      alias,
      kind,
      description,
      sites,
      values
    }
  }
}

/** How a value travels, in words, for Settings and approval cards. */
export function describeCredentialSend(send: CredentialSend): string {
  switch (send.as) {
    case 'header':
      return `in the ${send.name} header${send.prefix.trim() ? ` after "${send.prefix.trim()}"` : ''}`
    case 'basic':
      return 'as Basic authentication'
    case 'query':
      return `as the ${send.name} query parameter`
    case 'form':
      return `as the ${send.name} form field`
    case 'json':
      return `as the ${send.name} JSON field`
  }
}
