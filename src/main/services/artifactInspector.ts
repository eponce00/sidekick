import { BrowserWindow, nativeTheme } from 'electron'
import {
  ARTIFACT_INSPECTION_PAGE,
  ARTIFACT_INSPECTION_TIMEOUT_MS,
  ARTIFACT_INSPECTION_WIDTH,
  type ArtifactInspectionRequest,
  type ArtifactInspectionResult,
  type InspectedArtifactType
} from '../../shared/artifactInspection'

/** Tall enough for a full card or dashboard, short enough to stay legible to a vision model. */
const MAX_CAPTURE_HEIGHT = 1_600
const MIN_CAPTURE_HEIGHT = 120
const PAGE_LOAD_TIMEOUT_MS = 15_000
/** Margin over the page's own deadline for loading and capture. */
const INSPECTION_BUDGET_MS = ARTIFACT_INSPECTION_TIMEOUT_MS + 10_000

export interface ArtifactInspection extends ArtifactInspectionResult {
  image?: { mimeType: 'image/jpeg'; base64: string; width: number; height: number }
}

export interface ArtifactInspectorLike {
  inspect(
    artifact: { type: InspectedArtifactType; title: string; code: string },
    signal?: AbortSignal
  ): Promise<ArtifactInspection>
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/**
 * Renders an artifact off screen, the way the visual browser observes a page,
 * so the model that made it can see whether it works and what it looks like.
 *
 * The page it loads renders the artifact with the chat's own components. The
 * window is never shown, cannot open windows or navigate, and is destroyed
 * after one capture.
 */
export class ArtifactInspector implements ArtifactInspectorLike {
  async inspect(
    artifact: { type: InspectedArtifactType; title: string; code: string },
    signal?: AbortSignal
  ): Promise<ArtifactInspection> {
    signal?.throwIfAborted()
    const window = new BrowserWindow({
      show: false,
      width: ARTIFACT_INSPECTION_WIDTH,
      height: 900,
      useContentSize: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // An unshown ordinary window neither paints nor runs animation frames,
        // so neither the artifact nor a capture would ever complete. Offscreen
        // rendering paints into a buffer without ever showing anything.
        offscreen: true,
        backgroundThrottling: false
      }
    })
    window.webContents.setFrameRate(30)
    const abort = (): void => {
      if (!window.isDestroyed()) window.destroy()
    }
    signal?.addEventListener('abort', abort, { once: true })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    try {
      return await withTimeout(
        this.run(window, artifact),
        INSPECTION_BUDGET_MS,
        'Artifact inspection timed out'
      )
    } finally {
      signal?.removeEventListener('abort', abort)
      abort()
    }
  }

  private async run(
    window: BrowserWindow,
    artifact: { type: InspectedArtifactType; title: string; code: string }
  ): Promise<ArtifactInspection> {
    await withTimeout(
      window.loadURL(ARTIFACT_INSPECTION_PAGE),
      PAGE_LOAD_TIMEOUT_MS,
      'The artifact inspection page did not load'
    )
    const request: ArtifactInspectionRequest = { ...artifact, mode: await themeMode() }
    const result = (await window.webContents.executeJavaScript(
      `window.__sidekickInspectArtifact(${JSON.stringify(request)})`,
      true
    )) as ArtifactInspectionResult
    const height = Math.max(
      MIN_CAPTURE_HEIGHT,
      Math.min(MAX_CAPTURE_HEIGHT, Math.ceil(result.height || 0))
    )
    const image = await this.capture(window, height).catch((error) => {
      console.warn('[ArtifactInspector] Capture failed:', error)
      return undefined
    })
    return { ...result, ...(image ? { image } : {}) }
  }

  private async capture(
    window: BrowserWindow,
    height: number
  ): Promise<ArtifactInspection['image']> {
    // Size the viewport to the artifact, then give it a moment to lay out and
    // paint at that size before taking the frame.
    window.setContentSize(ARTIFACT_INSPECTION_WIDTH, height)
    await new Promise((resolve) => setTimeout(resolve, 250))
    let image = await window.webContents.capturePage()
    if (image.isEmpty()) throw new Error('The artifact capture was empty')
    // Offscreen frames can come back at device pixels; the model gets CSS pixels.
    if (image.getSize().width !== ARTIFACT_INSPECTION_WIDTH) {
      image = image.resize({ width: ARTIFACT_INSPECTION_WIDTH, quality: 'good' })
    }
    const size = image.getSize()
    return {
      mimeType: 'image/jpeg',
      base64: image.toJPEG(82).toString('base64'),
      width: size.width,
      height: size.height
    }
  }
}

/** The user's current theme, read from the app window that shows the chat. */
async function themeMode(): Promise<'dark' | 'light'> {
  const devRendererUrl = process.env['ELECTRON_RENDERER_URL']
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    // Only the app's own window; never script a page the visual browser opened.
    const url = window.webContents.getURL()
    if (!url.startsWith('file:') && !(devRendererUrl && url.startsWith(devRendererUrl))) continue
    const mode = await withTimeout(
      window.webContents.executeJavaScript('document.body?.dataset.theme ?? null', true),
      1_000,
      'Theme lookup timed out'
    ).catch(() => null)
    if (mode === 'light' || mode === 'dark') return mode
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}
