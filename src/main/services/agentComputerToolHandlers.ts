import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import type { ToolResultImageMimeType } from '../../shared/agentRuntime'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import type { ToolOutputStore } from './toolOutputStore'
import {
  ComputerUseRefusal,
  type ComputerLook,
  type ComputerUseService
} from './computerUseService'
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
    const realInput = args.real_input === true
    const confirmRisky = args.confirm_risky === true
    const succeed = async (content: string) => {
      const bounded = await outputs.apply(content)
      return toolExecutionSucceeded({
        title,
        data: { action, app },
        modelContent: bounded.content,
        output: bounded.output
      })
    }
    // The user sees the picture in the chat either way; only a model with vision is sent it.
    const showLook = async (seen: ComputerLook, before = '', isZoom = false) => {
      // Web-based apps often expose no controls, and then only the picture says what is there.
      const bounded = await outputs.apply(
        isZoom || /\[\d+\]/.test(seen.text)
          ? `${before}${seen.text}`
          : `${before}${seen.text}\n${options.vision ? 'This app lists no controls. Work from the image, by pixel.' : 'This app lists no controls, and this model cannot see the image, so it cannot operate this app. Tell the user.'}`
      )
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
        media:
          first && options.vision
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
    // An action comes back with the app as it now stands, so the agent sees what its step really did.
    const acted = async (result: string) => {
      const seen = await service.lookAfterAction(chat, app, signal).catch((error) => {
        if (signal.aborted) throw error
        return null
      })
      if (!seen) return succeed(result)
      return showLook(seen, `${result}\n${seen.note ? `${seen.note}\n` : ''}`)
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
        case 'look':
          return await showLook(await service.look(chat, app, true, signal, number(args, 'window')))
        case 'zoom': {
          const [x, y, toX, toY] = ['x', 'y', 'to_x', 'to_y'].map((key) => number(args, key))
          if (x === undefined || y === undefined || toX === undefined || toY === undefined) {
            throw new ComputerUseRefusal('zoom needs x and y, and to_x and to_y.')
          }
          return await showLook(await service.zoom(chat, app, { x, y, toX, toY }, signal), '', true)
        }
        case 'click':
        case 'double_click':
        case 'right_click':
          return await acted(
            await service.click(
              chat,
              app,
              {
                element,
                x: number(args, 'x'),
                y: number(args, 'y'),
                double: action === 'double_click',
                button: action === 'right_click' ? 'right' : 'left',
                fromZoom: args.from_zoom === true
              },
              signal,
              realInput,
              confirmRisky
            )
          )
        case 'drag':
          return await acted(
            await service.drag(
              chat,
              app,
              { x: number(args, 'x'), y: number(args, 'y') },
              { x: number(args, 'to_x'), y: number(args, 'to_y') },
              signal,
              realInput
            )
          )
        case 'type':
          return await acted(
            await service.type(chat, app, text(args, 'text'), element, signal, realInput)
          )
        case 'set_value':
          if (element === undefined) throw new ComputerUseRefusal('set_value needs an element.')
          return await acted(await service.setValue(chat, app, element, text(args, 'text'), signal))
        case 'key':
          return await acted(
            await service.key(
              chat,
              app,
              text(args, 'key'),
              Array.isArray(args.modifiers) ? args.modifiers.map(String) : [],
              signal,
              realInput
            )
          )
        case 'scroll':
          return await acted(
            await service.scroll(
              chat,
              app,
              text(args, 'direction'),
              number(args, 'amount') ?? 3,
              { x: number(args, 'x'), y: number(args, 'y') },
              signal,
              realInput
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
