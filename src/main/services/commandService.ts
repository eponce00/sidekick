import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import type { BackgroundTask, ShellCommandResult } from '../../shared/types'
import { resolveSecureWorkspacePath } from '../utils/workspacePaths'
import { CommandRunner } from './commandRunner'

export interface CommandServiceRunInput {
  runId: string
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
  cwd: string
}

const MAX_PERSISTED_OUTPUT = 32 * 1024

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:^|_)(?:API_?KEY|AUTH|BEARER|COOKIE|CREDENTIAL|PASSWORD|PRIVATE_?KEY|SECRET|SESSION|TOKEN)(?:_|$)/i

/** Build the child environment without ambient provider or application credentials. */
export function shellChildEnvironment(
  source: NodeJS.ProcessEnv,
  workspaceRoot: string,
  scratchDirectory: string
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || SENSITIVE_ENVIRONMENT_NAME.test(name)) continue
    safe[name] = value
  }
  safe.WORKSPACE_FOLDER = workspaceRoot
  safe.SIDEKICK_WORKSPACE = workspaceRoot
  safe.SIDEKICK_SCRATCH = scratchDirectory
  return safe
}

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

  constructor(
    private readonly db: Database.Database,
    private readonly outputRoot: string,
    private readonly onTaskUpdate: (task: OwnedBackgroundTask) => void = () => undefined
  ) {
    this.restore()
  }

  private outputPath(id: string): string {
    return join(this.outputRoot, `${id}.log`)
  }

  private shellEnvironment(runId: string, workspaceRoot: string): NodeJS.ProcessEnv {
    const scratchDirectory = join(this.outputRoot, 'scratch', runId)
    mkdirSync(scratchDirectory, { recursive: true })
    return shellChildEnvironment(process.env, workspaceRoot, scratchDirectory)
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
        `SELECT id, run_id, title, command, cwd, status, started_at, ended_at, result_json
         FROM background_tasks ORDER BY started_at DESC LIMIT 200`
      )
      .all() as Array<{
      id: string
      run_id: string | null
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
    if (!input.command.trim()) throw new Error('Command is required')
    const cwd = await resolveSecureWorkspacePath(
      input.workspaceRoot,
      projectRelativeCommandCwd(input.workspaceRoot, input.cwd)
    )
    const id = randomUUID()
    if (input.background) return this.startBackground(id, cwd, input)
    const abort = (): void => {
      this.runner.cancel(id)
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    try {
      return await this.runner.run({
        id,
        command: input.command,
        cwd,
        timeoutMs: Math.max(1, Math.min(86_400, input.timeoutSecs ?? 30)) * 1_000,
        outputPath: this.outputPath(id),
        env: this.shellEnvironment(input.runId, input.workspaceRoot),
        onOutput: input.onOutput
      })
    } finally {
      input.signal?.removeEventListener('abort', abort)
    }
  }

  private startBackground(
    id: string,
    cwd: string,
    input: CommandServiceRunInput
  ): OwnedBackgroundTask {
    const task: OwnedBackgroundTask = {
      id,
      runId: input.runId,
      title: input.title,
      command: input.command,
      cwd,
      status: 'running',
      startedAt: Date.now()
    }
    this.backgroundTasks.set(id, task)
    this.persist(task)
    void this.runner
      .run({
        id,
        command: input.command,
        cwd,
        timeoutMs: Math.max(1, Math.min(86_400, input.timeoutSecs ?? 3_600)) * 1_000,
        outputPath: this.outputPath(id),
        env: this.shellEnvironment(input.runId, input.workspaceRoot)
      })
      .then((result) => {
        task.result = result
        task.endedAt = Date.now()
        task.status = result.cancelled ? 'cancelled' : result.success ? 'success' : 'error'
        this.persist(task)
        this.onTaskUpdate({ ...task })
      })
    return { ...task }
  }

  listBackground(runId?: string): OwnedBackgroundTask[] {
    return [...this.backgroundTasks.values()]
      .filter((task) => !runId || task.runId === runId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((task) => ({ ...task, result: compactResult(task.result) }))
  }

  cancelBackground(taskId: string, runId?: string): boolean {
    const task = this.backgroundTasks.get(taskId)
    if (!task || (runId && task.runId !== runId)) return false
    const cancelled = this.runner.cancel(taskId)
    if (cancelled) {
      task.status = 'cancelled'
      task.endedAt = Date.now()
      this.persist(task)
      this.onTaskUpdate({ ...task })
    }
    return cancelled
  }

  cancelRun(runId: string): void {
    for (const task of this.backgroundTasks.values()) {
      if (task.runId === runId && task.status === 'running') this.cancelBackground(task.id, runId)
    }
  }

  cancelAll(): void {
    this.runner.cancelAll()
  }
}
