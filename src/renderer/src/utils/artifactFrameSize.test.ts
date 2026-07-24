import { describe, expect, it } from 'vitest'
import {
  boundedArtifactFrameHeight,
  DEFAULT_ARTIFACT_FRAME_HEIGHT,
  MAX_ARTIFACT_FRAME_HEIGHT,
  MIN_ARTIFACT_FRAME_HEIGHT
} from './artifactFrameSize'

describe('artifact preview frame sizing', () => {
  it('keeps auto-sized previews within a finite, scrollable viewport', () => {
    expect(boundedArtifactFrameHeight(96)).toBe(MIN_ARTIFACT_FRAME_HEIGHT)
    expect(boundedArtifactFrameHeight(342.2)).toBe(343)
    expect(boundedArtifactFrameHeight(80_000)).toBe(MAX_ARTIFACT_FRAME_HEIGHT)
  })

  it('falls back safely when a sandbox reports an invalid measurement', () => {
    expect(boundedArtifactFrameHeight(Number.NaN)).toBe(DEFAULT_ARTIFACT_FRAME_HEIGHT)
    expect(boundedArtifactFrameHeight(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ARTIFACT_FRAME_HEIGHT)
  })
})
