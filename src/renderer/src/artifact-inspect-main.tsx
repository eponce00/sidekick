import { createRoot } from 'react-dom/client'
import Artifact from './components/artifacts/Artifact'
import {
  ARTIFACT_INSPECTION_MAX_ERRORS,
  ARTIFACT_INSPECTION_SETTLE_MS,
  ARTIFACT_INSPECTION_TIMEOUT_MS,
  ARTIFACT_INSPECTION_WIDTH,
  type ArtifactInspectionRequest,
  type ArtifactInspectionResult
} from '../../shared/artifactInspection'
import './styles/App.css'

// Renders one artifact with the chat's own components for the main process to
// photograph. It never talks to the preload API; its only output is the
// promise below, read back by the inspecting window.

const container = document.getElementById('root')!
container.style.width = `${ARTIFACT_INSPECTION_WIDTH}px`
container.style.padding = '0'
document.body.style.margin = '0'
document.body.style.background = 'var(--app-bg)'
const root = createRoot(container)

window.__sidekickInspectArtifact = (request: ArtifactInspectionRequest) =>
  new Promise<ArtifactInspectionResult>((resolve) => {
    document.body.dataset.theme = request.mode
    const errors: string[] = []
    let finished = false
    let settleTimer: number | undefined

    const finish = (status: ArtifactInspectionResult['status']): void => {
      if (finished) return
      finished = true
      window.clearTimeout(settleTimer)
      window.clearTimeout(deadline)
      // A short pause so an error banner or late layout is in place before
      // capture. Not requestAnimationFrame: an unshown window may never fire it.
      window.setTimeout(
        () =>
          resolve({
            status,
            errors: errors.slice(0, ARTIFACT_INSPECTION_MAX_ERRORS),
            width: ARTIFACT_INSPECTION_WIDTH,
            // The artifact's own extent, not the page's, which is at least as
            // tall as the viewport and would pad the capture with empty space.
            height: Math.ceil(
              (container.firstElementChild ?? container).getBoundingClientRect().bottom
            )
          }),
        60
      )
    }

    const deadline = window.setTimeout(() => finish('timeout'), ARTIFACT_INSPECTION_TIMEOUT_MS)

    root.render(
      <Artifact
        artifact={{ type: request.type, title: request.title, code: request.code }}
        onResult={(result) => {
          if (result.success) {
            // Success is reported as soon as the component mounts; the data it
            // fetches and a late runtime error can still arrive after that.
            if (settleTimer === undefined) {
              settleTimer = window.setTimeout(
                () => finish(errors.length ? 'error' : 'rendered'),
                ARTIFACT_INSPECTION_SETTLE_MS
              )
            }
            return
          }
          const message = result.error?.trim() || 'The artifact reported an error'
          if (!errors.includes(message)) errors.push(message)
          window.clearTimeout(settleTimer)
          settleTimer = window.setTimeout(() => finish('error'), 300)
        }}
      />
    )
  })
