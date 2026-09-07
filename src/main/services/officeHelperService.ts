import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { ProviderSettings } from '../../shared/settings'
import { officeHelperWorkflows } from '../../shared/agentToolCatalog'
import { executeDirectOfficeHelper, type OfficeHelperReceipt } from './directOfficeHelper'
import type { AgentToolExecutionContext } from './agentToolRegistry'

/** Only user-picked or main settings input; selection never executes the file. */
export async function validateOfficeInterpreter(value: unknown): Promise<string | undefined> {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))
    throw new Error('Choose an absolute Office Python executable')
  try {
    const path = await realpath(value)
    if (!(await lstat(path)).isFile()) throw new Error()
    return path
  } catch {
    throw new Error('Office Python executable is unavailable or invalid')
  }
}

export class OfficeHelperService {
  private readonly recentReceipts: {
    runId: string
    toolCallId: string
    receipt: Readonly<OfficeHelperReceipt>
  }[] = []
  constructor(
    private readonly settings: () => Pick<
      ProviderSettings,
      'officeHelperInterpreter' | 'officeHelperConfigurationId' | 'shellIsolation'
    >,
    private readonly assetsRoot: () => string,
    private readonly observe?: (
      runId: string,
      toolCallId: string,
      receipt: Readonly<OfficeHelperReceipt>
    ) => void
  ) {}

  session(workspaceRoot?: string) {
    const interpreter = this.settings().officeHelperInterpreter
    const configurationId = this.settings().officeHelperConfigurationId
    const available = () =>
      Boolean(
        workspaceRoot &&
        isAbsolute(workspaceRoot) &&
        interpreter &&
        isAbsolute(interpreter) &&
        this.settings().officeHelperInterpreter === interpreter &&
        this.settings().officeHelperConfigurationId === configurationId &&
        (this.settings().shellIsolation ?? 'host') === 'host'
      )
    const assetsRoot = available() ? this.assetsRoot() : undefined
    // Pin app-owned helper bytes for this session, not hashes supplied by tool arguments.
    const digests = assetsRoot
      ? Promise.all(
          ['preflight.py', 'office/validate.py'].map(async (path) =>
            createHash('sha256')
              .update(await readFile(join(assetsRoot, path)))
              .digest('hex')
          )
        ).catch(() => null)
      : Promise.resolve(null)
    return {
      available,
      execute: async (
        name: string,
        args: Record<string, unknown>,
        context: AgentToolExecutionContext,
        skills: readonly string[]
      ) => {
        if (
          !available() ||
          !assetsRoot ||
          !context.toolCallId ||
          !context.workspaceRoot ||
          resolve(context.workspaceRoot) !== resolve(workspaceRoot!)
        )
          throw new Error(
            'Office helper configuration is unavailable or changed; retry in a new run'
          )
        const workflows = officeHelperWorkflows(skills)
        if (!workflows.length) throw new Error('Load a corresponding Office skill first')
        const helper =
          name === 'office_preflight' ? 'preflight' : name === 'office_validate' ? 'validate' : null
        if (
          !helper ||
          Object.keys(args).some((key) => key !== (helper === 'preflight' ? 'workflow' : 'path'))
        )
          throw new Error('Invalid Office helper arguments')
        if (helper === 'preflight' && !workflows.includes(String(args.workflow)))
          throw new Error('Preflight workflow is not available for the loaded Office skill')
        const hashes = await digests
        if (!hashes || !available())
          throw new Error(
            'Office helper configuration is unavailable or changed; retry in a new run'
          )
        return executeDirectOfficeHelper(
          {
            assetsRoot,
            interpreter: interpreter!,
            workspaceRoot: workspaceRoot!,
            windowsSystemRoot: process.env.SystemRoot,
            expectedDigests: { preflight: hashes[0], validate: hashes[1] },
            authorize: available,
            observe: (receipt) => {
              this.recentReceipts.push({
                runId: context.runId,
                toolCallId: context.toolCallId!,
                receipt
              })
              if (this.recentReceipts.length > 256) this.recentReceipts.shift()
              this.observe?.(context.runId, context.toolCallId!, receipt)
            }
          },
          helper === 'preflight'
            ? {
                helper,
                workflow: args.workflow as 'office',
                backend: 'host',
                timeoutMs: 30000,
                signal: context.signal
              }
            : {
                helper,
                path: args.path as string,
                backend: 'host',
                timeoutMs: 30000,
                signal: context.signal
              }
        )
      }
    }
  }
}
