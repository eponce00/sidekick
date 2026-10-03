import type Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { resolve } from 'path'
import { stat } from 'node:fs/promises'
import { projectRelativePath, resolveSecureWorkspacePath } from '../utils/workspacePaths'
import {
  normalizeAgentToolParameters,
  type AgentToolDefinition
} from '../../shared/agentToolDefinitions'
import type { AgentToolCatalogOptions } from '../../shared/agentToolCatalog'
import { mcpToolRisk } from '../../shared/mcp'
import {
  toolExecutionFailed,
  toolExecutionSucceeded,
  type AgentRunSurface,
  type ToolDiagnostic,
  type ToolExecutionResult,
  type ToolWorkspaceChange
} from '../../shared/agentRuntime'
import type { McpServerConfig, McpToolInfo, TodoItem, ToolRisk } from '../../shared/types'
import { getSkillById } from '../../shared/skills'
import {
  isWorkspaceMutationTool,
  WORKSPACE_MUTATION_TOOL_NAMES,
  workspaceMutationRequestFromTool,
  workspaceMutationResultForModel,
  workspaceMutationTargetPaths
} from '../../shared/workspaceMutations'
import { executeWorkspaceMutation } from './workspaceMutationService'
import { WorkspaceReadService } from './workspaceReadService'
import { CommandService, type OwnedBackgroundTask } from './commandService'
import type { TerminalModelRead } from './terminalSessions'
import {
  MAX_TERMINAL_INPUT_LENGTH,
  terminalSessionIsLive,
  type TerminalSessionSummary
} from '../../shared/terminalSessions'
import {
  MAX_AGENT_CONDITIONAL_WAIT_SECONDS,
  MAX_AGENT_WAIT_SECONDS,
  agentWaitTitle,
  waitForAgentDelay
} from '../../shared/agentWait'
import type { OfficeHelperService } from './officeHelperService'
import { McpClientManager } from './mcpClientManager'
import {
  DEFAULT_TOOL_OUTPUT_TOKENS,
  ToolOutputStore,
  type ToolOutputPolicy
} from './toolOutputStore'
import type { AgentKernelToolRouter } from './agentRunKernel'
import type { AgentToolExecutionContext } from './agentToolRegistry'
import { resolveWorkspaceInstructionsForPath } from './workspaceRules'
import type {
  CodeIntelligenceInput,
  WorkspaceVerificationTerminalController
} from '../../shared/verification'
import { LanguageIntelligenceService } from './languageIntelligence/languageIntelligenceService'
import {
  WorkspaceVerificationService,
  type WorkspaceCommandSnapshot
} from './workspaceVerificationService'
import { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { registerCoreToolHandlers } from './agentCoreToolHandlers'
import { registerWebToolHandlers } from './agentWebToolHandlers'
import { registerConversationToolHandlers } from './agentConversationToolHandlers'
import { registerSkillToolHandlers } from './agentSkillToolHandlers'
import type { ArtifactInspectorLike } from './artifactInspector'
import type { InspectedArtifactType } from '../../shared/artifactInspection'
import { registerMcpToolHandlers } from './agentMcpToolHandlers'
import { registerVisionToolHandlers } from './agentVisionToolHandlers'
import { externalImageApprovalForMode } from './externalImageApproval'
import type { PermissionMode } from '../../shared/permissions'
import { AgentBrowserSessionManager, registerBrowserToolHandlers } from './agentBrowserToolHandlers'
import type { NativeBrowserSessionService } from './nativeBrowserSessionService'

export interface AgentCollaborationToolHandler {
  execute(
    name: string,
    args: Record<string, unknown>,
    context: AgentToolExecutionContext
  ): Promise<unknown>
}

export interface AgentGoalToolHandler {
  execute(args: Record<string, unknown>, context: AgentToolExecutionContext): Promise<unknown>
  onTodosUpdated?(todos: TodoItem[]): void
}

export interface AgentPlanToolHandler {
  stage: () => import('../../shared/agentPlans').AgentPlanStage
  complete: (completion: unknown) => {
    accepted: boolean
    errors: string[]
    completion?: import('../../shared/agentPlans').AgentPlanCompletion
  }
}

/** What an artifact builder returns: the version it settled on and how it got there. */
export interface ArtifactBuildResult {
  childRunId: string
  artifact: { type: InspectedArtifactType; title: string; code: string }
  /** Every version rendered, the agent's first included. */
  versions: number
  status: 'completed' | 'failed' | 'cancelled'
}

export interface AgentChildRunLauncher {
  launch(
    task: string,
    context: string | undefined,
    parent: AgentToolExecutionContext
  ): Promise<unknown>
  /**
   * Refines an artifact out of the chat's sight: a builder run renders it,
   * reviews what it shows, and fixes defects until it is right or out of turns.
   */
  buildArtifact(
    first: {
      artifact: { type: InspectedArtifactType; title: string; code: string }
      /** How the first version rendered, as the agent would have been told. */
      review: ToolExecutionResult
    },
    parent: AgentToolExecutionContext
  ): Promise<ArtifactBuildResult>
}

export interface AgentToolRuntimeSessionInput {
  permissionMode?: PermissionMode
  runId: string
  surface: AgentRunSurface
  workspaceRoot?: string
  webSearchEnabled: boolean
  /** Enable SideKick's built-in visual browser for this model/run. */
  browserEnabled?: boolean
  /** The previous reply made an artifact, so the web-artifacts guidance is already in history. */
  artifactContinuation?: boolean
  /** This run is an artifact builder: its create_artifact renders directly, never through another builder. */
  artifactBuilder?: boolean
  editingDialect?: AgentToolCatalogOptions['editingDialect']
  capabilities?: AgentToolCatalogOptions['capabilities']
  persistentSkillIds?: readonly string[]
  mcpConfigs?: readonly McpServerConfig[]
  collaboration?: AgentCollaborationToolHandler
  goal?: AgentGoalToolHandler
  plan?: AgentPlanToolHandler
  instructionScopeId?: string
  onWorkspaceWillMutate?: () => Promise<void>
}

export interface AgentToolRuntimeSession {
  catalog: () => AgentToolCatalogOptions
  router: AgentKernelToolRouter
  persistentSkillIds: () => string[]
  verificationController?: WorkspaceVerificationTerminalController
}

interface AgentToolRuntimeSessionState {
  codeIntelligenceRisk: ToolRisk
  baselineRevision: number
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(number)))
    : fallback
}

/** How long a reply to command input waits for the program to react before reading it. */
const COMMAND_INPUT_SETTLE_MS = 1_500

function backgroundNote(task: OwnedBackgroundTask): string {
  if (task.detached === 'waiting_for_input') {
    return (
      `The command stopped at a prompt and is waiting for input, so it now runs in the background as task ${task.id}; ` +
      'its last lines are in "recentOutput". Answer with send_command_input, read more with read_command_output, or stop it ' +
      'with cancel_background_task. Ask the user instead when the answer is their decision or a secret.'
    )
  }
  if (task.detached === 'user') {
    return `The user moved this command to the background; it keeps running as task ${task.id}. You will be told when it ends; check on it with read_command_output.`
  }
  if (task.detached === 'still_running') {
    return (
      `The command was still running when its time was up, so it goes on in the background as task ${task.id}; ` +
      '"recentOutput" is what it printed so far. Keep working and you will be told when it ends, or call wait with ' +
      'its task ID to wait for it. Stop it with cancel_background_task if it is stuck.'
    )
  }
  return `Running in the background as task ${task.id}. You will be told when it ends; read its output with read_command_output, or wait for it with wait.`
}

// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** What woke a wait, as the model is told. */
type WaitWake =
  | { woke: 'task_ended' | 'waiting_for_input' | 'pattern_matched'; task: TerminalSessionSummary }
  | { woke: 'user_message' }

function stringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return [...new Set(values.filter((item): item is string => typeof item === 'string' && !!item))]
}

function commandReadContent(read: TerminalModelRead): string {
  return JSON.stringify({
    taskId: read.id,
    state: read.state,
    ...(read.exitCode !== undefined ? { exitCode: read.exitCode } : {}),
    ...(read.omittedLines ? { omittedLines: read.omittedLines } : {}),
    output: read.text
  })
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  return typeof args[key] === 'string' ? args[key] : fallback
}

function mcpNameSegment(value: string): string {
  const readable = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 18) || 'unnamed'
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8)
  return `${readable}_${digest}`
}

export function mcpFunctionName(tool: Pick<McpToolInfo, 'serverId' | 'name'>): string {
  return `mcp__${mcpNameSegment(tool.serverId)}__${mcpNameSegment(tool.name)}`
}

function mcpDefinition(tool: McpToolInfo): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name: mcpFunctionName(tool),
      description: `[MCP: ${tool.serverName}] ${tool.description || tool.name}`,
      parameters: normalizeAgentToolParameters(tool.inputSchema)
    }
  }
}

/** Longest edit text kept in the run ledger; later turns replay it as the model's own call. */
export const MAX_RECORDED_EDIT_CHARACTERS = 16_000

function recordedEditText(value: string): string {
  return value.length > MAX_RECORDED_EDIT_CHARACTERS
    ? `${value.slice(0, MAX_RECORDED_EDIT_CHARACTERS)}\n[${(value.length - MAX_RECORDED_EDIT_CHARACTERS).toLocaleString('en-US')} more characters were not kept]`
    : value
}

export function safeToolArguments(
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (name === 'office_preflight') return { workflow: stringArg(args, 'workflow') }
  if (name === 'office_validate') return { path: stringArg(args, 'path') }
  if (isWorkspaceMutationTool(name)) {
    // Keep the tool's own argument names and (bounded) text. Follow-up turns replay these
    // calls; a byte-count stand-in taught models to call apply_patch with patch_bytes.
    const text = (key: string) =>
      key in args ? { [key]: recordedEditText(stringArg(args, key)) } : {}
    return {
      ...('file_path' in args ? { file_path: args.file_path } : {}),
      ...('replace_all' in args ? { replace_all: args.replace_all } : {}),
      ...text('old_string'),
      ...text('new_string'),
      ...text('patch'),
      ...text('content')
    }
  }
  if (name === 'shell') {
    return {
      title: args.title,
      command: stringArg(args, 'command').slice(0, 2_000),
      cwd: args.cwd,
      timeout: args.timeout,
      background: args.background,
      accessLevel: args.accessLevel
    }
  }
  if (name === 'browser_type') {
    const { value: _value, ...safe } = args
    return {
      ...safe,
      value_redacted: true,
      value_bytes: Buffer.byteLength(stringArg(args, 'value'))
    }
  }
  if (name === 'browser_fill_form') {
    const fields = Array.isArray(args.fields) ? args.fields : []
    return {
      fields: fields.map((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { invalid: true }
        const field = raw as Record<string, unknown>
        const safe = {
          kind: field.kind,
          ref: field.ref,
          selector: field.selector,
          text: field.text
        }
        if ('value' in field) {
          return {
            ...safe,
            value_redacted: true,
            value_bytes: Buffer.byteLength(typeof field.value === 'string' ? field.value : '')
          }
        }
        if ('values' in field) {
          const values = Array.isArray(field.values)
            ? field.values.filter((value): value is string => typeof value === 'string')
            : []
          return {
            ...safe,
            values_redacted: true,
            value_count: values.length,
            values_bytes: values.reduce((sum, value) => sum + Buffer.byteLength(value), 0)
          }
        }
        return { ...safe, checked_redacted: 'checked' in field }
      })
    }
  }
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      // The preview also reaches the model through replayed history, where a
      // bare ellipsis read as part of the value and was copied into new calls.
      typeof value === 'string' && value.length > 2_000
        ? `${value.slice(0, 2_000)}… [${value.length - 2_000} more characters not kept]`
        : value
    ])
  )
}

function comparablePath(path: string): string {
  const normalized = path.replace(/\\([ !"#$&'()*,:;<=>?@[\]^`{|}~])/g, '$1').replaceAll('\\', '/')
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized
}

/**
 * Rejects obvious shell paths that accidentally cross a collaboration
 * participant's project boundary. This is defense in depth, not an OS sandbox:
 * unrestricted host commands can use indirection that text inspection cannot
 * prove safe. Permission/audit UI must not describe this guard as confinement.
 */
export function collaborationCommandScopeError(
  command: string,
  workspaceRoot: string
): string | null {
  const normalizedCommand = command.trim()
  if (
    /(^|[\s;&|()])(?:cd\s+)?\.\.(?:[\\/]|(?=$|[\s;&|()]))/.test(normalizedCommand) ||
    /\$\{?WORKSPACE_FOLDER\}?[\\/]\.\./i.test(normalizedCommand) ||
    /dirname\s+(?:["']?\$\{?WORKSPACE_FOLDER\}?)/i.test(normalizedCommand)
  ) {
    return 'Collaboration commands cannot traverse above the assigned project root.'
  }

  const root = comparablePath(workspaceRoot).replace(/[\\/]$/, '')
  const pathBoundary = String.raw`(?:^|[\s;&|(<>'"\x60=])`
  const pathEnd = String.raw`(?:[\\/]|(?=$|[\s;&|()<>'"\x60]))`
  const locationAliases = new RegExp(
    `${pathBoundary}(?:~(?=${pathEnd})|\\$(?:\\{)?(?:HOME|USERPROFILE|TMPDIR|TEMP|TMP)(?:\\})?(?=${pathEnd})|%(?:USERPROFILE|TEMP|TMP)%|\\$env:(?:USERPROFILE|TEMP|TMP)(?=${pathEnd}))`,
    'i'
  )
  if (locationAliases.test(normalizedCommand)) {
    return 'Collaboration commands cannot access paths outside the assigned project root. Use collaboration_share_file and collaboration_import_artifact for cross-project handoffs.'
  }
  const unixPaths = new RegExp(`${pathBoundary}(/(?:(?:\\\\.)|[^\\s;&|<>'"\\x60])+)`, 'g')
  const windowsPaths = new RegExp(
    `${pathBoundary}([A-Za-z]:[\\\\/](?:(?:\\\\.)|[^\\s;&|<>'"\\x60])+)`,
    'g'
  )
  const absoluteCandidates = [
    ...[...normalizedCommand.matchAll(unixPaths)].map((match) => match[1]),
    ...[...normalizedCommand.matchAll(windowsPaths)].map((match) => match[1])
  ].map((path) => comparablePath(path).replace(/[),]+$/, ''))
  const outside = absoluteCandidates.find(
    (candidate) => candidate !== root && !candidate.startsWith(`${root}/`)
  )
  return outside
    ? 'Collaboration commands cannot access paths outside the assigned project root. Use collaboration_share_file and collaboration_import_artifact for cross-project handoffs.'
    : null
}

export class AgentToolRuntime {
  private childLauncher?: AgentChildRunLauncher
  private artifactInspector?: ArtifactInspectorLike
  private readonly recordedBackgroundVerification = new Set<string>()
  private readonly backgroundVerificationSnapshots = new Map<string, WorkspaceCommandSnapshot>()
  private readonly languageIntelligence: LanguageIntelligenceService
  private readonly verification: WorkspaceVerificationService
  readonly browser?: AgentBrowserSessionManager

  constructor(
    private readonly db: Database.Database,
    private readonly workspaceReads: WorkspaceReadService,
    private readonly commands: CommandService,
    private readonly outputs: ToolOutputStore,
    private readonly mcp: McpClientManager,
    languageIntelligence?: LanguageIntelligenceService,
    verification?: WorkspaceVerificationService,
    browser?: NativeBrowserSessionService,
    private readonly officeHelpers?: OfficeHelperService
  ) {
    this.languageIntelligence = languageIntelligence ?? new LanguageIntelligenceService()
    this.verification = verification ?? new WorkspaceVerificationService(db)
    this.browser = browser ? new AgentBrowserSessionManager(browser) : undefined
  }

  /** Waits in a run that end when the user sends it a message. */
  private readonly userMessageWaiters = new Map<string, Set<() => void>>()

  setChildLauncher(launcher: AgentChildRunLauncher): void {
    this.childLauncher = launcher
  }

  /** Lets create_artifact render what it made and show the model the result. */
  setArtifactInspector(inspector: ArtifactInspectorLike): void {
    this.artifactInspector = inspector
  }

  async beginBrowserHumanTakeover(conversationId: string, expectedSessionId: string) {
    if (!this.browser) throw new Error('Visual browser is unavailable')
    return this.browser.beginHumanTakeover(conversationId, expectedSessionId)
  }

  async completeBrowserHumanTakeover(conversationId: string, expectedSessionId: string) {
    if (!this.browser) throw new Error('Visual browser is unavailable')
    return this.browser.completeHumanTakeover(conversationId, expectedSessionId)
  }

  async createSession(input: AgentToolRuntimeSessionInput): Promise<AgentToolRuntimeSession> {
    const activeSkillIds = new Set(input.persistentSkillIds ?? [])
    const officeSession = this.officeHelpers?.session(input.workspaceRoot)
    const readReceipts = new Map<string, string>()
    const mcpByFunction = new Map<string, McpToolInfo>()
    const enabledMcpByFunction = new Map<string, McpToolInfo>()
    const baselineRevision = this.verification.beginSession(input.workspaceRoot)
    const intelligenceStatus = input.workspaceRoot
      ? this.languageIntelligence.workspaceStatus(input.workspaceRoot)
      : null
    const codeIntelligenceAvailable = intelligenceStatus?.available === true
    const sessionState: AgentToolRuntimeSessionState = {
      codeIntelligenceRisk: intelligenceStatus?.availableServers.some(
        (server) => server.origin === 'workspace'
      )
        ? 'execute'
        : 'read',
      baselineRevision
    }
    if (input.mcpConfigs?.length) {
      await this.mcp.sync([...input.mcpConfigs])
      const listed = await this.mcp.listTools()
      for (const tool of listed.tools) mcpByFunction.set(mcpFunctionName(tool), tool)
    }
    const handlers = new AgentToolHandlerRegistry()
    registerCoreToolHandlers(handlers, this.outputs)
    registerWebToolHandlers(handlers, this.outputs)
    registerVisionToolHandlers(handlers, externalImageApprovalForMode(input.permissionMode))
    if (input.browserEnabled === true && this.browser) {
      registerBrowserToolHandlers(handlers, this.browser, this.outputs)
    }
    registerConversationToolHandlers(handlers, this.db, { goal: input.goal, plan: input.plan })
    registerSkillToolHandlers(handlers, {
      activeSkillIds,
      officeHelpersAvailable: () => officeSession?.available() ?? false,
      readReceipts,
      childLauncher: () => this.childLauncher,
      artifactInspector: () => this.artifactInspector,
      // The visual browser is enabled exactly when the model accepts images.
      visionEnabled: input.browserEnabled === true,
      artifactContinuation: input.artifactContinuation === true,
      // A chat's artifacts are refined out of sight; a builder renders its own directly.
      buildArtifacts: input.surface === 'conversation' && input.artifactBuilder !== true
    })
    handlers.register(
      ['office_preflight', 'office_validate'],
      async ({ name, title, arguments: args, context }) => {
        if (!officeSession?.available())
          return toolExecutionFailed({
            title,
            code: 'unsupported',
            message: 'Direct Office helpers are not configured for this host run'
          })
        try {
          const targetPath = name === 'office_validate' ? stringArg(args, 'path') : ''
          const isDirectory =
            name === 'office_validate'
              ? (
                  await stat(
                    await resolveSecureWorkspacePath(this.requireWorkspace(input), targetPath)
                  )
                ).isDirectory()
              : true
          const instructions = await this.scopedInstructions(input, targetPath, isDirectory, false)
          if (instructions.retryRequired)
            return this.success(
              title,
              { executed: false, retryRequired: true },
              instructions.content
            )
          const receipt = await officeSession.execute(name, args, context, [...activeSkillIds])
          if ('outcome' in receipt && receipt.outcome === 'cancelled')
            return toolExecutionFailed({
              title,
              code: 'cancelled',
              status: 'cancelled',
              message: 'Office helper execution cancelled'
            })
          if ('outcome' in receipt && receipt.outcome === 'timed_out')
            return toolExecutionFailed({
              title,
              code: 'timeout',
              message: 'Office helper execution timed out'
            })
          if (
            !('outcome' in receipt) ||
            receipt.outcome !== 'exited' ||
            !receipt.report ||
            receipt.report.status === 'unusable_output'
          )
            return toolExecutionFailed({
              title,
              code: 'command_failed',
              message: 'Office helper did not produce a usable result'
            })
          return toolExecutionSucceeded({
            title,
            data: { helper: receipt.helper, report: receipt.report },
            modelContent:
              instructions.content +
              JSON.stringify({ helper: receipt.helper, report: receipt.report })
          })
        } catch {
          return toolExecutionFailed({
            title,
            code: 'command_failed',
            message:
              'Office helper request is invalid, unavailable, or its trusted configuration changed'
          })
        }
      }
    )
    registerMcpToolHandlers(handlers, {
      mcp: this.mcp,
      available: mcpByFunction,
      enabled: enabledMcpByFunction,
      readReceipts
    })
    handlers.register(
      [
        'read',
        'code_intelligence',
        'shell',
        'wait',
        'list_background_tasks',
        'cancel_background_task',
        'read_command_output',
        'send_command_input',
        ...WORKSPACE_MUTATION_TOOL_NAMES
      ],
      ({ name, arguments: args, context }) =>
        this.execute(input, readReceipts, sessionState, name, args, context)
    )
    if (input.collaboration) {
      handlers.register(
        [
          'collaboration_read',
          'collaboration_send',
          'collaboration_share_file',
          'collaboration_list_artifacts',
          'collaboration_import_artifact',
          'collaboration_status',
          'collaboration_claim_complete'
        ],
        ({ name, arguments: args, context }) =>
          this.execute(input, readReceipts, sessionState, name, args, context)
      )
    }
    const catalog = (): AgentToolCatalogOptions => ({
      surface: input.surface,
      workspaceRoot: input.workspaceRoot,
      webSearchEnabled: input.webSearchEnabled,
      browserEnabled: input.browserEnabled === true && Boolean(this.browser),
      activeSkillIds: [...activeSkillIds],
      officeHelpersAvailable: officeSession?.available() ?? false,
      capabilities: input.capabilities,
      mcpTools: [...enabledMcpByFunction.values()].map(mcpDefinition),
      mcpToolRisks: Object.fromEntries(
        [...enabledMcpByFunction.entries()].map(([name, tool]) => [name, mcpToolRisk(tool)])
      ),
      goalEnabled: Boolean(input.goal),
      planStage: input.plan?.stage() ?? 'inactive',
      codeIntelligenceAvailable,
      codeIntelligenceRisk: sessionState.codeIntelligenceRisk,
      editingDialect: input.editingDialect
    })
    return {
      catalog,
      persistentSkillIds: () =>
        [...activeSkillIds].filter((id) => getSkillById(id)?.activationScope === 'conversation'),
      verificationController: this.verification.createTerminalController(
        input.runId,
        input.workspaceRoot,
        baselineRevision
      ),
      router: {
        execute: (name, args, context) => {
          const title = this.title(name, args)
          return handlers.execute({ name, title, arguments: args, context })
        },
        title: (name, args) => this.title(name, args),
        safeArguments: safeToolArguments,
        ...(this.browser
          ? {
              reserveBrowserHumanTakeover: (conversationId: string) =>
                this.browser!.reserveHumanTakeover(conversationId),
              releaseBrowserHumanTakeover: (conversationId: string, expectedSessionId: string) =>
                this.browser!.releaseHumanTakeover(conversationId, expectedSessionId)
            }
          : {})
      }
    }
  }

  private title(name: string, args: Record<string, unknown>): string {
    if (name === 'shell') return stringArg(args, 'title', 'Run command')
    if (name === 'read') return `Read ${stringArg(args, 'path', '.')}`
    if (name === 'code_intelligence') {
      return `${stringArg(args, 'operation', 'Inspect code').replaceAll('_', ' ')} ${stringArg(args, 'file_path')}`.trim()
    }
    if (isWorkspaceMutationTool(name))
      return `${name.replaceAll('_', ' ')} ${stringArg(args, 'file_path')}`.trim()
    if (name === 'web_search') return `Search: ${stringArg(args, 'query')}`
    if (name === 'web_image_search') return `Image search: ${stringArg(args, 'query')}`
    if (name === 'web_fetch') return `Fetch: ${stringArg(args, 'url')}`
    if (name === 'browser_open') return `Open ${stringArg(args, 'url', 'browser')}`
    if (name === 'browser_observe') return 'Inspect browser'
    if (name === 'browser_screenshot') return 'Capture browser screenshot'
    if (name === 'browser_click')
      return `Click ${stringArg(args, 'text') || stringArg(args, 'selector') || stringArg(args, 'ref') || 'browser element'}`
    if (name === 'browser_hold') return 'Press and hold browser control'
    if (name === 'browser_request_human') return 'Human browser verification'
    if (name === 'browser_type') return 'Type in browser'
    if (name === 'browser_select') return 'Select browser option'
    if (name === 'browser_fill_form') return 'Fill browser form'
    if (name === 'browser_press') return `Press ${stringArg(args, 'key', 'key')}`
    if (name === 'browser_scroll') return 'Scroll browser'
    if (name === 'browser_hover') return 'Hover browser element'
    if (name === 'browser_wait') return 'Wait for browser'
    if (name === 'browser_navigate') {
      const action = stringArg(args, 'action', 'url')
      return action === 'url'
        ? `Navigate to ${stringArg(args, 'url', 'page')}`
        : `${action[0]?.toUpperCase() || ''}${action.slice(1)} browser`
    }
    if (name === 'browser_resize') {
      return `Resize browser to ${String(args.width || '?')} × ${String(args.height || '?')}`
    }
    if (name === 'browser_tabs') return `${stringArg(args, 'action', 'List')} browser tabs`
    if (name === 'browser_console') return 'Read browser console'
    if (name === 'browser_network') return 'Read browser network failures'
    if (name === 'browser_evaluate') return 'Inspect page state'
    if (name === 'browser_verify') return `Verify ${stringArg(args, 'criterion', 'UI visually')}`
    if (name === 'browser_close') return 'Close browser'
    if (name === 'use_skill') return `Load ${stringArg(args, 'skill_id')} skill`
    if (name === 'update_goal') {
      return args.status === 'complete' ? 'Complete goal' : 'Report goal blocker'
    }
    if (name === 'enter_plan_mode') return 'Suggest Plan mode'
    if (name === 'present_plan') return 'Review plan'
    if (name === 'complete_plan') return 'Complete plan contract'
    if (name === 'wait') return agentWaitTitle(args)
    return name.replaceAll('_', ' ')
  }

  private async success(
    title: string,
    data: unknown,
    content?: string,
    options: {
      policy?: ToolOutputPolicy
      changes?: ToolWorkspaceChange[]
      diagnostics?: ToolDiagnostic[]
    } = {}
  ): Promise<ToolExecutionResult> {
    const serialized = content ?? JSON.stringify(data)
    const bounded = await this.outputs.apply(serialized, options.policy)
    return toolExecutionSucceeded({
      title,
      data,
      modelContent: bounded.content,
      output: bounded.output,
      changes: options.changes,
      diagnostics: options.diagnostics
    })
  }

  private requireWorkspace(input: AgentToolRuntimeSessionInput): string {
    if (!input.workspaceRoot) throw new Error('This run has no active project workspace')
    return input.workspaceRoot
  }

  private async scopedInstructions(
    input: AgentToolRuntimeSessionInput,
    targetPath: string,
    isDirectory: boolean,
    mutation: boolean
  ): Promise<{ content: string; retryRequired: boolean }> {
    if (!input.workspaceRoot || !input.instructionScopeId) {
      return { content: '', retryRequired: false }
    }
    const result = await resolveWorkspaceInstructionsForPath(
      input.instructionScopeId,
      input.workspaceRoot,
      targetPath,
      isDirectory,
      mutation
    )
    return {
      content: result.content
        ? `<project_instructions trust="app-loaded-project-instructions">\n${result.content}\n</project_instructions>\n\n`
        : '',
      retryRequired: result.retryRequired
    }
  }

  private async execute(
    input: AgentToolRuntimeSessionInput,
    readReceipts: Map<string, string>,
    sessionState: AgentToolRuntimeSessionState,
    name: string,
    args: Record<string, unknown>,
    context: AgentToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const title = this.title(name, args)
    if (name === 'read') {
      const path = stringArg(args, 'path', '.')
      const result = await this.workspaceReads.readPath(this.requireWorkspace(input), path, {
        startLine: args.start_line as number | undefined,
        endLine: args.end_line as number | undefined,
        cursor: args.cursor as number | undefined,
        maxEntries: args.max_entries as number | undefined,
        // Room under the result budget for the header and any scoped instructions, so a long file
        // ends on a whole line the model can continue from instead of being cut mid-line.
        maxTokens: DEFAULT_TOOL_OUTPUT_TOKENS - 1_024,
        glob: stringArg(args, 'glob') || undefined,
        signal: context.signal
      })
      const instructions = await this.scopedInstructions(
        input,
        path,
        result.kind === 'directory',
        false
      )
      if (result.kind === 'directory') {
        const metadata = `[Directory: ${path} | next_cursor ${result.nextCursor ?? 'none'}]\n`
        return this.success(
          title,
          result,
          instructions.content + metadata + result.files.join('\n')
        )
      }
      // Keyed like change records, so ./a.ts, an absolute path and a.ts share one receipt.
      readReceipts.set(projectRelativePath(this.requireWorkspace(input), path), result.version)
      if (input.workspaceRoot) this.languageIntelligence.observeFile(input.workspaceRoot, path)
      const metadata =
        `[File: ${path} | lines ${result.startLine}-${result.endLine} of ${result.totalLines}` +
        ` | version ${result.version}${result.nextLine ? ` | next_line ${result.nextLine}` : ''}]\n`
      const continuation = result.nextLine
        ? `\n[Showing lines ${result.startLine}-${result.endLine} of ${result.totalLines}. ` +
          `Read again with start_line ${result.nextLine} to continue.]`
        : ''
      return this.success(
        title,
        result,
        instructions.content + metadata + result.content + continuation
      )
    }
    if (name === 'code_intelligence') {
      const operation = stringArg(args, 'operation') as CodeIntelligenceInput['operation']
      const filePath = stringArg(args, 'file_path')
      const result = await this.languageIntelligence.execute(
        this.requireWorkspace(input),
        {
          operation,
          filePath,
          line: args.line as number | undefined,
          column: args.column as number | undefined,
          query: stringArg(args, 'query') || undefined
        },
        context.signal
      )
      // The project-local process crossed the normal permission boundary on its first successful
      // request. Further semantic queries in this run are read-only.
      sessionState.codeIntelligenceRisk = 'read'
      if (operation === 'diagnostics' && Array.isArray(result.result) && !result.truncated) {
        const changedPaths = this.verification.changedPaths(
          input.runId,
          this.requireWorkspace(input),
          sessionState.baselineRevision
        )
        const checkedPaths = changedPaths.filter(
          (path) =>
            resolve(this.requireWorkspace(input), path) ===
            resolve(this.requireWorkspace(input), filePath)
        )
        if (checkedPaths.length) {
          this.verification.recordDiagnostics(
            input.runId,
            this.requireWorkspace(input),
            result.result as ToolDiagnostic[],
            checkedPaths,
            `${result.serverId} diagnostics`
          )
        }
      }
      return this.success(title, result, JSON.stringify(result), {
        policy: { preview: 'head-tail' }
      })
    }
    if (isWorkspaceMutationTool(name)) {
      const request = workspaceMutationRequestFromTool(name, args)
      const instructionBlocks: string[] = []
      let retryRequired = false
      for (const targetPath of workspaceMutationTargetPaths(request)) {
        const resolution = await this.scopedInstructions(input, targetPath, false, true)
        if (resolution.content) instructionBlocks.push(resolution.content)
        if (resolution.retryRequired) retryRequired = true
      }
      if (retryRequired) {
        return this.success(
          title,
          { changed: false, retryRequired: true },
          instructionBlocks.join('') +
            'New directory-scoped project instructions apply. Review them, re-read the target if needed, then retry the mutation.'
        )
      }
      await input.onWorkspaceWillMutate?.()
      const result = await executeWorkspaceMutation(this.requireWorkspace(input), request, {
        requireReadReceipt: true,
        expectedVersions: Object.fromEntries(readReceipts)
      })
      if (!result.ok) {
        const failureCode = result.failure?.code
        const stale =
          failureCode === 'read_required' ||
          failureCode === 'stale_read' ||
          /stale|re-?read|read receipt/i.test(result.error || '')
        const ambiguous = failureCode === 'multiple_matches'
        const patchSyntax =
          name === 'apply_patch' &&
          /^Invalid (?:patch|Add File|Delete File|Update File|hunk)/i.test(result.error || '')
        return toolExecutionFailed({
          title,
          code: patchSyntax ? 'invalid_arguments' : stale ? 'stale_read' : 'conflict',
          message: result.error || 'Workspace mutation failed',
          retryable: true,
          recoveryAction:
            patchSyntax || ambiguous
              ? 'correct_input'
              : stale
                ? 'refresh_state'
                : 'change_strategy',
          recovery:
            (patchSyntax
              ? 'Send one corrected apply_patch call. Use *** Begin Patch and *** End Patch, a file header, then bare @@ (no unified-diff line numbers). Put *** Move to: immediately after *** Update File:. Prefix hunk lines with space, - or +. Example:\n*** Begin Patch\n*** Update File: path/file.txt\n@@\n-old text\n+new text\n*** End Patch'
              : result.failure?.recovery) ||
            (stale
              ? 'Re-read the affected file, then submit one corrected mutation.'
              : 'Change the mutation arguments or use a different editing strategy.'),
          data: workspaceMutationResultForModel(result)
        })
      }
      const modelResult = workspaceMutationResultForModel(result)
      // Keep the complete bounded aggregate diff for the expandable human review,
      // while the provider receives only the compact modelResult below. Per-file
      // diffs are omitted from presentation data to avoid storing them twice.
      const presentationResult = {
        ...modelResult,
        diff: result.diff,
        diffTruncated: result.diffTruncated === true
      }
      for (const file of result.files) {
        const previousPath = file.path.replaceAll('\\', '/')
        if (file.action === 'delete' || file.action === 'move') readReceipts.delete(previousPath)
        const currentPath = (file.movePath || file.path).replaceAll('\\', '/')
        if (file.action !== 'delete') {
          const version = await this.workspaceReads.getFileVersion(
            this.requireWorkspace(input),
            currentPath
          )
          if (version) readReceipts.set(currentPath, version)
          else readReceipts.delete(currentPath)
        }
      }
      const changes: ToolWorkspaceChange[] = result.files.map((file) => ({
        path: file.movePath || file.path,
        kind:
          file.action === 'add'
            ? 'create'
            : file.action === 'delete'
              ? 'delete'
              : file.action === 'move'
                ? 'move'
                : 'update',
        previousPath: file.movePath ? file.path : undefined,
        beforeHash: file.beforeHash,
        afterHash: file.afterHash
      }))
      this.verification.recordChanges(
        input.runId,
        this.requireWorkspace(input),
        'workspace_tool',
        changes
      )
      const diagnosticBatch = await this.languageIntelligence
        .diagnosticsAfterChanges(this.requireWorkspace(input), changes, context.signal)
        .catch(() => ({
          diagnostics: [],
          attemptedFiles: [],
          failedFiles: [],
          complete: false
        }))
      const diagnostics = diagnosticBatch.diagnostics
      if (diagnosticBatch.complete) {
        this.verification.recordDiagnostics(
          input.runId,
          this.requireWorkspace(input),
          diagnostics,
          changes.map((change) => change.path)
        )
      }
      const diagnosticErrors = diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error' && diagnostic.state !== 'resolved'
      )
      const diagnosticContent = diagnosticBatch.attemptedFiles.length
        ? `\n\nLanguage diagnostics: ${
            diagnosticBatch.failedFiles.length
              ? `unavailable for ${diagnosticBatch.failedFiles.length} changed file(s); run a project check before completion`
              : diagnosticErrors.length
                ? `${diagnosticErrors.length} current error(s)`
                : 'no current errors'
          }${diagnostics.length ? `\n${JSON.stringify(diagnostics.slice(0, 30))}` : ''}`
        : ''
      return this.success(
        title,
        presentationResult,
        JSON.stringify(modelResult) + diagnosticContent,
        {
          changes,
          diagnostics
        }
      )
    }
    if (name === 'shell') {
      const command = stringArg(args, 'command')
      const workspaceRoot = this.requireWorkspace(input)
      const scopeError =
        input.surface === 'collaboration'
          ? collaborationCommandScopeError(command, workspaceRoot)
          : null
      if (scopeError) {
        return toolExecutionFailed({
          title,
          code: 'workspace_scope',
          message: scopeError
        })
      }
      const instructions = await this.scopedInstructions(input, stringArg(args, 'cwd'), true, true)
      if (instructions.retryRequired) {
        return this.success(
          title,
          { executed: false, retryRequired: true },
          instructions.content +
            'New directory-scoped project instructions apply. Review them, then retry the command.'
        )
      }
      // A shell command may mutate files, but receipts are content-versioned and the mutation
      // service compares them with the current file immediately before applying a patch. Keep
      // still-valid receipts; an actually changed file is rejected as stale without forcing
      // redundant reads after every diagnostic command.
      const verificationSnapshot = this.verification.captureCommandWorkspace(workspaceRoot, command)
      await input.onWorkspaceWillMutate?.()
      const commandStartedAt = Date.now()
      const result = await this.commands.execute({
        runId: context.runId,
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
        title,
        command,
        workspaceRoot,
        cwd: stringArg(args, 'cwd') || undefined,
        timeoutSecs: boundedNumber(args.timeout, args.background === true ? 3_600 : 30, 1, 86_400),
        background: args.background === true,
        signal: context.signal,
        onOutput: ({ chunk, stream }) => context.onOutput?.({ chunk, stream })
      })
      const publicResult = { ...result, outputPath: undefined }
      const content =
        'stdout' in result
          ? JSON.stringify({
              success: result.success,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              error: result.error,
              cancelled: result.cancelled
            })
          : JSON.stringify({ ...publicResult, note: backgroundNote(result) })
      if ('stdout' in result) {
        this.verification.recordCommand(
          input.runId,
          workspaceRoot,
          command,
          stringArg(args, 'cwd') || undefined,
          result,
          commandStartedAt,
          verificationSnapshot
        )
      } else if (verificationSnapshot) {
        this.backgroundVerificationSnapshots.set(result.id, verificationSnapshot)
      }
      if ('stdout' in result && !result.success) {
        const bounded = await this.outputs.apply(content, { preview: 'head-tail' })
        const timedOut = result.error?.toLowerCase().includes('timed out') === true
        const cancelled = result.cancelled === true
        if (result.stoppedByUser) {
          return toolExecutionFailed({
            title,
            code: 'cancelled',
            message: 'The user stopped this command',
            retryable: false,
            recoveryAction: 'change_strategy',
            recovery:
              'The user stopped this command. Do not run it again unless they ask; continue with what you have, or ask them how to proceed.',
            data: publicResult,
            modelContent: bounded.content,
            output: bounded.output,
            status: 'error'
          })
        }
        return toolExecutionFailed({
          title,
          code: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'command_failed',
          message:
            result.error ||
            `Command exited with code ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 500)}` : ''}`,
          retryable: !cancelled,
          recoveryAction: cancelled ? 'stop' : timedOut ? 'retry_later' : 'change_strategy',
          recovery: cancelled
            ? 'The command was cancelled. Do not retry unless the user requests it.'
            : timedOut
              ? 'Reduce the command scope, increase the timeout when justified, or run it as a background task.'
              : 'Inspect the exit code and bounded stderr, correct the command or use a different diagnostic approach, then retry only if it can make progress.',
          data: publicResult,
          modelContent: bounded.content,
          output: bounded.output,
          status: cancelled ? 'cancelled' : 'error'
        })
      }
      return this.success(title, publicResult, content, { policy: { preview: 'head-tail' } })
    }
    // A conversation's background commands outlive the reply that started them.
    const commandScope = { conversationId: context.conversationId, runId: context.runId }
    if (name === 'wait') return this.waitUntil(title, args, context)
    if (name === 'list_background_tasks') {
      const tasks = this.commands.listBackground(commandScope)
      for (const task of tasks) if (task.status !== 'running') this.commands.markSeen(task.id)
      if (input.workspaceRoot) {
        for (const task of tasks) {
          if (!task.result || this.recordedBackgroundVerification.has(task.id)) continue
          this.verification.recordCommand(
            input.runId,
            input.workspaceRoot,
            task.command,
            task.cwd,
            task.result,
            task.startedAt,
            this.backgroundVerificationSnapshots.get(task.id)
          )
          this.recordedBackgroundVerification.add(task.id)
          this.backgroundVerificationSnapshots.delete(task.id)
        }
      }
      return this.success(title, { tasks })
    }
    if (name === 'cancel_background_task') {
      const cancelled = this.commands.cancelBackground(stringArg(args, 'taskId'), commandScope)
      if (cancelled) this.commands.markSeen(stringArg(args, 'taskId'))
      return cancelled
        ? this.success(title, { cancelled: true, taskId: args.taskId })
        : toolExecutionFailed({
            title,
            code: 'not_found',
            message: 'No running background task with that ID in this conversation'
          })
    }
    if (name === 'read_command_output') {
      const taskId = stringArg(args, 'taskId')
      if (!this.commands.ownsCommand(taskId, commandScope)) {
        return toolExecutionFailed({
          title,
          code: 'not_found',
          message: 'No command with that ID in this conversation'
        })
      }
      let pattern: RegExp | undefined
      const source = stringArg(args, 'pattern')
      if (source) {
        try {
          pattern = new RegExp(source, 'i')
        } catch (error) {
          return toolExecutionFailed({
            title,
            code: 'invalid_arguments',
            message: `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`
          })
        }
      }
      const read = await this.commands.terminals.readForModel(taskId, {
        mode: args.mode === 'tail' ? 'tail' : 'new',
        maxLines: boundedNumber(args.lines, 80, 1, 400),
        pattern
      })
      if (!read) {
        return toolExecutionFailed({ title, code: 'not_found', message: 'Command output is gone' })
      }
      if (!terminalSessionIsLive(read.state)) this.commands.markSeen(taskId)
      return this.success(title, read, commandReadContent(read))
    }
    if (name === 'send_command_input') {
      const taskId = stringArg(args, 'taskId')
      const session = this.commands.terminals.get(taskId)
      if (!session || !this.commands.ownsCommand(taskId, commandScope)) {
        return toolExecutionFailed({
          title,
          code: 'not_found',
          message: 'No command with that ID in this conversation'
        })
      }
      const text = stringArg(args, 'input')
      if (text.length > MAX_TERMINAL_INPUT_LENGTH) {
        return toolExecutionFailed({
          title,
          code: 'invalid_arguments',
          message: `Input is limited to ${MAX_TERMINAL_INPUT_LENGTH} characters`
        })
      }
      // A terminal's Enter is a carriage return; a pipe reads lines.
      const enter = args.enter === false ? '' : session.pty ? '\r' : '\n'
      if (!this.commands.write(taskId, text + enter)) {
        return toolExecutionFailed({
          title,
          code: 'not_found',
          message: 'The command is no longer running'
        })
      }
      // Give the program a moment to answer, so the result shows what the input did.
      await new Promise((resolve) => setTimeout(resolve, COMMAND_INPUT_SETTLE_MS))
      const read = await this.commands.terminals.readForModel(taskId, { mode: 'new' })
      return this.success(
        title,
        { sent: true, taskId },
        read ? commandReadContent(read) : JSON.stringify({ sent: true, taskId })
      )
    }
    if (name.startsWith('collaboration_') && input.collaboration) {
      if (name === 'collaboration_import_artifact') readReceipts.clear()
      return this.success(title, await input.collaboration.execute(name, args, context))
    }
    return toolExecutionFailed({
      title,
      code: 'unknown_tool',
      message: `No runtime implementation exists for ${name}`
    })
  }

  /**
   * Waits at most `seconds` for what the agent named: a command to end, its output to match a
   * pattern, or, for a plain wait, any background command of the conversation to end. A message
   * from the user always ends it, so the agent never sleeps through what they said.
   */
  private async waitUntil(
    title: string,
    args: Record<string, unknown>,
    context: AgentToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const scope = { conversationId: context.conversationId, runId: context.runId }
    const taskIds = stringList(args.taskIds ?? args.taskId)
    const unknown = taskIds.find((id) => !this.commands.ownsCommand(id, scope))
    if (unknown) {
      return toolExecutionFailed({
        title,
        code: 'not_found',
        message: `No command with ID ${unknown} in this conversation`
      })
    }
    let pattern: RegExp | undefined
    const source = stringArg(args, 'pattern')
    if (source) {
      try {
        pattern = new RegExp(source, 'i')
      } catch (error) {
        return toolExecutionFailed({
          title,
          code: 'invalid_arguments',
          message: `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`
        })
      }
    }
    const conditional = taskIds.length > 0 || pattern !== undefined
    const terminals = this.commands.terminals
    const alreadyEnded = taskIds
      .map((id) => terminals.get(id))
      .find((session) => session && !terminalSessionIsLive(session.state))
    if (alreadyEnded) {
      return this.waitResult(title, { woke: 'task_ended', task: alreadyEnded }, 0, 0)
    }

    const relevant = (session: TerminalSessionSummary): boolean =>
      taskIds.length
        ? taskIds.includes(session.id)
        : Boolean(context.conversationId) && session.conversationId === context.conversationId
    const printed = new Map<string, string>()
    const result = await waitForAgentDelay<WaitWake>(args.seconds ?? (conditional ? 600 : 30), {
      signal: context.signal,
      maxSeconds: conditional ? MAX_AGENT_CONDITIONAL_WAIT_SECONDS : MAX_AGENT_WAIT_SECONDS,
      wake: (wake) => {
        const stopStates = terminals.onStateChange((session) => {
          if (!relevant(session)) return
          if (session.state === 'waiting_for_input')
            wake({ woke: 'waiting_for_input', task: session })
          // A foreground command of another tool call ending is that call's business.
          else if (!terminalSessionIsLive(session.state) && (taskIds.length || session.background))
            wake({ woke: 'task_ended', task: session })
        })
        const stopOutput = pattern
          ? terminals.onOutput((id, data) => {
              const session = terminals.get(id)
              if (!session || !relevant(session)) return
              const text = ((printed.get(id) ?? '') + data.replace(TERMINAL_CONTROL, '')).slice(
                -16_384
              )
              printed.set(id, text)
              if (pattern!.test(text)) wake({ woke: 'pattern_matched', task: session })
            })
          : () => undefined
        const userMessage = (): void => wake({ woke: 'user_message' })
        const waiters = this.userMessageWaiters.get(context.runId) ?? new Set<() => void>()
        waiters.add(userMessage)
        this.userMessageWaiters.set(context.runId, waiters)
        return () => {
          stopStates()
          stopOutput()
          waiters.delete(userMessage)
          if (!waiters.size) this.userMessageWaiters.delete(context.runId)
        }
      }
    })
    if (result.reason === 'cancelled') {
      return toolExecutionFailed({
        title,
        code: 'cancelled',
        message: 'Wait cancelled',
        status: 'cancelled',
        data: result
      })
    }
    return this.waitResult(title, result.event, result.waitedMs, result.requestedSeconds)
  }

  private async waitResult(
    title: string,
    wake: WaitWake | undefined,
    waitedMs: number,
    requestedSeconds: number
  ): Promise<ToolExecutionResult> {
    const task = wake && 'task' in wake ? wake.task : undefined
    const read = task
      ? await this.commands.terminals.readForModel(task.id, { mode: 'new', maxLines: 60 })
      : undefined
    if (task && read && !terminalSessionIsLive(read.state)) this.commands.markSeen(task.id)
    const summary = {
      woke: wake?.woke ?? 'timeout',
      waitedSeconds: Math.round(waitedMs / 100) / 10,
      requestedSeconds,
      ...(task
        ? {
            taskId: task.id,
            title: task.title,
            state: read?.state ?? task.state,
            ...((read?.exitCode ?? task.exitCode) !== undefined
              ? { exitCode: read?.exitCode ?? task.exitCode }
              : {})
          }
        : {}),
      ...(wake?.woke === 'user_message'
        ? { note: 'The user sent a message; it is in the conversation now.' }
        : {}),
      ...(read?.text ? { output: read.text } : {})
    }
    return this.success(title, summary, JSON.stringify(summary))
  }

  /** The user sent a message to the run; a wait in it ends so the agent reads it now. */
  notifyUserMessage(runId: string): void {
    for (const wake of [...(this.userMessageWaiters.get(runId) ?? [])]) wake()
  }

  cancelRun(runId: string): void {
    this.commands.cancelRun(runId)
  }

  async close(): Promise<void> {
    await Promise.all([this.languageIntelligence.close(), this.browser?.dispose()])
  }
}
