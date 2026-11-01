import { globalShortcut } from 'electron'
import { ComputerUseHighlight } from './computerUseHighlight'

/** One set of overlays for whatever is driving, computer use or Chrome: there's one screen and one Esc. */
export const computerOverlay = new ComputerUseHighlight()

const stops = new Set<() => void>()

/** While any of these is armed, Esc anywhere stops all of them. Returns how to take this one back. */
export function armEscape(stop: () => void): () => void {
  if (!stops.size) {
    globalShortcut.register('Escape', () => {
      for (const each of [...stops]) each()
    })
  }
  stops.add(stop)
  return () => {
    stops.delete(stop)
    if (!stops.size) globalShortcut.unregister('Escape')
  }
}
