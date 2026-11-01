/**
 * How a tool uses a stored credential: what the approval card shows before the call, and, at the
 * moment the tool sends a request or starts a process, the values, after checking the use again.
 * A use is a sensitive action the permission mode decides like any other; values go only to a
 * call the kernel approved for exactly that use. Every use, denial and refusal is audited by alias
 * and target, never by value.
 */
import type { AgentApprovalPreview } from '../../shared/agentRuntime'
import {
  credentialPageOrigin,
  credentialSendFor,
  credentialSiteMatches,
  credentialVariableRefusal,
  describeCredentialSend,
  type CredentialEvent,
  type CredentialEventKind,
  type CredentialSummary,
  type CredentialValues
} from '../../shared/credentials'
import type { ResolvedCredential } from './credentialVault'

export type CredentialUseKind = 'web' | 'command' | 'browser'

export interface CredentialUseRequest {
  alias: string
  tool: string
  kind: CredentialUseKind
  /** A web request's URL, a command's text, or the address of the page to sign in on. */
  target: string
  /** For a command: the environment variable that receives the value. */
  variable?: string
  /** For a web request: where the call asks for the value to go, its `credential_as`. */
  placement?: unknown
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
  /** Chat-grant keys: one per entry, so "Allow for this chat" covers its later uses. */
  keys: string[]
  /** What "Allow for this chat" covers, in words. */
  label: string
  preview: AgentApprovalPreview
}

export type CredentialTake =
  | {
      ok: true
      summary: CredentialSummary
      values: CredentialValues
      /** A token an earlier response returned, which goes as a bearer token. */
      derived?: true
      /** With `deferUse`: records whether the value left, once the caller knows. */
      audit?: CredentialUseAudit
    }
  | { ok: false; message: string }

/** A deferred use's outcome: the value went out, or the call refused before sending it. */
export interface CredentialUseAudit {
  sent(): void
  notSent(reason: string): void
}

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

/** A value travels only over HTTPS, or plain HTTP to a server on this computer. */
function secureUrl(target: string): URL | string {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return 'The request address is not a valid URL.'
  }
  if (url.username || url.password) return 'Leave the user name and password out of the address.'
  if (url.protocol !== 'https:' && !credentialPageOrigin(`${url.protocol}//${url.host}`)) {
    return `A credential is sent only over HTTPS, not to ${url.protocol}//${url.host}.`
  }
  return url
}

/** Why an entry with websites may not go to this host. */
function elsewhere(credential: CredentialSummary, host: string): string {
  return `${credential.alias} belongs to ${credential.sites!.join(', ')}, not ${host}. Use it only there; the user can add a website in Settings → Credentials.`
}

/** Where a web request goes, without its query: a value sent as a parameter must not be kept. */
export function credentialWebTarget(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`
}

/** What the audit and approval card show for a use's target. */
function shownTarget(request: CredentialUseRequest): string | undefined {
  if (request.kind === 'command') return request.target.slice(0, 300)
  if (request.kind === 'browser') return credentialPageOrigin(request.target) ?? undefined
  try {
    return credentialWebTarget(new URL(request.target))
  } catch {
    return undefined
  }
}

/**
 * One approved use: the run, the call, the alias, and the address, command or page origin it was
 * approved for. A sign-in is approved for an origin, since the page's path may change as it loads.
 */
function permitKey(request: CredentialUseRequest): string | undefined {
  if (!request.runId || !request.toolCallId) return undefined
  let target: string | null = request.target
  if (request.kind === 'browser') target = credentialPageOrigin(request.target)
  else if (request.kind === 'web') {
    try {
      target = new URL(request.target).href
    } catch {
      return undefined
    }
  }
  if (target === null) return undefined
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
   * The rules no approval can stand in for, checked without asking anyone: the entry exists and
   * this computer can read it, a value travels only over HTTPS, a command's variable cannot change
   * how commands run, and a sign-in is filled only on a secure page.
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
    if (credential.needsValue) {
      return {
        ok: false,
        credential,
        message: `${credential.alias} has to be entered again on this computer. Call credentials_request to ask the user.`
      }
    }
    if (request.kind === 'command') {
      const variable = request.variable ? credentialVariableRefusal(request.variable) : null
      return variable ? { ok: false, credential, message: variable } : { ok: true, credential }
    }
    if (request.kind === 'browser') {
      if (credential.kind !== 'sign_in') {
        return {
          ok: false,
          credential,
          message: `${credential.alias} has no username, so it cannot be filled into a sign-in page. Use it in http_request or shell instead.`
        }
      }
      if (!credentialPageOrigin(request.target)) {
        return {
          ok: false,
          credential,
          message: `${credential.alias} is filled in only on an HTTPS page, or a server on this computer, and the browser is not on one. Open the sign-in page first.`
        }
      }
      const page = new URL(request.target).hostname
      if (!credentialSiteMatches(credential.sites, page)) {
        return { ok: false, credential, message: elsewhere(credential, page) }
      }
      return { ok: true, credential }
    }
    const url = secureUrl(request.target)
    if (typeof url === 'string') return { ok: false, credential, message: url }
    if (!credentialSiteMatches(credential.sites, url.hostname)) {
      return { ok: false, credential, message: elsewhere(credential, url.hostname) }
    }
    return { ok: true, credential, url }
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
    const url = secureUrl(request.target)
    if (typeof url === 'string') return { ok: false, credential: parent, message: url }
    return { ok: true, credential: parent, url, derived: token }
  }

  /**
   * What the approval card shows before a call that uses a credential, or why the call is refused:
   * a use that breaks a rule is refused then, never asked about, so no card can stand in for it.
   */
  approval(request: CredentialUseRequest): CredentialApproval | CredentialRefusal {
    const checked = this.check(request)
    const send =
      checked.ok && request.kind === 'web' && !checked.derived
        ? credentialSendFor(request.placement, checked.credential.kind)
        : null
    if (!checked.ok || typeof send === 'string') {
      const message = checked.ok ? (send as string) : checked.message
      if (checked.credential) {
        this.store.record('refused', checked.credential, {
          ...this.details(request),
          detail: message
        })
      }
      return { refused: message }
    }
    const { credential } = checked
    const grant = {
      alias: request.alias,
      keys: [`credential:${credential.id}`],
      label: `${credential.alias} in this chat`
    }
    const about = credential.description ? [{ label: 'About', value: credential.description }] : []
    if (request.kind === 'command') {
      return {
        ...grant,
        preview: {
          summary: `SideKick puts ${request.alias} in ${request.variable ?? 'an environment variable'} for this command. The command can print or send the value, so read it before allowing it.`,
          changes: [],
          facts: [
            { label: 'Credential', value: request.alias },
            ...about,
            { label: 'Variable', value: request.variable ?? '' },
            { label: 'Command', value: request.target.slice(0, 300) }
          ]
        }
      }
    }
    if (request.kind === 'browser') {
      return {
        ...grant,
        preview: {
          summary: `SideKick fills in ${request.alias} on this page itself; the agent never sees the password.`,
          changes: [],
          facts: [
            { label: 'Sign-in', value: request.alias },
            ...about,
            ...(credential.username ? [{ label: 'As', value: credential.username }] : []),
            { label: 'On', value: credentialPageOrigin(request.target)! }
          ]
        }
      }
    }
    return {
      ...grant,
      preview: {
        summary: `SideKick adds ${request.alias} to this request itself; the agent never sees the value.`,
        changes: [],
        facts: [
          { label: 'Credential', value: request.alias },
          ...about,
          { label: 'Sent to', value: credentialWebTarget(checked.url!) },
          {
            label: 'How',
            value: send ? describeCredentialSend(send) : 'as a bearer token it returned'
          }
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

  /**
   * The values for an approved use about to happen, checked again now; records the outcome. A
   * caller that may still refuse before the value leaves, such as a web request checking its
   * body, passes `deferUse` and reports the outcome through the returned `audit`.
   */
  take(request: CredentialUseRequest, options: { deferUse?: boolean } = {}): CredentialTake {
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
    const credential = checked.credential
    const resolved = checked.derived ? undefined : this.store.resolve(credential.alias)
    if (!checked.derived && !resolved) {
      return { ok: false, message: `${credential.alias} has no value on this computer.` }
    }
    const detail = checked.derived
      ? `Returned token ${request.alias}`
      : request.variable
        ? `In ${request.variable}`
        : undefined
    const audit: CredentialUseAudit = {
      sent: () =>
        this.store.record('used', credential, { ...details, ...(detail ? { detail } : {}) }),
      notSent: (reason) => this.store.record('refused', credential, { ...details, detail: reason })
    }
    if (!options.deferUse) audit.sent()
    return {
      ok: true,
      summary: credential,
      ...(checked.derived
        ? { values: { secret: checked.derived.value }, derived: true as const }
        : { values: resolved!.values }),
      ...(options.deferUse ? { audit } : {})
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
   * Keeps a token a request returned under a new alias, usable only in this run's web requests,
   * and redacted like a stored value until SideKick restarts.
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

/**
 * The credential uses a tool call asks for, read from the arguments of the tools that take one.
 * `browserUrl` is the address the chat's browser is on, which a sign-in is checked against.
 */
export function credentialRequestsFor(
  name: string,
  args: Record<string, unknown>,
  context: { conversationId?: string; runId?: string; toolCallId?: string },
  browserUrl?: string
): CredentialUseRequest[] {
  if (name === 'browser_sign_in' && typeof args.credential === 'string' && args.credential.trim()) {
    return [
      {
        alias: args.credential.trim(),
        tool: name,
        kind: 'browser',
        target: browserUrl ?? '',
        ...context
      }
    ]
  }
  if (name === 'http_request' && typeof args.credential === 'string' && args.credential.trim()) {
    return [
      {
        alias: args.credential.trim(),
        tool: name,
        kind: 'web',
        target: String(args.url ?? ''),
        placement: args.credential_as,
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

/**
 * One approval for every credential a call uses, whose chat grant must cover each of them. One use
 * that breaks a rule refuses the whole call.
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
  return {
    alias: approvals.map((approval) => approval.alias).join(', '),
    keys: [...new Set(approvals.flatMap((approval) => approval.keys))],
    label: approvals.map((approval) => approval.label).join('; '),
    preview: {
      summary: approvals[0].preview.summary,
      changes: [],
      facts: approvals.flatMap((approval) => approval.preview.facts ?? [])
    }
  }
}
