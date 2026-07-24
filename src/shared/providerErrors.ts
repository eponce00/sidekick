export interface ProviderContextWindowErrorDetails {
  contextLength?: number
  requestedOutputTokens?: number
  inputTokens?: number
}

function numericMatch(message: string, pattern: RegExp): number | undefined {
  const raw = message.match(pattern)?.[1]?.replaceAll(',', '')
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Recognizes context-limit failures across OpenAI-compatible, LiteLLM, Anthropic, and Ollama. */
export function providerContextWindowError(
  message: string | null | undefined
): ProviderContextWindowErrorDetails | null {
  if (!message) return null
  const normalized = message.toLowerCase()
  const recognized =
    [
      'contextwindowexceeded',
      'context_window_exceeded',
      'maximum context length',
      'context length exceeded',
      'context window exceeded',
      'prompt is too long',
      'input is too long',
      'exceeds the context window'
    ].some((fragment) => normalized.includes(fragment)) ||
    /too many tokens[^.\n]*(?:context|maximum|max(?:imum)? length)/i.test(message)
  if (!recognized) return null
  return {
    contextLength:
      numericMatch(message, /maximum context length is\s*([\d,]+)/i) ??
      numericMatch(message, /context(?:\s+window)?(?:\s+of|\s+is|:)\s*([\d,]+)\s*tokens/i),
    requestedOutputTokens:
      numericMatch(message, /requested\s*([\d,]+)\s*output tokens/i) ??
      numericMatch(message, /max(?:imum)?[_\s-]*output[_\s-]*tokens[=: ]+([\d,]+)/i),
    inputTokens:
      numericMatch(
        message,
        /(?:prompt contains at least|input(?:_tokens| tokens)?[=:])\s*([\d,]+)/i
      ) ?? numericMatch(message, /prompt is too long:\s*([\d,]+)\s*tokens/i)
  }
}
