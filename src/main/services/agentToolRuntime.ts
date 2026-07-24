import type Database from 'better-sqlite3'
import { createHash } from 'crypto'
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
import { waitForAgentDelay } from '../../shared/agentWait'
import { getSkillById } from '../../shared/skills'
import type { McpServerConfig, McpToolInfo, TodoItem, ToolRisk } from '../../shared/types'
import {
  editingDialectForModel,
  isWorkspaceMutationTool,
  workspaceMutationRequestFromTool,
  workspaceMutationResultForModel,
  workspaceMutationTargetPaths,
  type EditingDialect
} from '../../shared/workspaceMutations'
import { searchImages } from './sidekickSearch/imageSearch'
import { readPage } from './sidekickSearch/pageReader'
import { searchWeb } from './sidekickSearch/searchCoordinator'
import { executeWorkspaceMutation } from './workspaceMutationService'
import { WorkspaceReadService, WorkspaceSearchArgumentError } from './workspaceReadService'
import { CommandService } from './commandService'
import { McpClientManager } from './mcpClientManager'
import { ToolOutputStore, type ToolOutputPolicy } from './toolOutputStore'
import type { AgentKernelToolRouter } from './agentRunKernel'
import type { AgentToolExecutionContext } from './agentToolRegistry'
import { resolveWorkspaceInstructionsForPath } from './workspaceRules'
import type { CodeIntelligenceInput, VerificationTerminalDecision } from '../../shared/verification'
import { LanguageIntelligenceService } from './languageIntelligence/languageIntelligenceService'
import { WorkspaceVerificationService } from './workspaceVerificationService'

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

export interface AgentChildRunLauncher {
  launch(
    task: string,
    context: string | undefined,
    parent: AgentToolExecutionContext
  ): Promise<unknown>
}

export interface AgentToolRuntimeSessionInput {
  runId: string
  surface: AgentRunSurface
  workspaceRoot?: string
  webSearchEnabled: boolean
  editingTarget: NonNullable<AgentToolCatalogOptions['editingTarget']>
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
  editingDialect: () => EditingDialect
  setEditingDialect: (dialect: EditingDialect) => void
  verificationController?: {
    afterTerminalTurn: () => Promise<VerificationTerminalDecision>
  }
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

function safeToolArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (isWorkspaceMutationTool(name)) {
    return {
      file_path: args.file_path,
      accessLevel: args.accessLevel,
      ...('replace_all' in args ? { replace_all: args.replace_all } : {}),
      ...('old_string' in args
        ? { old_string_bytes: Buffer.byteLength(stringArg(args, 'old_string')) }
        : {}),
      ...('new_string' in args
        ? { new_string_bytes: Buffer.byteLength(stringArg(args, 'new_string')) }
        : {}),
      ...(name === 'apply_patch'
        ? { patch_bytes: Buffer.byteLength(stringArg(args, 'patch')) }
        : {}),
      ...('content' in args ? { content_bytes: Buffer.byteLength(stringArg(args, 'content')) } : {})
    }
  }
  if (name === 'execute_command') {
    return {
      title: args.title,
      command: stringArg(args, 'command').slice(0, 2_000),
      cwd: args.cwd,
      timeout: args.timeout,
      background: args.background,
      accessLevel: args.accessLevel
    }
  }
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === 'string' && value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value
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
  private readonly recordedBackgroundVerification = new Set<string>()
  private readonly languageIntelligence: LanguageIntelligenceService
  private readonly verification: WorkspaceVerificationService

  constructor(
    private readonly db: Database.Database,
    private readonly workspaceReads: WorkspaceReadService,
    private readonly commands: CommandService,
    private readonly outputs: ToolOutputStore,
    private readonly mcp: McpClientManager,
    languageIntelligence?: LanguageIntelligenceService,
    verification?: WorkspaceVerificationService
  ) {
    this.languageIntelligence = languageIntelligence ?? new LanguageIntelligenceService()
    this.verification = verification ?? new WorkspaceVerificationService(db)
  }

  setChildLauncher(launcher: AgentChildRunLauncher): void {
    this.childLauncher = launcher
  }

  async createSession(input: AgentToolRuntimeSessionInput): Promise<AgentToolRuntimeSession> {
    const activeSkillIds = new Set(input.persistentSkillIds ?? [])
    const readReceipts = new Map<string, string>()
    const mcpByFunction = new Map<string, McpToolInfo>()
    let editingDialect = editingDialectForModel(input.editingTarget)
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
    const catalog = (): AgentToolCatalogOptions => ({
      surface: input.surface,
      workspaceRoot: input.workspaceRoot,
      webSearchEnabled: input.webSearchEnabled,
      editingTarget: { ...input.editingTarget, dialect: editingDialect },
      activeSkillIds: [...activeSkillIds],
      capabilities: input.capabilities,
      mcpTools: [...mcpByFunction.values()].map(mcpDefinition),
      mcpToolRisks: Object.fromEntries(
        [...mcpByFunction.entries()].map(([name, tool]) => [name, mcpToolRisk(tool)])
      ),
      goalEnabled: Boolean(input.goal),
      planStage: input.plan?.stage() ?? 'inactive',
      codeIntelligenceAvailable,
      codeIntelligenceRisk: sessionState.codeIntelligenceRisk
    })
    return {
      catalog,
      persistentSkillIds: () =>
        [...activeSkillIds].filter((id) => getSkillById(id)?.activationScope === 'conversation'),
      editingDialect: () => editingDialect,
      setEditingDialect: (dialect) => {
        editingDialect = dialect
      },
      verificationController: this.verification.createTerminalController(
        input.runId,
        input.workspaceRoot,
        baselineRevision
      ),
      router: {
        execute: (name, args, context) =>
          this.execute(
            input,
            activeSkillIds,
            readReceipts,
            mcpByFunction,
            sessionState,
            name,
            args,
            context
          ),
        title: (name, args) => this.title(name, args),
        safeArguments: safeToolArguments
      }
    }
  }

  private title(name: string, args: Record<string, unknown>): string {
    if (name === 'execute_command') return stringArg(args, 'title', 'Run command')
    if (name === 'read_workspace_file') return `Read ${stringArg(args, 'file_path')}`
    if (name === 'list_workspace_files')
      return `List ${stringArg(args, 'sub_path', 'project files')}`
    if (name === 'search_workspace_files') return `Search ${stringArg(args, 'regex')}`
    if (name === 'code_intelligence') {
      return `${stringArg(args, 'operation', 'Inspect code').replaceAll('_', ' ')} ${stringArg(args, 'file_path')}`.trim()
    }
    if (isWorkspaceMutationTool(name))
      return `${name.replaceAll('_', ' ')} ${stringArg(args, 'file_path')}`.trim()
    if (name === 'web_search') return `Search: ${stringArg(args, 'query')}`
    if (name === 'web_image_search') return `Image search: ${stringArg(args, 'query')}`
    if (name === 'web_fetch') return `Fetch: ${stringArg(args, 'url')}`
    if (name === 'use_skill') return `Load ${stringArg(args, 'skill_id')} skill`
    if (name === 'update_goal') {
      return args.status === 'complete' ? 'Complete goal' : 'Report goal blocker'
    }
    if (name === 'enter_plan_mode') return 'Suggest Plan mode'
    if (name === 'present_plan') return 'Review plan'
    if (name === 'complete_plan') return 'Complete plan contract'
    if (name === 'wait') return `Wait ${String(args.seconds)}s`
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
    activeSkillIds: Set<string>,
    readReceipts: Map<string, string>,
    mcpByFunction: Map<string, McpToolInfo>,
    sessionState: AgentToolRuntimeSessionState,
    name: string,
    args: Record<string, unknown>,
    context: AgentToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const title = this.title(name, args)
    if (name === 'read_tool_output') {
      const result = await this.outputs.read(
        stringArg(args, 'handle'),
        boundedNumber(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
        boundedNumber(args.max_bytes, 50 * 1024, 1_024, 50 * 1024)
      )
      return this.success(title, result, result.content)
    }
    if (name === 'wait') {
      const result = await waitForAgentDelay(args.seconds, { signal: context.signal })
      return result.completed
        ? this.success(title, result)
        : toolExecutionFailed({
            title,
            code: 'cancelled',
            message: 'Wait cancelled',
            status: 'cancelled',
            data: result
          })
    }
    if (name === 'manage_todo_list') {
      return this.manageTodos(context.runId, title, args, input.goal?.onTodosUpdated)
    }
    if (name === 'update_goal' && input.goal) {
      return this.success(title, await input.goal.execute(args, context))
    }
    if (name === 'complete_plan' && input.plan) {
      const result = input.plan.complete(args.completion)
      return this.success(
        title,
        result,
        result.accepted
          ? JSON.stringify(result)
          : `${JSON.stringify(result)}\nThe plan contract is not complete. Correct every listed issue before trying complete_plan again.`
      )
    }
    if (name === 'list_workspace_files') {
      const instructions = await this.scopedInstructions(
        input,
        stringArg(args, 'sub_path'),
        true,
        false
      )
      const result = await this.workspaceReads.listFiles(this.requireWorkspace(input), {
        subPath: stringArg(args, 'sub_path') || undefined,
        glob: stringArg(args, 'glob') || undefined,
        signal: context.signal
      })
      return this.success(title, result, instructions.content + result.files.join('\n'))
    }
    if (name === 'read_workspace_file') {
      const instructions = await this.scopedInstructions(
        input,
        stringArg(args, 'file_path'),
        false,
        false
      )
      const result = await this.workspaceReads.readFile(
        this.requireWorkspace(input),
        stringArg(args, 'file_path'),
        {
          startLine: args.start_line as number | undefined,
          endLine: args.end_line as number | undefined,
          signal: context.signal
        }
      )
      readReceipts.set(stringArg(args, 'file_path').replaceAll('\\', '/'), result.version)
      if (input.workspaceRoot) {
        this.languageIntelligence.observeFile(input.workspaceRoot, stringArg(args, 'file_path'))
      }
      const metadata =
        `[File: ${stringArg(args, 'file_path')} | lines ${result.startLine}-${result.endLine} of ${result.totalLines}` +
        ` | version ${result.version}${result.nextLine ? ` | next_line ${result.nextLine}` : ''}]\n`
      return this.success(title, result, instructions.content + metadata + result.content)
    }
    if (name === 'search_workspace_files') {
      const instructions = await this.scopedInstructions(
        input,
        stringArg(args, 'path'),
        true,
        false
      )
      try {
        const result = await this.workspaceReads.searchFiles(this.requireWorkspace(input), {
          regex: stringArg(args, 'regex'),
          path: stringArg(args, 'path') || undefined,
          filePattern: stringArg(args, 'file_pattern') || undefined,
          contextLines: args.context_lines as number | undefined,
          signal: context.signal
        })
        return this.success(title, result, instructions.content + result.output)
      } catch (error) {
        if (!(error instanceof WorkspaceSearchArgumentError)) throw error
        return toolExecutionFailed({
          title,
          code: 'invalid_arguments',
          message: error.message,
          retryable: true,
          recoveryAction: 'correct_input',
          recovery:
            'Use a valid JavaScript regular expression and a project-relative file or directory path.'
        })
      }
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
      if (operation === 'diagnostics' && Array.isArray(result.result)) {
        const changedPaths = this.verification.changedPaths(
          input.runId,
          this.requireWorkspace(input),
          sessionState.baselineRevision
        )
        if (changedPaths.length) {
          this.verification.recordDiagnostics(
            input.runId,
            this.requireWorkspace(input),
            result.result as ToolDiagnostic[],
            changedPaths,
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
        return toolExecutionFailed({
          title,
          code: stale ? 'stale_read' : 'conflict',
          message: result.error || 'Workspace mutation failed',
          retryable: true,
          recoveryAction: ambiguous ? 'correct_input' : stale ? 'refresh_state' : 'change_strategy',
          recovery:
            result.failure?.recovery ||
            (stale
              ? 'Re-read the affected file, then submit one corrected mutation.'
              : 'Change the mutation arguments or use a different editing strategy.'),
          data: workspaceMutationResultForModel(result)
        })
      }
      const modelResult = workspaceMutationResultForModel(result)
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
      return this.success(title, modelResult, JSON.stringify(modelResult) + diagnosticContent, {
        changes,
        diagnostics
      })
    }
    if (name === 'execute_command') {
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
      readReceipts.clear()
      await input.onWorkspaceWillMutate?.()
      const commandStartedAt = Date.now()
      const result = await this.commands.execute({
        runId: context.runId,
        title,
        command,
        workspaceRoot,
        cwd: stringArg(args, 'cwd') || undefined,
        timeoutSecs: boundedNumber(args.timeout, args.background === true ? 3_600 : 30, 1, 86_400),
        background: args.background === true,
        signal: context.signal
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
          : JSON.stringify(publicResult)
      if ('stdout' in result) {
        this.verification.recordCommand(
          input.runId,
          workspaceRoot,
          command,
          stringArg(args, 'cwd') || undefined,
          result,
          commandStartedAt
        )
      }
      if ('stdout' in result && !result.success) {
        const bounded = await this.outputs.apply(content, { preview: 'head-tail' })
        const timedOut = result.error?.toLowerCase().includes('timed out') === true
        const cancelled = result.cancelled === true
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
    if (name === 'list_background_tasks') {
      const tasks = this.commands.listBackground(context.runId)
      if (input.workspaceRoot) {
        for (const task of tasks) {
          if (!task.result || this.recordedBackgroundVerification.has(task.id)) continue
          this.verification.recordCommand(
            input.runId,
            input.workspaceRoot,
            task.command,
            task.cwd,
            task.result,
            task.startedAt
          )
          this.recordedBackgroundVerification.add(task.id)
        }
      }
      return this.success(title, { tasks })
    }
    if (name === 'cancel_background_task') {
      const cancelled = this.commands.cancelBackground(stringArg(args, 'taskId'), context.runId)
      return cancelled
        ? this.success(title, { cancelled: true, taskId: args.taskId })
        : toolExecutionFailed({
            title,
            code: 'not_found',
            message: 'Background task was not found in this run'
          })
    }
    if (name === 'web_search') {
      const result = await searchWeb(stringArg(args, 'query'), boundedNumber(args.limit, 8, 1, 20))
      return this.success(title, result)
    }
    if (name === 'web_image_search') {
      const results = await searchImages(stringArg(args, 'query'), 8, {
        includeImageData: args.include_image_data === true,
        maxImagesWithData: 3
      })
      return this.success(title, { results })
    }
    if (name === 'web_fetch') {
      const page = await readPage(stringArg(args, 'url'))
      return this.success(title, page, JSON.stringify(page), { policy: { preview: 'head-tail' } })
    }
    if (name === 'use_skill') {
      const skill = getSkillById(stringArg(args, 'skill_id'))
      if (!skill || skill.invocation === 'manual') {
        return toolExecutionFailed({
          title,
          code: 'not_found',
          message: `Skill is not available: ${stringArg(args, 'skill_id')}`
        })
      }
      activeSkillIds.add(skill.id)
      const content =
        `<skill_instructions id="${skill.id}" trust="trusted-skill-instructions">\n` +
        `${skill.systemPromptInjection}\n</skill_instructions>`
      return this.success(title, { id: skill.id, name: skill.name }, content)
    }
    if (name === 'create_artifact') {
      if (!activeSkillIds.has('web-artifacts')) {
        return toolExecutionFailed({
          title,
          code: 'permission_denied',
          message: 'Load the web-artifacts skill before creating an inline artifact'
        })
      }
      return this.success(title, {
        artifact: {
          type: args.type,
          title: args.title,
          code: args.code
        }
      })
    }
    if (name === 'spawn_subagent') {
      if (!this.childLauncher) {
        return toolExecutionFailed({
          title,
          code: 'unsupported',
          message: 'Child-agent execution is not configured'
        })
      }
      readReceipts.clear()
      return this.success(
        title,
        await this.childLauncher.launch(
          stringArg(args, 'task'),
          stringArg(args, 'context') || undefined,
          context
        )
      )
    }
    const mcpTool = mcpByFunction.get(name)
    if (mcpTool) {
      readReceipts.clear()
      return this.success(
        title,
        await this.mcp.callTool(mcpTool.serverId, mcpTool.name, args, {
          signal: context.signal
        })
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

  private async manageTodos(
    runId: string,
    title: string,
    args: Record<string, unknown>,
    onUpdated?: (todos: TodoItem[]) => void
  ): Promise<ToolExecutionResult> {
    if (args.operation === 'write') {
      const todos = Array.isArray(args.todoList) ? (args.todoList as TodoItem[]) : []
      if (todos.filter((todo) => todo.status === 'in-progress').length > 1) {
        return toolExecutionFailed({
          title,
          code: 'invalid_arguments',
          message: 'At most one todo item may be in progress',
          retryable: true
        })
      }
      this.db
        .prepare(
          `INSERT INTO agent_run_todos (run_id, todo_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET todo_json = excluded.todo_json, updated_at = excluded.updated_at`
        )
        .run(runId, JSON.stringify(todos), Date.now())
      onUpdated?.(todos)
    }
    const row = this.db
      .prepare('SELECT todo_json FROM agent_run_todos WHERE run_id = ?')
      .get(runId) as { todo_json: string } | undefined
    const todos = row ? (JSON.parse(row.todo_json) as TodoItem[]) : []
    return this.success(title, { todoList: todos })
  }

  cancelRun(runId: string): void {
    this.commands.cancelRun(runId)
  }

  async close(): Promise<void> {
    await this.languageIntelligence.close()
  }
}
