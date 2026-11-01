import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOOL_CALL_LIMIT,
  MAX_TOOL_CALL_LIMIT,
  MIN_TOOL_CALL_LIMIT,
  normalizeToolCallLimit,
  resolveStoredToolCallLimit
} from './agentLimits'

describe('agent round limits', () => {
  it('normalizes the tool round range', () => {
    expect(normalizeToolCallLimit(undefined)).toBe(DEFAULT_TOOL_CALL_LIMIT)
    expect(normalizeToolCallLimit(1)).toBe(MIN_TOOL_CALL_LIMIT)
    expect(normalizeToolCallLimit(10_000)).toBe(MAX_TOOL_CALL_LIMIT)
  })

  it('migrates former defaults without overriding an intentional current value', () => {
    expect(resolveStoredToolCallLimit(15, 1)).toBe(DEFAULT_TOOL_CALL_LIMIT)
    expect(resolveStoredToolCallLimit(15, 2)).toBe(15)
    expect(resolveStoredToolCallLimit(100, 2)).toBe(DEFAULT_TOOL_CALL_LIMIT)
    expect(resolveStoredToolCallLimit(100, 3)).toBe(100)
    expect(resolveStoredToolCallLimit(1000, 3)).toBe(DEFAULT_TOOL_CALL_LIMIT)
    // The old default of 80 moves to the new one; a value the user chose stays.
    expect(resolveStoredToolCallLimit(80, 4)).toBe(DEFAULT_TOOL_CALL_LIMIT)
    expect(resolveStoredToolCallLimit(80, 5)).toBe(80)
    expect(resolveStoredToolCallLimit(240, 4)).toBe(240)
    expect(normalizeToolCallLimit(1_500)).toBe(1_500)
  })
})
