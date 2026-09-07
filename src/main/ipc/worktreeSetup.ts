import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, appendFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { CommandRunner } from '../services/commandRunner'
import { shellChildEnvironment } from '../services/commandService'
import { isolatedShellProcess } from '../services/dockerShellIsolation'
import { getBundledSkillAssetsPath } from '../services/bundledSkillAssets'
import { projectStartCommands } from '../services/projectHooks'
import { runWorktreeCreationHooks } from '../services/worktreeCreationHooks'
import { getStore } from './state'
import type { ProviderSettings } from '../../shared/settings'

const runner = new CommandRunner()
let shuttingDown = false
const activeExecutions = new Set<Promise<unknown>>()

function trackExecution<T>(action: () => Promise<T>): Promise<T> {
  const execution = action()
  activeExecutions.add(execution)
  return execution.finally(() => activeExecutions.delete(execution))
}

export async function shutdownWorktreeSetup(): Promise<void> {
  shuttingDown = true
  runner.cancelAll()
  await Promise.allSettled([...activeExecutions])
}

/** Runs only after the fork is durable, so failure never rolls back user files. */
export async function setupCreatedWorktree(
  sender: WebContents,
  sourceRoot: string,
  workspaceRoot: string
): Promise<void> {
  const settings = getStore().get('settings', {}) as ProviderSettings
  const commands = projectStartCommands(settings.projectWorktreeHooks, sourceRoot)
  if (!commands.length) return
  const isolated = settings.shellIsolation === 'docker'
  const canonicalRoot = await realpath(workspaceRoot)
  const owner = BrowserWindow.fromWebContents(sender)
  const show = (options: Electron.MessageBoxOptions) =>
    owner && !owner.isDestroyed()
      ? dialog.showMessageBox(owner, options)
      : dialog.showMessageBox(options)
  const result = await runWorktreeCreationHooks({
    commands,
    approve: async (command) => {
      if (sender.isDestroyed() || shuttingDown) return false
      const answer = await show({
        type: 'question',
        title: 'Approve worktree setup command',
        message: 'Run this configured command in the new worktree?',
        detail: `Folder: ${workspaceRoot}\nEnvironment: ${isolated ? 'isolated Linux container' : 'host shell'}\nMaximum time: 120 seconds\n\n${command}\n\nApproval applies only to this command. Skipping preserves the new worktree without completing setup.`,
        buttons: ['Skip remaining setup', 'Run command'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return answer.response === 1 && !sender.isDestroyed() && !shuttingDown
    },
    execute: (command) =>
      trackExecution(async () => {
        const id = randomUUID()
        const outputRoot = join(app.getPath('userData'), 'worktree-setup', id)
        mkdirSync(outputRoot, { recursive: true, mode: 0o700 })
        const outputPath = join(outputRoot, 'output.log')
        const env = shellChildEnvironment(
          process.env,
          canonicalRoot,
          outputRoot,
          getBundledSkillAssetsPath()
        )
        let sandbox: Awaited<ReturnType<typeof isolatedShellProcess>> | undefined
        let success = false
        const cancel = () => {
          runner.cancel(id)
        }
        sender.once('destroyed', cancel)
        try {
          if ((await realpath(workspaceRoot)) !== canonicalRoot)
            throw new Error('Worktree path changed during approval')
          sandbox = isolated
            ? await isolatedShellProcess({
                id,
                cwd: canonicalRoot,
                workspaceRoot: canonicalRoot,
                command,
                timeoutSecs: 120,
                env
              })
            : undefined
          if (sender.isDestroyed() || shuttingDown) throw new Error('Setup cancelled before launch')
          const result = await runner.run({
            id,
            command,
            process: sandbox,
            cwd: canonicalRoot,
            timeoutMs: 120000,
            outputPath,
            env
          })
          success = result.success
          appendFileSync(
            outputPath,
            '\n[SideKick worktree setup outcome]\n' +
              JSON.stringify({
                success: result.success,
                exitCode: result.exitCode,
                cancelled: result.cancelled,
                error: result.error
              }) +
              (success
                ? '\n'
                : '\nEffects may have occurred. Inspect actual state before retrying.\n'),
            { mode: 0o600 }
          )
        } catch (error) {
          success = false
          // This is private application output, never diagnostic-export data.
          appendFileSync(
            outputPath,
            error instanceof Error ? error.message : 'Setup launch failed',
            {
              mode: 0o600
            }
          )
        } finally {
          sender.removeListener('destroyed', cancel)
          try {
            await sandbox?.cleanup()
          } catch (error) {
            success = false
            appendFileSync(
              outputPath,
              '\nCleanup could not be confirmed: ' +
                (error instanceof Error ? error.message : 'unknown failure') +
                '\nInspect Docker and actual files before retrying.\n',
              { mode: 0o600 }
            )
          }
        }
        return { success, outputPath }
      })
  })
  if (result.status === 'skipped' || shuttingDown || sender.isDestroyed()) return
  await show({
    type: result.status === 'completed' ? 'info' : 'warning',
    title: result.status === 'completed' ? 'Worktree setup completed' : 'Worktree setup incomplete',
    message: `${result.completed} configured command(s) completed. The new worktree has been preserved.`,
    detail: `Folder: ${workspaceRoot}\n${result.status === 'completed' ? '' : 'Setup stopped. Inspect actual files and command output before retrying; completed or uncertain commands are never automatically replayed.\n'}${result.outputPaths.length ? '\nPrivate output files:\n' + result.outputPaths.join('\n') : ''}`,
    buttons: ['OK'],
    noLink: true
  })
}
