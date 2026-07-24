import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOOL_CALL_LIMIT,
  MAX_TOOL_CALL_LIMIT,
  MIN_TOOL_CALL_LIMIT,
  normalizeToolCallLimit,
  resolveStoredToolCallLimit
} from './agentLimits'

describe('agent round limits', () => {
  it('normalizes the same range for direct and group agents', () => {
    expect(normalizeToolCallLimit(undefined)).toBe(DEFAULT_TOOL_CALL_LIMIT)
    expect(normalizeToolCallLimit(1)).toBe(MIN_TOOL_CALL_LIMIT)
    expect(normalizeToolCallLimit(10_000)).toBe(MAX_TOOL_CALL_LIMIT)
  })

  it('migrates former defaults without overriding an intentional current value', () => {
    expect(resolveStoredToolCallLimit(15, 1)).toBe(DEFAULT_TOOL_CALL_LIMIT)
    expect(resolveStoredToolCallLimit(15, 2)).toBe(15)
    expect(resolveStoredToolCallLimit(100, 2)).toBe(DEFAULT_TOOL_CALL_LIMIT)
    expect(resolveStoredToolCallLimit(100, 3)).toBe(100)
  })
})
