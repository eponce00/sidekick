export const DEFAULT_ARTIFACT_FRAME_HEIGHT = 280
export const MIN_ARTIFACT_FRAME_HEIGHT = 160
export const MAX_ARTIFACT_FRAME_HEIGHT = 560

export function boundedArtifactFrameHeight(
  reportedHeight: number,
  maxHeight = MAX_ARTIFACT_FRAME_HEIGHT
): number {
  if (!Number.isFinite(reportedHeight)) return DEFAULT_ARTIFACT_FRAME_HEIGHT
  return Math.min(maxHeight, Math.max(MIN_ARTIFACT_FRAME_HEIGHT, Math.ceil(reportedHeight)))
}
