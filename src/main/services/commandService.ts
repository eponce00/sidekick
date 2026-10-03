import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import type { BackgroundTask, ShellCommandResult } from '../../shared/types'
import { resolveSecureWorkspacePath } from '../utils/workspacePaths'
import { CommandRunner } from './commandRunner'
import { isolatedShellProcess } from './dockerShellIsolation'
import { TerminalSessionStore } from './terminalSessions'
import type { TerminalSessionState } from '../../shared/terminalSessions'

export interface CommandServiceRunInput {
  runId: string
  /** The conversation the command belongs to; its background commands outlive one reply. */
  conversationId?: string
  toolCallId?: string
  title: string
  command: string
  workspaceRoot: string
  cwd?: string
  timeoutSecs?: number
  background?: boolean
  signal?: AbortSignal
  onOutput?: (data: { commandId: string; chunk: string; stream: 'stdout' | 'stderr' }) => void
}

export interface OwnedBackgroundTask extends BackgroundTask {
  runId: string
  conversationId?: string
  cwd: string
  /** A foreground command moved to the background before it finished, and why. */
  detached?: 'waiting_for_input' | 'user'
  /** For a command waiting for input, the question it asked. */
  prompt?: string
}

/** Which background commands a caller may see and stop. */
export interface BackgroundTaskScope {
  conversationId?: string
  runId?: string
}

export interface CommandServiceOptions {
  /** The shared record of every command's terminal; one is made when none is given. */
  terminals?: TerminalSessionStore
  /** Run commands in a pseudo-terminal when one is available. */
  terminalEnabled?: () => boolean
}

const MAX_PERSISTED_OUTPUT = 32 * 1024

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:^|_)(?:API_?KEY|AUTH|BEARER|COOKIE|CREDENTIAL|PASSWORD|PRIVATE_?KEY|SECRET|SESSION|TOKEN)(?:_|$)/i

/** Build the child environment without ambient provider or application credentials. */
export function shellChildEnvironment(
  source: NodeJS.ProcessEnv,
  workspaceRoot: string,
  scratchDirectory: string,
  skillAssetsPath?: string
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || SENSITIVE_ENVIRONMENT_NAME.test(name)) continue
    safe[name] = value
  }
  safe.WORKSPACE_FOLDER = workspaceRoot
  safe.SIDEKICK_WORKSPACE = workspaceRoot
  safe.SIDEKICK_SCRATCH = scratchDirectory
  if (skillAssetsPath) safe.SIDEKICK_SKILLS = skillAssetsPath
  return safe
}

function inScope(task: OwnedBackgroundTask, scope: BackgroundTaskScope): boolean {
  if (scope.conversationId) return task.conversationId === scope.conversationId
  return !scope.runId || task.runId === scope.runId
}

function sessionState(
  result: ShellCommandResult
): Exclude<TerminalSessionState, 'running' | 'waiting_for_input'> {
  if (result.cancelled) return 'stopped'
  if (result.error?.toLowerCase().includes('timed out')) return 'timed_out'
  if (result.exitCode === -1 && result.error) return 'failed'
  return 'exited'
}

const MAX_RENDERED_OUTPUT = 256 * 1024

function compactResult(result: ShellCommandResult | undefined): ShellCommandResult | undefined {
  if (!result) return undefined
  return {
    ...result,
    stdout: result.stdout.slice(0, MAX_PERSISTED_OUTPUT),
    stderr: result.stderr.slice(0, MAX_PERSISTED_OUTPUT),
    outputPath: undefined
  }
}

/**
 * Models occasionally echo the absolute project path shown in the system context back as cwd.
 * Accept that harmless form while keeping the secure project-relative resolver as the authority.
 */
export function projectRelativeCommandCwd(workspaceRoot: string, cwd = ''): string {
  if (!isAbsolute(cwd)) return cwd
  const root = resolve(workspaceRoot)
  const target = resolve(cwd)
  const withinProject = relative(root, target)
  if (withinProject === '..' || withinProject.startsWith(`..${sep}`) || isAbsolute(withinProject)) {
    return cwd
  }
  return withinProject
}

export class CommandService {
  private readonly runner = new CommandRunner()
  private readonly backgroundTasks = new Map<string, OwnedBackgroundTask>()
  readonly terminals: TerminalSessionStore
  private readonly terminalEnabled: () => boolean
  /** Ends a foreground command's wait, leaving it running as a background task. */
  private readonly detachers = new Map<string, (reason: 'waiting_for_input' | 'user') => void>()
  private readonly stoppedByUser = new Set<string>()

  constructor(
    private readonly db: Database.Database,
    private readonly outputRoot: string,
    private readonly onTaskUpdate: (task: OwnedBackgroundTask) => void = () => undefined,
    private readonly skillAssetsPath?: string,
    private readonly isolationEnabled: () => boolean = () => false,
    options: CommandServiceOptions = {}
  ) {
    this.terminals = options.terminals ?? new TerminalSessionStore()
    this.terminalEnabled = options.terminalEnabled ?? (() => false)
    // A foreground command stopped at a prompt cannot be answered while the agent waits on it.
    this.terminals.onStateChange((session) => {
      if (session.state === 'waiting_for_input')
        this.detachers.get(session.id)?.('waiting_for_input')
    })
    this.restore()
  }

  private outputPath(id: string): string {
    return join(this.outputRoot, `${id}.log`)
  }

  private shellEnvironment(runId: string, workspaceRoot: string): NodeJS.ProcessEnv {
    const scratchDirectory = join(this.outputRoot, 'scratch', runId)
    mkdirSync(scratchDirectory, { recursive: true })
    return shellChildEnvironment(process.env, workspaceRoot, scratchDirectory, this.skillAssetsPath)
  }

  private persist(task: OwnedBackgroundTask): void {
    this.db
      .prepare(
        `INSERT INTO background_tasks
         (id, run_id, title, command, cwd, status, started_at, ended_at, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           run_id = excluded.run_id,
           title = excluded.title,
           command = excluded.command,
           cwd = excluded.cwd,
           status = excluded.status,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           result_json = excluded.result_json`
      )
      .run(
        task.id,
        task.runId,
        task.title,
        task.command,
        task.cwd,
        task.status,
        task.startedAt,
        task.endedAt ?? null,
        task.result ? JSON.stringify(compactResult(task.result)) : null
      )
    this.db
      .prepare(
        `DELETE FROM background_tasks WHERE id NOT IN (
           SELECT id FROM background_tasks ORDER BY started_at DESC LIMIT 200
         )`
      )
      .run()
  }

  private restore(): void {
    const rows = this.db
      .prepare(
        `SELECT task.id, task.run_id, run.thread_id, task.title, task.command, task.cwd,
                task.status, task.started_at, task.ended_at, task.result_json
         FROM background_tasks task LEFT JOIN agent_runs run ON run.id = task.run_id
         ORDER BY task.started_at DESC LIMIT 200`
      )
      .all() as Array<{
      id: string
      run_id: string | null
      thread_id: string | null
      title: string
      command: string
      cwd: string | null
      status: BackgroundTask['status']
      started_at: number
      ended_at: number | null
      result_json: string | null
    }>
    for (const row of rows) {
      const interrupted = row.status === 'running'
      let result: ShellCommandResult | undefined
      if (row.result_json) {
        try {
          result = JSON.parse(row.result_json) as ShellCommandResult
        } catch {
          result = undefined
        }
      }
      const task: OwnedBackgroundTask = {
        id: row.id,
        runId: row.run_id || 'user',
        ...(row.thread_id ? { conversationId: row.thread_id } : {}),
        title: row.title,
        command: row.command,
        cwd: row.cwd || process.cwd(),
        status: interrupted ? 'error' : row.status,
        startedAt: row.started_at,
        endedAt: interrupted ? Date.now() : (row.ended_at ?? undefined),
        result: interrupted
          ? {
              success: false,
              exitCode: -1,
              stdout: '',
              stderr: '',
              error: 'Task was interrupted when SideKick exited'
            }
          : result
      }
      this.backgroundTasks.set(task.id, task)
      if (interrupted) this.persist(task)
    }
  }

  async execute(input: CommandServiceRunInput): Promise<ShellCommandResult | OwnedBackgroundTask> {
    if (input.signal?.aborted) throw new Error('Command cancelled before execution')
    if (!input.command.trim()) throw new Error('Command is required')
    const cwd = await resolveSecureWorkspacePath(
      input.workspaceRoot,
      projectRelativeCommandCwd(input.workspaceRoot, input.cwd)
    )
    const id = randomUUID()
    const isolate = this.isolationEnabled()
    if (isolate && input.background)
      throw new Error(
        'Background commands are not supported in isolated mode; run a bounded foreground command'
      )
    if (input.background) return this.startBackground(id, cwd, input)
    const env = this.shellEnvironment(input.runId, input.workspaceRoot)
    const sandbox = isolate
      ? await isolatedShellProcess({
          id,
          cwd,
          workspaceRoot: input.workspaceRoot,
          command: input.command,
          timeoutSecs: input.timeoutSecs,
          env,
          skillAssetsPath: this.skillAssetsPath
        })
      : undefined
    if (input.signal?.aborted) throw new Error('Command cancelled before execution')
    const abort = (): void => {
      this.runner.cancel(id)
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    const run = this.runner.run({
      id,
      command: input.command,
      process: sandbox,
      cwd,
      timeoutMs: Math.max(1, Math.min(86_400, input.timeoutSecs ?? 30)) * 1_000,
      outputPath: this.outputPath(id),
      env,
      terminal: !sandbox && this.terminalEnabled(),
      onStart: ({ pty }) => this.openSession(id, cwd, input, false, pty),
      onOutput: (data) => {
        this.terminals.append(id, data.chunk)
        input.onOutput?.(data)
      }
    })
    // An isolated command runs in a container that is removed when the call returns, so only a
    // host command can go on in the background.
    const detached = sandbox
      ? new Promise<never>(() => undefined)
      : new Promise<'waiting_for_input' | 'user'>((resolve) => this.detachers.set(id, resolve))
    try {
      const outcome = await Promise.race([
        run.then((result) => ({ result })),
        detached.then((reason) => ({ reason }))
      ])
      if ('reason' in outcome) {
        input.signal?.removeEventListener('abort', abort)
        return await this.continueInBackground(id, cwd, input, run, outcome.reason)
      }
      return await this.completeSession(id, outcome.result)
    } finally {
      this.detachers.delete(id)
      input.signal?.removeEventListener('abort', abort)
      await sandbox?.cleanup()
    }
  }

  private openSession(
    id: string,
    cwd: string,
    input: CommandServiceRunInput,
    background: boolean,
    pty: boolean
  ): void {
    this.terminals.start({
      id,
      runId: input.runId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      title: input.title,
      command: input.command,
      cwd,
      background,
      pty
    })
  }

  /**
   * Records how a command ended. Output from a pseudo-terminal is replaced by the text the
   * terminal shows: the raw stream is full of cursor moves and repaints a model cannot read.
   */
  private async completeSession(
    id: string,
    result: ShellCommandResult
  ): Promise<ShellCommandResult> {
    const stoppedByUser = this.stoppedByUser.delete(id)
    await this.terminals.finish(id, { state: sessionState(result), exitCode: result.exitCode })
    let completed: ShellCommandResult = stoppedByUser
      ? {
          ...result,
          stoppedByUser: true,
          error: 'The user stopped this command'
        }
      : result
    if (result.terminal) {
      const text = ((await this.terminals.lines(id)) ?? []).join('\n')
      const truncated = text.length > MAX_RENDERED_OUTPUT
      completed = {
        ...completed,
        stdout: truncated ? text.slice(-MAX_RENDERED_OUTPUT) : text,
        truncated: completed.truncated || truncated
      }
    }
    return completed
  }

  /** Turns a foreground command whose call has returned into a background task. */
  private async continueInBackground(
    id: string,
    cwd: string,
    input: CommandServiceRunInput,
    run: Promise<ShellCommandResult>,
    reason: 'waiting_for_input' | 'user'
  ): Promise<OwnedBackgroundTask> {
    const task: OwnedBackgroundTask = {
      id,
      runId: input.runId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      title: input.title,
      command: input.command,
      cwd,
      status: 'running',
      startedAt: this.terminals.get(id)?.startedAt ?? Date.now()
    }
    this.backgroundTasks.set(id, task)
    this.persist(task)
    this.terminals.moveToBackground(id)
    this.followBackground(task, run)
    const lines = (await this.terminals.lines(id)) ?? []
    return {
      ...task,
      detached: reason,
      ...(reason === 'waiting_for_input' && lines.length
        ? { prompt: lines.slice(-6).join('\n') }
        : {})
    }
  }

  private followBackground(task: OwnedBackgroundTask, run: Promise<ShellCommandResult>): void {
    void run
      .then((result) => this.completeSession(task.id, result))
      .then((result) => {
        task.result = result
        task.endedAt = Date.now()
        task.status = result.cancelled ? 'cancelled' : result.success ? 'success' : 'error'
        this.persist(task)
        this.onTaskUpdate({ ...task })
      })
      // A command ending as the app shuts down has nowhere to record it; nothing else to do.
      .catch((error: unknown) =>
        console.warn('[Commands] Could not record a finished task:', error)
      )
  }

  private startBackground(
    id: string,
    cwd: string,
    input: CommandServiceRunInput
  ): OwnedBackgroundTask {
    const task: OwnedBackgroundTask = {
      id,
      runId: input.runId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      title: input.title,
      command: input.command,
      cwd,
      status: 'running',
      startedAt: Date.now()
    }
    this.backgroundTasks.set(id, task)
    this.persist(task)
    this.followBackground(
      task,
      this.runner.run({
        id,
        command: input.command,
        cwd,
        timeoutMs: Math.max(1, Math.min(86_400, input.timeoutSecs ?? 3_600)) * 1_000,
        outputPath: this.outputPath(id),
        env: this.shellEnvironment(input.runId, input.workspaceRoot),
        terminal: this.terminalEnabled(),
        onStart: ({ pty }) => this.openSession(id, cwd, input, true, pty),
        onOutput: (data) => this.terminals.append(id, data.chunk)
      })
    )
    return { ...task }
  }

  listBackground(scope: BackgroundTaskScope = {}): OwnedBackgroundTask[] {
    return [...this.backgroundTasks.values()]
      .filter((task) => inScope(task, scope))
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((task) => ({ ...task, result: compactResult(task.result) }))
  }

  cancelBackground(taskId: string, scope: BackgroundTaskScope = {}): boolean {
    const task = this.backgroundTasks.get(taskId)
    if (!task || !inScope(task, scope)) return false
    const cancelled = this.runner.cancel(taskId)
    if (cancelled) {
      task.status = 'cancelled'
      task.endedAt = Date.now()
      this.persist(task)
      this.onTaskUpdate({ ...task })
    }
    return cancelled
  }

  /** Whether a command, foreground or background, belongs to the conversation. */
  ownsCommand(id: string, scope: BackgroundTaskScope): boolean {
    const session = this.terminals.get(id)
    if (!session) return false
    if (scope.conversationId) return session.conversationId === scope.conversationId
    return !scope.runId || session.runId === scope.runId
  }

  /** The user stopped one command; the agent is told so and goes on. */
  stopByUser(id: string): boolean {
    if (!this.runner.isRunning(id)) return false
    this.stoppedByUser.add(id)
    const task = this.backgroundTasks.get(id)
    if (task) return this.cancelBackground(id)
    return this.runner.cancel(id)
  }

  /** Stops waiting on a foreground command and lets it run on in the background. */
  moveToBackground(id: string): boolean {
    const detach = this.detachers.get(id)
    if (!detach) return false
    detach('user')
    return true
  }

  /** Types into a running command, as at its terminal. */
  write(id: string, data: string): boolean {
    return this.runner.write(id, data)
  }

  cancelRun(runId: string): void {
    for (const task of this.backgroundTasks.values()) {
      if (task.runId === runId && task.status === 'running')
        this.cancelBackground(task.id, { runId })
    }
  }

  cancelAll(): void {
    this.runner.cancelAll()
  }
}
