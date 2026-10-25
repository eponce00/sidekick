import { readArtifactTheme, type ArtifactTheme } from './artifactTheme'

/**
 * The only channel between a running artifact and the chat that shows it. Artifacts run in a
 * frame on the isolated artifact origin; the chat sends that frame the code and the theme, and the
 * frame answers with its content's height and whether the code ran. Each side reads the other's
 * messages through the readers below, which accept exactly these shapes and nothing more.
 */

export const ARTIFACT_ORIGIN = 'sidekick-artifact://app'
/** Runs React artifacts, with the bundled libraries. */
export const ARTIFACT_REACT_SANDBOX_URL = `${ARTIFACT_ORIGIN}/sandbox.html`
/** Runs HTML and SVG artifacts as a document of their own. */
export const ARTIFACT_HTML_SANDBOX_URL = `${ARTIFACT_ORIGIN}/html-sandbox.html`

/** Larger than any artifact a model writes; a bound on what one message may carry. */
export const MAX_ARTIFACT_CODE_LENGTH = 2_000_000
export const MAX_ARTIFACT_ERROR_LENGTH = 2_000
/** Taller than any frame is shown, so a runaway layout cannot ask for an absurd size. */
export const MAX_ARTIFACT_CONTENT_HEIGHT = 50_000

/** What a frame tells the chat. */
export type ArtifactFrameEvent =
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'success' }
  | { type: 'error'; error: string }
  /**
   * The pointer entered or left the frame. The chat cannot see the pointer inside a frame from
   * another origin, and shows the artifact's controls while it is there.
   */
  | { type: 'pointer'; inside: boolean }

/** What the chat tells a frame. */
export type ArtifactHostCommand =
  | { type: 'render'; code: string; theme: ArtifactTheme }
  /**
   * The code that has arrived so far, while the model is still writing it. A frame that gets a
   * draft shows as much of it as runs and reports only its height; the finished code runs in a
   * frame of its own.
   */
  | { type: 'draft'; code: string; theme: ArtifactTheme }
  | { type: 'theme'; theme: ArtifactTheme }

function record(data: unknown): Record<string, unknown> | null {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null
}

/** A frame's message as the chat may act on it, or null for anything else. */
export function readArtifactFrameEvent(data: unknown): ArtifactFrameEvent | null {
  const message = record(data)
  if (!message) return null
  switch (message.type) {
    case 'ready':
    case 'success':
      return { type: message.type }
    case 'resize': {
      const height = message.height
      if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return null
      return { type: 'resize', height: Math.min(MAX_ARTIFACT_CONTENT_HEIGHT, Math.ceil(height)) }
    }
    case 'pointer':
      return typeof message.inside === 'boolean'
        ? { type: 'pointer', inside: message.inside }
        : null
    case 'error': {
      const error =
        typeof message.error === 'string' && message.error.trim()
          ? message.error.trim()
          : 'The artifact reported an error'
      return { type: 'error', error: error.slice(0, MAX_ARTIFACT_ERROR_LENGTH) }
    }
    default:
      return null
  }
}

/** The chat's message as a frame may act on it, or null for anything else. */
export function readArtifactHostCommand(data: unknown): ArtifactHostCommand | null {
  const message = record(data)
  if (!message) return null
  const theme = readArtifactTheme(message.theme)
  if (!theme) return null
  if (message.type === 'theme') return { type: 'theme', theme }
  if (
    (message.type === 'render' || message.type === 'draft') &&
    typeof message.code === 'string' &&
    message.code.length <= MAX_ARTIFACT_CODE_LENGTH
  ) {
    return { type: message.type, code: message.code, theme }
  }
  return null
}
