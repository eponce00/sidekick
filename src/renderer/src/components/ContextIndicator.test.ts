import { describe, expect, it } from 'vitest'
import { resolveContextDisplay } from '../utils/contextDisplay'

describe('context indicator metadata reliability', () => {
  it('never presents the runtime safety fallback as a model maximum', () => {
    expect(resolveContextDisplay('litellm:gateway/model', undefined, null, 32_768)).toEqual({
      contextWindow: 32_768,
      reliable: false
    })
    expect(
      resolveContextDisplay(
        'litellm:gateway/model',
        undefined,
        { value: 32_768, reliable: false },
        32_768
      )
    ).toEqual({ contextWindow: 32_768, reliable: false })
  })

  it('shows configured and provider-reported context limits as reliable', () => {
    expect(resolveContextDisplay('litellm:gateway/model', 131_072, null, 32_768)).toEqual({
      contextWindow: 131_072,
      reliable: true
    })
    expect(
      resolveContextDisplay(
        'litellm:gateway/model',
        undefined,
        { value: 200_000, reliable: true },
        32_768
      )
    ).toEqual({ contextWindow: 200_000, reliable: true })
  })
})
