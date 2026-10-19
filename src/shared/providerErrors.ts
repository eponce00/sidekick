export interface ProviderContextWindowErrorDetails {
  contextLength?: number
  requestedOutputTokens?: number
  inputTokens?: number
}

export interface ProviderImageLimitErrorDetails {
  maxImages?: number
}

// Node's fetch (undici) wraps network failures in a TypeError whose cause carries one of these.
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT'
])
const DROPPED_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'UND_ERR_CLOSED'])
const UNREACHABLE_PREFIX = 'Could not reach the model server'
const DROPPED_PREFIX = 'Lost the connection to the model server'

function serverName(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint
  } catch {
    return endpoint
  }
}

/**
 * Says in plain words that the model server could not be reached, or closed the connection while
 * it replied, naming the server. Other failures return null and keep their own message.
 */
export function providerConnectionFailureMessage(error: unknown, endpoint: string): string | null {
  if (!(error instanceof Error)) return null
  const cause = error.cause as { code?: unknown } | undefined
  const code = typeof cause?.code === 'string' ? cause.code : undefined
  const server = serverName(endpoint)
  if (code && UNREACHABLE_CODES.has(code))
    return `${UNREACHABLE_PREFIX} at ${server}. Check that it is running. (${code})`
  if ((code && DROPPED_CODES.has(code)) || (!code && error.message === 'terminated'))
    return `${DROPPED_PREFIX} at ${server} while it was replying; the server stopped or restarted.${code ? ` (${code})` : ''}`
  return null
}

/** Whether a run failed because the model server was unreachable or dropped the connection. */
export function providerConnectionFailureKind(
  message: string | null | undefined
): 'unreachable' | 'dropped' | null {
  if (message?.includes(UNREACHABLE_PREFIX)) return 'unreachable'
  if (message?.includes(DROPPED_PREFIX)) return 'dropped'
  return null
}

/** Only classify explicit inference failures, never infer hardware trouble from a timeout. */
export function providerInferenceFailure(
  message: string | null | undefined
): 'gpu-memory-exhausted' | 'engine-unavailable' | null {
  if (!message) return null
  if (/(?:cuda|gpu)[^\n]{0,100}out\s+of\s+memory|torch\.OutOfMemoryError/i.test(message))
    return 'gpu-memory-exhausted'
  if (/\bEngineDeadError\b|\bengine core (?:is dead|encountered an issue)\b/i.test(message))
    return 'engine-unavailable'
  return null
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

/** Recognizes image-count limits returned by OpenAI-compatible vision gateways. */
export function providerImageLimitError(
  message: string | null | undefined
): ProviderImageLimitErrorDetails | null {
  if (!message) return null
  const normalized = message.toLowerCase()
  if (
    !/at most\s+[\d,]+\s+image\(s\)\s+may be provided/i.test(message) &&
    !/maximum(?: number of)?\s+[\d,]+\s+images?/i.test(message) &&
    !normalized.includes('too many images')
  ) {
    return null
  }
  return {
    maxImages:
      numericMatch(message, /at most\s+([\d,]+)\s+image/i) ??
      numericMatch(message, /maximum(?: number of)?\s+([\d,]+)\s+images?/i)
  }
}
