/**
 * Credentials the user stores for SideKick's agent to use by alias. Values live only in the main
 * process: nothing here, and nothing the renderer or the model receives, ever carries one.
 */

export const CREDENTIAL_KINDS = ['secret', 'sign_in'] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

/** When SideKick asks before a use the entry's scope already allows. */
export const CREDENTIAL_ASK_POLICIES = ['every_use', 'once_per_chat', 'never'] as const
export type CredentialAskPolicy = (typeof CREDENTIAL_ASK_POLICIES)[number]

export interface CredentialScope {
  /** `all`, or the ids of the projects whose chats may use the entry. */
  projects: 'all' | string[]
  /** Whether chats a schedule or another chat started may use it. */
  background: boolean
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

/** Returns a normalized scope, or a reason it is invalid. */
export function normalizeCredentialScope(
  value: unknown
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
  return { scope: { projects, background: value.background } }
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
  const scope = normalizeCredentialScope(input.scope)
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
  return changes
}
