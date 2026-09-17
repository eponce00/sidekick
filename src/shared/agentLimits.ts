export const DEFAULT_TOOL_CALL_LIMIT = 80
export const MIN_TOOL_CALL_LIMIT = 10
export const MAX_TOOL_CALL_LIMIT = 400
export const TOOL_CALL_LIMIT_POLICY_VERSION = 4

export function normalizeToolCallLimit(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN

  if (!Number.isFinite(parsed)) return DEFAULT_TOOL_CALL_LIMIT
  return Math.min(MAX_TOOL_CALL_LIMIT, Math.max(MIN_TOOL_CALL_LIMIT, Math.round(parsed)))
}

export function resolveStoredToolCallLimit(value: unknown, policyVersion: unknown): number {
  const version = typeof policyVersion === 'number' ? policyVersion : 1
  if (version < 2 && value === 15) return DEFAULT_TOOL_CALL_LIMIT
  if (version < 3 && value === 100) return DEFAULT_TOOL_CALL_LIMIT
  if (version < TOOL_CALL_LIMIT_POLICY_VERSION && value === 1000) return DEFAULT_TOOL_CALL_LIMIT
  return normalizeToolCallLimit(value)
}
