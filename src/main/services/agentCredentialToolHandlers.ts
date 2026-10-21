import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import {
  CREDENTIALS_LIST_TOOL,
  CREDENTIALS_REQUEST_TOOL,
  CREDENTIAL_CONSUMER_TOOLS
} from '../../shared/credentialTools'
import {
  CREDENTIAL_ALIAS_PATTERN,
  CREDENTIAL_ASK_LABELS,
  MAX_CREDENTIAL_DESCRIPTION,
  type CredentialRequest,
  type CredentialSummary
} from '../../shared/credentials'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

/** Who is asking: decides whether an entry's project and background scope admit this chat. */
export interface CredentialUseContext {
  projectId: string | null
  /** Started by a schedule or by another chat rather than by the user. */
  background: boolean
}

/** What the credential tools may use: summaries without values, and Settings. */
export interface CredentialToolAccess {
  list: () => CredentialSummary[]
  useContext: (conversationId: string | undefined) => CredentialUseContext | undefined
  openEditor: (request: CredentialRequest) => boolean
}

/** Why `credential` cannot be used in this chat, or null when its scope admits it. */
export function credentialScopeRefusal(
  credential: CredentialSummary,
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

function describe(credential: CredentialSummary, context: CredentialUseContext | undefined) {
  const refusal = credentialScopeRefusal(credential, context)
  return {
    alias: credential.alias,
    kind: credential.kind,
    description: credential.description,
    ...(credential.username ? { username: credential.username } : {}),
    ask_before_use: CREDENTIAL_ASK_LABELS[credential.ask],
    projects: credential.scope.projects === 'all' ? 'all' : credential.scope.projects.length,
    background_runs: credential.scope.background,
    usable_in_this_chat: refusal === null,
    ...(refusal ? { not_usable_because: refusal } : {}),
    ...(credential.lastUsedAt ? { last_used: new Date(credential.lastUsedAt).toISOString() } : {})
  }
}

/** Registers the tools that tell the agent about stored credentials, never their values. */
export function registerCredentialToolHandlers(
  handlers: AgentToolHandlerRegistry,
  access: CredentialToolAccess
): void {
  handlers.register(CREDENTIALS_LIST_TOOL, async ({ title, context }) => {
    const useContext = access.useContext(context.conversationId)
    const credentials = access.list().map((credential) => describe(credential, useContext))
    const data = {
      credentials,
      tools_that_accept_a_credential: [...CREDENTIAL_CONSUMER_TOOLS]
    }
    const note = !credentials.length
      ? 'No credentials are stored. Use credentials_request to ask the user to add one.'
      : CREDENTIAL_CONSUMER_TOOLS.length
        ? `Pass an alias to ${CREDENTIAL_CONSUMER_TOOLS.join(', ')}; SideKick adds the value.`
        : 'No tool can use a credential yet; stored values are only redacted from output.'
    return toolExecutionSucceeded({
      title,
      data,
      modelContent: `${note}\n${JSON.stringify(data, null, 2)}`
    })
  })

  handlers.register(CREDENTIALS_REQUEST_TOOL, async ({ title, arguments: args }) => {
    const alias = typeof args.alias === 'string' ? args.alias.trim() : ''
    if (!CREDENTIAL_ALIAS_PATTERN.test(alias)) {
      return toolExecutionFailed({
        title,
        code: 'invalid_arguments',
        message:
          'The alias must be lowercase letters, digits, hyphens or underscores, starting with a letter or digit, at most 64 characters.'
      })
    }
    const kind = args.kind === 'sign_in' || args.kind === 'secret' ? args.kind : undefined
    const description =
      typeof args.description === 'string'
        ? args.description.trim().slice(0, MAX_CREDENTIAL_DESCRIPTION)
        : undefined
    const existing = access.list().find((credential) => credential.alias === alias)
    if (
      !access.openEditor({
        alias,
        ...(kind ? { kind } : {}),
        ...(description ? { description } : {})
      })
    ) {
      return toolExecutionFailed({
        title,
        code: 'unsupported',
        message: 'SideKick has no window open to show Credentials in.'
      })
    }
    return toolExecutionSucceeded({
      title,
      data: { alias, opened: true, existing: Boolean(existing) },
      modelContent: `Opened Credentials in SideKick's Settings ${existing ? `at ${alias}` : `with a new credential named ${alias}`}. The user types the value there; you will not see it. When they say they are done, credentials_list shows it.`
    })
  })
}
