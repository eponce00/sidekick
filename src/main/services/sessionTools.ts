import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { basename } from 'path'
import type { PendingAgentInteraction } from '../../shared/agentRuntime'
import { defaultAgentCapabilities } from '../../shared/agentToolCatalog'
import type { PermissionMode } from '../../shared/permissions'
import {
  AGENT_SESSION_MESSAGE_INTENTS,
  SESSION_LIMITS,
  SESSION_WORK_IN,
  sessionLinkFromConversation,
  sessionRunCapabilities,
  type AgentSessionMessageIntent,
  type SessionAttachmentRef,
  type StartSessionSpec,
  type StartSessionsCardRequest,
  type StartSessionsCardResponse
} from '../../shared/sessions'
import { resolveSecureWorkspacePath } from '../utils/workspacePaths'
import type { AgentToolExecutionContext } from './agentToolRegistry'
import type { ConversationSessionTools } from './conversationRunPreparer'
import type { SessionService } from './sessionService'
import { executeWorkspaceMutation } from './workspaceMutationService'
import { resolveWorkspaceInstructionsForPath } from './workspaceRules'

export interface SessionToolOptions {
  service: SessionService
  permissionMode: () => PermissionMode
  /** Pauses the run on a durable question to the user; see AgentRunKernel.requestUserDecision. */
  requestUserDecision: (
    runId: string,
    request: Record<string, unknown>,
    signal: AbortSignal
  ) => Promise<PendingAgentInteraction>
}

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  return text(args, key) || undefined
}

/**
 * The chat tools for one conversation run. A chat started by another chat is a worker: it only
 * messages its family, and a read-only worker also loses every tool that edits or executes.
 */
export function createSessionTools(options: SessionToolOptions): ConversationSessionTools {
  const { service } = options
  return (conversationId) => {
    const conversation = service.store.conversation(conversationId)
    if (!conversation) return null
    const { capabilities, role } = sessionRunCapabilities(
      defaultAgentCapabilities('conversation'),
      sessionLinkFromConversation(conversation)
    )
    return {
      capabilities,
      handler: {
        role,
        execute: (name, args, context) =>
          executeSessionTool(options, role, conversationId, name, args, context)
      }
    }
  }
}

/** A project by id or by name, as the model knows projects by name. */
function resolveProject(service: SessionService, value: string): string {
  const rows = service.store.projects()
  const byId = rows.find(({ id }) => id === value)
  if (byId) return byId.id
  const byName = rows.filter(({ name }) => name.toLowerCase() === value.toLowerCase())
  if (byName.length === 1) return byName[0].id
  if (byName.length > 1) throw new Error(`Several projects are named ${value}; use the project id`)
  throw new Error(
    `No project named ${value}. Projects: ${rows.map(({ name }) => name).join(', ') || 'none'}`
  )
}

function specsFromArgs(service: SessionService, args: Record<string, unknown>): StartSessionSpec[] {
  const sessions = args.sessions
  if (!Array.isArray(sessions) || !sessions.length)
    throw new Error('Name at least one chat to start')
  return sessions.map((value) => {
    const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const workIn = optionalText(item, 'work_in')
    if (workIn && !SESSION_WORK_IN.includes(workIn as never))
      throw new Error('work_in must be worktree, folder or read-only')
    const context = optionalText(item, 'context')
    if (context && context !== 'fresh' && context !== 'fork')
      throw new Error('context must be fresh or fork')
    const project = optionalText(item, 'project')
    return {
      title: text(item, 'title'),
      brief: text(item, 'brief'),
      ...(optionalText(item, 'handle') ? { handle: optionalText(item, 'handle') } : {}),
      ...(project ? { projectId: resolveProject(service, project) } : {}),
      ...(workIn ? { workIn: workIn as StartSessionSpec['workIn'] } : {}),
      ...(optionalText(item, 'base_ref') ? { baseRef: optionalText(item, 'base_ref') } : {}),
      ...(context ? { context: context as 'fresh' | 'fork' } : {})
    }
  })
}

/** Applies the user's changes from the start card; anything else stays as the agent asked. */
function applyCardChanges(
  specs: StartSessionSpec[],
  response: StartSessionsCardResponse
): StartSessionSpec[] {
  return specs.map((spec, index) => {
    const change = response.sessions?.[index]
    if (!change) return spec
    return {
      ...spec,
      ...(change.projectId !== undefined ? { projectId: change.projectId } : {}),
      ...(change.workIn && SESSION_WORK_IN.includes(change.workIn) ? { workIn: change.workIn } : {})
    }
  })
}

async function startSessions(
  options: SessionToolOptions,
  conversationId: string,
  args: Record<string, unknown>,
  context: AgentToolExecutionContext
): Promise<unknown> {
  const { service } = options
  const specs = specsFromArgs(service, args)
  if (args.mode === 'propose') {
    const { proposals } = await service.start(
      { managerConversationId: conversationId, sessions: specs, mode: 'propose' },
      'agent'
    )
    return {
      conversationId,
      suggested: proposals.map(({ id, spec }) => ({ id, title: spec.title })),
      note: 'The user sees each suggestion as a card and can start it. Nothing is running.'
    }
  }
  const rows = await service.previewStart({
    managerConversationId: conversationId,
    sessions: specs
  })
  // Decision: full access starts chats at once; any other mode, or a project this chat may not
  // use yet, asks the user first.
  const ask =
    options.permissionMode() !== 'full-access' || rows.some(({ needsGrant }) => needsGrant)
  let approved = specs
  if (ask) {
    const request: StartSessionsCardRequest = {
      intent: 'start_sessions',
      managerConversationId: conversationId,
      sessions: rows,
      projects: service.store.projects().map(({ id, name }) => ({ id, name }))
    }
    const interaction = await options.requestUserDecision(
      context.runId,
      request as unknown as Record<string, unknown>,
      context.signal
    )
    const response = (interaction.response ?? {}) as unknown as StartSessionsCardResponse
    if (interaction.status !== 'resolved' || response.action !== 'start') {
      return {
        started: [],
        declined: true,
        note: 'The user chose not to start these chats. Continue without them, or ask what they would like instead.'
      }
    }
    approved = applyCardChanges(specs, response)
  }
  const { started } = await service.start(
    { managerConversationId: conversationId, sessions: approved },
    // Approval in the card is the user's own decision, which may allow a new project.
    ask ? 'user' : 'agent'
  )
  return {
    started: started.map((member) => ({
      name: member.handle,
      title: member.title,
      project: member.projectName,
      workIn: member.workIn
    })),
    note: 'Each chat works on its own and reports back here when it goes idle; its report arrives as a message. Do not poll. Continue with your own part, or end your turn to wait.'
  }
}

async function attachFiles(
  service: SessionService,
  conversationId: string,
  workspaceRoot: string | undefined,
  paths: unknown
): Promise<SessionAttachmentRef[]> {
  if (paths === undefined) return []
  if (!Array.isArray(paths) || paths.length > 5) throw new Error('Attach at most five files')
  if (paths.length && !workspaceRoot) throw new Error('This chat has no project to attach from')
  const attachments: SessionAttachmentRef[] = []
  for (const value of paths) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid attachment path')
    const file = await resolveSecureWorkspacePath(workspaceRoot!, value.trim())
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > SESSION_LIMITS.attachmentMaxBytes)
      throw new Error('Only UTF-8 text files up to 1 MB can be attached')
    const bytes = await fs.readFile(file)
    const content = bytes.toString('utf8')
    if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes))
      throw new Error(`${value} is not a UTF-8 text file`)
    const attachment = service.store.insertAttachment({
      senderConversationId: conversationId,
      name: basename(file),
      sourcePath: value.trim(),
      content,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
    attachments.push({
      id: attachment.id,
      name: attachment.name,
      byteSize: attachment.byteSize,
      sha256: attachment.sha256
    })
  }
  return attachments
}

async function executeSessionTool(
  options: SessionToolOptions,
  role: 'manager' | 'worker',
  conversationId: string,
  name: string,
  args: Record<string, unknown>,
  context: AgentToolExecutionContext
): Promise<unknown> {
  const { service } = options
  if (name === 'start_session') {
    if (role !== 'manager') throw new Error('A chat started by another chat cannot start chats')
    return startSessions(options, conversationId, args, context)
  }
  if (name === 'send_message') {
    const intent = (optionalText(args, 'intent') ?? 'update') as AgentSessionMessageIntent
    if (!AGENT_SESSION_MESSAGE_INTENTS.includes(intent))
      throw new Error('intent must be request, response or update')
    const attachments = await attachFiles(
      service,
      conversationId,
      service.store.workspaceRoot(conversationId),
      args.attachments
    )
    const sent = service.send({
      fromConversationId: conversationId,
      to: text(args, 'to'),
      intent,
      body: text(args, 'message'),
      ...(optionalText(args, 'reply_to')
        ? { replyToMessageId: optionalText(args, 'reply_to') }
        : {}),
      attachments
    })
    return {
      sent: sent.length,
      messageIds: sent.map(({ id }) => id),
      ...(attachments.length
        ? { attachments: attachments.map(({ id, name: file }) => ({ id, file })) }
        : {})
    }
  }
  if (name === 'list_sessions') {
    const family = service.family(conversationId)
    const waiting = service.store.undelivered(conversationId).length
    if (!family) return { chats: [], waitingMessages: waiting }
    const describe = (member: (typeof family.workers)[number], isManager: boolean) => ({
      name: isManager ? 'manager' : member.handle,
      title: member.title,
      state: member.state,
      project: member.projectName,
      ...(member.workIn ? { workIn: member.workIn } : {}),
      ...(member.archivedAt ? { archived: true } : {}),
      ...(member.conversationId === conversationId ? { you: true } : {})
    })
    return {
      chats: [describe(family.manager, true), ...family.workers.map((w) => describe(w, false))],
      waitingMessages: waiting
    }
  }
  if (name === 'stop_session') {
    if (role !== 'manager') throw new Error('Only the chat that started a chat can stop it')
    const handle = text(args, 'name')
    const worker = service.store
      .workers(conversationId, true)
      .find(({ session_handle }) => session_handle === handle)
    if (!worker) throw new Error(`This chat did not start one named ${handle}`)
    service.stop(worker.id)
    return { stopping: handle }
  }
  if (name === 'import_attachment') {
    const workspaceRoot = service.store.workspaceRoot(conversationId)
    if (!workspaceRoot) throw new Error('This chat has no project to import into')
    const attachment = service.store.attachmentFor(conversationId, text(args, 'attachment_id'))
    if (!attachment) throw new Error('No attachment with that id was sent to this chat')
    const destinationPath = text(args, 'destination_path')
    const scoped = await resolveWorkspaceInstructionsForPath(
      context.runId,
      workspaceRoot,
      destinationPath,
      false,
      true
    )
    if (scoped.retryRequired) {
      return {
        imported: false,
        retryRequired: true,
        projectInstructions: scoped.content,
        error: 'New directory-scoped instructions apply. Review them, then retry the import.'
      }
    }
    const mutation = await executeWorkspaceMutation(
      workspaceRoot,
      {
        kind: 'write',
        filePath: destinationPath,
        content: attachment.content,
        accessLevel: 'auto'
      },
      { requireReadReceipt: true }
    )
    if (!mutation.ok && /read receipt required/i.test(mutation.error || '')) {
      mutation.error = `Destination already exists: ${destinationPath}. Choose a new path; importing never overwrites project files.`
    }
    return { imported: mutation.ok && mutation.changed, destinationPath, mutation }
  }
  throw new Error(`Unknown chat tool ${name}`)
}
