import { useEffect, useRef } from 'react'

/**
 * The phone's back gesture, as the ChatGPT and Claude apps treat it: it closes an open sheet or
 * the chat drawer first, then returns to the chat open before, and finally to the new-chat home.
 * Every chat shown and every sheet or drawer opened is a browser history entry, so the system's
 * own back button and gesture walk through them.
 */

const MARK = 'sidekickPhone'

export interface ShownChat {
  /** Null for the new-chat home, until its first message creates the chat. */
  id: string | null
  title: string
}

export interface NavEntry {
  /** Which chat entry this is; sheets and the drawer opened over it share its number. */
  nav: number
  chat: ShownChat
  /** How many sheets or drawers are open over the chat at this entry. */
  layer: number
}

export const HOME: ShownChat = { id: null, title: '' }

export function entryState(entry: NavEntry): Record<string, unknown> {
  return { [MARK]: entry }
}

/** The entry a history state describes, or null for one this page did not write. */
export function readEntry(state: unknown): NavEntry | null {
  if (!state || typeof state !== 'object') return null
  const entry = (state as Record<string, unknown>)[MARK]
  if (!entry || typeof entry !== 'object') return null
  const { nav, chat, layer } = entry as Partial<NavEntry>
  if (typeof nav !== 'number' || typeof layer !== 'number' || !chat || typeof chat !== 'object')
    return null
  const id = typeof chat.id === 'string' ? chat.id : null
  const title = typeof chat.title === 'string' ? chat.title : ''
  return { nav, chat: { id, title }, layer }
}

interface Layer {
  depth: number
  close: () => void
}

/** The layers that stay open, and those to close, once history lands at a depth. */
export function splitLayers<T extends { depth: number }>(
  open: readonly T[],
  landed: number
): { kept: T[]; closed: T[] } {
  return {
    kept: open.filter((layer) => layer.depth <= landed),
    // Topmost first, as they close.
    closed: open.filter((layer) => layer.depth > landed).reverse()
  }
}

let layers: Layer[] = []

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (event) => {
    const { kept, closed } = splitLayers(layers, readEntry(event.state)?.layer ?? 0)
    layers = kept
    for (const layer of closed) layer.close()
  })
}

/**
 * Closes every open sheet and drawer without going back, for when the entry under them is about
 * to be replaced, as when a chat is picked in the drawer.
 */
export function releaseLayers(): void {
  const closed = [...layers].reverse()
  layers = []
  for (const layer of closed) layer.close()
}

/**
 * Gives an open sheet or drawer a history entry, so back closes it. Closing it from the page takes
 * its entry away again.
 */
export function useBackLayer(open: boolean, onClose: () => void): void {
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    if (!open) return
    const below = readEntry(history.state) ?? { nav: 0, chat: HOME, layer: 0 }
    const layer: Layer = { depth: layers.length + 1, close: () => close.current() }
    layers.push(layer)
    history.pushState(entryState({ ...below, layer: layer.depth }), '')
    return () => {
      // Gone already when back closed it or a chat replaced its entry.
      if (!layers.includes(layer)) return
      layers = layers.filter((candidate) => candidate !== layer)
      if (readEntry(history.state)?.layer === layer.depth) history.back()
    }
  }, [open])
}
