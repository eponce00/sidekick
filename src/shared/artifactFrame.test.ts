import { describe, expect, it } from 'vitest'
import {
  MAX_ARTIFACT_CODE_LENGTH,
  MAX_ARTIFACT_CONTENT_HEIGHT,
  MAX_ARTIFACT_ERROR_LENGTH,
  readArtifactFrameEvent,
  readArtifactHostCommand
} from './artifactFrame'
import { getArtifactFallbackTheme } from './artifactTheme'

describe('what the chat accepts from an artifact frame', () => {
  it('reads the four events the frame may send', () => {
    expect(readArtifactFrameEvent({ type: 'ready' })).toEqual({ type: 'ready' })
    expect(readArtifactFrameEvent({ type: 'success' })).toEqual({ type: 'success' })
    expect(readArtifactFrameEvent({ type: 'resize', height: 341.2 })).toEqual({
      type: 'resize',
      height: 342
    })
    expect(readArtifactFrameEvent({ type: 'error', error: '  Boom  ' })).toEqual({
      type: 'error',
      error: 'Boom'
    })
  })

  it('reads whether the pointer is inside, and nothing that is not a yes or no', () => {
    expect(readArtifactFrameEvent({ type: 'pointer', inside: true })).toEqual({
      type: 'pointer',
      inside: true
    })
    expect(readArtifactFrameEvent({ type: 'pointer', inside: 'yes' })).toBeNull()
  })

  it('drops extra fields instead of passing them on', () => {
    expect(readArtifactFrameEvent({ type: 'ready', code: 'x', theme: {} })).toEqual({
      type: 'ready'
    })
  })

  it('bounds a height no frame could need and refuses one that is not a size', () => {
    expect(readArtifactFrameEvent({ type: 'resize', height: 1e9 })).toEqual({
      type: 'resize',
      height: MAX_ARTIFACT_CONTENT_HEIGHT
    })
    for (const height of [Number.NaN, Number.POSITIVE_INFINITY, -1, '400', null, undefined]) {
      expect(readArtifactFrameEvent({ type: 'resize', height })).toBeNull()
    }
  })

  it('bounds an error message and names one that says nothing', () => {
    const long = readArtifactFrameEvent({ type: 'error', error: 'x'.repeat(10_000) })
    expect(long?.type === 'error' && long.error.length).toBe(MAX_ARTIFACT_ERROR_LENGTH)
    expect(readArtifactFrameEvent({ type: 'error', error: { toString: () => 'hi' } })).toEqual({
      type: 'error',
      error: 'The artifact reported an error'
    })
  })

  it('ignores anything else', () => {
    for (const data of [
      null,
      'ready',
      42,
      [],
      ['ready'],
      { type: 'render' },
      { type: 'navigate' }
    ]) {
      expect(readArtifactFrameEvent(data)).toBeNull()
    }
  })
})

describe('what an artifact frame accepts from the chat', () => {
  const theme = getArtifactFallbackTheme('light')

  it('reads a render with its code and theme, and a theme change', () => {
    expect(readArtifactHostCommand({ type: 'render', code: 'function App() {}', theme })).toEqual({
      type: 'render',
      code: 'function App() {}',
      theme
    })
    expect(readArtifactHostCommand({ type: 'theme', theme })).toEqual({ type: 'theme', theme })
  })

  it('refuses a command without a theme it can read', () => {
    expect(readArtifactHostCommand({ type: 'theme' })).toBeNull()
    expect(readArtifactHostCommand({ type: 'theme', theme: { themeMode: 'sepia' } })).toBeNull()
    expect(readArtifactHostCommand({ type: 'render', code: 'x', theme: 'dark' })).toBeNull()
  })

  it('refuses code that is not text or is larger than any artifact', () => {
    expect(readArtifactHostCommand({ type: 'render', code: 42, theme })).toBeNull()
    expect(
      readArtifactHostCommand({
        type: 'render',
        code: 'x'.repeat(MAX_ARTIFACT_CODE_LENGTH + 1),
        theme
      })
    ).toBeNull()
  })

  it('ignores commands it does not know', () => {
    expect(readArtifactHostCommand({ type: 'eval', code: 'x', theme })).toBeNull()
    expect(readArtifactHostCommand(null)).toBeNull()
  })
})
