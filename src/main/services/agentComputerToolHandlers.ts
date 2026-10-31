import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import type { ToolResultImageMimeType } from '../../shared/agentRuntime'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import type { ToolOutputStore } from './toolOutputStore'
import { ComputerUseRefusal, type ComputerUseService } from './computerUseService'
import { saveViewedImagePreview } from './viewedImagePreviews'

const IMAGE_TYPES: readonly ToolResultImageMimeType[] = ['image/png', 'image/jpeg', 'image/webp']

function text(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? args[key] : ''
}

function number(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The one `computer` tool. The service decides what it may reach; this only maps its actions. */
export function registerComputerToolHandlers(
  registry: AgentToolHandlerRegistry,
  service: ComputerUseService,
  outputs: ToolOutputStore,
  options: { vision: boolean }
): void {
  registry.register('computer', async ({ title, arguments: args, context }) => {
    const chat = context.conversationId ?? context.runId
    const { signal } = context
    const action = text(args, 'action')
    const app = text(args, 'app')
    const element = number(args, 'element')
    const succeed = async (content: string) => {
      const bounded = await outputs.apply(content)
      return toolExecutionSucceeded({
        title,
        data: { action, app },
        modelContent: bounded.content,
        output: bounded.output
      })
    }
    try {
      if (action === 'list_apps') return await succeed(await service.apps(signal))
      if (!app) {
        return toolExecutionFailed({
          title,
          code: 'invalid_arguments',
          message: 'Name the app. Use list_apps to see which are open.'
        })
      }
      switch (action) {
        case 'request_app':
          return await succeed(await service.requestApp(chat, app, signal))
        case 'look': {
          const seen = await service.look(chat, app, options.vision, signal, number(args, 'window'))
          const bounded = await outputs.apply(seen.text)
          const images = seen.images.filter((image) =>
            IMAGE_TYPES.includes(image.mimeType as ToolResultImageMimeType)
          )
          const first = images[0]
          const previewUrl = first
            ? await saveViewedImagePreview(Buffer.from(first.data, 'base64'))
            : undefined
          return toolExecutionSucceeded({
            title,
            data: { action, app, ...(previewUrl ? { previewUrl } : {}) },
            modelContent: bounded.content,
            output: bounded.output,
            // The model clicks by pixels in this image, so its copy must keep its size.
            media: first
              ? [
                  {
                    type: 'image',
                    mimeType: first.mimeType as ToolResultImageMimeType,
                    name: `${app} window`,
                    description: `The ${app} window`,
                    keepDimensions: true,
                    source: {
                      type: 'data_url',
                      dataUrl: `data:${first.mimeType};base64,${first.data}`
                    }
                  }
                ]
              : undefined
          })
        }
        case 'click':
        case 'double_click':
        case 'right_click':
          return await succeed(
            await service.click(
              chat,
              app,
              {
                element,
                x: number(args, 'x'),
                y: number(args, 'y'),
                double: action === 'double_click',
                button: action === 'right_click' ? 'right' : 'left'
              },
              signal
            )
          )
        case 'drag':
          return await succeed(
            await service.drag(
              chat,
              app,
              { x: number(args, 'x'), y: number(args, 'y') },
              { x: number(args, 'to_x'), y: number(args, 'to_y') },
              signal
            )
          )
        case 'type':
          return await succeed(await service.type(chat, app, text(args, 'text'), element, signal))
        case 'set_value':
          if (element === undefined) throw new ComputerUseRefusal('set_value needs an element.')
          return await succeed(
            await service.setValue(chat, app, element, text(args, 'text'), signal)
          )
        case 'key':
          return await succeed(
            await service.key(
              chat,
              app,
              text(args, 'key'),
              Array.isArray(args.modifiers) ? args.modifiers.map(String) : [],
              signal
            )
          )
        case 'scroll':
          return await succeed(
            await service.scroll(
              chat,
              app,
              text(args, 'direction'),
              number(args, 'amount') ?? 3,
              signal
            )
          )
        default:
          return toolExecutionFailed({
            title,
            code: 'invalid_arguments',
            message: `Unknown action ${action || '(none)'}.`
          })
      }
    } catch (error) {
      if (signal.aborted) {
        return toolExecutionFailed({
          title,
          code: 'cancelled',
          status: 'cancelled',
          message: 'Computer use was cancelled.'
        })
      }
      if (error instanceof ComputerUseRefusal) {
        return toolExecutionFailed({
          title,
          code: error.refresh ? 'stale_read' : 'permission_denied',
          message: error.message,
          recoveryAction: error.refresh ? 'refresh_state' : 'change_strategy'
        })
      }
      return toolExecutionFailed({
        title,
        code: 'internal',
        message: `Computer use failed: ${error instanceof Error ? error.message : String(error)}`
      })
    }
  })
}
