import { describe, expect, it } from 'vitest'
import { normalizeCompletedToolInput, readIncompleteToolInputError } from './toolCalls'

describe('tool call input recovery', () => {
  it('preserves complete JSON object input', () => {
    expect(normalizeCompletedToolInput('{"path":"src/app.ts"}')).toEqual({
      arguments: '{"path":"src/app.ts"}',
      recovered: false
    })
  })

  it('replaces truncated and non-object input with a non-executable marker', () => {
    for (const input of ['{"content":"partial', '"not an object"', ['invalid']]) {
      const result = normalizeCompletedToolInput(input)
      expect(result.recovered).toBe(true)
      expect(readIncompleteToolInputError(result.arguments)).toContain('tool was not executed')
    }
  })
})
