/**
 * Credentials the user stores for SideKick's agent to use by alias. Values live only in the main
 * process: nothing here, and nothing the renderer or the model receives, ever carries one.
 */

export const CREDENTIAL_KINDS = ['secret', 'sign_in'] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

/** When SideKick asks before a use the entry's scope already allows. */
export const CREDENTIAL_ASK_POLICIES = ['every_use', 'once_per_chat', 'never'] as const
export type CredentialAskPolicy = (typeof CREDENTIAL_ASK_POLICIES)[number]

/**
 * Where a value goes in a request. The user decides this, not the model, so the model cannot put a
 * value somewhere an allowed host would publish it, such as an issue comment's body.
 */
export type CredentialSend =
  | { as: 'header'; name: string; prefix: string }
  | { as: 'basic' }
  | { as: 'query'; name: string }
  | { as: 'form'; name: string; usernameName?: string }
  | { as: 'json'; name: string; usernameName?: string }

export interface CredentialWebScope {
  /** Exact hosts, with a port when it is not 443, or `*.example.com` for its subdomains. */
  hosts: string[]
  send: CredentialSend
  /** Hosts that may receive tokens returned by a request that used this credential. */
  tokenHosts: string[]
}

/**
 * Commands that may receive the value in an environment variable. A command that holds a value can
 * reveal it, so `ask` asks before every command, and `programs` admits only a single simple command
 * whose program is one the user named.
 */
export interface CredentialCommandScope {
  mode: 'ask' | 'programs'
  programs: string[]
}

export interface CredentialScope {
  /** `all`, or the ids of the projects whose chats may use the entry. */
  projects: 'all' | string[]
  /** Whether chats a schedule or another chat started may use it. */
  background: boolean
  /** Absent when the entry may not be sent in web requests. */
  web?: CredentialWebScope
  /** Absent when no command may receive the entry. */
  commands?: CredentialCommandScope
}

/** What the renderer and the agent may know about an entry. */
export interface CredentialSummary {
  id: string
  alias: string
  kind: CredentialKind
  description: string
  /** Lets the agent read a sign-in's username; the password stays hidden either way. */
  usernameVisible: boolean
  /** Present only when `usernameVisible` is on. */
  username?: string
  ask: CredentialAskPolicy
  scope: CredentialScope
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  /**
   * The stored record cannot be read on this computer, as after copying the profile to another
   * one. It keeps its alias and description but needs its values and scope entered again.
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
  usernameVisible: boolean
  ask: CredentialAskPolicy
  scope: CredentialScope
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

export const CREDENTIAL_ASK_LABELS: Record<CredentialAskPolicy, string> = {
  every_use: 'Every use',
  once_per_chat: 'First use in each chat',
  never: 'Never, within its scope'
}

export function defaultCredentialScope(): CredentialScope {
  return { projects: 'all', background: false }
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

/**
 * The canonical form of a host the user typed: lowercase, punycode, no trailing dot, and a port
 * only when it is not 443. `*.example.com` stands for the subdomains of a domain. Anything with a
 * path, user name, another scheme or a wildcard elsewhere is refused.
 */
export function normalizeCredentialHost(raw: string): string | null {
  let text = raw.trim().toLowerCase()
  if (text.startsWith('https://')) text = text.slice('https://'.length).replace(/\/$/, '')
  if (!text || /[\s/@?#\\]/.test(text)) return null
  const wildcard = text.startsWith('*.')
  if (wildcard) text = text.slice(2)
  if (text.includes('*')) return null
  let url: URL
  try {
    url = new URL(`https://${text}`)
  } catch {
    return null
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
  const host = url.hostname.replace(/\.$/, '')
  if (!host) return null
  if (wildcard) {
    // A wildcard covers a domain's subdomains, never an address or a bare suffix.
    if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host) || host.split('.').length < 2) {
      return null
    }
  }
  return `${wildcard ? '*.' : ''}${host}${url.port ? `:${url.port}` : ''}`
}

function splitHostPort(pattern: string): { host: string; port: string } {
  if (pattern.startsWith('[')) {
    const end = pattern.indexOf(']')
    return { host: pattern.slice(0, end + 1), port: pattern.slice(end + 2) }
  }
  const colon = pattern.lastIndexOf(':')
  return colon < 0
    ? { host: pattern, port: '' }
    : { host: pattern.slice(0, colon), port: pattern.slice(colon + 1) }
}

/** Whether `url` is an HTTPS address on one of `patterns`, port included. */
export function credentialHostMatches(patterns: readonly string[], url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  return patterns.some((pattern) => {
    const expected = splitHostPort(pattern)
    if (expected.port !== url.port) return false
    if (expected.host.startsWith('*.')) return host.endsWith(`.${expected.host.slice(2)}`)
    return host === expected.host
  })
}

function normalizeHosts(value: unknown, label: string, allowEmpty: boolean): string[] | string {
  if (!Array.isArray(value) || value.length > 50) return `Invalid ${label} list.`
  const hosts: string[] = []
  for (const raw of value) {
    const host = typeof raw === 'string' ? normalizeCredentialHost(raw) : null
    if (!host) return `${typeof raw === 'string' && raw ? raw : 'That'} is not a host name.`
    if (!hosts.includes(host)) hosts.push(host)
  }
  if (!allowEmpty && !hosts.length) return `Add at least one ${label}.`
  return hosts.sort()
}

function normalizeSend(value: unknown, kind: CredentialKind): CredentialSend | string {
  if (!isRecord(value)) return 'Choose how the value is sent.'
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const usernameName = typeof value.usernameName === 'string' ? value.usernameName.trim() : ''
  switch (value.as) {
    case 'header': {
      if (!HEADER_NAME.test(name) || isReservedCredentialHeader(name)) {
        return 'Enter a header name SideKick can send, such as Authorization or X-Api-Key.'
      }
      const prefix = typeof value.prefix === 'string' ? value.prefix : ''
      if (prefix.length > 50 || /[\r\n\0]/.test(prefix)) return 'Invalid header prefix.'
      return { as: 'header', name, prefix }
    }
    case 'basic':
      if (kind !== 'sign_in') return 'Basic authentication needs a sign-in.'
      return { as: 'basic' }
    case 'query':
      if (!FIELD_NAME.test(name)) return 'Enter the query parameter name.'
      return { as: 'query', name }
    case 'form':
    case 'json': {
      if (!FIELD_NAME.test(name)) return 'Enter the field name.'
      if (kind === 'sign_in') {
        if (!FIELD_NAME.test(usernameName) || usernameName === name) {
          return 'Enter the username field name, different from the password field.'
        }
        return { as: value.as, name, usernameName }
      }
      return { as: value.as, name }
    }
    default:
      return 'Choose how the value is sent.'
  }
}

/** Returns a normalized web scope, or a reason it is invalid. */
export function normalizeCredentialWebScope(
  value: unknown,
  kind: CredentialKind
): { web: CredentialWebScope } | { error: string } {
  if (!isRecord(value)) return { error: 'Invalid web request settings.' }
  const hosts = normalizeHosts(value.hosts, 'host', false)
  if (typeof hosts === 'string') return { error: hosts }
  const tokenHosts = normalizeHosts(value.tokenHosts ?? [], 'token host', true)
  if (typeof tokenHosts === 'string') return { error: tokenHosts }
  const send = normalizeSend(value.send, kind)
  if (typeof send === 'string') return { error: send }
  return { web: { hosts, send, tokenHosts } }
}

/**
 * Programs that run whatever they are given, so allowing one would allow every command: shells,
 * interpreters, launchers and package runners.
 */
const UNSAFE_PROGRAMS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'pwsh',
  'powershell',
  'cmd',
  'wsl',
  'node',
  'deno',
  'bun',
  'python',
  'python3',
  'py',
  'ruby',
  'perl',
  'php',
  'lua',
  'osascript',
  'wscript',
  'cscript',
  'mshta',
  'rundll32',
  'regsvr32',
  'start',
  // These run other programs, or commands on another computer, as easily as a shell.
  'ssh',
  'busybox',
  'toybox',
  'su',
  'script',
  'watch',
  'timeout',
  'nice',
  'stdbuf',
  'chroot',
  'parallel',
  'env',
  'sudo',
  'doas',
  'runas',
  'nohup',
  'time',
  'xargs',
  'find',
  'awk',
  'sed',
  'make',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'invoke-expression',
  'iex',
  'invoke-command',
  'start-process'
])

/** Why a program cannot be allowed, or null. */
export function credentialProgramRefusal(program: string): string | null {
  const name = program.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(name)) return `${program} is not a program name.`
  if (UNSAFE_PROGRAMS.has(name.replace(/\.(exe|cmd|bat|ps1)$/, ''))) {
    return `${name} runs whatever it is given, so allowing it would allow every command.`
  }
  return null
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

function normalizeCommands(value: unknown): CredentialCommandScope | string {
  if (!isRecord(value)) return 'Invalid command settings.'
  if (value.mode === 'ask') return { mode: 'ask', programs: [] }
  if (value.mode !== 'programs') return 'Choose how commands may use it.'
  if (!Array.isArray(value.programs) || !value.programs.length || value.programs.length > 20) {
    return 'Name at least one program.'
  }
  const programs: string[] = []
  for (const raw of value.programs) {
    if (typeof raw !== 'string') return 'Invalid program.'
    const refusal = credentialProgramRefusal(raw)
    if (refusal) return refusal
    const name = raw
      .trim()
      .toLowerCase()
      .replace(/\.(exe|cmd|bat|ps1|com)$/, '')
    if (!programs.includes(name)) programs.push(name)
  }
  return { mode: 'programs', programs: programs.sort() }
}

/** Returns a normalized scope, or a reason it is invalid. */
export function normalizeCredentialScope(
  value: unknown,
  kind: CredentialKind = 'secret'
): { scope: CredentialScope } | { error: string } {
  if (!isRecord(value)) return { error: 'Choose where the credential can be used.' }
  let projects: CredentialScope['projects']
  if (value.projects === 'all') projects = 'all'
  else if (
    Array.isArray(value.projects) &&
    value.projects.length > 0 &&
    value.projects.length <= 200 &&
    value.projects.every((id) => typeof id === 'string' && /^[\w.:-]{1,200}$/.test(id))
  ) {
    projects = [...new Set(value.projects as string[])].sort()
  } else return { error: 'Choose all projects or at least one project.' }
  if (typeof value.background !== 'boolean') return { error: 'Invalid background setting.' }
  const scope: CredentialScope = { projects, background: value.background }
  if (value.web !== undefined && value.web !== null) {
    const web = normalizeCredentialWebScope(value.web, kind)
    if ('error' in web) return web
    scope.web = web.web
  }
  if (value.commands !== undefined && value.commands !== null) {
    const commands = normalizeCommands(value.commands)
    if (typeof commands === 'string') return { error: commands }
    scope.commands = commands
  }
  return { scope }
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
        'The alias must be 1 to 64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.'
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
  if (!CREDENTIAL_ASK_POLICIES.includes(input.ask as CredentialAskPolicy)) {
    return { error: 'Choose when SideKick asks before a use.' }
  }
  if (typeof input.usernameVisible !== 'boolean') return { error: 'Invalid username setting.' }
  const scope = normalizeCredentialScope(input.scope, kind)
  if ('error' in scope) return scope
  if (input.id !== undefined && (typeof input.id !== 'string' || !input.id)) {
    return { error: 'Invalid credential id.' }
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
        error: `The ${field} must be at least ${MIN_CREDENTIAL_VALUE} characters; SideKick cannot keep shorter values out of output.`
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
      error: kind === 'secret' ? 'Enter the secret.' : 'Enter both the username and the password.'
    }
  }
  return {
    input: {
      ...(typeof input.id === 'string' ? { id: input.id } : {}),
      alias,
      kind,
      description,
      usernameVisible: kind === 'sign_in' && input.usernameVisible,
      ask: input.ask as CredentialAskPolicy,
      scope: scope.scope,
      values
    }
  }
}

const ASK_ORDER: Record<CredentialAskPolicy, number> = { every_use: 0, once_per_chat: 1, never: 2 }

/**
 * Plain descriptions of every way `next` lets the agent use an entry more than `previous` did.
 * Widening an existing entry needs the user's confirmation in a trusted dialog, so a compromised
 * renderer cannot quietly extend where a stored value may go.
 */
export function credentialWidening(
  previous: Pick<CredentialSummary, 'ask' | 'scope' | 'usernameVisible'>,
  next: Pick<CredentialSaveInput, 'ask' | 'scope' | 'usernameVisible'>
): string[] {
  const changes: string[] = []
  if (ASK_ORDER[next.ask] > ASK_ORDER[previous.ask]) {
    changes.push(`Ask before use: ${CREDENTIAL_ASK_LABELS[next.ask]}`)
  }
  const before = previous.scope.projects
  const after = next.scope.projects
  if (after === 'all') {
    if (before !== 'all') changes.push('Usable in every project')
  } else if (before !== 'all') {
    const added = after.filter((id) => !before.includes(id))
    if (added.length) {
      changes.push(`Usable in ${added.length} more project${added.length === 1 ? '' : 's'}`)
    }
  }
  if (next.scope.background && !previous.scope.background) {
    changes.push('Usable by schedules and chats other chats start')
  }
  if (next.usernameVisible && !previous.usernameVisible) {
    changes.push('The agent can read the username')
  }
  const web = next.scope.web
  const previousWeb = previous.scope.web
  if (web) {
    const hosts = web.hosts.filter((host) => !previousWeb?.hosts.includes(host))
    if (hosts.length) changes.push(`Sent in web requests to ${hosts.join(', ')}`)
    const tokenHosts = web.tokenHosts.filter((host) => !previousWeb?.tokenHosts.includes(host))
    if (tokenHosts.length) changes.push(`Tokens it returns sent to ${tokenHosts.join(', ')}`)
    if (previousWeb && JSON.stringify(previousWeb.send) !== JSON.stringify(web.send)) {
      changes.push(`Sent ${describeCredentialSend(web.send)}`)
    }
  }
  const commands = next.scope.commands
  const previousCommands = previous.scope.commands
  if (commands) {
    if (!previousCommands)
      changes.push(`Usable in commands: ${describeCredentialCommands(commands)}`)
    else if (commands.mode === 'programs') {
      const programs = commands.programs.filter(
        (program) =>
          previousCommands.mode !== 'programs' || !previousCommands.programs.includes(program)
      )
      if (programs.length)
        changes.push(`Commands may use it without asking each time: ${programs.join(', ')}`)
    }
  }
  return changes
}

/** Which commands may receive a value, in words. */
export function describeCredentialCommands(commands: CredentialCommandScope): string {
  return commands.mode === 'ask'
    ? 'any command, asking every time'
    : `${commands.programs.join(', ')} only, one simple command at a time`
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

/** Which chat wants to use an entry: its project, and whether the user started it. */
export interface CredentialUseContext {
  projectId: string | null
  /** Started by a schedule or by another chat rather than by the user. */
  background: boolean
}

/** Why an entry's project and background scope keep it out of this chat, or null. */
export function credentialScopeRefusal(
  credential: Pick<CredentialSummary, 'needsValue' | 'scope'>,
  context: CredentialUseContext | undefined
): string | null {
  if (credential.needsValue) return 'its value has to be entered again on this computer'
  if (credential.scope.projects !== 'all') {
    if (!context?.projectId || !credential.scope.projects.includes(context.projectId)) {
      return "it is not allowed in this chat's project"
    }
  }
  if (context?.background && !credential.scope.background) {
    return 'it is not allowed in chats a schedule or another chat started'
  }
  return null
}
