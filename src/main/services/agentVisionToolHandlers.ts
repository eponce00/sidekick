import { stat } from 'fs/promises'
import { extname, relative, resolve } from 'path'
import {
  toolExecutionFailed,
  toolExecutionSucceeded,
  type ToolResultImageMimeType
} from '../../shared/agentRuntime'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'

const IMAGE_MIME_TYPES: Readonly<Record<string, ToolResultImageMimeType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

function projectImagePath(workspaceRoot: string, requested: string): string {
  const root = resolve(workspaceRoot)
  const target = resolve(root, requested)
  const rel = relative(root, target)
  if (!requested.trim() || rel.startsWith('..') || rel.includes(':') || resolve(root, rel) !== target) {
    throw new Error('Image path must stay inside the active project')
  }
  return target
}

export function registerVisionToolHandlers(registry: AgentToolHandlerRegistry): void {
  registry.register('view_image', async ({ title, arguments: args, context }) => {
    if (!context.workspaceRoot) {
      return toolExecutionFailed({
        title,
        code: 'workspace_scope',
        message: 'view_image requires an active project workspace',
        recoveryAction: 'change_strategy'
      })
    }
    const requested = typeof args.path === 'string' ? args.path : ''
    let path: string
    try {
      path = projectImagePath(context.workspaceRoot, requested)
    } catch (error) {
      return toolExecutionFailed({
        title,
        code: 'workspace_scope',
        message: error instanceof Error ? error.message : String(error),
        recoveryAction: 'correct_input'
      })
    }
    const mimeType = IMAGE_MIME_TYPES[extname(path).toLowerCase()]
    if (!mimeType) {
      return toolExecutionFailed({
        title,
        code: 'unsupported',
        message: 'view_image supports PNG, JPEG, WebP, and GIF files',
        recoveryAction: 'correct_input'
      })
    }
    const info = await stat(path)
    if (!info.isFile()) {
      return toolExecutionFailed({
        title,
        code: 'not_found',
        message: 'Image path is not a file',
        recoveryAction: 'correct_input'
      })
    }
    if (info.size > 8 * 1024 * 1024) {
      return toolExecutionFailed({
        title,
        code: 'unsupported',
        message: `Image is ${info.size} bytes; the vision input limit is 8 MiB`,
        recoveryAction: 'change_strategy',
        recovery: 'Resize or convert the image, then inspect the smaller project file.'
      })
    }
    return toolExecutionSucceeded({
      title,
      data: {
        path: requested,
        mimeType,
        bytes: info.size,
        detail: args.detail === 'original' || args.detail === 'high' ? args.detail : 'auto'
      },
      modelContent: `Attached project image ${requested} (${mimeType}, ${info.size} bytes) for visual inspection.`,
      media: [
        {
          type: 'image',
          mimeType,
          name: requested,
          description: 'Project image selected by view_image',
          source: { type: 'file', path }
        }
      ]
    })
  })
}
