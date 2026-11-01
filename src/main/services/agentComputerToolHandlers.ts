import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import type { ToolResultImageMimeType } from '../../shared/agentRuntime'
import type { AgentToolHandlerRegistry } from './agentToolHandlerRegistry'
import type { ToolOutputStore } from './toolOutputStore'
import {
  computerKeyCombination,
  ComputerUseRefusal,
  type ComputerLook,
  type ComputerUseService
} from './computerUseService'
import { saveViewedImagePreview } from './viewedImagePreviews'

const IMAGE_TYPES: readonly ToolResultImageMimeType[] = ['image/png', 'image/jpeg', 'image/webp']
const MAX_BATCH_STEPS = 50
const MAX_WAIT_SECONDS = 30
// Enough for a menu or a field to be ready for the next step.
const BATCH_STEP_PAUSE_MS = 150
// These can work and leave the window looking as it did.
const SHOW_NOTHING: ReadonlySet<string> = new Set([
  'wait',
  'mouse_down',
  'mouse_up',
  'hold_key',
  'read_clipboard',
  'write_clipboard'
])

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
    const realInput = args.real_input === true
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
    const showLook = async (
      seen: ComputerLook,
      before = '',
      isZoom = false,
      // Asked for outright, which has to bring a picture: a model got none and took the app for blank.
      always = false
    ) => {
      // The model has this picture already, so sending it again would only be slower.
      const sendImage = options.vision && (always || seen.changed !== false)
      // Web-based apps often expose no controls, and then only the picture says what is there.
      const bounded = await outputs.apply(
        isZoom || seen.controls
          ? `${before}${seen.text}${options.vision && !sendImage && seen.images.length ? "\nThe picture is the same as your last one, so it wasn't sent again." : ''}`
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
          first && sendImage
            ? [
                {
                  type: 'image',
                  mimeType: first.mimeType as ToolResultImageMimeType,
                  name: app ? `${app} window` : 'Screen',
                  description: app ? `The ${app} window` : 'The whole screen',
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
    const acted = async (result: string, step: { realInput: boolean; mayShowNothing: boolean }) => {
      const seen = await service.lookAfterAction(chat, app, signal, step).catch((error) => {
        if (signal.aborted) throw error
        return null
      })
      if (!seen) return succeed(result)
      return showLook(seen, `${result}\n${seen.note ? `${seen.note}\n` : ''}`)
    }
    const held = (step: Record<string, unknown>): string[] =>
      Array.isArray(step.modifiers) ? step.modifiers.map(String) : []
    // Copying shows nothing, and waiting may well not, so neither is a sign of a step not landing.
    const mayShowNothing = (step: Record<string, unknown>): boolean =>
      SHOW_NOTHING.has(text(step, 'action')) || isCombination(step)
    const isCombination = (step: Record<string, unknown>): boolean =>
      text(step, 'action') === 'key' &&
      computerKeyCombination(
        text(step, 'key'),
        Array.isArray(step.modifiers) ? step.modifiers.map(String) : []
      ).modifiers.length > 0
    /** One action, with no look after it. Null for anything that isn't one. */
    const perform = async (
      step: Record<string, unknown>,
      real: boolean
    ): Promise<string | null> => {
      const name = text(step, 'action')
      const row = number(step, 'element')
      switch (name) {
        case 'click':
        case 'double_click':
        case 'triple_click':
        case 'middle_click':
        case 'right_click':
          return service.click(
            chat,
            app,
            {
              element: row,
              x: number(step, 'x'),
              y: number(step, 'y'),
              double: name === 'double_click',
              triple: name === 'triple_click',
              middle: name === 'middle_click',
              button: name === 'right_click' ? 'right' : 'left',
              fromZoom: step.from_zoom === true,
              modifiers: held(step)
            },
            signal,
            real,
            step.confirm_risky === true
          )
        case 'wait': {
          const seconds = Math.min(Math.max(number(step, 'seconds') ?? 2, 0.1), MAX_WAIT_SECONDS)
          await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
          signal.throwIfAborted()
          return `Waited ${seconds} seconds.`
        }
        case 'press_and_hold':
          return service.pressAndHold(
            chat,
            app,
            { element: row, x: number(step, 'x'), y: number(step, 'y') },
            number(step, 'seconds') ?? 1,
            signal
          )
        case 'mouse_down':
          return service.mouseDown(
            chat,
            app,
            {
              element: row,
              x: number(step, 'x'),
              y: number(step, 'y'),
              button: text(step, 'button') || undefined
            },
            signal,
            step.confirm_risky === true
          )
        case 'mouse_up':
          return service.mouseUp(
            chat,
            app,
            { element: row, x: number(step, 'x'), y: number(step, 'y') },
            signal,
            step.confirm_risky === true
          )
        case 'hold_key':
          return service.holdKey(chat, app, text(step, 'key'), number(step, 'seconds') ?? 1, signal)
        case 'read_clipboard':
          return service.readClipboard(chat, signal)
        case 'write_clipboard':
          return service.writeClipboard(chat, text(step, 'text'), step.keep === true, signal)
        case 'hover':
          return service.hover(
            chat,
            app,
            { element: row, x: number(step, 'x'), y: number(step, 'y') },
            signal
          )
        case 'drag':
          return service.drag(
            chat,
            app,
            {
              x: number(step, 'x'),
              y: number(step, 'y'),
              // Models reach for this name, since the other end is to_element.
              element: row ?? number(step, 'from_element')
            },
            {
              x: number(step, 'to_x'),
              y: number(step, 'to_y'),
              element: number(step, 'to_element')
            },
            signal,
            real,
            { seconds: number(step, 'seconds'), modifiers: held(step) }
          )
        case 'type':
          return service.type(chat, app, text(step, 'text'), row, signal, real)
        case 'set_value':
          if (row === undefined) throw new ComputerUseRefusal('set_value needs an element.')
          return service.setValue(chat, app, row, text(step, 'text'), signal)
        case 'key':
          return service.key(
            chat,
            app,
            text(step, 'key'),
            Array.isArray(step.modifiers) ? step.modifiers.map(String) : [],
            signal,
            real
          )
        case 'scroll':
          return service.scroll(
            chat,
            app,
            text(step, 'direction'),
            number(step, 'amount') ?? 3,
            { x: number(step, 'x'), y: number(step, 'y') },
            signal,
            real
          )
        default:
          return null
      }
    }
    /** Steps the model could already predict, for one turn of its time instead of one each. */
    const batch = async (
      steps: Array<Record<string, unknown>>,
      allReal = realInput,
      intro = ''
    ) => {
      const done: string[] = intro ? [intro] : []
      let anyReal = false
      let stopped = false
      for (const [index, step] of steps.entries()) {
        const real = step.real_input === true || allReal
        anyReal ||= real
        try {
          const result = await perform(step, real)
          if (result === null) {
            throw new ComputerUseRefusal(
              `${text(step, 'action') || '(none)'} can't be in a batch, only click, double_click, triple_click, middle_click, right_click, type, set_value, key, scroll, drag, hover, press_and_hold, mouse_down, mouse_up, hold_key, read_clipboard, write_clipboard and wait.`
            )
          }
          done.push(`${index + 1}. ${result}`)
        } catch (error) {
          // Nothing else is coming to finish a press, so it can't stay down.
          await service.letGo('a step before it failed')
          if (!(error instanceof ComputerUseRefusal)) throw error
          done.push(`${index + 1}. Not done: ${error.message}`)
          if (index + 1 < steps.length)
            done.push(`The other ${steps.length - index - 1} were not tried.`)
          stopped = true
          break
        }
        if (index + 1 < steps.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_STEP_PAUSE_MS))
        }
      }
      return acted(done.join('\n'), {
        realInput: anyReal,
        mayShowNothing: !stopped && mayShowNothing(steps[steps.length - 1])
      })
    }
    try {
      if (action === 'list_apps') return await succeed(await service.apps(signal))
      if (action === 'look_screen') {
        if (!options.vision) {
          throw new ComputerUseRefusal(
            'This model cannot see images, so it cannot use look_screen.'
          )
        }
        const shot = await service.lookAtScreen(chat, number(args, 'display') ?? 0, signal)
        return await showLook(shot, '', false, true)
      }
      // These aren't about any one app, and show nothing in one.
      if (action === 'read_clipboard' || action === 'write_clipboard') {
        return await succeed((await perform(args, realInput)) ?? '')
      }
      if (!app) {
        return toolExecutionFailed({
          title,
          code: 'invalid_arguments',
          message: 'Name the app. Use list_apps to see which are open.'
        })
      }
      switch (action) {
        case 'request_app': {
          const answer = await service.requestApp(chat, app, signal)
          // Every job goes on to look, and asking for it would take a turn of its own.
          const first = await service.look(chat, app, true, signal).catch((error) => {
            if (signal.aborted || !(error instanceof ComputerUseRefusal)) throw error
            return null
          })
          return first ? await showLook(first, `${answer}\n`, false, true) : await succeed(answer)
        }
        case 'look': {
          const find = text(args, 'find') || undefined
          return await showLook(
            await service.look(chat, app, true, signal, number(args, 'window'), find),
            '',
            false,
            true
          )
        }
        case 'zoom': {
          const [x, y, toX, toY] = ['x', 'y', 'to_x', 'to_y'].map((key) => number(args, key))
          if (x === undefined || y === undefined || toX === undefined || toY === undefined) {
            throw new ComputerUseRefusal('zoom needs x and y, and to_x and to_y.')
          }
          return await showLook(await service.zoom(chat, app, { x, y, toX, toY }, signal), '', true)
        }
        case 'batch': {
          const steps = Array.isArray(args.steps)
            ? (args.steps as Array<Record<string, unknown>>)
            : []
          if (!steps.length || steps.length > MAX_BATCH_STEPS) {
            throw new ComputerUseRefusal(`batch needs 1 to ${MAX_BATCH_STEPS} steps.`)
          }
          return await batch(steps)
        }
        case 'teach': {
          const steps = Array.isArray(args.steps)
            ? (args.steps as Array<Record<string, unknown>>)
            : []
          if (steps.length > MAX_BATCH_STEPS) {
            throw new ComputerUseRefusal(`teach can take up to ${MAX_BATCH_STEPS} steps.`)
          }
          const answer = await service.teach(
            chat,
            app,
            {
              text: text(args, 'text'),
              element: number(args, 'element'),
              x: number(args, 'x'),
              y: number(args, 'y'),
              nextDoes: steps.length
            },
            signal
          )
          if (answer === 'exit') {
            return await succeed(
              'The user ended the walkthrough, so nothing else was done. Do not show more steps.'
            )
          }
          // They are watching, and have just said to go on.
          return steps.length
            ? await batch(steps, true, 'The user pressed Next.')
            : await acted('The user pressed Next.', { realInput: true, mayShowNothing: true })
        }
        default: {
          const result = await perform(args, realInput)
          if (result === null) {
            return toolExecutionFailed({
              title,
              code: 'invalid_arguments',
              message: `Unknown action ${action || '(none)'}.`
            })
          }
          return await acted(result, { realInput, mayShowNothing: mayShowNothing(args) })
        }
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
