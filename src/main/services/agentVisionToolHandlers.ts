import { open, realpath, stat } from 'fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'path'
import { workspaceAbsolutePath, workspaceFolderRoots } from '../utils/workspacePaths'
import {
  toolExecutionFailed,
  toolExecutionSucceeded,
  type ToolResultImageMimeType
} from '../../shared/agentRuntime'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import { saveViewedImagePreview } from './viewedImagePreviews'
import { imageContentType } from '../../shared/imageContent'
import { MAX_IMAGE_INPUT_BYTES, type ProviderImageProfile } from '../../shared/imagePreparation'
import { MAX_TOOL_RESULT_MEDIA_BYTES } from '../../shared/agentRuntime'
import { prepareProviderImage } from '../providers/providerImages'
const TYPES: Readonly<Record<string, ToolResultImageMimeType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}
const LIMIT = MAX_IMAGE_INPUT_BYTES
// A larger image is kept in the run's journal as a copy that fits the tool media cap; each
// provider request then fits that copy to the model.
const JOURNAL_COPY: ProviderImageProfile = {
  maxLongEdge: Number.POSITIVE_INFINITY,
  maxBytes: MAX_TOOL_RESULT_MEDIA_BYTES,
  formats: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  maxImages: 1
}
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
      // A relative path may name another project folder, as `<name>/image.png`.
      const path = await realpath(
        context.workspaceRoot && !isAbsolute(requested)
          ? workspaceAbsolutePath(context.workspaceRoot, requested)
          : resolve(context.workspaceRoot ?? '', requested)
      )
      // An image in any of the project's folders is the project's own.
      const roots = context.workspaceRoot
        ? await Promise.all(
            workspaceFolderRoots(context.workspaceRoot).map((root) =>
              realpath(root).catch(() => null)
            )
          )
        : []
      const external = !roots.some((root) => {
        if (!root) return false
        const rel = relative(root, path)
        return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      })
      if (!TYPES[extname(path).toLowerCase()])
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
          message: 'Image must be a nonempty regular file no larger than 100 MB.'
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
        const buffer = Buffer.alloc(before.size + 1)
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
      const mimeType = imageContentType(bytes)
      if (!mimeType)
        return toolExecutionFailed({
          title,
          code: 'unsupported',
          message:
            `${requested} is not a whole PNG, JPEG, WebP, or GIF image, so it was not attached. ` +
            'A shell redirect such as `adb shell screencap -p > file.png` or PowerShell `>` ' +
            'rewrites binary output. Save the file where it is made and copy it instead, for ' +
            'example `adb shell screencap -p /sdcard/screen.png` then `adb pull /sdcard/screen.png`.'
        })
      let sent = { mimeType, bytes }
      if (bytes.length > MAX_TOOL_RESULT_MEDIA_BYTES) {
        const copy = await prepareProviderImage(bytes, JOURNAL_COPY, { keepDimensions: true })
        if (!copy.ok)
          return toolExecutionFailed({
            title,
            code: 'unsupported',
            message:
              copy.reason === 'too_large'
                ? `${requested} has more pixels than SideKick can open.`
                : `${requested} could not be decoded as an image.`
          })
        sent = { mimeType: copy.mimeType, bytes: copy.bytes }
      }
      const previewUrl = await saveViewedImagePreview(sent.bytes)
      return toolExecutionSucceeded({
        title,
        data: {
          path: requested,
          mimeType,
          bytes: bytes.length,
          ...(previewUrl ? { previewUrl } : {}),
          detail: args.detail === 'original' || args.detail === 'high' ? args.detail : 'auto'
        },
        modelContent: `Attached image ${requested} (${mimeType}, ${bytes.length} bytes) for visual inspection.`,
        media: [
          {
            type: 'image',
            mimeType: sent.mimeType,
            name: requested,
            description: 'Image selected by view_image',
            source: {
              type: 'data_url',
              dataUrl: `data:${sent.mimeType};base64,${sent.bytes.toString('base64')}`
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
