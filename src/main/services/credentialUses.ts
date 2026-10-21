/**
 * How a tool uses a stored credential: whether the call needs the user's approval first, and, at
 * the moment the tool sends a request or starts a process, the values, after checking scope again.
 * Values go only to a call the kernel approved for exactly that use. Every use, denial and refusal
 * is audited by alias and target, never by value.
 */
import type { AgentApprovalPreview } from '../../shared/agentRuntime'
import {
  CREDENTIAL_ASK_LABELS,
  credentialHostMatches,
  credentialScopeRefusal,
  describeCredentialSend,
  simpleCommandProgram,
  type CredentialAskPolicy,
  type CredentialEvent,
  type CredentialEventKind,
  type CredentialSend,
  type CredentialSummary,
  type CredentialUseContext,
  type CredentialValues
} from '../../shared/credentials'
import type { ResolvedCredential } from './credentialVault'

export type CredentialUseKind = 'web' | 'command'

export interface CredentialUseRequest {
  alias: string
  tool: string
  kind: CredentialUseKind
  /** A web request's URL, or a command's text. */
  target: string
  /** For a command: the environment variable that receives the value. */
  variable?: string
  conversationId?: string
  runId?: string
  /** Set by the tool registry from the call, never from its arguments. */
  toolCallId?: string
}

/** A use the kernel refuses before the call runs, without asking anyone. */
export interface CredentialRefusal {
  refused: string
}

/** What the kernel shows before a call that names a credential runs. */
export interface CredentialApproval {
  alias: string
  ask: CredentialAskPolicy
  /** Chat-grant keys: the same entry used for the same target. */
  keys: string[]
  /** What "Allow for this chat" covers, in words. */
  label: string
  preview: AgentApprovalPreview
}

export type CredentialTake =
  | { ok: true; summary: CredentialSummary; values: CredentialValues; send?: CredentialSend }
  | { ok: false; message: string }

/** The vault calls this service relies on. */
export interface CredentialStore {
  list(): CredentialSummary[]
  resolve(alias: string): ResolvedCredential | undefined
  record(
    kind: CredentialEventKind,
    entry: { id: string; alias: string },
    details?: Partial<
      Pick<CredentialEvent, 'tool' | 'target' | 'conversationId' | 'runId' | 'detail'>
    >
  ): unknown
  setTransientSecrets(secrets: ReadonlyArray<{ alias: string; value: string }>): void
}

interface DerivedToken {
  alias: string
  parentAlias: string
  runId: string
  value: string
  expiresAt: number
}

type Checked =
  | {
      ok: true
      credential: CredentialSummary
      /** For web uses. */
      url?: URL
      derived?: DerivedToken
    }
  | { ok: false; message: string; credential?: CredentialSummary }

/** A returned token is usable for at most this long, or less when the response says so. */
const DERIVED_TOKEN_LIFETIME_MS = 60 * 60 * 1_000
const DERIVED_ALIAS = /^([a-z0-9][a-z0-9_-]{0,63})~(\d+)$/
const SETTINGS_HINT = 'The user can change this in Settings → Credentials.'

/** Where a web request goes, without its query: a value sent as a parameter must not be kept. */
export function credentialWebTarget(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`
}

/** What the audit and approval card show for a use's target. */
function shownTarget(request: CredentialUseRequest): string | undefined {
  if (request.kind === 'command') return request.target.slice(0, 300)
  try {
    return credentialWebTarget(new URL(request.target))
  } catch {
    return undefined
  }
}

/** One approved use: the run, the call, the alias, and the address or command it was approved for. */
function permitKey(request: CredentialUseRequest): string | undefined {
  if (!request.runId || !request.toolCallId) return undefined
  let target = request.target
  if (request.kind === 'web') {
    try {
      target = new URL(request.target).href
    } catch {
      return undefined
    }
  }
  return JSON.stringify([
    request.runId,
    request.toolCallId,
    request.kind,
    request.alias,
    target,
    request.variable ?? ''
  ])
}

export class CredentialUses {
  private readonly derived = new Map<string, DerivedToken>()
  /** Tokens that expired or whose run ended, still redacted until SideKick restarts. */
  private readonly retiredDerived: Array<{ alias: string; value: string }> = []
  private readonly permits = new Set<string>()
  private derivedCount = 0

  constructor(
    private readonly store: CredentialStore,
    private readonly useContext: (
      conversationId: string | undefined
    ) => CredentialUseContext | undefined,
    private readonly now: () => number = Date.now
  ) {}

  private find(alias: string): CredentialSummary | undefined {
    return this.store.list().find((credential) => credential.alias === alias)
  }

  private liveDerived(alias: string): DerivedToken | undefined {
    const token = this.derived.get(alias)
    if (!token) return undefined
    if (token.expiresAt > this.now()) return token
    this.retire([token])
    return undefined
  }

  /** A token stops working but stays redacted: the model must not learn it later from output. */
  private retire(tokens: readonly DerivedToken[]): void {
    for (const token of tokens) {
      this.derived.delete(token.alias)
      this.retiredDerived.push({ alias: token.alias, value: token.value })
    }
    if (tokens.length) this.publishDerived()
  }

  private publishDerived(): void {
    this.store.setTransientSecrets([
      ...[...this.derived.values()].map(({ alias, value }) => ({ alias, value })),
      ...this.retiredDerived
    ])
  }

  /**
   * Checks every rule that decides whether this use may happen, without asking anyone: the entry
   * exists, its project and background scope admit the chat, and the target is in its scope.
   */
  private check(request: CredentialUseRequest): Checked {
    const derivedMatch = DERIVED_ALIAS.exec(request.alias)
    if (derivedMatch) return this.checkDerived(request, derivedMatch[1])
    const credential = this.find(request.alias)
    if (!credential) {
      return {
        ok: false,
        message: `No credential is called ${request.alias}. Call credentials_list, or credentials_request to ask the user to add it.`
      }
    }
    const refusal = credentialScopeRefusal(credential, this.useContext(request.conversationId))
    if (refusal) {
      return {
        ok: false,
        credential,
        message: `${credential.alias} cannot be used here: ${refusal}.`
      }
    }
    return request.kind === 'command'
      ? this.checkCommand(credential, request.target)
      : this.checkWeb(credential, request.target)
  }

  private checkWeb(credential: CredentialSummary, target: string): Checked {
    let url: URL
    try {
      url = new URL(target)
    } catch {
      return { ok: false, credential, message: 'The request address is not a valid URL.' }
    }
    const web = credential.scope.web
    if (!web) {
      return {
        ok: false,
        credential,
        message: `${credential.alias} may not be sent in web requests. ${SETTINGS_HINT}`
      }
    }
    if (!credentialHostMatches(web.hosts, url)) {
      return {
        ok: false,
        credential,
        message: `${credential.alias} may be sent only over HTTPS to ${web.hosts.join(', ')}, not to ${url.protocol}//${url.host}. ${SETTINGS_HINT}`
      }
    }
    return { ok: true, credential, url }
  }

  private checkCommand(credential: CredentialSummary, command: string): Checked {
    const commands = credential.scope.commands
    if (!commands) {
      return {
        ok: false,
        credential,
        message: `${credential.alias} may not be given to commands. ${SETTINGS_HINT}`
      }
    }
    if (commands.mode === 'programs') {
      const program = simpleCommandProgram(command)
      if (!program) {
        return {
          ok: false,
          credential,
          message: `${credential.alias} is given only to one simple command at a time: no chaining, pipes, redirection, subshells or paths to a program. Run ${commands.programs.join(' or ')} on its own.`
        }
      }
      if (!commands.programs.includes(program)) {
        return {
          ok: false,
          credential,
          message: `${credential.alias} may be given only to ${commands.programs.join(', ')}, not ${program}. ${SETTINGS_HINT}`
        }
      }
    }
    return { ok: true, credential }
  }

  private checkDerived(request: CredentialUseRequest, parentAlias: string): Checked {
    const token = this.liveDerived(request.alias)
    const parent = this.find(parentAlias)
    if (!token || !parent || !request.runId || token.runId !== request.runId) {
      return {
        ok: false,
        message: `${request.alias} is not a token this reply received, or it has expired. Request a new one.`
      }
    }
    if (request.kind !== 'web') {
      return {
        ok: false,
        credential: parent,
        message: `${request.alias} is a token a request returned; it can be sent only in web requests.`
      }
    }
    const refusal = credentialScopeRefusal(parent, this.useContext(request.conversationId))
    if (refusal) {
      return {
        ok: false,
        credential: parent,
        message: `${parent.alias} cannot be used here: ${refusal}.`
      }
    }
    let url: URL
    try {
      url = new URL(request.target)
    } catch {
      return { ok: false, credential: parent, message: 'The request address is not a valid URL.' }
    }
    const hosts = parent.scope.web?.tokenHosts ?? []
    if (!credentialHostMatches(hosts, url)) {
      return {
        ok: false,
        credential: parent,
        message: hosts.length
          ? `Tokens from ${parent.alias} may be sent only over HTTPS to ${hosts.join(', ')}. ${SETTINGS_HINT}`
          : `${parent.alias} does not allow the tokens it returns to be sent anywhere. ${SETTINGS_HINT}`
      }
    }
    return { ok: true, credential: parent, url, derived: token }
  }

  /**
   * The approval a call needs before it runs, or the reason it is refused: a use outside scope is
   * refused then, never asked about, so no approval card can stand in for it.
   */
  approval(request: CredentialUseRequest): CredentialApproval | CredentialRefusal {
    const checked = this.check(request)
    if (!checked.ok) {
      if (checked.credential) {
        this.store.record('refused', checked.credential, {
          ...this.details(request),
          detail: checked.message
        })
      }
      return { refused: checked.message }
    }
    const { credential } = checked
    const about = credential.description ? [{ label: 'About', value: credential.description }] : []
    if (request.kind === 'command') {
      // A command that holds a value can reveal it, so "ask" means every command.
      const ask = credential.scope.commands?.mode === 'programs' ? credential.ask : 'every_use'
      return {
        alias: request.alias,
        ask,
        keys: [`credential:${credential.id}:command:${request.variable ?? ''}:${request.target}`],
        label: `${credential.alias} with this exact command`,
        preview: {
          summary: `SideKick puts ${request.alias} in ${request.variable ?? 'an environment variable'} for this command. The command can print or send the value, so read it before allowing it.`,
          changes: [],
          facts: [
            { label: 'Credential', value: request.alias },
            ...about,
            { label: 'Variable', value: request.variable ?? '' },
            { label: 'Command', value: request.target.slice(0, 300) },
            { label: 'Asks', value: CREDENTIAL_ASK_LABELS[ask] }
          ]
        }
      }
    }
    const url = checked.url!
    return {
      alias: request.alias,
      ask: credential.ask,
      keys: [`credential:${credential.id}:web:${url.protocol}//${url.host}`],
      label: `${credential.alias} with ${url.host}`,
      preview: {
        summary: `SideKick adds ${request.alias} to this request itself; the agent never sees the value.`,
        changes: [],
        facts: [
          { label: 'Credential', value: request.alias },
          ...about,
          { label: 'Sent to', value: credentialWebTarget(url) },
          {
            label: 'How',
            value: checked.derived
              ? 'as a bearer token it returned'
              : describeCredentialSend(credential.scope.web!.send)
          },
          { label: 'Asks', value: CREDENTIAL_ASK_LABELS[credential.ask] }
        ]
      }
    }
  }

  private details(request: CredentialUseRequest) {
    return {
      tool: request.tool,
      target: shownTarget(request),
      conversationId: request.conversationId,
      runId: request.runId
    }
  }

  /** The kernel approved this use for this call; `take` hands values only to approved uses. */
  permit(request: CredentialUseRequest): void {
    const key = permitKey(request)
    if (key) this.permits.add(key)
  }

  /** The values for an approved use about to happen, checked again now; records the outcome. */
  take(request: CredentialUseRequest): CredentialTake {
    const key = permitKey(request)
    const permitted = key !== undefined && this.permits.delete(key)
    const checked: ReturnType<CredentialUses['check']> = permitted
      ? this.check(request)
      : {
          ok: false,
          credential: this.find(DERIVED_ALIAS.exec(request.alias)?.[1] ?? request.alias),
          message: `SideKick did not approve ${request.alias} for this call. Make the call again.`
        }
    const details = this.details(request)
    if (!checked.ok) {
      if (checked.credential) {
        this.store.record('refused', checked.credential, { ...details, detail: checked.message })
      }
      return { ok: false, message: checked.message }
    }
    if (checked.derived) {
      this.store.record('used', checked.credential, {
        ...details,
        detail: `Returned token ${request.alias}`
      })
      return {
        ok: true,
        summary: checked.credential,
        values: { secret: checked.derived.value },
        send: { as: 'header', name: 'Authorization', prefix: 'Bearer ' }
      }
    }
    const resolved = this.store.resolve(checked.credential.alias)
    if (!resolved) {
      return { ok: false, message: `${checked.credential.alias} has no value on this computer.` }
    }
    this.store.record('used', checked.credential, {
      ...details,
      ...(request.variable ? { detail: `In ${request.variable}` } : {})
    })
    return {
      ok: true,
      summary: checked.credential,
      values: resolved.values,
      ...(request.kind === 'web' ? { send: checked.credential.scope.web!.send } : {})
    }
  }

  /** The user said no to a use. */
  denied(request: CredentialUseRequest): void {
    const parent = DERIVED_ALIAS.exec(request.alias)?.[1] ?? request.alias
    const credential = this.find(parent)
    if (!credential) return
    this.store.record('denied', credential, this.details(request))
  }

  /** A run ended: its returned tokens stop working, and approvals it did not use lapse. */
  releaseRun(runId: string): void {
    for (const key of this.permits) {
      if ((JSON.parse(key) as string[])[0] === runId) this.permits.delete(key)
    }
    this.retire([...this.derived.values()].filter((token) => token.runId === runId))
  }

  /**
   * Keeps a token a request returned under a new alias, usable only in this run, only with its
   * entry's token hosts, and redacted like a stored value until SideKick restarts.
   */
  addDerived(parentAlias: string, runId: string, value: string, expiresInSeconds?: number): string {
    if (!runId) throw new Error('A returned token needs the run that received it.')
    const alias = `${parentAlias}~${++this.derivedCount}`
    const lifetime =
      typeof expiresInSeconds === 'number' && expiresInSeconds > 0
        ? Math.min(expiresInSeconds * 1_000, DERIVED_TOKEN_LIFETIME_MS)
        : DERIVED_TOKEN_LIFETIME_MS
    this.derived.set(alias, {
      alias,
      parentAlias,
      runId,
      value,
      expiresAt: this.now() + lifetime
    })
    this.publishDerived()
    return alias
  }
}

/** A sign-in's field named after its alias, as in `site.username`; plain aliases mean the secret. */
export function credentialReference(reference: string): {
  alias: string
  field: 'secret' | 'username' | 'password' | undefined
} {
  const match = /^(.+?)\.(username|password)$/.exec(reference.trim())
  return match
    ? { alias: match[1], field: match[2] as 'username' | 'password' }
    : { alias: reference.trim(), field: undefined }
}

/** The credential uses a tool call asks for, read from the arguments of the tools that take one. */
export function credentialRequestsFor(
  name: string,
  args: Record<string, unknown>,
  context: { conversationId?: string; runId?: string; toolCallId?: string }
): CredentialUseRequest[] {
  if (name === 'http_request' && typeof args.credential === 'string' && args.credential.trim()) {
    return [
      {
        alias: args.credential.trim(),
        tool: name,
        kind: 'web',
        target: String(args.url ?? ''),
        ...context
      }
    ]
  }
  if (name === 'shell' && args.secrets && typeof args.secrets === 'object') {
    return Object.entries(args.secrets as Record<string, unknown>).flatMap(([variable, value]) =>
      typeof value === 'string' && value.trim()
        ? [
            {
              alias: credentialReference(value).alias,
              tool: name,
              kind: 'command' as const,
              target: String(args.command ?? ''),
              variable,
              ...context
            }
          ]
        : []
    )
  }
  return []
}

const ASK_STRICTNESS: Record<CredentialAskPolicy, number> = {
  never: 0,
  once_per_chat: 1,
  every_use: 2
}

/**
 * One approval for every credential a call uses: the strictest setting decides, and a chat grant
 * must cover each of them. One use outside scope refuses the whole call.
 */
export function credentialApprovalFor(
  uses: CredentialUses,
  requests: readonly CredentialUseRequest[]
): CredentialApproval | CredentialRefusal | undefined {
  const approvals: CredentialApproval[] = []
  for (const request of requests) {
    const approval = uses.approval(request)
    if ('refused' in approval) return approval
    approvals.push(approval)
  }
  if (!approvals.length) return undefined
  if (approvals.length === 1) return approvals[0]
  const ask = approvals.reduce<CredentialAskPolicy>(
    (strictest, approval) =>
      ASK_STRICTNESS[approval.ask] > ASK_STRICTNESS[strictest] ? approval.ask : strictest,
    'never'
  )
  return {
    alias: approvals.map((approval) => approval.alias).join(', '),
    ask,
    keys: approvals.flatMap((approval) => approval.keys),
    label: approvals.map((approval) => approval.label).join('; '),
    preview: {
      summary: approvals[0].preview.summary,
      changes: [],
      facts: approvals.flatMap((approval) => approval.preview.facts ?? [])
    }
  }
}
