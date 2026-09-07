import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  OFFICE_HELPER_OUTPUT_LIMIT,
  parseOfficeHelperReport,
  type OfficeHelperReport
} from './directOfficeHelperReport'

const HELPERS = Object.freeze({
  preflight: 'preflight.py',
  validate: 'office/validate.py'
} as const)
const WORKFLOWS = ['office', 'office-validate', 'docx-comment', 'xlsx', 'pptx-read'] as const
export type OfficeHelperId = keyof typeof HELPERS

export interface OfficeHelperReceipt {
  invocationId: string
  helper: OfficeHelperId
  helperDigest: string
  backend: 'host'
  lifecycle: 'started' | 'finished'
  outcome: 'running' | 'exited' | 'spawn_error' | 'process_error' | 'cancelled' | 'timed_out'
  exitCode: number | null
  /** Sanitized content claim, independent of this app-generated process receipt. */
  report?: OfficeHelperReport
}

export interface DirectOfficeHelperConfiguration {
  /** Main-process configuration only, never populated from tool arguments. */
  assetsRoot: string
  interpreter: string
  workspaceRoot: string
  /** Required on Windows; trusted app configuration, not inherited PATH. */
  windowsSystemRoot?: string
  expectedDigests: Partial<Record<OfficeHelperId, string>>
  /** Private per-call observer supplies correlation; no model-controlled metadata. */
  observe?: (receipt: Readonly<OfficeHelperReceipt>) => void
  /** Main-process live authorization recheck immediately before process dispatch. */
  authorize?: () => boolean
}

export type DirectOfficeHelperInput = {
  timeoutMs: number
  signal?: AbortSignal
  backend: 'host' | 'docker'
} & (
  | { helper: 'validate'; path: string }
  | { helper: 'preflight'; workflow: (typeof WORKFLOWS)[number] }
)

async function checkedFilesystem<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch {
    throw new Error('Helper filesystem validation failed')
  }
}

/** Direct host execution, no shell parsing or nested-process attestation.
 * The configured installation/interpreter must be trusted and immutable during execution.
 * Stdout is bounded and adapted to a content report; stderr is discarded.
 * Neither output channel supplies process receipts or exit markers.
 */
export async function executeDirectOfficeHelper(
  config: DirectOfficeHelperConfiguration,
  input: DirectOfficeHelperInput
): Promise<
  | Readonly<OfficeHelperReceipt>
  | { executionProvenance: 'unverified'; reason: 'unsupported_backend' }
> {
  if (input.backend !== 'host')
    return { executionProvenance: 'unverified', reason: 'unsupported_backend' }
  if (!Object.hasOwn(HELPERS, input.helper)) throw new Error('Unknown Office helper')
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'helper',
          'timeoutMs',
          'signal',
          'backend',
          input.helper === 'validate' ? 'path' : 'workflow'
        ].includes(key)
    ) ||
    (input.helper === 'validate'
      ? typeof input.path !== 'string' ||
        !input.path ||
        input.path.includes('\0') ||
        isAbsolute(input.path)
      : !WORKFLOWS.includes(input.workflow)) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.timeoutMs > 2_147_483_647 ||
    !isAbsolute(config.assetsRoot) ||
    !isAbsolute(config.interpreter) ||
    !isAbsolute(config.workspaceRoot) ||
    (process.platform === 'win32' &&
      (!config.windowsSystemRoot || !isAbsolute(config.windowsSystemRoot)))
  )
    throw new Error('Invalid direct helper configuration')

  // Snapshot caller-owned values before asynchronous validation.
  const requestedPath = input.helper === 'validate' ? input.path : undefined
  const workflow = input.helper === 'preflight' ? input.workflow : undefined
  const helper = input.helper
  const expected = config.expectedDigests[helper]
  const interpreter = config.interpreter
  const configuredWorkspace = config.workspaceRoot
  const signal = input.signal
  const timeoutMs = input.timeoutMs
  const observe = config.observe
  const authorize = config.authorize
  const windowsSystemRoot = config.windowsSystemRoot
  const env = process.platform === 'win32' ? { SystemRoot: windowsSystemRoot } : {}
  const taskkill = windowsSystemRoot
    ? join(windowsSystemRoot, 'System32', 'taskkill.exe')
    : undefined
  if (process.platform === 'win32' && taskkill) {
    const located = await checkedFilesystem(() => realpath(taskkill))
    if (
      relative(resolve(located), resolve(taskkill)) !== '' ||
      !(await checkedFilesystem(() => lstat(taskkill))).isFile()
    )
      throw new Error('Configured Windows cleanup executable is invalid')
  }
  const cwd = await checkedFilesystem(() => realpath(configuredWorkspace))
  const args: string[] = []
  if (requestedPath !== undefined) {
    const target = await checkedFilesystem(() => realpath(resolve(cwd, requestedPath)))
    const within = relative(cwd, target)
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new Error('Validation target escapes the workspace')
    args.push(target)
  } else {
    args.push(workflow!, '--workspace', cwd)
  }
  const root = await checkedFilesystem(() => realpath(config.assetsRoot))
  const helperPath = join(root, HELPERS[helper])
  if (!expected || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error('Missing trusted helper digest')
  const located = await checkedFilesystem(() => realpath(helperPath))
  if (
    relative(resolve(located), resolve(helperPath)) !== '' ||
    !(await checkedFilesystem(() => lstat(helperPath))).isFile()
  )
    throw new Error('Bundled helper identity is invalid')
  if (!(await checkedFilesystem(() => lstat(interpreter))).isFile())
    throw new Error('Configured interpreter is invalid')
  const digest = createHash('sha256')
    .update(await checkedFilesystem(() => readFile(helperPath)))
    .digest('hex')
  if (digest !== expected) throw new Error('Bundled helper digest mismatch')

  const invocationId = randomUUID()
  let observerFailed = false
  const receipt = (
    lifecycle: OfficeHelperReceipt['lifecycle'],
    outcome: OfficeHelperReceipt['outcome'],
    exitCode: number | null = null,
    report?: OfficeHelperReport
  ): Readonly<OfficeHelperReceipt> => {
    const value = Object.freeze({
      invocationId,
      helper,
      helperDigest: digest,
      backend: 'host' as const,
      lifecycle,
      outcome,
      exitCode,
      ...(report ? { report } : {})
    })
    try {
      observe?.(value)
    } catch {
      observerFailed = true
    }
    return value
  }
  if (signal?.aborted) {
    const result = receipt('finished', 'cancelled')
    if (observerFailed) throw new Error('Helper receipt observer failed')
    return result
  }

  const result = await new Promise<Readonly<OfficeHelperReceipt>>((resolveResult) => {
    if (authorize && !authorize())
      throw new Error('Office helper authorization changed before execution')
    let child: ChildProcess
    try {
      child = spawn(interpreter, ['-B', '-s', '-E', helperPath, ...args], {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
        // Do not inherit ambient credentials or Python startup/module overrides.
        env
      })
    } catch {
      resolveResult(receipt('finished', 'spawn_error'))
      return
    }
    let settled = false
    let outputBytes = 0
    let outputOverflow = false
    let outputReadError = false
    const output: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outputOverflow || outputReadError) return
      outputBytes += chunk.length
      if (outputBytes > OFFICE_HELPER_OUTPUT_LIMIT) {
        outputOverflow = true
        output.length = 0
        return
      }
      output.push(Buffer.from(chunk))
    })
    child.stdout?.on('error', () => {
      // A read failure does not prove that the child exited. Discard even a
      // complete-looking partial report and let close/cancel/timeout settle it.
      outputReadError = true
      output.length = 0
    })
    let started = false
    let processError = false
    let reason: 'cancelled' | 'timed_out' | undefined
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    const killChild = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal)
      } catch {
        // Failure to request termination is not process completion. Keep the
        // close listener and escalation timer active; never emit a false exit.
      }
    }
    const terminate = (force = false): void => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        try {
          const killer = spawn(taskkill!, ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
            shell: false,
            env
          })
          killer.on('error', () => killChild('SIGKILL'))
        } catch {
          killChild('SIGKILL')
        }
      } else {
        try {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
        } catch {
          killChild(force ? 'SIGKILL' : 'SIGTERM')
        }
      }
    }
    const stop = (next: 'cancelled' | 'timed_out'): void => {
      if (settled || reason) return
      reason = next
      terminate()
      forceTimer = setTimeout(() => terminate(true), 3000)
      forceTimer.unref()
    }
    const abort = (): void => stop('cancelled')
    const timer = setTimeout(() => stop('timed_out'), timeoutMs)
    const finish = (outcome: OfficeHelperReceipt['outcome'], code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      signal?.removeEventListener('abort', abort)
      const report: OfficeHelperReport | undefined =
        !reason && outcome === 'exited'
          ? outputReadError
            ? Object.freeze({
                evidence: 'helper_json_report',
                status: 'unusable_output',
                reason: 'stream_error'
              })
            : parseOfficeHelperReport(helper, workflow, Buffer.concat(output), outputOverflow, code)
          : undefined
      output.length = 0
      resolveResult(receipt('finished', reason ?? outcome, code, report))
    }
    child.once('spawn', () => {
      started = true
      receipt('started', 'running')
    })
    child.on('error', () => {
      // A failed kill can emit error while the process is still alive.
      if (!started) finish('spawn_error', null)
      else processError = true
    })
    child.once('close', (code) => finish(processError ? 'process_error' : 'exited', code))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
  // Observer exceptions never strand the child; surface them after lifecycle settlement.
  if (observerFailed) throw new Error('Helper receipt observer failed')
  return result
}
