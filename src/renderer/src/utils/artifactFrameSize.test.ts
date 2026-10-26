import { describe, expect, it } from 'vitest'
import {
  boundedArtifactFrameHeight,
  MAX_ARTIFACT_FRAME_HEIGHT,
  PENDING_ARTIFACT_FRAME_HEIGHT,
  rememberArtifactHeight,
  rememberedArtifactHeight
} from './artifactFrameSize'

describe('artifact frame sizing', () => {
  it('is as tall as the content, however small, up to the limit', () => {
    expect(boundedArtifactFrameHeight(24)).toBe(24)
    expect(boundedArtifactFrameHeight(342.2)).toBe(343)
    expect(boundedArtifactFrameHeight(80_000)).toBe(MAX_ARTIFACT_FRAME_HEIGHT)
    expect(boundedArtifactFrameHeight(2_000, 2_400)).toBe(2_000)
  })

  it('holds the pending line for a measurement that is not a size', () => {
    expect(boundedArtifactFrameHeight(Number.NaN)).toBe(PENDING_ARTIFACT_FRAME_HEIGHT)
    expect(boundedArtifactFrameHeight(Number.POSITIVE_INFINITY)).toBe(PENDING_ARTIFACT_FRAME_HEIGHT)
    expect(boundedArtifactFrameHeight(-5)).toBe(PENDING_ARTIFACT_FRAME_HEIGHT)
  })

  it('remembers the height each artifact rendered at, by its code', () => {
    rememberArtifactHeight('react', 'function App() { return 1 }', 420)
    expect(rememberedArtifactHeight('react', 'function App() { return 1 }')).toBe(420)
    expect(rememberedArtifactHeight('react', 'function App() { return 2 }')).toBeNull()
    expect(rememberedArtifactHeight('html', 'function App() { return 1 }')).toBeNull()
  })
})
