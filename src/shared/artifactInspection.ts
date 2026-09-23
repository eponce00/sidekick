/**
 * Contract between the main process and the artifact inspection page.
 *
 * The page renders an artifact with the same components the chat uses, so a
 * model reviewing its own artifact sees what the user sees rather than a
 * separate approximation of it.
 */

export type InspectedArtifactType = 'react' | 'html' | 'svg'

export interface ArtifactInspectionRequest {
  type: InspectedArtifactType
  title: string
  code: string
  mode: 'dark' | 'light'
}

export interface ArtifactInspectionResult {
  /** `rendered` means the artifact reported success and stayed error-free while it settled. */
  status: 'rendered' | 'error' | 'timeout'
  errors: string[]
  width: number
  height: number
}

/** Close to the chat column, so layout decisions match what the user sees. */
export const ARTIFACT_INSPECTION_WIDTH = 720
/** Time after a successful render for data requests and animations to land. */
export const ARTIFACT_INSPECTION_SETTLE_MS = 1_800
/** Longest an inspection may wait for the artifact to report anything. */
export const ARTIFACT_INSPECTION_TIMEOUT_MS = 20_000
export const ARTIFACT_INSPECTION_MAX_ERRORS = 5

export const ARTIFACT_INSPECTION_PAGE = 'sidekick-artifact://app/artifact-inspect.html'

declare global {
  interface Window {
    __sidekickInspectArtifact?: (
      request: ArtifactInspectionRequest
    ) => Promise<ArtifactInspectionResult>
  }
}
