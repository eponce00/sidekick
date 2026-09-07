import { open, realpath, stat } from 'fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'path'
import {
  toolExecutionFailed,
  toolExecutionSucceeded,
  type ToolResultImageMimeType
} from '../../shared/agentRuntime'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
const TYPES: Readonly<Record<string, ToolResultImageMimeType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}
const LIMIT = 8 * 1024 * 1024
export type ExternalImageApproval = (canonicalPath: string, signal: AbortSignal) => Promise<boolean>
async function approved(
  approve: ExternalImageApproval,
  path: string,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false
  let onAbort: () => void = () => {}
  const cancelled = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false)
  })
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([approve(path, signal), cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
export function registerVisionToolHandlers(
  registry: AgentToolHandlerRegistry,
  approveExternal?: ExternalImageApproval
): void {
  registry.register('view_image', async ({ title, arguments: args, context }) => {
    const cancelled = () =>
      toolExecutionFailed({
        title,
        code: 'cancelled',
        status: 'cancelled',
        message: 'Image access cancelled'
      })
    if (context.signal.aborted) return cancelled()
    const requested = typeof args.path === 'string' ? args.path : ''
    if (
      !requested.trim() ||
      requested.includes('\0') ||
      (!context.workspaceRoot && !isAbsolute(requested))
    )
      return toolExecutionFailed({
        title,
        code: 'workspace_scope',
        message: 'Choose an absolute image path or an active project image.'
      })
    try {
      const path = await realpath(resolve(context.workspaceRoot ?? '', requested))
      const root = context.workspaceRoot ? await realpath(context.workspaceRoot) : undefined
      const rel = root ? relative(root, path) : undefined
      const external =
        rel === undefined || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
      const mimeType = TYPES[extname(path).toLowerCase()]
      if (!mimeType)
        return toolExecutionFailed({
          title,
          code: 'unsupported',
          message: 'view_image supports PNG, JPEG, WebP, and GIF files'
        })
      const before = await stat(path)
      if (!before.isFile() || before.size <= 0 || before.size > LIMIT)
        return toolExecutionFailed({
          title,
          code: 'unsupported',
          message: 'Image must be a nonempty regular file no larger than 8 MiB.'
        })
      if (external) {
        if (!approveExternal)
          return toolExecutionFailed({
            title,
            code: 'workspace_scope',
            message: 'External image access requires explicit user confirmation.'
          })
        if (!(await approved(approveExternal, path, context.signal))) {
          if (context.signal.aborted) return cancelled()
          return toolExecutionFailed({
            title,
            code: 'permission_denied',
            status: 'denied',
            message: 'External image access denied. Do not retry through shell or another tool.'
          })
        }
      }
      if (context.signal.aborted) return cancelled()
      // Pin one canonical identity and snapshot bounded bytes; no deferred path read.
      if ((await realpath(path)) !== path) throw new Error('changed')
      const file = await open(path, 'r')
      let bytes: Buffer
      try {
        const current = await file.stat()
        if (
          !current.isFile() ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.size !== before.size ||
          current.mtimeMs !== before.mtimeMs
        )
          throw new Error('changed')
        const buffer = Buffer.alloc(LIMIT + 1)
        let length = 0
        while (length < buffer.length) {
          const read = await file.read(buffer, length, buffer.length - length, null)
          if (!read.bytesRead) break
          length += read.bytesRead
        }
        const after = await file.stat()
        if (
          length !== before.size ||
          length > LIMIT ||
          after.mtimeMs !== before.mtimeMs ||
          (await realpath(path)) !== path
        )
          throw new Error('changed')
        bytes = buffer.subarray(0, length)
      } finally {
        await file.close()
      }
      if (context.signal.aborted) return cancelled()
      return toolExecutionSucceeded({
        title,
        data: {
          path: requested,
          mimeType,
          bytes: bytes.length,
          detail: args.detail === 'original' || args.detail === 'high' ? args.detail : 'auto'
        },
        modelContent: `Attached image ${requested} (${mimeType}, ${bytes.length} bytes) for visual inspection.`,
        media: [
          {
            type: 'image',
            mimeType,
            name: requested,
            description: 'Image selected by view_image',
            source: {
              type: 'data_url',
              dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`
            }
          }
        ]
      })
    } catch {
      if (context.signal.aborted) return cancelled()
      return toolExecutionFailed({
        title,
        code: 'not_found',
        message: 'Image is unavailable or changed during access; select it again.'
      })
    }
  })
}
