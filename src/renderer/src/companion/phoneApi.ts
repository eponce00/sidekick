import type { AgentRunChangedEvent } from '../../../shared/agentRunApi'
import type { CompanionEvent } from '../../../shared/companion'
import type { CompanionConnection } from './chatState'
import { createPhoneVoice, dispatchVoiceEvent } from './phoneVoice'

/**
 * The phone shows chats with the desktop's own components, which reach the computer through
 * `window.api`. This is that API for the phone: the parts those components call, backed by the
 * encrypted connection. What needs the computer's files or windows says so instead of acting.
 */

export const COMPUTER_ONLY = 'Open this on the computer to use it.'

let bound: CompanionConnection | null = null
let showNotice: (text: string) => void = () => undefined
const runListeners = new Set<(change: AgentRunChangedEvent) => void>()
const imageCache = new Map<string, Promise<string | null>>()

/** Points the API at the computer the phone follows, and at where its notices show. */
export function bindPhoneApi(
  connection: CompanionConnection | null,
  notice: (text: string) => void = () => undefined
): void {
  bound = connection
  showNotice = notice
  imageCache.clear()
}

/** Shows a short notice, such as where to do something the phone cannot. */
export function phoneNotice(text: string): void {
  showNotice(text)
}

function connection(): CompanionConnection {
  if (!bound) throw new Error('The computer is not connected.')
  return bound
}

/** Passes an event from the computer to the components listening for it. */
export function dispatchToPhoneApi(event: CompanionEvent): void {
  if (event.type === 'run.event') {
    for (const listener of runListeners) listener({ event: event.event })
  } else dispatchVoiceEvent(event)
}

/**
 * Copies text. The page is plain HTTP, where browsers withhold the clipboard API, but a selected
 * text field still copies.
 */
export async function copyOnPhone(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* Falls back to the text field. */
  }
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.append(field)
  field.select()
  field.setSelectionRange(0, text.length)
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  field.remove()
  return copied
}

/**
 * An image the chat shows, as an address this page may load: its own data, a file this page
 * serves, or a capture the computer keeps, fetched once. Anything on the network is not shown.
 */
export function resolvePhoneImage(src: string): Promise<string | null> {
  if (src.startsWith('data:image/')) return Promise.resolve(src)
  if (src.startsWith('sidekick-browser://artifact/')) {
    let pending = imageCache.get(src)
    if (!pending) {
      pending = connection()
        .call('media.get', { url: src })
        .then(({ dataUrl }) => (dataUrl.startsWith('data:image/') ? dataUrl : null))
        .catch(() => {
          // A failure may be the connection; the next look tries again.
          imageCache.delete(src)
          return null
        })
      imageCache.set(src, pending)
    }
    return pending
  }
  try {
    if (new URL(src, location.href).origin === location.origin) return Promise.resolve(src)
  } catch {
    /* Not an address. */
  }
  return Promise.resolve(null)
}

const refuse = (): Promise<never> => Promise.reject(new Error(COMPUTER_ONLY))
const onComputer = async (): Promise<void> => phoneNotice(COMPUTER_ONLY)

/** The parts of the desktop API the chat's components call. */
export function createPhoneApi() {
  return {
    agentRuns: {
      events: async (runId: string, afterSequence = 0) => {
        const page = await connection().call('run.events', { runId, afterSequence })
        return { run: page.run, events: page.events, pendingInteractions: [] }
      },
      onEvent: (callback: (change: AgentRunChangedEvent) => void) => {
        runListeners.add(callback)
        return () => {
          runListeners.delete(callback)
        }
      },
      stop: (runId: string) => connection().call('run.stop', { runId }),
      resolveInteraction: async (input: {
        interactionId: string
        response: Record<string, unknown>
        cancelled?: boolean
      }) => {
        await connection().call('interaction.resolve', {
          interactionId: input.interactionId,
          response: input.response,
          ...(input.cancelled ? { cancelled: true } : {})
        })
        return { success: true }
      },
      beginBrowserHumanTakeover: refuse,
      completeBrowserHumanTakeover: refuse
    },
    // Chats an agent suggests are started where their folders are.
    sessions: {
      proposals: async () => [],
      onChanged: () => () => undefined,
      startProposal: refuse,
      dismissProposal: refuse
    },
    clipboard: {
      writeText: async (text: string) =>
        (await copyOnPhone(text))
          ? { success: true }
          : { success: false, error: 'This phone did not allow copying.' }
    },
    workspace: {
      openFile: onComputer,
      openFolder: onComputer,
      openFileReference: async () => ({ ok: false, error: COMPUTER_ONLY }),
      resolveFileReference: async () => ({ ok: false, matches: [] }),
      showPathMenu: async () => undefined
    },
    // Site icons come from the sites themselves, which this page may not load.
    siteIcons: { get: async () => ({ dataUrl: null }) },
    voice: createPhoneVoice(() => bound)
  }
}

/** Gives the desktop's components their API on the phone. */
export function installPhoneApi(): void {
  window.api = createPhoneApi() as unknown as Window['api']
}
