/**
 * How a tool uses a stored credential: whether the call needs the user's approval first, and, at
 * the moment the tool sends a request or starts a process, the values, after checking scope again.
 * Every use, denial and refusal is audited by alias and target, never by value.
 */
import type { AgentApprovalPreview } from '../../shared/agentRuntime'
import {
  CREDENTIAL_ASK_LABELS,
  credentialHostMatches,
  credentialScopeRefusal,
  describeCredentialSend,
  type CredentialAskPolicy,
  type CredentialEvent,
  type CredentialEventKind,
  type CredentialSend,
  type CredentialSummary,
  type CredentialUseContext,
  type CredentialValues
} from '../../shared/credentials'
import type { ResolvedCredential } from './credentialVault'

export type CredentialUseKind = 'web'

export interface CredentialUseRequest {
  alias: string
  tool: string
  kind: CredentialUseKind
  /** A web request's URL. */
  target: string
  conversationId?: string
  runId?: string
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
  | { ok: true; summary: CredentialSummary; values: CredentialValues; send: CredentialSend }
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
  conversationId: string | undefined
  value: string
  expiresAt: number
}

/** A returned token is usable for at most this long, or less when the response says so. */
const DERIVED_TOKEN_LIFETIME_MS = 60 * 60 * 1_000
const DERIVED_ALIAS = /^([a-z0-9][a-z0-9_-]{0,63})~(\d+)$/

/** Where a web request goes, without its query: a value sent as a parameter must not be kept. */
export function credentialWebTarget(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`
}

export class CredentialUses {
  private readonly derived = new Map<string, DerivedToken>()
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
    this.derived.delete(alias)
    this.publishDerived()
    return undefined
  }

  private publishDerived(): void {
    this.store.setTransientSecrets(
      [...this.derived.values()].map(({ alias, value }) => ({ alias, value }))
    )
  }

  /**
   * Checks every rule that decides whether this use may happen, without asking anyone: the entry
   * exists, its project and background scope admit the chat, and the target is in its scope.
   */
  private check(
    request: CredentialUseRequest
  ):
    | { ok: true; credential: CredentialSummary; target: URL; derived?: DerivedToken }
    | { ok: false; message: string; credential?: CredentialSummary } {
    let target: URL
    try {
      target = new URL(request.target)
    } catch {
      return { ok: false, message: 'The request address is not a valid URL.' }
    }
    const derivedMatch = DERIVED_ALIAS.exec(request.alias)
    if (derivedMatch) {
      const token = this.liveDerived(request.alias)
      const parent = this.find(derivedMatch[1])
      if (!token || !parent || token.conversationId !== request.conversationId) {
        return {
          ok: false,
          message: `${request.alias} is not a token this chat received, or it has expired. Request a new one.`
        }
      }
      const refusal = credentialScopeRefusal(parent, this.useContext(request.conversationId))
      if (refusal)
        return {
          ok: false,
          credential: parent,
          message: `${parent.alias} cannot be used here: ${refusal}.`
        }
      const hosts = parent.scope.web?.tokenHosts ?? []
      if (!credentialHostMatches(hosts, target)) {
        return {
          ok: false,
          credential: parent,
          message: hosts.length
            ? `Tokens from ${parent.alias} may be sent only over HTTPS to ${hosts.join(', ')}. The user can add hosts in Settings → Credentials.`
            : `${parent.alias} does not allow the tokens it returns to be sent anywhere. The user can add hosts in Settings → Credentials.`
        }
      }
      return { ok: true, credential: parent, target, derived: token }
    }
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
    const web = credential.scope.web
    if (!web) {
      return {
        ok: false,
        credential,
        message: `${credential.alias} may not be sent in web requests. The user can allow it in Settings → Credentials.`
      }
    }
    if (!credentialHostMatches(web.hosts, target)) {
      return {
        ok: false,
        credential,
        message: `${credential.alias} may be sent only over HTTPS to ${web.hosts.join(', ')}, not to ${target.protocol}//${target.host}. The user can add a host in Settings → Credentials.`
      }
    }
    return { ok: true, credential, target }
  }

  /**
   * The approval a call needs before it runs, or undefined when it names no usable credential: a
   * use outside scope is refused by the tool itself, with the reason, and never asked about.
   */
  approval(request: CredentialUseRequest): CredentialApproval | undefined {
    const checked = this.check(request)
    if (!checked.ok) return undefined
    const { credential, target } = checked
    const send = credential.scope.web!.send
    const where = credentialWebTarget(target)
    const facts = [
      { label: 'Credential', value: request.alias },
      ...(credential.description ? [{ label: 'About', value: credential.description }] : []),
      { label: 'Sent to', value: where },
      {
        label: 'How',
        value: checked.derived ? 'as a bearer token it returned' : describeCredentialSend(send)
      },
      { label: 'Asks', value: CREDENTIAL_ASK_LABELS[credential.ask] }
    ]
    return {
      alias: request.alias,
      ask: credential.ask,
      keys: [`credential:${credential.id}:${request.kind}:${target.protocol}//${target.host}`],
      label: `${credential.alias} with ${target.host}`,
      preview: {
        summary: `SideKick adds ${request.alias} to this request itself; the agent never sees the value.`,
        changes: [],
        facts
      }
    }
  }

  /** The values for a use about to happen, checked again now; records the use or refusal. */
  take(request: CredentialUseRequest): CredentialTake {
    const checked = this.check(request)
    const details = {
      tool: request.tool,
      target: (() => {
        try {
          return credentialWebTarget(new URL(request.target))
        } catch {
          return undefined
        }
      })(),
      conversationId: request.conversationId,
      runId: request.runId
    }
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
    this.store.record('used', checked.credential, details)
    return {
      ok: true,
      summary: checked.credential,
      values: resolved.values,
      send: checked.credential.scope.web!.send
    }
  }

  /** The user said no to a use. */
  denied(request: CredentialUseRequest): void {
    const parent = DERIVED_ALIAS.exec(request.alias)?.[1] ?? request.alias
    const credential = this.find(parent)
    if (!credential) return
    let target: string | undefined
    try {
      target = credentialWebTarget(new URL(request.target))
    } catch {
      target = undefined
    }
    this.store.record('denied', credential, {
      tool: request.tool,
      target,
      conversationId: request.conversationId,
      runId: request.runId
    })
  }

  /**
   * Keeps a token a request returned under a new alias, usable only in this chat, only with its
   * entry's token hosts, and redacted like a stored value until it expires.
   */
  addDerived(
    parentAlias: string,
    conversationId: string | undefined,
    value: string,
    expiresInSeconds?: number
  ): string {
    const alias = `${parentAlias}~${++this.derivedCount}`
    const lifetime =
      typeof expiresInSeconds === 'number' && expiresInSeconds > 0
        ? Math.min(expiresInSeconds * 1_000, DERIVED_TOKEN_LIFETIME_MS)
        : DERIVED_TOKEN_LIFETIME_MS
    this.derived.set(alias, {
      alias,
      parentAlias,
      conversationId,
      value,
      expiresAt: this.now() + lifetime
    })
    this.publishDerived()
    return alias
  }
}

/** The credential uses a tool call asks for, read from the arguments of the tools that take one. */
export function credentialRequestsFor(
  name: string,
  args: Record<string, unknown>,
  context: { conversationId?: string; runId?: string }
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
  return []
}

const ASK_STRICTNESS: Record<CredentialAskPolicy, number> = {
  never: 0,
  once_per_chat: 1,
  every_use: 2
}

/**
 * One approval for every credential a call uses: the strictest setting decides, and a chat grant
 * must cover each of them. Uses outside scope are left to the tool, which refuses them.
 */
export function credentialApprovalFor(
  uses: CredentialUses,
  requests: readonly CredentialUseRequest[]
): CredentialApproval | undefined {
  const approvals = requests.flatMap((request) => {
    const approval = uses.approval(request)
    return approval ? [approval] : []
  })
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
