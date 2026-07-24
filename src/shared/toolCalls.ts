export const INCOMPLETE_TOOL_INPUT_KEY = '__sidekick_incomplete_tool_input'

export const INCOMPLETE_TOOL_INPUT_MESSAGE =
  'The provider ended this tool call before its JSON input was complete. The tool was not executed. Retry with a smaller, focused tool call.'

export function looksLikeIncompleteToolInputError(error: string): boolean {
  return /unterminated|string starting at|unexpected end|invalid json|json.*(?:decode|parse|syntax)|(?:decode|parse).*json|tool[_ -]?(?:call|input|arguments?).*(?:invalid|incomplete|parse)/i.test(
    error
  )
}

export function incompleteToolInputArguments(): Record<string, string> {
  return { [INCOMPLETE_TOOL_INPUT_KEY]: INCOMPLETE_TOOL_INPUT_MESSAGE }
}

export function normalizeCompletedToolInput(argumentsValue: unknown): {
  arguments: Record<string, unknown> | string
  recovered: boolean
} {
  if (argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
    return { arguments: argumentsValue as Record<string, unknown>, recovered: false }
  }
  if (typeof argumentsValue === 'string') {
    if (!argumentsValue.trim()) return { arguments: {}, recovered: false }
    try {
      const parsed = JSON.parse(argumentsValue) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { arguments: argumentsValue, recovered: false }
      }
    } catch {
      // Fall through to the safe recovery marker.
    }
  }
  return { arguments: incompleteToolInputArguments(), recovered: true }
}

export function readIncompleteToolInputError(argumentsValue: unknown): string | null {
  let parsed = argumentsValue
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const message = (parsed as Record<string, unknown>)[INCOMPLETE_TOOL_INPUT_KEY]
  return typeof message === 'string' && message.trim() ? message : null
}
