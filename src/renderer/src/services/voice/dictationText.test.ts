import { describe, expect, it } from 'vitest'
import { applyDictation, insertDictation } from './dictationText'

describe('insertDictation', () => {
  it('spaces dictated words from the text around the caret', () => {
    expect(insertDictation('Hello', 5, 5, 'world.')).toEqual({ value: 'Hello world.', caret: 12 })
    expect(insertDictation('Say  now', 4, 4, 'it')).toEqual({ value: 'Say it now', caret: 6 })
    expect(insertDictation('', 0, 0, 'Hi.')).toEqual({ value: 'Hi.', caret: 3 })
  })

  it('replaces a selection', () => {
    expect(insertDictation('one two three', 4, 7, '2')).toEqual({
      value: 'one 2 three',
      caret: 5
    })
  })
})

describe('applyDictation', () => {
  it('replaces the draft of a phrase as it grows, then keeps the final text', () => {
    let value = 'Note:'
    let range = { start: 5, end: 5 }
    for (const [text, final] of [
      ['the build', false],
      ['the build passed', false],
      ['The build passed.', true]
    ] as const) {
      const next = applyDictation(value, range, text, final)
      value = next.value
      range = next.range
    }
    expect(value).toBe('Note: The build passed.')
    expect(range).toEqual({ start: 23, end: 23 })
    // The next phrase starts after it.
    expect(applyDictation(value, range, 'Ship it.', true).value).toBe(
      'Note: The build passed. Ship it.'
    )
  })

  it('removes a draft whose phrase turned out empty', () => {
    const drafted = applyDictation('Hi', { start: 2, end: 2 }, 'um', false)
    expect(drafted.value).toBe('Hi um')
    expect(applyDictation(drafted.value, drafted.range, '', true)).toEqual({
      value: 'Hi',
      range: { start: 2, end: 2 },
      caret: 2
    })
  })
})
