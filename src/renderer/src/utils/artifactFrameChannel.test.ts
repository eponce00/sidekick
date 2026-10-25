// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getArtifactFallbackTheme } from '../../../shared/artifactTheme'
import { listenToHost, measureContentHeight } from './artifactFrameChannel'

describe('the frame side of the artifact channel', () => {
  afterEach(() => vi.restoreAllMocks())

  it('takes commands only from the window that embeds the frame, and only valid ones', () => {
    const onCommand = vi.fn()
    const stop = listenToHost(onCommand)
    const theme = getArtifactFallbackTheme('dark')
    const other = document.createElement('iframe')
    document.body.appendChild(other)

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'render', code: 'x', theme },
        source: other.contentWindow
      })
    )
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'eval', code: 'x', theme }, source: window })
    )
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'theme', theme }, source: window.parent })
    )
    stop()
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'theme', theme }, source: window.parent })
    )

    expect(onCommand).toHaveBeenCalledTimes(1)
    expect(onCommand).toHaveBeenCalledWith({ type: 'theme', theme })
    other.remove()
  })

  it('measures the content, not the frame, so a frame can shrink with it', () => {
    vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue({
      height: 180.4
    } as DOMRect)
    vi.spyOn(document.body, 'scrollHeight', 'get').mockReturnValue(120)
    expect(measureContentHeight(document)).toBe(181)

    vi.spyOn(document.body, 'scrollHeight', 'get').mockReturnValue(260)
    expect(measureContentHeight(document)).toBe(260)
  })
})
